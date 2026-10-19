"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireActionUser } from "@/lib/auth/guards";
import { runAction, type ActionResult } from "@/lib/errors";
import { advanceSection, saveAnswer, serveIndex } from "@/lib/aptitude/sitting";
import { finaliseMock } from "@recx/db/mock";
import { db } from "@/lib/db";
import { answerPracticeQuestion, recordPracticeServed } from "@/lib/aptitude/practice";
import { startOrResumeMock } from "@/lib/aptitude/start";

/**
 * A candidate's own actions during aptitude practice and a mock (Phase 7c).
 *
 * Every one of them guards again with `requireActionUser()` and scopes by
 * `userId` in a `where` clause — the `(student)` layout calling `requireUser()`
 * is not RBAC on its own (`docs/CONVENTIONS.md` golden rule 2), and a sitting
 * id in a request is not authorisation.
 *
 * None of these audits. A practice answer is not a sensitive mutation and an
 * audit row per answer would bury the governance trail under 3.6M rows a
 * year. `finaliseMock` writes a ledger row, and the ledger is itself the
 * record.
 *
 * And none of them can penalise anything: Phase 7 writes no ProctorEvent,
 * reads no IntegrityFlag and touches nothing in `lib/flags.ts`. The only
 * automatic actions in the phase are closing a section at its own deadline
 * and finalising at the paper's — both deadlines, not penalties.
 */

const attemptId = z.string().min(1).max(64);
const questionId = z.string().min(1).max(64);
const millis = z.number().int().min(0).max(24 * 3_600_000);

const startSchema = z.object({ slug: z.string().trim().min(3).max(60) }).strict();

export async function startMock(input: unknown): Promise<ActionResult<{ attemptId: string; resumed: boolean }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const { slug } = startSchema.parse(input);
    const started = await startOrResumeMock({ userId: user.id, slug, now: new Date() });
    revalidatePath(`/aptitude/mock/${slug}`);
    return started;
  }, "startMock");
}

const serveSchema = z.object({ attemptId, index: z.number().int().min(0).max(199) }).strict();

export async function serveMockQuestion(input: unknown): Promise<ActionResult<{ highWaterIndex: number }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = serveSchema.parse(input);
    return serveIndex({ ...parsed, userId: user.id });
  }, "serveMockQuestion");
}

const answerSchema = z
  .object({
    attemptId,
    questionId,
    /** The indexes as SHOWN; the server maps them back through the layout. */
    shownIndexes: z.array(z.number().int().min(0).max(7)).max(8).default([]),
    numericValue: z.number().finite().nullable().default(null),
    markedForReview: z.boolean().default(false),
    seenAtMs: millis,
    answeredAtMs: millis.nullable().default(null),
  })
  .strict();

export async function saveMockAnswer(input: unknown): Promise<ActionResult<{ saved: true; index: number }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = answerSchema.parse(input);
    return saveAnswer({ ...parsed, userId: user.id }, new Date());
  }, "saveMockAnswer");
}

const advanceSchema = z.object({ attemptId }).strict();

export async function advanceMockSection(
  input: unknown,
): Promise<ActionResult<{ position: number; finished: boolean }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = advanceSchema.parse(input);
    const moved = await advanceSection({ attemptId: parsed.attemptId, userId: user.id, now: new Date() });
    revalidatePath(`/aptitude/mock/attempt/${parsed.attemptId}`);
    return moved;
  }, "advanceMockSection");
}

export async function finaliseMockAttempt(input: unknown): Promise<ActionResult<{ attemptId: string; percent: number }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = advanceSchema.parse(input);
    const result = await finaliseMock(db, {
      attemptId: parsed.attemptId,
      userId: user.id,
      at: new Date(),
      auto: false,
    });
    if (!result) throw new Error("That sitting was not found.");
    revalidatePath(`/aptitude/mock/attempt/${parsed.attemptId}/review`);
    return { attemptId: result.attemptId, percent: result.percent };
  }, "finaliseMockAttempt");
}

const practiceSchema = z
  .object({
    questionId,
    selectedIndexes: z.array(z.number().int().min(0).max(7)).max(8).default([]),
    numericValue: z.number().finite().nullable().default(null),
    seenAtMs: millis,
    answeredAtMs: millis,
  })
  .strict();

export async function answerPractice(input: unknown): Promise<ActionResult<Awaited<ReturnType<typeof answerPracticeQuestion>>>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = practiceSchema.parse(input);
    return answerPracticeQuestion({ ...parsed, userId: user.id, at: new Date() });
  }, "answerPractice");
}

const servedSchema = z.object({ questionId }).strict();

export async function recordPracticeQuestionServed(input: unknown): Promise<ActionResult<{ recorded: true }>> {
  return runAction(async () => {
    await requireActionUser();
    const parsed = servedSchema.parse(input);
    await recordPracticeServed(parsed.questionId, new Date());
    return { recorded: true as const };
  }, "recordPracticeQuestionServed");
}
