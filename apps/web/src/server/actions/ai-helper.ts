"use server";

import { askAiHelperFor, type AiAnswer } from "@/lib/ai/ask";
import type { AskAiInput } from "@/lib/ai/schema";
import { requireActionUser } from "@/lib/auth/guards";
import { runAction, type ActionResult } from "@/lib/errors";
import { WORKSPACE_HELP_CONTEXT } from "@/lib/help/access";

/**
 * The practice workspace's "Ask the assistant" button. Signed-in users only;
 * the input is zod-parsed (strict: no client-chosen context, and the code
 * comes from the draft the server already holds), and the help chokepoint is
 * consulted again on every call — so a forged request from a contest or an
 * exam tab gets exactly what the panel would have offered there, which is
 * nothing.
 */
export async function askAiHelper(input: AskAiInput): Promise<ActionResult<AiAnswer>> {
  return runAction(async () => {
    const user = await requireActionUser();
    return askAiHelperFor(user.id, input, WORKSPACE_HELP_CONTEXT);
  }, "askAiHelper");
}
