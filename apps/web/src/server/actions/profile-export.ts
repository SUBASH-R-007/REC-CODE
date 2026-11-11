"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  EXPORT_DEFAULT_DAYS,
  EXPORT_PAYLOAD_VERSION,
  MAX_LIVE_EXPORTS,
  PROFILE_EXPORT_KINDS,
  READINESS_RULES_VERSION,
  READINESS_TIERS,
  TOPICS,
  campusDay,
  forbiddenKeysIn,
  profileExportPayloadSchema,
  rebuildSnapshot,
  topicCounts,
  type ProfileExportPayload,
} from "@recx/shared";
import { requireActionUser } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { newExportCode, signPayload, EXPORT_ALGORITHM } from "@/lib/export/signature";

/**
 * A student signs their own record (Phase 9f).
 *
 * Self-service: `requireActionUser()` and nothing stronger, and the student
 * is always the subject. There is no path here that exports somebody else —
 * an officer who wants cohort data has the CSV, which records who asked.
 *
 * The payload is built from the student's own newest snapshot and validated
 * against `profileExportPayloadSchema` BEFORE it is signed, then checked once
 * more for forbidden keys at any depth. Both, because the two can disagree: a
 * strict schema can still accept a record whose values somebody widened, and
 * the second check reads the built object rather than its type.
 *
 * What a public link may never attest to: an email, a roll number, a
 * department, a section, an integrity band, a flag count. A verification page
 * is a PUBLIC page — anybody with the link reads it — so the test is not
 * "would a recruiter misuse this" but "is this safe on the open web".
 *
 *   createProfileExport   self-service   placement.export_issued
 *   revokeProfileExport   self-service   placement.export_revoked
 */

const createSchema = z.object({ kind: z.enum(PROFILE_EXPORT_KINDS).default("PROFILE") }).strict();
const revokeSchema = z.object({ code: z.string().min(1).max(64) }).strict();

export async function createProfileExport(input: unknown): Promise<ActionResult<{ code: string }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = createSchema.parse(input ?? {});

    const live = await db.profileExport.count({
      where: { userId: user.id, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    if (live >= MAX_LIVE_EXPORTS) {
      throw new ConflictError(
        `You already have ${MAX_LIVE_EXPORTS} live links. Withdraw one you are not using before making another — a link you have forgotten is a link you cannot withdraw.`,
      );
    }

    const payload = await buildPayload(user.id, parsed.kind);
    const code = newExportCode();
    const signature = signPayload(code, payload);
    const issuedAt = new Date();

    await db.profileExport.create({
      data: {
        code,
        userId: user.id,
        kind: parsed.kind,
        payload: payload as never,
        rulesVersion: payload.rulesVersion,
        signature,
        algorithm: EXPORT_ALGORITHM,
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + EXPORT_DEFAULT_DAYS * 86_400_000),
      },
    });

    await audit({
      actorId: user.id,
      action: "placement.export_issued",
      entityType: "ProfileExport",
      entityId: code,
      targetUserId: user.id,
      sensitivity: "NORMAL",
      metadata: { kind: parsed.kind, days: EXPORT_DEFAULT_DAYS },
      ipHash: await requestIpHash(),
    });

    revalidatePath("/placement");
    return { code };
  }, "createProfileExport");
}

/**
 * Withdraw a link the student has already sent.
 *
 * The one state change the row permits, and only once: un-revoking would let
 * somebody re-publish a record the student had pulled back. The link is not
 * deleted, so a recruiter who follows it is told it was withdrawn rather than
 * being shown a 404 they would read as a mistake.
 */
