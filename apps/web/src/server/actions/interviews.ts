"use server";

import { revalidatePath } from "next/cache";
import { requireActionUser } from "@/lib/auth/guards";
import { submitExperienceFor, withdrawExperienceFor, type ExperienceId } from "@/lib/interviews/archive";
import type { SubmitExperienceInput, WithdrawExperienceInput } from "@/lib/interviews/schema";
import { runAction, type ActionResult } from "@/lib/errors";

/**
 * The student half of the interview archive (Phase 12e). Signed-in users
 * only, always acting on their own rows: submitting their own account of
 * their own interview, and withdrawing it while nobody has read it.
 *
 * Not audited. Like a hint reveal or a discussion post, this is the
 * student's own activity and the row with its timestamp is the record.
 * The DECISION is audited, in the moderation module.
 */

export async function submitInterviewExperience(input: SubmitExperienceInput): Promise<ActionResult<ExperienceId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const experience = await submitExperienceFor(user.id, input);
    revalidatePath("/interviews");
    return experience;
  }, "submitInterviewExperience");
}

export async function withdrawInterviewExperience(input: WithdrawExperienceInput): Promise<ActionResult<ExperienceId>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const experience = await withdrawExperienceFor(user.id, input);
    revalidatePath("/interviews");
    return experience;
  }, "withdrawInterviewExperience");
}
