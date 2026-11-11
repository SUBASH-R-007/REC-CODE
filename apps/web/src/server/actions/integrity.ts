"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireActionRole } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";

/**
 * Deciding a flag, and appealing one (Phase 6e).
 *
 * SPEC §5 requires "mandatory human verdict with a written rationale" and a
 * "7-day two-person appeal". Both of those are CHECKs in the database — the
 * rationale floor and the two-person rule — so this file's job is to make the
 * refusals readable and to resolve the flag when the reviewers are done.
 *
 * What this file CANNOT do, by `tests/repo/integrity-isolation.test.ts`:
 * import the judge, contests, ratings or XP, write any scoring model, or set
 * any score column. A verdict publishes or withholds a result. It never
 * changes one.
 */

const RATIONALE = z
  .string()
  .trim()
  .min(40, "Say what you concluded and why, in a sentence or two. The student reads this.")
  .max(4_000);


// ── A reviewer's verdict ─────────────────────────────────────────────────

const verdictSchema = z
  .object({
    flagId: z.string().min(1).max(64),
    verdict: z.enum(["CLEAR", "UPHOLD"]),
    rationale: RATIONALE,
  })
  .strict();

/**
 * Record one reviewer's verdict, and resolve the flag once enough reviewers
 * have spoken.
 *
 * At HIGH two INDEPENDENT reviewers are required, and they can disagree. The
 * rule when they do is deliberately asymmetric: any CLEAR clears the flag.
 * One reviewer who is not convinced is enough to publish a result, because
 * the cost of withholding an honest student's result is borne by the student
 * and the cost of publishing a dishonest one is borne by nobody in
 * particular. SPEC §0's whole posture — "no signal ever auto-penalises" —
 * points the same way.
 */
export async function recordVerdict(input: unknown): Promise<ActionResult<{ resolved: boolean }>> {
  return runAction(async () => {
    const reviewer = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = verdictSchema.parse(input);

    const flag = await db.integrityFlag.findUnique({
      where: { id: parsed.flagId },
      select: {
        id: true,
        status: true,
        band: true,
        reviewersRequired: true,
        attempt: { select: { id: true, userId: true } },
        reviews: { select: { reviewerId: true, verdict: true } },
      },
    });
    if (!flag) throw new NotFoundError("That flag was not found.");
    if (flag.status !== "OPEN") throw new ValidationError("That flag has already been resolved.");
    if (flag.reviews.some((review) => review.reviewerId === reviewer.id)) {
      throw new ValidationError("You have already recorded a verdict on this flag.");
    }

    await db.integrityReview.create({
      data: {
        flagId: flag.id,
        reviewerId: reviewer.id,
        verdict: parsed.verdict,
        rationale: parsed.rationale,
      },
    });

    await audit({
      actorId: reviewer.id,
      action: "integrity.verdict.recorded",
      entityType: "IntegrityFlag",
      entityId: flag.id,
      targetUserId: flag.attempt.userId,
      sensitivity: "SENSITIVE",
      metadata: {
        attemptId: flag.attempt.id,
        band: flag.band,
        verdict: parsed.verdict,
        rationale: parsed.rationale,
      },
    });

    // Enough reviewers? Count this one in.
    const verdicts = [...flag.reviews.map((r) => r.verdict), parsed.verdict];
    const required = Math.max(1, flag.reviewersRequired);
    if (verdicts.length < required) {
      revalidateIntegrity(flag.id);
      return { resolved: false };
    }

    // Any CLEAR clears. See the doc comment: the asymmetry is the point.
    const status = verdicts.includes("CLEAR") ? "CLEARED" : "UPHELD";
    const resolvedAt = new Date();
    await db.integrityFlag.updateMany({
      where: { id: flag.id, status: "OPEN" },
      data: { status, resolvedAt, withheld: false },
    });

    await audit({
      actorId: reviewer.id,
      action: status === "CLEARED" ? "integrity.flag.cleared" : "integrity.flag.upheld",
      entityType: "IntegrityFlag",
      entityId: flag.id,
      targetUserId: flag.attempt.userId,
      sensitivity: "SENSITIVE",
      metadata: {
        attemptId: flag.attempt.id,
        reviewers: verdicts.length,
        note:
          status === "CLEARED"
            ? "Published. A single CLEAR among the reviewers is enough."
            : "Upheld. The student may appeal within 7 days, and two different people decide it.",
      },
    });
    revalidateIntegrity(flag.id);
    return { resolved: true };
  }, "recordVerdict");
}

