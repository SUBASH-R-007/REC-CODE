"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { audit } from "@/lib/audit";

/**
 * Overturning an integrity decision (Phase 6e, super-admin only).
 *
 * The last door. A flag is normally decided by its reviewers and, if the
 * student appeals, by two more; this is for the case where that process
 * itself went wrong — a reviewer who misread a timeline, a threshold that
 * turned out to be miscalibrated, a cohort flagged by a bug.
 *
 * It only ever moves in one direction: a decision can be OVERTURNED, never
 * upheld-harder. SPEC §0 caps the automatic consequence at a flag and a
 * withheld leaderboard place, and nothing in this file may exceed what the
 * reviewers could already do — so there is no "uphold" here at all, and no
 * score is touched (`tests/repo/integrity-isolation.test.ts` keeps it that
 * way).
 *
 * It takes a written reason of real length, audited at SECURITY, because
 * reaching past two reviewers and an appeal panel is exactly the action that
 * has to be answerable afterwards.
 */

const schema = z
  .object({
    flagId: z.string().min(1).max(64),
    reason: z
      .string()
      .trim()
      .min(40, "Say why in a sentence or two — this reaches past the reviewers and is recorded.")
      .max(2_000),
  })
  .strict();

export async function overturnIntegrityDecision(input: unknown): Promise<ActionResult<{ overturned: true }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = schema.parse(input);

    const flag = await db.integrityFlag.findUnique({
      where: { id: parsed.flagId },
      select: { id: true, status: true, band: true, attempt: { select: { id: true, userId: true } } },
    });
    if (!flag) throw new NotFoundError("That flag was not found.");

    // Only an UPHELD decision is a decision to overturn. A cleared flag is
    // already in the student's favour, and the database agrees: OVERTURNED is
    // reachable only from UPHELD.
    if (flag.status !== "UPHELD") {
      throw new ValidationError(
        flag.status === "OPEN"
          ? "That flag has not been decided yet. Review it rather than overturning it."
          : "That flag is not upheld, so there is nothing to overturn.",
      );
    }

    const moved = await db.integrityFlag.updateMany({
      where: { id: flag.id, status: "UPHELD" },
      data: { status: "OVERTURNED", withheld: false, resolvedAt: new Date() },
    });
    if (moved.count !== 1) throw new ValidationError("That flag changed while you were deciding. Reload and look again.");

    await audit({
      actorId: actor.id,
      action: "integrity.decision.overturned",
      entityType: "IntegrityFlag",
      entityId: flag.id,
      targetUserId: flag.attempt.userId,
      sensitivity: "SECURITY",
      metadata: {
        attemptId: flag.attempt.id,
        band: flag.band,
        reason: parsed.reason,
        note: "Overturned by a super-admin, reaching past the reviewers and any appeal.",
      },
    });

    revalidatePath("/super/integrity");
    revalidatePath("/admin/integrity");
    return { overturned: true as const };
  }, "overturnIntegrityDecision");
}
