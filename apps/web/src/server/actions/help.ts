"use server";

import { requireActionUser } from "@/lib/auth/guards";
import { runAction, type ActionResult } from "@/lib/errors";
import { WORKSPACE_HELP_CONTEXT } from "@/lib/help/access";
import { revealHintFor, viewEditorialFor, type RevealedEditorial, type RevealedHint } from "@/lib/help/reveal";
import type { RevealHintInput, ViewEditorialInput } from "@/lib/help/schema";

/**
 * The workspace's "Reveal hint N" and "View editorial" buttons. Signed-in
 * users only; the input is zod-parsed (strict: no client-chosen context) and
 * the help chokepoint is consulted again on every call, so a forged request
 * can never reveal more than the panel would have offered.
 */

export async function revealHint(input: RevealHintInput): Promise<ActionResult<RevealedHint>> {
  return runAction(async () => {
    const user = await requireActionUser();
    return revealHintFor(user.id, input, WORKSPACE_HELP_CONTEXT);
  }, "revealHint");
}

export async function viewEditorial(input: ViewEditorialInput): Promise<ActionResult<RevealedEditorial>> {
  return runAction(async () => {
    const user = await requireActionUser();
    return viewEditorialFor(user.id, input, WORKSPACE_HELP_CONTEXT);
  }, "viewEditorial");
}
