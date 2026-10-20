"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  DRIVE_ELIGIBILITY,
  DRIVE_REASON_MIN,
  READINESS_TIERS,
  campusDayDate,
} from "@recx/shared";
import { requirePlacementAction } from "@/lib/auth/guards";
import { appendAuditEntriesInTx } from "@recx/db/audit";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * Drives, and the human eligibility decision (Phase 9f).
 *
 * SPEC §5: eligibility is "a human decision recorded in the audit log". The
 * honest statement of what is enforced, because a draft of the design
 * overclaimed it: a NOT NULL actor with a foreign key does NOT make an
 * automatic decision impossible — any job holding a staff user id satisfies
 * both. What IS enforced is that a decision is attributable, carries a
 * reason, never changes, and cannot exist without an `AuditLog` row in the
 * same transaction.
 *
 * That last one is why `recordEligibility` writes both inside ONE
 * `$transaction` and uses `appendAuditEntriesInTx`: the deferred constraint
 * trigger `DriveEligibilityDecision_requires_audit` checks at COMMIT, so a
 * decision written through `audit()` after the transaction would not commit
 * at all. The failure mode is loud by design.
 *
 *   createDrive          placement officer   placement.drive_created
 *   archiveDrive         placement officer   placement.drive_archived
 *   recordEligibility    placement officer   placement.eligibility_decided
 */

