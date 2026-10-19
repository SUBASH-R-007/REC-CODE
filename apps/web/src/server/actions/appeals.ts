"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireActionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";

/**
 * A student's own appeal (Phase 6e).
 *
 * In its own module, away from the reviewers' actions, for two reasons. The
 * honest one: a student action and a staff action in one file is a smell.
 * The concrete one: `tests/repo/admin-scope.test.ts` treats any file that
 * calls a guard and mentions ADMIN as admin code, and then requires every
 * student query in it to be shaped with `scopedStudentWhere`. That is the
 * wrong tool here — this action is scoped by `userId: user.id`, which is
 * STRONGER than a department grant, and splitting the file makes that
 * visible instead of burying it in an exemption.
 *
 * SPEC §5 gives an appeal 7 days and two deciders. The student's words are
 * stored as written and never summarised: they are the appeal.
 */

const APPEAL_DAYS = 7;

const appealSchema = z
  .object({
    flagId: z.string().min(1).max(64),
    reason: z
      .string()
      .trim()
      .min(20, "Tell us in your own words why you think this is wrong.")
      .max(4_000),
  })
  .strict();

export async function submitAppeal(input: unknown): Promise<ActionResult<{ decideBy: Date }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = appealSchema.parse(input);

    const flag = await db.integrityFlag.findFirst({
      // Their OWN sitting. Not a department grant — the student themself.
      where: { id: parsed.flagId, attempt: { userId: user.id } },
      select: { id: true, status: true, appeals: { select: { id: true } }, attempt: { select: { id: true } } },
    });
    if (!flag) throw new NotFoundError("That decision was not found.");
    if (flag.status !== "UPHELD") {
      throw new ValidationError(
        "There is nothing to appeal: this result is not being withheld. If it still shows as under review, the deadline will publish it automatically.",
      );
    }
    if (flag.appeals.length > 0) throw new ValidationError("You have already appealed this decision.");

    const submittedAt = new Date();
    const decideBy = new Date(submittedAt.getTime() + APPEAL_DAYS * 24 * 3_600_000);
    await db.integrityAppeal.create({
      data: { flagId: flag.id, studentId: user.id, reason: parsed.reason, submittedAt, decideBy },
    });

    await audit({
      actorId: user.id,
      action: "integrity.appeal.submitted",
      entityType: "IntegrityFlag",
      entityId: flag.id,
      targetUserId: user.id,
      sensitivity: "SENSITIVE",
      metadata: {
        attemptId: flag.attempt.id,
        decideBy: decideBy.toISOString(),
        note:
          "Two people who did not review the flag decide it. Undecided by the deadline resolves in the student's favour.",
      },
    });
    revalidatePath("/assessments");
    return { decideBy };
  }, "submitAppeal");
}
