"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  APTITUDE_AREAS,
  APTITUDE_TOPICS,
  EXPLANATION_MIN_CHARS,
  aptitudeDisplayCode,
  aptitudePassageSchema,
  aptitudeQuestionSchema,
  normaliseQuestionForHash,
  wordCountOf,
} from "@recx/shared";
import { requireActionRole } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";

/**
 * Authoring the aptitude bank (Phase 7d).
 *
 * Every export opens with `requireActionRole("ADMIN", "SUPER_ADMIN")` —
 * `docs/CONVENTIONS.md` golden rule 2: the layout's own guard is not RBAC.
 *
 * PUBLISHING is bound to the SUPER_ADMIN `problems.lifecycle` capability
 * rather than to plain ADMIN, because publishing is the act that makes a
 * cohort scorable on a question, and that is the class of act Phase 4 already
 * put behind SUPER_ADMIN. Retiring is an ADMIN act: it only ever stops a
 * question being served, and an urgent "this question is wrong" must not wait
 * for a super-admin.
 *
 * `audit()` on every write. A question's wording is what a student disputes,
 * and "who changed this and when" has to be answerable.
 */

const id = z.string().min(1).max(64);

const questionInput = z
  .object({
    kind: z.enum(["SINGLE_CHOICE", "MULTI_CHOICE", "NUMERIC_ENTRY", "PASSAGE_GROUPED"]),
    area: z.enum(APTITUDE_AREAS),
    topic: z.enum(APTITUDE_TOPICS),
    difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
    stem: z.string(),
    options: z.array(z.string()).default([]),
    correctOptionIndexes: z.array(z.number().int()).default([]),
    numericAnswer: z.number().nullable().default(null),
    numericTolerance: z.number().nullable().default(null),
    numericUnit: z.string().nullable().default(null),
    explanation: z.string().default(""),
    expectedSeconds: z.number().int(),
    origin: z.enum(["FACULTY", "SENIOR_STUDENT", "AI_ASSISTED"]),
    sourceBatch: z.string().nullable().default(null),
    passageId: z.string().nullable().default(null),
  })
  .passthrough();

/**
 * The sequence, so two authors cannot be handed the same code.
 *
 * `$queryRaw` with a tagged template and NO interpolation, not
 * `$queryRawUnsafe`: `tests/repo/admin-scope.test.ts` R3 forbids the unsafe
 * form in admin code, because raw SQL assembled from strings is raw SQL a
 * scope check cannot see into. There is nothing to interpolate here anyway.
 */
async function nextDisplayCode(tx: Pick<typeof db, "$queryRaw">): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ next: bigint }>>`
    SELECT nextval('public.aptitude_display_code_seq') AS next
  `;
  return aptitudeDisplayCode(Number(rows[0]!.next));
}

export async function createAptitudeQuestion(input: unknown): Promise<ActionResult<{ id: string; displayCode: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    // The SAME schema the CSV importer finishes with. One shape definition,
    // so a question an author can save is a question an import can create.
    const parsed = aptitudeQuestionSchema.parse(questionInput.parse(input));

    const created = await db.$transaction(async (tx) => {
      const displayCode = await nextDisplayCode(tx);
      return tx.aptitudeQuestion.create({
        data: {
          ...parsed,
          displayCode,
          authorId: actor.id,
          contentHash: createHash("sha256").update(normaliseQuestionForHash(parsed)).digest("hex"),
        },
        select: { id: true, displayCode: true },
      });
    });

    await audit({
      actorId: actor.id,
      action: "aptitude.question.created",
      entityType: "AptitudeQuestion",
      entityId: created.id,
      metadata: { displayCode: created.displayCode, topic: parsed.topic, kind: parsed.kind },
    });
    revalidatePath("/admin/aptitude");
    return created;
  }, "createAptitudeQuestion");
}

export async function updateAptitudeQuestion(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const { questionId, ...rest } = z.object({ questionId: id }).passthrough().parse(input);
    const parsed = aptitudeQuestionSchema.parse(questionInput.parse(rest));

    const current = await db.aptitudeQuestion.findUnique({
      where: { id: questionId },
      select: { id: true, status: true, displayCode: true },
    });
    if (!current) throw new NotFoundError("That question was not found.");

    /**
     * A published question's key is frozen and its EXPLANATION is not.
     * `recx_refuse_published_question_change` would refuse the write anyway;
     * refusing it here gives an author a sentence instead of a 500, and says
     * what they can do instead.
     */
    if (current.status === "PUBLISHED" || current.status === "RETIRED") {
      throw new ValidationError(
        `${current.displayCode} is ${current.status.toLowerCase()} — students have already been scored on it, so its wording, options and answer are frozen. You can still improve its worked explanation, or retire it and add a new question.`,
      );
    }

    await db.aptitudeQuestion.update({
      where: { id: questionId },
      data: {
        ...parsed,
        contentHash: createHash("sha256").update(normaliseQuestionForHash(parsed)).digest("hex"),
      },
    });
    await audit({
      actorId: actor.id,
      action: "aptitude.question.updated",
      entityType: "AptitudeQuestion",
      entityId: questionId,
      metadata: { displayCode: current.displayCode, topic: parsed.topic },
    });
    revalidatePath("/admin/aptitude");
    revalidatePath(`/admin/aptitude/${questionId}`);
    return { id: questionId };
  }, "updateAptitudeQuestion");
}