// ── Deciding an appeal: two people, neither the original reviewer ────────

const appealVerdictSchema = z
  .object({
    appealId: z.string().min(1).max(64),
    verdict: z.enum(["CLEAR", "UPHOLD"]),
    rationale: RATIONALE,
  })
  .strict();

/**
 * One of the two appeal verdicts.
 *
 * Neither decider may be a reviewer who already judged the flag: an appeal
 * reviewed by the person whose decision is being appealed is not an appeal.
 * The database enforces that the two deciders are different people; this
 * enforces that neither of them is the original reviewer, which the database
 * cannot see.
 */
export async function decideAppeal(input: unknown): Promise<ActionResult<{ resolved: boolean }>> {
  return runAction(async () => {
    const reviewer = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = appealVerdictSchema.parse(input);

    const appeal = await db.integrityAppeal.findUnique({
      where: { id: parsed.appealId },
      select: {
        id: true,
        flagId: true,
        studentId: true,
        outcome: true,
        firstReviewerId: true,
        firstVerdict: true,
        secondReviewerId: true,
        flag: { select: { status: true, reviews: { select: { reviewerId: true } } } },
      },
    });
    if (!appeal) throw new NotFoundError("That appeal was not found.");
    if (appeal.outcome !== "PENDING") throw new ValidationError("That appeal has already been decided.");
    if (appeal.flag.reviews.some((review) => review.reviewerId === reviewer.id)) {
      throw new ValidationError(
        "You recorded the verdict being appealed. An appeal has to be decided by two people who did not.",
      );
    }
    if (appeal.firstReviewerId === reviewer.id) {
      throw new ValidationError("You have already given your verdict on this appeal.");
    }

    const now = new Date();
    const first = appeal.firstVerdict === null;
    const data = first
      ? {
          firstReviewerId: reviewer.id,
          firstVerdict: parsed.verdict,
          firstRationale: parsed.rationale,
          firstDecidedAt: now,
        }
      : {
          secondReviewerId: reviewer.id,
          secondVerdict: parsed.verdict,
          secondRationale: parsed.rationale,
          secondDecidedAt: now,
        };
    const written = await db.integrityAppeal.updateMany({
      where: { id: appeal.id, outcome: "PENDING" },
      data,
    });
    if (written.count !== 1) throw new ValidationError("That appeal changed while you were deciding. Reload it.");

    await audit({
      actorId: reviewer.id,
      action: "integrity.appeal.verdict",
      entityType: "IntegrityAppeal",
      entityId: appeal.id,
      targetUserId: appeal.studentId,
      sensitivity: "SENSITIVE",
      metadata: { which: first ? "first" : "second", verdict: parsed.verdict, rationale: parsed.rationale },
    });

    if (first) {
      revalidateIntegrity(appeal.flagId);
      return { resolved: false };
    }

    // Both have spoken. Any CLEAR overturns, for the same reason a single
    // CLEAR clears a flag: an unconvinced reviewer is enough.
    const fresh = await db.integrityAppeal.findUniqueOrThrow({
      where: { id: appeal.id },
      select: { firstVerdict: true, secondVerdict: true },
    });
    const overturned = fresh.firstVerdict === "CLEAR" || fresh.secondVerdict === "CLEAR";
    await db.integrityAppeal.updateMany({
      where: { id: appeal.id, outcome: "PENDING" },
      data: { outcome: overturned ? "OVERTURNED" : "UPHELD", resolvedAt: now },
    });
    if (overturned) {
      await db.integrityFlag.updateMany({
        where: { id: appeal.flagId, status: "UPHELD" },
        data: { status: "OVERTURNED", withheld: false, resolvedAt: now },
      });
    }

    await audit({
      actorId: reviewer.id,
      action: overturned ? "integrity.appeal.overturned" : "integrity.appeal.upheld",
      entityType: "IntegrityAppeal",
      entityId: appeal.id,
      targetUserId: appeal.studentId,
      sensitivity: "SENSITIVE",
      metadata: { flagId: appeal.flagId },
    });
    revalidateIntegrity(appeal.flagId);
    return { resolved: true };
  }, "decideAppeal");
}

function revalidateIntegrity(flagId: string): void {
  revalidatePath("/admin/integrity");
  revalidatePath(`/admin/integrity/${flagId}`);
  revalidatePath("/super/integrity");
}