export async function revokeProfileExport(input: unknown): Promise<ActionResult<{ code: string }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = revokeSchema.parse(input);

    // The owner is in the WHERE, so a student can only withdraw their own.
    const existing = await db.profileExport.findFirst({
      where: { code: parsed.code, userId: user.id },
      select: { code: true, revokedAt: true },
    });
    if (!existing) throw new NotFoundError("That link was not found.");
    if (existing.revokedAt) throw new ConflictError("That link has already been withdrawn.");

    await db.profileExport.update({
      where: { code: existing.code },
      data: { revokedAt: new Date(), revokedById: user.id },
    });

    await audit({
      actorId: user.id,
      action: "placement.export_revoked",
      entityType: "ProfileExport",
      entityId: existing.code,
      targetUserId: user.id,
      sensitivity: "NORMAL",
      ipHash: await requestIpHash(),
    });

    revalidatePath("/placement");
    return { code: existing.code };
  }, "revokeProfileExport");
}

/**
 * The attested facts, from the student's own rows.
 *
 * Validated against the schema and then swept for forbidden keys. A payload
 * that fails either is a bug, not a user error, so it throws rather than
 * being silently trimmed — a trimmed payload would be signed and published.
 */
async function buildPayload(userId: string, kind: ProfileExportPayload["kind"]): Promise<ProfileExportPayload> {
  const [user, snapshot, stats, rating, assessments] = await Promise.all([
    db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { firstName: true, lastName: true, handle: true, batchYear: true },
    }),
    db.readinessSnapshot.findFirst({
      where: { userId },
      orderBy: { computedOn: "desc" },
      select: {
        computedOn: true,
        rulesVersion: true,
        components: true,
        topicUnassisted: true,
      },
    }),
    db.userStats.findUnique({ where: { userId }, select: { solvedTotal: true, assistedSolves: true } }),
    db.userRating.findUnique({ where: { userId }, select: { rating: true, contestsRated: true } }),
    db.assessmentAttempt.findMany({
      where: {
        userId,
        status: { in: ["SUBMITTED", "AUTO_SUBMITTED"] },
        assessment: { status: { in: ["CLOSED", "ARCHIVED"] } },
        maxScore: { gt: 0 },
      },
      select: { totalScore: true, maxScore: true },
    }),
  ]);

  const tiers = snapshot
    ? (() => {
        const { tiers: scored } = rebuildSnapshot(snapshot);
        return READINESS_TIERS.map((tier) => ({
          tier,
          score: scored[tier].availableWeight === 0 ? null : Math.round(scored[tier].score),
          availableWeight: Math.round(scored[tier].availableWeight),
        }));
      })()
    : [];

  const counts = snapshot ? topicCounts(snapshot.topicUnassisted) : {};
  const mean =
    assessments.length === 0
      ? null
      : Math.round(
          assessments.reduce((sum, a) => sum + (a.totalScore / (a.maxScore || 1)) * 100, 0) / assessments.length,
        );

  const payload = {
    v: EXPORT_PAYLOAD_VERSION as typeof EXPORT_PAYLOAD_VERSION,
    kind,
    name: `${user.firstName} ${user.lastName}`.trim(),
    handle: user.handle,
    batchYear: user.batchYear,
    computedOn: snapshot ? campusDay(snapshot.computedOn) : null,
    rulesVersion: snapshot?.rulesVersion ?? READINESS_RULES_VERSION,
    tiers,
    solvedTotal: stats?.solvedTotal ?? 0,
    solvedUnassisted: Math.max(0, (stats?.solvedTotal ?? 0) - (stats?.assistedSolves ?? 0)),
    topics: Object.fromEntries(TOPICS.map((topic) => [topic, counts[topic] ?? 0])),
    rating: rating?.rating ?? null,
    contestsRated: rating?.contestsRated ?? 0,
    releasedAssessments: assessments.length,
    assessmentScoreAverage: mean,
    issuedOn: campusDay(new Date()),
  };

  const validated = profileExportPayloadSchema.parse(payload);
  const forbidden = forbiddenKeysIn(validated);
  if (forbidden.length > 0) {
    // Never reachable through the builder above; it is here because the
    // alternative to throwing is signing and publishing it.
    throw new Error(`Refusing to sign a payload carrying ${forbidden.join(", ")}.`);
  }
  return validated;
}
