"use server";

import { requireActionUser } from "@/lib/auth/guards";
import { draftSaveSchema, type DraftSaveInput } from "@/lib/drafts/schema";
import { saveServerDraft } from "@/lib/drafts/server";
import { runAction, type ActionResult } from "@/lib/errors";

/**
 * The workspace's server draft save (3 s after the last keystroke, and on
 * editor blur). Page-hide saves use the POST /api/drafts beacon route, which
 * shares the schema and the upsert. `saved:false` means the stored draft is
 * newer than this one (another tab or device got there first) — not an
 * error.
 */
export async function saveDraft(input: DraftSaveInput): Promise<ActionResult<{ saved: boolean }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = draftSaveSchema.parse(input);
    return saveServerDraft(user.id, parsed);
  }, "saveDraft");
}
