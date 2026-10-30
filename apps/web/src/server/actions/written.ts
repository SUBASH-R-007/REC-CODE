"use server";

import { revalidatePath } from "next/cache";
import { requireActionUser, requireMentorAction } from "@/lib/auth/guards";
import { runAction, type ActionResult } from "@/lib/errors";
import {
  createPromptAs,
  gradeAnswerAs,
  handBackAs,
  publishPromptAs,
  retirePromptAs,
  saveDraftAs,
  submitAnswerAs,
  type AnswerId,
  type PromptId,
} from "@/lib/written/answers";
import type {
  CreatePromptInput,
  GradeAnswerInput,
  HandBackInput,
  PromptIdInput,
  SaveDraftInput,
  SubmitAnswerInput,
} from "@/lib/written/schema";

/**
 * Written and system-design answers (Phase 12i).
 *
 * Two guards. Writing, publishing, retiring, marking and handing back are
 * a TA's and use `requireMentorAction`; drafting and handing in are the
 * student's and use `requireActionUser`. As everywhere else, the role is
 * the outer gate and the per-row ownership check inside each library
 * function is what actually decides — a mentor is also a signed-in user,
 * and a role cannot tell whose answer this is.
 *
 * Not audited. A question and a mark are both shown, in full, to the
 * person they are about; the row, with its grader and its timestamp, is
 * the record.
 */

const STUDENT = "/written";
const MENTOR = "/mentor/written";

export async function createWrittenPrompt(input: CreatePromptInput): Promise<ActionResult<PromptId>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const prompt = await createPromptAs(actor.id, input);
    revalidatePath(MENTOR);
    return prompt;
  }, "createWrittenPrompt");
}

export async function publishWrittenPrompt(input: PromptIdInput): Promise<ActionResult<PromptId>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const prompt = await publishPromptAs(actor, input);
    revalidatePath(MENTOR);
    revalidatePath(STUDENT);
    return prompt;
  }, "publishWrittenPrompt");
}

export async function retireWrittenPrompt(input: PromptIdInput): Promise<ActionResult<PromptId>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const prompt = await retirePromptAs(actor, input);
    revalidatePath(MENTOR);
    revalidatePath(STUDENT);
    return prompt;
  }, "retireWrittenPrompt");
}

export async function gradeWrittenAnswer(input: GradeAnswerInput): Promise<ActionResult<AnswerId>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const answer = await gradeAnswerAs(actor.id, input);
    revalidatePath(MENTOR);
    revalidatePath(STUDENT);
    return answer;
  }, "gradeWrittenAnswer");
}

export async function handBackWrittenAnswer(input: HandBackInput): Promise<ActionResult<AnswerId>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const answer = await handBackAs(actor.id, input);
    revalidatePath(MENTOR);
    revalidatePath(STUDENT);
    return answer;
  }, "handBackWrittenAnswer");
}

export async function saveWrittenDraft(input: SaveDraftInput): Promise<ActionResult<AnswerId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    return saveDraftAs(user.id, input);
  }, "saveWrittenDraft");
}

export async function submitWrittenAnswer(input: SubmitAnswerInput): Promise<ActionResult<AnswerId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const answer = await submitAnswerAs(user.id, input);
    revalidatePath(STUDENT);
    revalidatePath(MENTOR);
    return answer;
  }, "submitWrittenAnswer");
}
