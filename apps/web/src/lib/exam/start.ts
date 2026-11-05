import "server-only";
import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import type { AssessmentAttempt } from "@recx/db";
import {
  acceptsWork,
  computeExpiresAt,
  isFinished,
  matchesAnyCidr,
  requiresDeviceAssertion,
  paperQuestionCount,
  questionLanguages,
  resolveLayout,
  type AccommodationKind,
  type AttemptLayout,
  type AttemptStatus,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { mintAttemptToken, setAttemptCookie } from "@/lib/exam/attempt-token";
import { checkContainment } from "@/lib/exam/containment";
import { endExamBrowserSitting, examBrowserSittingClaimedBy } from "@/lib/exam/exam-browser";
import { acceptedLanguagesFor } from "@/lib/exam/language";
import { attemptLayoutOf } from "@/lib/exam/layout";
import { consumeLoaner, freshAssertionFor } from "@/lib/exam/webauthn";
import { hashUserAgent, requestIp, requestIpHash } from "@/lib/ip";

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
  | "needs_lab_session"
  | "needs_device"
  /**
   * Phase 12s. The hall's network and the kiosk's key, checked BEFORE a
   * sitting is created rather than only on the request after it.
   */
  | "outside_allowlist"
  | "seb_required"
  | "recx_browser_required";

export const START_REFUSAL_MESSAGES: Readonly<Record<StartRefusal, string>> = Object.freeze({
  not_found: "That assessment does not exist.",
  not_open: "This assessment is not open right now. Check the window with your department.",
  not_your_audience: "This assessment is not set for your batch, department or section.",
  no_attempts_left: "You have used all your attempts at this assessment.",
  finished: "You have already finished this assessment.",
  needs_lab_session:
    "This assessment is sat in a supervised lab. Your invigilator will seat you in an exam session first.",
  needs_device:
    "This assessment needs a registered device. Verify yours before starting — or ask your invigilator, who can enrol this machine or issue a loaner.",
  /**
   * Phase 12s. `checkContainment` returns a sentence of its own, and a more
   * specific one for SEB, but a refusal travels back to the readiness page as
   * a KEY in a query string and is rendered from this table — deliberately, so
   * nothing a candidate can type ends up as text on the page. These two say
   * the same thing in the same register, and the precise verdict is in the
   * audit entry an invigilator can read.
   */
  outside_allowlist:
    "This assessment can only be sat from the exam hall network. Tell your invigilator — if you are in the hall, the network has changed.",
  seb_required:
    "This assessment is sat in Safe Exam Browser. Open it from the configuration file your invigilator gave you, not in a normal browser.",
  recx_browser_required:
    "This assessment is sat in REC Exam Browser. Launch it from the readiness check — the button there installs it if this machine does not have it yet.",
});

/**
 * The hall this sitting belongs to, if one is open for this paper.
 *
 * It matters most for LAB_SUPERVISED, where the CIDR allowlist and the seat
 * label are columns on that row, and for KIOSK_SEB, where the Safe Exam
 * Browser keys ROTATE PER EXAM SESSION (SPEC §5) — `sebKeysFor` prefers
 * `seb:<examSessionId>` over the platform-wide entry, so a kiosk sitting
 * that is not linked to its hall can only ever be checked against the
 * college-wide key, and a hall that rotated its own key would refuse the
 * candidate who used the right .seb file.
 *
 * But a hall can be scheduled for a paper in ANY proctor mode
 * (`scheduleExamSession` only requires an allowlist for the modes that need
 * one), and `ExamSession.attempts` is documented as "candidates sitting in
 * this hall". So every mode is linked: for the modes containment does not
 * check, the link costs nothing and is what makes the invigilator's roster
 * — `where: { examSessionId }` — show the room.
 *
 * Which hall, when a paper has two rooms open at once: the one whose
 * network the candidate is on. Picking arbitrarily was harmless while this
 * lookup only answered "does a hall exist", and stopped being harmless the
 * moment the row's allowlist became the one a sitting is checked against —
 * a candidate in Lab 3 compared against Lab 4's blocks is refused for being
 * exactly where they should be. With no address to go on, or no room
 * matching it, the order is deterministic (earliest, then id) so a
 * candidate is not seated differently on each press.
 */
async function pickHall(args: {
  readonly assessmentId: string;
  readonly now: Date;
}): Promise<{ readonly id: string } | null> {
  const halls = await db.examSession.findMany({
    where: { assessmentId: args.assessmentId, startsAt: { lte: args.now }, endsAt: { gt: args.now } },
    select: { id: true, allowedCidrs: true },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  const first = halls[0];
  if (first === undefined) return null;
  if (halls.length === 1) return { id: first.id };

  const ip = await requestIp();
  if (ip !== null) {
    for (const hall of halls) {
      const verdict = matchesAnyCidr(ip, hall.allowedCidrs);
      // `empty` means the room has no allowlist, which says nothing about
      // whether this candidate is in it — so it is not a match, it is a
      // room that cannot be matched. The deterministic fallback takes it.
      if (!verdict.empty && verdict.allowed) return { id: hall.id };
    }
  }
  return { id: first.id };
}

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
  /** The request itself: the SEB key is a hash OF THE URL, so the check needs it. */
  readonly request: Request;
  readonly slug: string;
  readonly userId: string;
  readonly sessionId: string | null;
  /** The seat an invigilator put this candidate in (LAB_SUPERVISED). */
  readonly seatLabel?: string | null;
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
      /** Which languages the paper may be answered in (Phase 13a). */
      allowedLanguages: true,
      // `allowedLanguages` per question (Phase 13c): the narrowing a
      // question may put on the paper's own set.
      problems: {
        select: { id: true, problemVersionId: true, position: true, points: true, allowedLanguages: true },
      },
      /**
       * The paper's MCQs (Phase 12r). `options` comes back only to be
       * counted: the layout records the order THIS candidate will see them
       * in, and the text is fetched when the paper is rendered. The
       * correct index is not selected at all, here or anywhere a
       * candidate's request can reach.
       */
      mcqs: { select: { id: true, position: true, points: true, options: true } },
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
  const resuming = existing !== null && acceptsWork(existing.status as AttemptStatus);

  /**
   * Whether this paper can be STARTED at all, asked before the hall is —
   * so that a candidate reads the refusal that is actually about them.
   *
   * These four are facts about the paper and the attempts already spent,
   * and they are free to check. A candidate at home whose paper closed
   * yesterday should read "this assessment is not open", not "this
   * assessment can only be sat from the exam hall network": both are true,
   * one of them is the reason. A candidate who is resuming skips the lot —
   * a sitting in progress continues past `closesAt` on purpose, which is
   * why these were written after the resume branch to begin with.
   */
  if (!resuming) {
    if (assessment.status !== "OPEN") return refuse("not_open");
    if (now < assessment.opensAt || now >= assessment.closesAt) return refuse("not_open");
    // Nothing to sit at all. Either kind counts; see paperQuestionCount.
    if (paperQuestionCount(assessment) === 0) return refuse("not_open");
    const spent = existing?.attemptNumber ?? 0;
    if (existing && isFinished(existing.status as AttemptStatus) && spent >= assessment.maxAttempts) {
      return refuse(spent === 1 && assessment.maxAttempts === 1 ? "finished" : "no_attempts_left");
    }
    if (spent >= assessment.maxAttempts) return refuse("no_attempts_left");
  }

  /**
   * The hall's network and the kiosk's key, BEFORE anything is created
   * (Phase 12s).
   *
   * `checkContainment` runs on every request through `guardAttempt`, which
   * is what makes "leaving the lab network ends the session" true — but it
   * did not run on the request that STARTS the sitting. The sitting was
   * created, the clock started, an attempt was spent, and the very next
   * request refused it. For a paper with `maxAttempts: 1` that meant a
   * candidate who pressed Start in an ordinary browser instead of Safe
   * Exam Browser, or from the wrong network, burned their only attempt on
   * a sitting they could never work in. Containment was never the thing
   * that failed; what failed was charging them for finding out.
   *
   * Before the resume branch as well as the new-sitting one: resuming
   * spends nothing, but a candidate whose wifi moved should read the
   * network's sentence rather than be let in and cut off a second later.
   *
   * `audited: false` because there is no attempt row for an audit to point
   * at yet — the refusal the candidate reads is the point here, and the
   * audited refusals happen on the paths that have an attempt.
   */
  const hall = await pickHall({ assessmentId: assessment.id, now });

  /**
   * Which REC Exam Browser sitting this request is being made from
   * (Phase 14h).
   *
   * The other proctor modes need nothing here: SEB's key is shared and the
   * hall's allowlist is about the network. `KIOSK_RECX` is per sitting, and
   * `checkContainment` reads the expected sitting off the attempt -- which
   * at Start does not exist yet. Until this line, that made a `KIOSK_RECX`
   * paper impossible to begin: the request trying to create the attempt was
   * refused for not naming a sitting the attempt could not yet hold.
   *
   * The lookup proves ownership (this candidate, this paper, bound, not
   * ended) and nothing else. The SIGNATURE is what proves the browser holds
   * the key, and `checkContainment` on the next line does that once -- once,
   * because verifying spends the nonce.
   */
  const examBrowserSittingId =
    assessment.proctorMode === "KIOSK_RECX"
      ? await examBrowserSittingClaimedBy({
          request: args.request,
          userId: args.userId,
          assessmentId: assessment.id,
        })
      : null;

  const containment = await checkContainment({
    request: args.request,
    attempt: {
      id: "",
      userId: args.userId,
      assessmentId: assessment.id,
      examSessionId: hall?.id ?? null,
      proctorMode: assessment.proctorMode,
      examBrowserSittingId,
    },
    audited: false,
  });
  if (!containment.ok) return refuse(containment.refusal ?? "outside_allowlist");

  if (resuming && existing) {
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
        /**
         * Seated on resume if it was not seated at start: a sitting that
         * began before the invigilator created the hall, or one started
         * before this column was ever written, starts being checked against
         * the allowlist from here on. Only ever null → a hall, never one
         * hall to another: which room a sitting happened in is a fact, and a
         * sitting that could be re-pointed could be re-pointed to a room
         * whose allowlist admits anyone.
         */
        ...(existing.examSessionId === null && hall ? { examSessionId: hall.id } : {}),
        /**
         * Re-pointed at the sitting that is resuming it (Phase 14h).
         *
         * Unlike the hall above, this one CAN move from sitting to sitting,
         * and has to. An exam browser that crashed is relaunched, which
         * spends a new launch token and mints a new sitting, and the attempt
         * must follow -- the old sitting's key is on a process that no
         * longer exists. It is not a loosening: `examBrowserSittingClaimedBy`
         * only returns a sitting belonging to this candidate and this paper,
         * and containment has already verified a signature under its key on
         * this very request.
         */
        ...(examBrowserSittingId !== null && examBrowserSittingId !== existing.examBrowserSittingId
          ? { examBrowserSittingId }
          : {}),
        version: { increment: 1 },
      },
    });

    /**
     * And the one it left behind is ended, which revokes its session too.
     * A candidate whose exam browser crashed has a signed-in window on
     * their machine that nothing is watching any more.
     */
    if (
      existing.examBrowserSittingId !== null &&
      existing.examBrowserSittingId !== examBrowserSittingId
    ) {
      await endExamBrowserSitting(existing.examBrowserSittingId);
    }

    await setAttemptCookie(existing.id, token.token, secondsLeft);
    return { ok: true, attempt: existing, layout: attemptLayoutOf(existing), resumed: true };
  }

  // ── A new sitting ──────────────────────────────────────────────────────
  // Whether there is one to start was settled above, before containment.
  const used = existing?.attemptNumber ?? 0;

  // LAB_SUPERVISED means an invigilator seats the candidate in an ExamSession
  // first; the CIDR allowlist and the seat label hang off that row (slice 6d).
  // Refusing here rather than starting a sitting that cannot be supervised.
  // The same hall the containment check above resolved.
  if (assessment.proctorMode === "LAB_SUPERVISED" && !hall) return refuse("needs_lab_session");

  // ── A fresh device assertion (Phase 6d) ────────────────────────────────
  // SPEC §5 requires one to START a REMOTE_MONITORED or LAB_SUPERVISED
  // attempt. The assertion happened in its own request; a short-lived signed
  // cookie scoped to this assessment carries the result here.
  let device: { deviceId: string; isLoaner: boolean } | null = null;
  if (requiresDeviceAssertion(assessment.proctorMode)) {
    device = await freshAssertionFor({ userId: args.userId, assessmentId: assessment.id });
    if (!device) return refuse("needs_device");
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
  /**
   * The accepted languages, resolved once and frozen (Phase 13a).
   *
   * What the department chose, narrowed to what the judge can run. The
   * FIRST of them is the one the editor opens in, which keeps `language`
   * meaning exactly what it meant before: the paper's default.
   */
  const accepted = await acceptedLanguagesFor(assessment.allowedLanguages);
  const layout = resolveLayout({
    /**
     * Each question's narrowing is resolved against the paper's set HERE,
     * so the layout stores what the candidate may actually use rather
     * than a pair of lists that a later reader has to intersect again
     * (Phase 13c). A question that narrows to nothing the paper accepts
     * keeps the paper's set, which `questionLanguages` decides.
     */
    questions: assessment.problems.map((problem) => ({
      ...problem,
      languages:
        problem.allowedLanguages.length === 0
          ? undefined
          : questionLanguages({ question: problem.allowedLanguages, paper: accepted }),
    })),
    seed,
    // Frozen with the paper (Phase 12r.4), so enabling a toolchain while
    // somebody is sitting cannot move their paper to it.
    language: accepted[0],
    // And the whole set with it (Phase 13a), so narrowing the paper's list
    // mid-sitting cannot strand a candidate in a language the server has
    // stopped accepting -- with their answer already written in it.
    languages: accepted,
    mcqs: assessment.mcqs.map((mcq) => ({
      id: mcq.id,
      position: mcq.position,
      points: mcq.points,
      optionCount: mcq.options.length,
    })),
  });

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
      // Which machine sat this exam, answerable from the row long after the
      // assertion cookie is gone.
      deviceRegistrationId: device?.deviceId ?? null,
      seatLabel: args.seatLabel ?? null,
      /**
       * The sitting this paper is being sat in (Phase 14h). Null for every
       * mode but `KIOSK_RECX`, which the database also insists on:
       * `AssessmentAttempt_browser_sitting_needs_kiosk_recx`.
       */
      examBrowserSittingId,
      /**
       * The hall this sitting belongs to — and the whole reason the
       * allowlist works at all (Phase 12s).
       *
       * `checkContainment` checks the CIDR allowlist only when
       * `attempt.examSessionId !== null`, because an unseated candidate has
       * no hall to be inside. Nothing in the application EVER wrote this
       * column, so every attempt row carried null and that branch never ran
       * once: docs/PROCTORING.md §4 listed the allowlist among the controls
       * that "actually enforce" and promised it was "re-verified on every
       * heartbeat", and it was being re-verified against nothing. The
       * invigilator's own roster reads `where: { examSessionId }` too, so
       * every hall page showed an empty room.
       *
       * It is not in the write-once tuple `recx_refuse_attempt_change()`
       * freezes, deliberately: the hall is a fact about where a sitting is
       * taking place, which an invigilator may establish after a candidate
       * has begun.
       */
      examSessionId: hall?.id ?? null,
    },
  });

  await setAttemptCookie(row.id, token.token, expiry.grantedSec);
  // A loan is spent only now, after the sitting exists: a candidate who
  // asserted and then failed a later check has not burned their loaner.
  if (device?.isLoaner) await consumeLoaner(device.deviceId);

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
      deviceBound: device !== null,
      onLoaner: device?.isLoaner ?? false,
    },
  });

  return { ok: true, attempt: row, layout, resumed: false };
}

/** The accommodation kinds frozen on an attempt, typed. */
export function accommodationKindsOf(attempt: Pick<AssessmentAttempt, "accommodationFlags">): AccommodationKind[] {
  return attempt.accommodationFlags as AccommodationKind[];
}
