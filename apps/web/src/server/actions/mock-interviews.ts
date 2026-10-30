"use server";

import { revalidatePath } from "next/cache";
import { requireActionUser, requireMentorAction } from "@/lib/auth/guards";
import { runAction, type ActionResult } from "@/lib/errors";
import {
  bookSlotAs,
  cancelSlotAs,
  finishInterviewAs,
  giveUpSlotAs,
  markNoShowAs,
  offerSlotAs,
  startInterviewAs,
  type InterviewId,
} from "@/lib/mock/interviews";
import type {
  CancelSlotInput,
  FinishInterviewInput,
  OfferSlotInput,
  SlotIdInput,
  StartInterviewInput,
} from "@/lib/mock/schema";

/**
 * Mock interviews (Phase 12h).
 *
 * Two guards, because there are two halves. Offering, starting, finishing
 * and marking a no-show are a mentor's and use `requireMentorAction`;
 * booking, giving a slot back and calling one off are the candidate's and
 * use `requireActionUser` — the per-slot ownership check inside each body
 * is what actually decides, since a mentor is also a signed-in user and a
 * role alone cannot tell whose slot this is.
 *
 * Not audited. A mock interview is a conversation between two people who
 * both see every change to it; the row, with its timestamps and the
 * cancellation reason the other person is shown, is the record.
 */

const STUDENT = "/mock-interviews";
const MENTOR = "/mentor/mock-interviews";

export async function offerMockSlot(input: OfferSlotInput): Promise<ActionResult<InterviewId>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const slot = await offerSlotAs(actor.id, input);
    revalidatePath(MENTOR);
    revalidatePath(STUDENT);
    return slot;
  }, "offerMockSlot");
}

export async function startMockInterview(input: StartInterviewInput): Promise<ActionResult<InterviewId>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const slot = await startInterviewAs(actor.id, input);
    revalidatePath(MENTOR);
    return slot;
  }, "startMockInterview");
}

export async function finishMockInterview(input: FinishInterviewInput): Promise<ActionResult<InterviewId>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const slot = await finishInterviewAs(actor.id, input);
    revalidatePath(MENTOR);
    revalidatePath(STUDENT);
    return slot;
  }, "finishMockInterview");
}

export async function markMockNoShow(input: SlotIdInput): Promise<ActionResult<InterviewId>> {
  return runAction(async () => {
    const actor = await requireMentorAction();
    const slot = await markNoShowAs(actor.id, input);
    revalidatePath(MENTOR);
    return slot;
  }, "markMockNoShow");
}

export async function bookMockSlot(input: SlotIdInput): Promise<ActionResult<InterviewId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const slot = await bookSlotAs(user.id, input);
    revalidatePath(STUDENT);
    revalidatePath(MENTOR);
    return slot;
  }, "bookMockSlot");
}

export async function giveUpMockSlot(input: SlotIdInput): Promise<ActionResult<InterviewId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const slot = await giveUpSlotAs(user.id, input);
    revalidatePath(STUDENT);
    revalidatePath(MENTOR);
    return slot;
  }, "giveUpMockSlot");
}

export async function cancelMockInterview(input: CancelSlotInput): Promise<ActionResult<InterviewId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const slot = await cancelSlotAs(user, input);
    revalidatePath(STUDENT);
    revalidatePath(MENTOR);
    return slot;
  }, "cancelMockInterview");
}
