import "server-only";
import type { Role } from "@recx/db";
import {
  WRITTEN_REFUSALS,
  canTransitionAnswer,
  canTransitionPrompt,
  mayEditAnswer,
  mayGrade,
  rubricScore,
  unmarkedCriteria,
} from "@recx/shared";
import { db } from "@/lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { slugify } from "@/lib/interviews/archive";
import {
  createPromptSchema,
  gradeAnswerSchema,
  handBackSchema,
  promptIdSchema,
  saveDraftSchema,
  submitAnswerSchema,
} from "@/lib/written/schema";

/**
 * Written and system-design answers: the writes (Phase 12i).
 *
 * Two shapes of permission, decided here rather than by the page. A
 * question belongs to the TA who wrote it (staff may retire one too,
 * because a TA who leaves must not take a published question with them);
 * an answer belongs to the student who wrote it, and any mentor may mark
 * one — the queue is shared on purpose, since a question answered by
 * ninety students is not one person's evening.
 *
 * The grade is a single transaction: the marks, the note and the weighted
 * total that was true at the time. The CHECK demands those together and
 * the product reason is the same — a student shown half a mark has been
 * told something nobody meant to say.
 */

export interface PromptId {
  id: string;
}

export interface AnswerId {
  id: string;
}

export interface Actor {
  id: string;
  role: Role;
}

const isStaff = (role: Role) => role === "ADMIN" || role === "SUPER_ADMIN";

// ── The question ────────────────────────────────────────────────────────

async function promptOrThrow(promptId: string) {
  const prompt = await db.writtenPrompt.findUnique({
    where: { id: promptId },
    select: { id: true, status: true, authorId: true, slug: true },
  });
  if (!prompt) throw new NotFoundError("That question was not found.");
  return prompt;
}

/** A slug nobody is using yet. Two TAs may well ask about rate limiting. */
async function freeSlug(title: string): Promise<string> {
  const base = slugify(title) || "question";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await db.writtenPrompt.findUnique({ where: { slug }, select: { id: true } });
    if (!taken) return slug;
  }
  throw new ValidationError("Too many questions share that title. Give this one a different one.");
}

export async function createPromptAs(authorId: string, input: unknown): Promise<PromptId> {
  const parsed = createPromptSchema.parse(input);
  const labels = parsed.criteria.map((c) => c.label.toLowerCase());
  if (new Set(labels).size !== labels.length) {
    throw new ValidationError("Two criteria with the same name cannot be marked apart.");
  }

  const created = await db.writtenPrompt.create({
    data: {
      slug: await freeSlug(parsed.title),
      kind: parsed.kind,
      title: parsed.title,
      promptMd: parsed.promptMd,
      timeBoxMinutes: parsed.timeBoxMinutes,
      authorId,
      criteria: {
        createMany: {
          data: parsed.criteria.map((criterion, order) => ({
            order,
            label: criterion.label,
            guidance: criterion.guidance ? criterion.guidance : null,
            weight: criterion.weight,
          })),
        },
      },
    },
    select: { id: true },
  });
  return created;
}

export async function publishPromptAs(actor: Actor, input: unknown, now = new Date()): Promise<PromptId> {
  const { promptId } = promptIdSchema.parse(input);
  const prompt = await promptOrThrow(promptId);
  if (prompt.authorId !== actor.id && !isStaff(actor.role)) throw new ForbiddenError("That question is not yours.");
  if (!canTransitionPrompt(prompt.status, "PUBLISHED")) {
    throw new ValidationError(
      prompt.status === "PUBLISHED" ? "That question is already open." : "A retired question cannot reopen.",
    );
  }
  const criteria = await db.writtenCriterion.count({ where: { promptId } });
  if (criteria < 2) throw new ValidationError(WRITTEN_REFUSALS.needsCriteria);

  await db.writtenPrompt.update({
    where: { id: promptId },
    data: { status: "PUBLISHED", publishedAt: now },
  });
  return { id: promptId };
}

/**
 * Retiring hides the question and keeps every answer. A question
 * withdrawn after fifty students answered it must not take their work
 * with it, which is why this is a status and not a delete.
 */
export async function retirePromptAs(actor: Actor, input: unknown, now = new Date()): Promise<PromptId> {
  const { promptId } = promptIdSchema.parse(input);
  const prompt = await promptOrThrow(promptId);
  if (prompt.authorId !== actor.id && !isStaff(actor.role)) throw new ForbiddenError("That question is not yours.");
  if (!canTransitionPrompt(prompt.status, "RETIRED")) throw new ValidationError("That question is already retired.");

  await db.writtenPrompt.update({ where: { id: promptId }, data: { status: "RETIRED", retiredAt: now } });
  return { id: promptId };
}

// ── The student's answer ────────────────────────────────────────────────

async function openPromptOrThrow(promptId: string) {
  const prompt = await db.writtenPrompt.findUnique({
    where: { id: promptId },
    select: { id: true, status: true },
  });
  if (!prompt) throw new NotFoundError("That question was not found.");
  if (prompt.status !== "PUBLISHED") throw new ValidationError(WRITTEN_REFUSALS.notPublished);
  return prompt;
}

/**
 * The draft, saved as they type.
 *
 * An upsert keyed on (prompt, author): there is one answer per student per
 * question, and a second attempt at a design question is a different
 * question rather than a retry.
 */
