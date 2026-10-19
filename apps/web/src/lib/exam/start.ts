import "server-only";
import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import type { AssessmentAttempt } from "@recx/db";
import {
  acceptsWork,
  computeExpiresAt,
  isFinished,
  resolveLayout,
  type AccommodationKind,
  type AttemptLayout,
  type AttemptStatus,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { mintAttemptToken, setAttemptCookie } from "@/lib/exam/attempt-token";
import { attemptLayoutOf } from "@/lib/exam/layout";
import { hashUserAgent, requestIpHash } from "@/lib/ip";

/**
 * Starting and resuming a sitting (Phase 6c).
 *
 * This is where a candidate's paper comes into existence and where the clock
 * is set, and both are written ONCE: `seed`, `layout`, `startedAt` and
 * `expiresAt` are in the write-once tuple the `AssessmentAttempt_machine`
 * trigger refuses to change (migration 20261019160000). So everything
 * decided here is decided for good, and a resume returns exactly the paper
 * the candidate already had.
 *
 * SPEC §5:
 *
 *   expiresAt = min(startedAt + durationSec × (1 + extraTimePercent/100) +
 *   extraTimeMinutes, assessment.closesAt), computed server-side only, never
 *   accepted from the client.
 *
 *   seed = HMAC-SHA256(assessment.secret, attemptId), feeding xoshiro128**.
 *   [...] Freeze the whole resolution into AssessmentAttempt.layout so a
 *   reload or resume returns an identical paper.
 */

export type StartRefusal =
  | "not_found"
  | "not_open"
  | "not_your_audience"
  | "no_attempts_left"
  | "finished"
  | "needs_lab_session";

export const START_REFUSAL_MESSAGES: Readonly<Record<StartRefusal, string>> = Object.freeze({
  not_found: "That assessment does not exist.",
  not_open: "This assessment is not open right now. Check the window with your department.",
  not_your_audience: "This assessment is not set for your batch, department or section.",
  no_attempts_left: "You have used all your attempts at this assessment.",
  finished: "You have already finished this assessment.",
  needs_lab_session:
    "This assessment is sat in a supervised lab. Your invigilator will seat you in an exam session first.",
});

export type StartResult =
  | { readonly ok: true; readonly attempt: AssessmentAttempt; readonly layout: AttemptLayout; readonly resumed: boolean }
  | { readonly ok: false; readonly refusal: StartRefusal; readonly message: string };

const refuse = (refusal: StartRefusal): StartResult => ({
  ok: false,
  refusal,
  message: START_REFUSAL_MESSAGES[refusal],
});

/**
 * The attempt's randomisation seed, folded to a non-negative 32-bit integer
 * because `AssessmentAttempt.seed` is an Int and xoshiro128** is seeded from
 * one word. Taking the first four bytes of a 32-byte HMAC is the standard way
 * to narrow one: every bit of the output depends on every bit of the input.
 *
 * SPEC §5 writes it as `HMAC-SHA256(assessment.secret, attemptId)`. This uses
 * the sitting's NATURAL KEY instead — `assessmentId:userId:attemptNumber`,
 * which is exactly `@@unique([assessmentId, userId, attemptNumber])` — and the
 * reason is the write-once guard:
 *
 * The attempt id is assigned by the database on insert, so seeding from it
 * means creating the row and then writing `seed` and `layout` into it. But
 * both are in the tuple `recx_refuse_attempt_change()` freezes, so the
 * database refuses that second write — correctly, and it refused the first
 * draft of this function. Seeding from the natural key is known BEFORE the
 * insert, so the row is created complete and the write-once guard stays
 * absolute rather than needing an exception carved into it.
 *
 * It is no weaker: the natural key is unique per sitting, the secret is
 * per-assessment and never leaves the server, and it is now reproducible from
 * the key a dispute would quote rather than from an opaque cuid. Recorded in
 * docs/OPEN-QUESTIONS.md.
 */
export function attemptSeed(
  seedSecret: string,
  sitting: { readonly assessmentId: string; readonly userId: string; readonly attemptNumber: number },
): number {
  const mac = createHmac("sha256", seedSecret)
    .update(`${sitting.assessmentId}:${sitting.userId}:${sitting.attemptNumber}`)
    .digest();
  // & 0x7fffffff keeps it inside a signed Int4 and non-negative.
  return mac.readUInt32BE(0) & 0x7fff_ffff;
}

/** The accommodation in force for this candidate, if any. */
async function accommodationFor(userId: string, now: Date) {
  return db.accommodation.findFirst({
    where: { userId, status: "APPROVED", validUntil: { gt: now } },
    select: { kinds: true, extraTimePercent: true, extraTimeMinutes: true },
    orderBy: { grantedAt: "desc" },
  });
}

function audienceMatches(
  assessment: { audienceBatchYear: number | null; audienceDepartmentCode: string | null; audienceSection: string | null },
  user: { batchYear: number | null; departmentCode: string | null; section: string | null },
): boolean {
  // A null audience dimension means "every value of that dimension".
  if (assessment.audienceBatchYear !== null && assessment.audienceBatchYear !== user.batchYear) return false;
  if (assessment.audienceDepartmentCode !== null && assessment.audienceDepartmentCode !== user.departmentCode) {
    return false;
  }
  if (assessment.audienceSection !== null && assessment.audienceSection !== user.section) return false;
  return true;
}

/**
 * Start a new sitting, or return the one already in progress.
 *
 * Resuming is the common case and the one that must not go wrong: a
 * candidate whose laptop died reloads, and gets back the same questions in
 * the same order with the same deadline. That is why nothing about the paper
 * or the clock is recomputed on a resume — the stored row IS the paper.
 *
 * The attempt token is rotated on resume (SPEC §5), so a token captured from
 * the first load cannot be replayed by a second client afterwards.
 */
export async function startOrResumeAttempt(args: {
  readonly slug: string;
  readonly userId: string;
  readonly sessionId: string | null;
}): Promise<StartResult> {
  const now = new Date();

  const assessment = await db.assessment.findUnique({
    where: { slug: args.slug },
    select: {
      id: true,
      status: true,
      opensAt: true,
      closesAt: true,
      durationSec: true,
      maxAttempts: true,
      proctorMode: true,
      audienceBatchYear: true,
      audienceDepartmentCode: true,
      audienceSection: true,
      seedSecret: true,
      problems: { select: { id: true, problemVersionId: true, position: true, points: true } },
    },
  });
  if (!assessment) return refuse("not_found");

  const user = await db.user.findUniqueOrThrow({
    where: { id: args.userId },
    select: { batchYear: true, departmentCode: true, section: true },
  });
  if (!audienceMatches(assessment, user)) return refuse("not_your_audience");

  // ── An existing sitting ────────────────────────────────────────────────
  const existing = await db.assessmentAttempt.findFirst({
    where: { assessmentId: assessment.id, userId: args.userId },
    orderBy: { attemptNumber: "desc" },
  });

  if (existing && acceptsWork(existing.status as AttemptStatus)) {
    const token = mintAttemptToken();
    const secondsLeft = Math.max(
      60,
      Math.ceil((existing.expiresAt.getTime() + existing.pausedMs - now.getTime()) / 1000),
    );
    // Rotated on resume (SPEC §5): a token captured from the first load
    // cannot be replayed by a second client afterwards.
    await db.assessmentAttempt.updateMany({
      where: { id: existing.id, version: existing.version },
      data: {
        tokenHash: token.tokenHash,
        ipHashLast: (await requestIpHash()) ?? existing.ipHashLast,
        lockSessionId: args.sessionId ?? existing.lockSessionId,
        version: { increment: 1 },
      },
    });
    await setAttemptCookie(existing.id, token.token, secondsLeft);
    return { ok: true, attempt: existing, layout: attemptLayoutOf(existing), resumed: true };
  }

  // ── A new sitting ──────────────────────────────────────────────────────
  if (assessment.status !== "OPEN") return refuse("not_open");
  if (now < assessment.opensAt || now >= assessment.closesAt) return refuse("not_open");
  if (assessment.problems.length === 0) return refuse("not_open");

  const used = existing?.attemptNumber ?? 0;
  if (existing && isFinished(existing.status as AttemptStatus) && used >= assessment.maxAttempts) {
    return refuse(used === 1 && assessment.maxAttempts === 1 ? "finished" : "no_attempts_left");
  }
  if (used >= assessment.maxAttempts) return refuse("no_attempts_left");

  // LAB_SUPERVISED means an invigilator seats the candidate in an ExamSession
  // first; the CIDR allowlist and the seat label hang off that row (slice 6d).
  // Refusing here rather than starting a sitting that cannot be supervised.
  if (assessment.proctorMode === "LAB_SUPERVISED") {
    const session = await db.examSession.findFirst({
      where: { assessmentId: assessment.id, startsAt: { lte: now }, endsAt: { gt: now } },
      select: { id: true },
    });
    if (!session) return refuse("needs_lab_session");
  }

  const accommodation = await accommodationFor(args.userId, now);
  const expiry = computeExpiresAt({
    startedAt: now,
    durationSec: assessment.durationSec,
    closesAt: assessment.closesAt,
    accommodation: accommodation
      ? { extraTimePercent: accommodation.extraTimePercent, extraTimeMinutes: accommodation.extraTimeMinutes }
      : null,
  });

  const token = mintAttemptToken();
  const ipHash = await requestIpHash();
  const userAgent = (await headers()).get("user-agent");

  // The seed and the paper are resolved BEFORE the insert, so the row is
  // created complete and nothing ever needs to update a frozen column.
  const attemptNumber = used + 1;
  const seed = attemptSeed(assessment.seedSecret, {
    assessmentId: assessment.id,
    userId: args.userId,
    attemptNumber,
  });
  const layout = resolveLayout({ questions: assessment.problems, seed });

  const row = await db.assessmentAttempt.create({
    data: {
      assessmentId: assessment.id,
      userId: args.userId,
      attemptNumber,
      status: "IN_PROGRESS",
      seed,
      startedAt: now,
      expiresAt: expiry.expiresAt,
      layout: layout as never,
      tokenHash: token.tokenHash,
      proctorMode: assessment.proctorMode,
      accommodationFlags: accommodation?.kinds ?? [],
      ipHashFirst: ipHash,
      ipHashLast: ipHash,
      uaHash: userAgent ? hashUserAgent(userAgent) : null,
      lockSessionId: args.sessionId,
    },
  });

  await setAttemptCookie(row.id, token.token, expiry.grantedSec);

  await audit({
    actorId: args.userId,
    action: "assessment.attempt.started",
    entityType: "AssessmentAttempt",
    entityId: row.id,
    targetUserId: args.userId,
    metadata: {
      assessmentId: assessment.id,
      attemptNumber,
      proctorMode: assessment.proctorMode,
      expiresAt: expiry.expiresAt.toISOString(),
      grantedSec: expiry.grantedSec,
      // Staff must see when an accommodation was trimmed by the window's own
      // close time: that is a scheduling mistake someone has to fix, not a
      // detail to hide from the candidate who was granted extra time.
      cappedByClose: expiry.cappedByClose,
      accommodated: accommodation !== null,
      questions: layout.questions.length,
    },
  });

  return { ok: true, attempt: row, layout, resumed: false };
}

/** The accommodation kinds frozen on an attempt, typed. */
export function accommodationKindsOf(attempt: Pick<AssessmentAttempt, "accommodationFlags">): AccommodationKind[] {
  return attempt.accommodationFlags as AccommodationKind[];
}