const explanationSchema = z
  .object({ questionId: id, explanation: z.string().trim().min(EXPLANATION_MIN_CHARS).max(8_000) })
  .strict();

/**
 * Improving the worked explanation — allowed at any status, including
 * PUBLISHED.
 *
 * Decision 17's other half: students have already been scored on the
 * question, so rewriting its key silently rescores the past, while improving
 * the wording of the worked solution harms nobody and helps everybody who
 * gets it wrong next.
 */
export async function reviseAptitudeExplanation(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = explanationSchema.parse(input);
    const current = await db.aptitudeQuestion.findUnique({
      where: { id: parsed.questionId },
      select: { id: true, displayCode: true, status: true },
    });
    if (!current) throw new NotFoundError("That question was not found.");

    await db.aptitudeQuestion.update({
      where: { id: current.id },
      data: { explanation: parsed.explanation },
    });
    await audit({
      actorId: actor.id,
      action: "aptitude.question.explanation_revised",
      entityType: "AptitudeQuestion",
      entityId: current.id,
      metadata: { displayCode: current.displayCode, status: current.status, chars: parsed.explanation.length },
    });
    revalidatePath(`/admin/aptitude/${current.id}`);
    return { id: current.id };
  }, "reviseAptitudeExplanation");
}

const reviewSchema = z.object({ questionId: id }).strict();

export async function submitAptitudeQuestionForReview(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = reviewSchema.parse(input);
    const current = await db.aptitudeQuestion.findUnique({
      where: { id: parsed.questionId },
      select: { id: true, status: true, displayCode: true },
    });
    if (!current) throw new NotFoundError("That question was not found.");
    if (current.status !== "DRAFT") throw new ValidationError("Only a draft can be sent for review.");

    await db.aptitudeQuestion.update({ where: { id: current.id }, data: { status: "IN_REVIEW" } });
    await audit({
      actorId: actor.id,
      action: "aptitude.question.submitted_for_review",
      entityType: "AptitudeQuestion",
      entityId: current.id,
      metadata: { displayCode: current.displayCode },
    });
    revalidatePath("/admin/aptitude");
    return { id: current.id };
  }, "submitAptitudeQuestionForReview");
}

const retireSchema = z
  .object({
    questionId: id,
    reason: z
      .string()
      .trim()
      .min(10, "Say why in a sentence — this is recorded, and a student may ask to see it.")
      .max(500),
  })
  .strict();

/**
 * Retiring — ADMIN, not SUPER_ADMIN.
 *
 * It only ever stops a question being served, and "this question is wrong"
 * must not wait for a super-admin. A retired question is never deleted:
 * answer rows reference it, and past percentiles must stay honest.
 */
export async function retireAptitudeQuestion(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = retireSchema.parse(input);
    const current = await db.aptitudeQuestion.findUnique({
      where: { id: parsed.questionId },
      select: { id: true, status: true, displayCode: true },
    });
    if (!current) throw new NotFoundError("That question was not found.");
    if (current.status === "RETIRED") throw new ConflictError("That question is already retired.");

    await db.aptitudeQuestion.update({
      where: { id: current.id },
      data: { status: "RETIRED", retiredAt: new Date() },
    });
    await audit({
      actorId: actor.id,
      action: "aptitude.question.retired",
      entityType: "AptitudeQuestion",
      entityId: current.id,
      metadata: {
        displayCode: current.displayCode,
        reason: parsed.reason,
        note: "Retiring stops it being served. It is never deleted: answer rows reference it and past results must stay honest.",
      },
    });
    revalidatePath("/admin/aptitude");
    revalidatePath(`/admin/aptitude/${current.id}`);
    return { id: current.id };
  }, "retireAptitudeQuestion");
}

const passageSchema = aptitudePassageSchema.extend({ passageId: id.optional() });

export async function saveAptitudePassage(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    const parsed = passageSchema.parse(input);
    const { passageId, ...fields } = parsed;

    if (passageId) {
      const current = await db.aptitudePassage.findUnique({
        where: { id: passageId },
        select: { id: true, status: true },
      });
      if (!current) throw new NotFoundError("That passage was not found.");
      await db.aptitudePassage.update({
        where: { id: passageId },
        data: { ...fields, wordCount: wordCountOf(fields.body) },
      });
      await audit({
        actorId: actor.id,
        action: "aptitude.passage.updated",
        entityType: "AptitudePassage",
        entityId: passageId,
        metadata: { title: fields.title },
      });
      return { id: passageId };
    }

    const created = await db.aptitudePassage.create({
      data: { ...fields, wordCount: wordCountOf(fields.body), authorId: actor.id },
      select: { id: true },
    });
    await audit({
      actorId: actor.id,
      action: "aptitude.passage.created",
      entityType: "AptitudePassage",
      entityId: created.id,
      metadata: { title: fields.title, words: wordCountOf(fields.body) },
    });
    return created;
  }, "saveAptitudePassage");
}