export async function saveDraftAs(userId: string, input: unknown): Promise<AnswerId> {
  const { promptId, bodyMd } = saveDraftSchema.parse(input);
  await openPromptOrThrow(promptId);

  const existing = await db.writtenAnswer.findUnique({
    where: { promptId_authorId: { promptId, authorId: userId } },
    select: { id: true, status: true },
  });
  if (existing && !mayEditAnswer(existing.status)) {
    throw new ValidationError(
      existing.status === "GRADED" ? WRITTEN_REFUSALS.alreadyGraded : WRITTEN_REFUSALS.alreadySubmitted,
    );
  }

  const saved = await db.writtenAnswer.upsert({
    where: { promptId_authorId: { promptId, authorId: userId } },
    create: { promptId, authorId: userId, bodyMd },
    update: { bodyMd },
    select: { id: true },
  });
  return saved;
}

export async function submitAnswerAs(userId: string, input: unknown, now = new Date()): Promise<AnswerId> {
  const { promptId, bodyMd } = submitAnswerSchema.parse(input);
  await openPromptOrThrow(promptId);

  const existing = await db.writtenAnswer.findUnique({
    where: { promptId_authorId: { promptId, authorId: userId } },
    select: { id: true, status: true },
  });
  if (existing && !canTransitionAnswer(existing.status, "SUBMITTED")) {
    throw new ValidationError(
      existing.status === "GRADED" ? WRITTEN_REFUSALS.alreadyGraded : WRITTEN_REFUSALS.alreadySubmitted,
    );
  }

  const saved = await db.writtenAnswer.upsert({
    where: { promptId_authorId: { promptId, authorId: userId } },
    create: { promptId, authorId: userId, bodyMd, status: "SUBMITTED", submittedAt: now },
    update: { bodyMd, status: "SUBMITTED", submittedAt: now },
    select: { id: true },
  });
  return saved;
}

// ── The grader ──────────────────────────────────────────────────────────

async function answerForGrading(answerId: string) {
  const answer = await db.writtenAnswer.findUnique({
    where: { id: answerId },
    select: {
      id: true,
      status: true,
      authorId: true,
      promptId: true,
      prompt: { select: { criteria: { orderBy: { order: "asc" }, select: { id: true, weight: true } } } },
    },
  });
  if (!answer) throw new NotFoundError("That answer was not found.");
  return answer;
}

export async function gradeAnswerAs(graderId: string, input: unknown, now = new Date()): Promise<AnswerId> {
  const { answerId, marks, overallMd } = gradeAnswerSchema.parse(input);
  const answer = await answerForGrading(answerId);
  if (answer.authorId === graderId) throw new ForbiddenError(WRITTEN_REFUSALS.ownAnswer);
  if (!mayGrade(answer.status)) {
    throw new ValidationError(
      answer.status === "GRADED" ? WRITTEN_REFUSALS.alreadyGraded : WRITTEN_REFUSALS.notSubmitted,
    );
  }

  /**
   * Every criterion of THIS question, in its own order — a mark for a
   * criterion of another question, or two marks for one criterion, is a
   * rubric that does not add up.
   */
  const criteria = answer.prompt.criteria;
  const byCriterion = new Map(marks.map((mark) => [mark.criterionId, mark]));
  if (byCriterion.size !== marks.length) throw new ValidationError("That criterion is marked twice.");
  const ordered = criteria.map((criterion) => byCriterion.get(criterion.id));
  if (unmarkedCriteria(criteria, ordered).length > 0) throw new ValidationError(WRITTEN_REFUSALS.rubricIncomplete);
  if (byCriterion.size !== criteria.length) throw new ValidationError(WRITTEN_REFUSALS.rubricIncomplete);

  const score = rubricScore(
    criteria,
    ordered.map((mark) => ({ points: mark?.points ?? 0 })),
  );

  await db.$transaction([
    db.writtenMark.deleteMany({ where: { answerId } }),
    db.writtenMark.createMany({
      data: criteria.map((criterion) => {
        const mark = byCriterion.get(criterion.id);
        return {
          answerId,
          criterionId: criterion.id,
          points: mark?.points ?? 0,
          note: mark?.note ? mark.note : null,
        };
      }),
    }),
    db.writtenAnswer.update({
      where: { id: answerId },
      data: {
        status: "GRADED",
        graderId,
        gradedAt: now,
        overallMd,
        points: score.points,
        outOf: score.outOf,
      },
    }),
  ]);
  return { id: answerId };
}

/**
 * Handed back unmarked, with a sentence saying what is missing.
 *
 * A mark of 4 of 16 tells a student they did badly; "you have described
 * the API and not the storage" tells them what to do next, and leaves the
 * answer in their drafts to do it in.
 */
export async function handBackAs(graderId: string, input: unknown, now = new Date()): Promise<AnswerId> {
  const { answerId, note } = handBackSchema.parse(input);
  const answer = await answerForGrading(answerId);
  if (answer.authorId === graderId) throw new ForbiddenError(WRITTEN_REFUSALS.ownAnswer);
  if (!canTransitionAnswer(answer.status, "DRAFT")) {
    throw new ValidationError(
      answer.status === "GRADED" ? WRITTEN_REFUSALS.alreadyGraded : WRITTEN_REFUSALS.notSubmitted,
    );
  }

  await db.writtenAnswer.update({
    where: { id: answerId },
    data: { status: "DRAFT", submittedAt: null, handedBackAt: now, handBackNote: note },
  });
  return { id: answerId };
}
