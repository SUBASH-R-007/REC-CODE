"use server";

import { z } from "zod";
import { requireActionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { NotFoundError, runAction, type ActionResult } from "@/lib/errors";

/**
 * The bookmark toggle on the problem list and in the workspace.
 *
 * The client sends the state it wants (not "flip whatever is stored"), so an
 * optimistic double click converges on the last click instead of
 * oscillating, and a retried request is harmless: setting is an
 * INSERT … ON CONFLICT DO NOTHING, clearing a deleteMany.
 *
 * Bookmarks are private, low-stakes personal data — not a sensitive mutation,
 * so they are not audited (the Bookmark row is its own record). A student
 * only ever touches their own rows: the user id comes from the session,
 * never from the input.
 */

const toggleBookmarkSchema = z.object({
  problemId: z
    .string({ invalid_type_error: "Choose a problem to bookmark.", required_error: "Choose a problem to bookmark." })
    .trim()
    .min(1, "Choose a problem to bookmark.")
    .max(64, "That problem id is not valid."),
  bookmarked: z.boolean({
    invalid_type_error: "Say whether to add or remove the bookmark.",
    required_error: "Say whether to add or remove the bookmark.",
  }),
});
export type ToggleBookmarkInput = z.input<typeof toggleBookmarkSchema>;

export async function toggleBookmark(input: ToggleBookmarkInput): Promise<ActionResult<{ bookmarked: boolean }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const { problemId, bookmarked } = toggleBookmarkSchema.parse(input);

    if (!bookmarked) {
      await db.bookmark.deleteMany({ where: { userId: user.id, problemId } });
      return { bookmarked: false };
    }

    // Only a published problem can be bookmarked; anything else is "not found"
    // so draft ids cannot be probed.
    const problem = await db.problem.findFirst({
      where: { id: problemId, status: "PUBLISHED" },
      select: { id: true },
    });
    if (!problem) throw new NotFoundError("That problem is not available.");

    await db.bookmark.createMany({ data: [{ userId: user.id, problemId }], skipDuplicates: true });
    return { bookmarked: true };
  }, "toggleBookmark");
}