const driveSchema = z
  .object({
    companyName: z.string().trim().min(2, "Give the company's name.").max(120),
    tier: z.enum(READINESS_TIERS),
    driveOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Give the drive date as yyyy-MM-dd."),
    thresholdScore: z.coerce.number().int().min(0).max(100).nullable().optional(),
    eligibleBatchYear: z.coerce.number().int().min(1900).max(2200).nullable().optional(),
    eligibleDepartmentCodes: z.array(z.string().trim().min(1).max(16)).max(32).default([]),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict();

const decisionSchema = z
  .object({
    driveId: z.string().min(1).max(64),
    /**
     * The ROLL NUMBER, not an internal id. The officer types somebody they
     * have in mind; there is deliberately no list of "students above the
     * bar" to pick from, because a list beside a button that marks them
     * eligible is an automatic decision with a human's name on it.
     */
    collegeId: z.string().trim().min(1).max(32),
    decision: z.enum(DRIVE_ELIGIBILITY),
    reason: z
      .string()
      .trim()
      .min(DRIVE_REASON_MIN, `Say why, in at least ${DRIVE_REASON_MIN} characters. It is recorded against your name.`)
      .max(1000),
  })
  .strict();

export async function createDrive(input: unknown): Promise<ActionResult<{ driveId: string }>> {
  return runAction(async () => {
    const actor = await requirePlacementAction();
    const parsed = driveSchema.parse(input);

    const row = await db.placementDrive.create({
      data: {
        companyName: parsed.companyName,
        tier: parsed.tier,
        driveOn: campusDayDate(new Date(`${parsed.driveOn}T00:00:00.000Z`)),
        thresholdScore: parsed.thresholdScore ?? null,
        eligibleBatchYear: parsed.eligibleBatchYear ?? null,
        eligibleDepartmentCodes: parsed.eligibleDepartmentCodes,
        notes: parsed.notes?.length ? parsed.notes : null,
        createdById: actor.id,
      },
      select: { id: true },
    });

    await auditDrive(actor.id, "placement.drive_created", row.id, {
      tier: parsed.tier,
      thresholdScore: parsed.thresholdScore ?? null,
    });
    revalidatePath("/placement-cell/drives");
    return { driveId: row.id };
  }, "createDrive");
}

/**
 * Archive a drive.
 *
 * Archived, not deleted: the decisions recorded against it are the record of
 * what the drive was used for, and the database refuses the delete anyway
 * (`RESTRICT` on the decision's foreign key). Archiving is how a list stays
 * short without anything being lost.
 */
export async function archiveDrive(input: unknown): Promise<ActionResult<{ driveId: string }>> {
  return runAction(async () => {
    const actor = await requirePlacementAction();
    const parsed = z.object({ driveId: z.string().min(1).max(64) }).strict().parse(input);

    const existing = await db.placementDrive.findUnique({
      where: { id: parsed.driveId },
      select: { id: true, archivedAt: true },
    });
    if (!existing) throw new NotFoundError("That drive was not found.");
    if (existing.archivedAt) throw new ConflictError("That drive is already archived.");

    await db.placementDrive.update({ where: { id: existing.id }, data: { archivedAt: new Date() } });
    await auditDrive(actor.id, "placement.drive_archived", existing.id, {});
    revalidatePath("/placement-cell/drives");
    return { driveId: existing.id };
  }, "archiveDrive");
}

/**
 * Record one person's decision about one student and one drive.
 *
 * The decision and its audit row go in one transaction, in that order, and
 * the deferred trigger checks at commit. `readinessComputedOn` is stamped
 * from the student's newest snapshot, because the figures move nightly and
 * "they were under the bar" has to mean "under it on the day somebody
 * looked".
 */
export async function recordEligibility(input: unknown): Promise<ActionResult<{ decisionId: string }>> {
  return runAction(async () => {
    const actor = await requirePlacementAction();
    const parsed = decisionSchema.parse(input);

    const [drive, student] = await Promise.all([
      db.placementDrive.findUnique({ where: { id: parsed.driveId }, select: { id: true, archivedAt: true } }),
      db.user.findUnique({ where: { collegeId: parsed.collegeId }, select: { id: true, role: true } }),
    ]);

    if (!drive) throw new NotFoundError("That drive was not found.");
    if (drive.archivedAt) throw new ConflictError("That drive is archived. Decisions are recorded before it, not after.");
    // A roll number that is not a student's gives the same error as one that
    // does not exist, so the form cannot be used to enumerate staff accounts.
    if (!student || student.role !== "STUDENT") {
      throw new NotFoundError(`No student has the roll number ${parsed.collegeId}.`);
    }
    const userId = student.id;

    const [existing, snapshot] = await Promise.all([
      db.driveEligibilityDecision.findUnique({
        where: { driveId_userId: { driveId: parsed.driveId, userId } },
        select: { id: true },
      }),
      db.readinessSnapshot.findFirst({
        where: { userId },
        orderBy: { computedOn: "desc" },
        select: { computedOn: true },
      }),
    ]);

    if (existing) {
      // The unique index would refuse it anyway; this says the useful thing.
      throw new ConflictError(
        "A decision is already recorded for this student and this drive. A decision is never edited — if it has changed, that is a new drive-level decision with its own reason.",
      );
    }

    const decisionId = await db.$transaction(async (tx) => {
      const row = await tx.driveEligibilityDecision.create({
        data: {
          driveId: parsed.driveId,
          userId,
          decision: parsed.decision,
          reason: parsed.reason,
          decidedById: actor.id,
          readinessComputedOn: snapshot?.computedOn ?? null,
        },
        select: { id: true },
      });

      /**
       * In the SAME transaction, through the in-transaction helper. The
       * deferred constraint trigger checks at commit, so calling `audit()`
       * afterwards would make every decision fail to commit — which is the
       * correct failure and a confusing one, so the comment is here rather
       * than in a post-mortem.
       */
      await appendAuditEntriesInTx(tx, [
        {
          actorId: actor.id,
          action: "placement.eligibility_decided",
          entityType: "DriveEligibilityDecision",
          entityId: row.id,
          targetUserId: userId,
          sensitivity: "SENSITIVE",
          metadata: { driveId: parsed.driveId, decision: parsed.decision },
          ipHash: await requestIpHash(),
        },
      ]);
      return row.id;
    });

    revalidatePath(`/placement-cell/drives/${parsed.driveId}`);
    return { decisionId };
  }, "recordEligibility");
}

async function auditDrive(
  actorId: string,
  action: string,
  driveId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await audit({
    actorId,
    action,
    entityType: "PlacementDrive",
    entityId: driveId,
    sensitivity: "NORMAL",
    metadata: metadata as never,
    ipHash: await requestIpHash(),
  });
}
