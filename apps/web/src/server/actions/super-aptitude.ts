"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { aptitudePublishSchema } from "@recx/shared";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";

/**
 * Publishing an aptitude question (Phase 7d) — the one act in the slice that
 * is SUPER_ADMIN's.
 *
 * In its own `super-` module for the reason Phase 6e split
 * `super-integrity.ts` out: the filename prefix is what carries the
 * sensitive-path rule and what makes the role obvious at a glance, and a
 * super-only export sitting among staff ones is a role nobody notices.
 *
 * It is bound to the existing `problems.lifecycle` capability rather than a
 * new one, because publishing is the act that makes a cohort scorable on a
 * question — exactly the class of act Phase 4 put behind SUPER_ADMIN.
 */

const schema = z.object({ questionId: z.string().min(1).max(64) }).strict();

/**
 * Publishing — the act that makes a cohort scorable on this question.
 *
 * SUPER_ADMIN only, through the `problems.lifecycle` capability, which is
 * where Phase 4 put this class of act. And the second reviewer is a real
 * requirement rather than a courtesy: the author cannot publish their own
 * question, because a worked explanation nobody else has read is a worked
 * explanation nobody has checked.
 */
export async function publishAptitudeQuestion(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = schema.parse(input);
    const current = await db.aptitudeQuestion.findUnique({
      where: { id: parsed.questionId },
      select: {
        id: true,
        status: true,
        displayCode: true,
        authorId: true,
        kind: true,
        area: true,
        topic: true,
        difficulty: true,
        stem: true,
        options: true,
        correctOptionIndexes: true,
        numericAnswer: true,
        numericTolerance: true,
        numericUnit: true,
        explanation: true,
        expectedSeconds: true,
        origin: true,
        sourceBatch: true,
        passageId: true,
      },
    });
    if (!current) throw new NotFoundError("That question was not found.");
    if (current.status === "PUBLISHED") throw new ValidationError("That question is already published.");
    if (current.status === "RETIRED") {
      throw new ValidationError("A retired question is never re-published. Add a new question instead.");
    }
    if (current.authorId !== null && current.authorId === actor.id) {
      throw new ValidationError(
        "A question needs a second pair of eyes before it can be published. A worked explanation nobody else has read is a worked explanation nobody has checked.",
      );
    }

    // The publish schema, which is where the worked explanation becomes
    // mandatory. The CHECK says the same thing; this says it in a sentence.
    const ready = aptitudePublishSchema.safeParse({
      kind: current.kind,
      area: current.area,
      topic: current.topic,
      difficulty: current.difficulty,
      stem: current.stem,
      options: current.options,
      correctOptionIndexes: current.correctOptionIndexes,
      numericAnswer: current.numericAnswer === null ? null : Number(current.numericAnswer),
      numericTolerance: current.numericTolerance === null ? null : Number(current.numericTolerance),
      numericUnit: current.numericUnit,
      explanation: current.explanation,
      expectedSeconds: current.expectedSeconds,
      origin: current.origin,
      sourceBatch: current.sourceBatch,
      passageId: current.passageId,
    });
    if (!ready.success) {
      throw new ValidationError(ready.error.issues.map((issue) => issue.message).join(" "));
    }

    /**
     * A passage needs at least two questions, held here because the rule is
     * about a GROUP and no single row's CHECK can see one (SPEC §5: "one
     * shared passage, N questions").
     */
    if (current.passageId !== null) {
      const siblings = await db.aptitudeQuestion.count({ where: { passageId: current.passageId } });
      if (siblings < 2) {
        throw new ValidationError(
          "This passage has only one question. A passage with one question is a stem with extra steps — add another question to the passage, or make this a single-choice question.",
        );
      }
    }

    await db.aptitudeQuestion.update({
      where: { id: current.id },
      data: { status: "PUBLISHED", publishedAt: new Date(), reviewedById: actor.id },
    });
    await audit({
      actorId: actor.id,
      action: "aptitude.question.published",
      entityType: "AptitudeQuestion",
      entityId: current.id,
      sensitivity: "SENSITIVE",
      metadata: {
        displayCode: current.displayCode,
        topic: current.topic,
        authorId: current.authorId,
        note: "From this moment a cohort can be scored on this question, and its wording, options and answer are frozen.",
      },
    });
    revalidatePath("/admin/aptitude");
    revalidatePath(`/admin/aptitude/${current.id}`);
    return { id: current.id };
  }, "publishAptitudeQuestion");
}
