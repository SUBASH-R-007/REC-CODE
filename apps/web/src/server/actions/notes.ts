"use server";

import { revalidatePath } from "next/cache";
import { requireActionUser } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { NotFoundError, RateLimitError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { renderMarkdown } from "@/lib/markdown";
import { hitRateLimit } from "@/lib/rate-limit";
import { MAX_NOTES_PER_USER } from "@/components/notes/limits";
import {
  noteIdSchema,
  noteInputSchema,
  notePreviewSchema,
  noteUpdateSchema,
  type NoteInput,
  type NoteUpdateInput,
} from "@/components/notes/note-schema";

/**
 * Private Markdown notes (/notes). Every query is scoped to the session's
 * user id — never an id from the input — so another student's note is
 * indistinguishable from a missing one. Content is stored as written and
 * rendered only through the sanitised helper (src/lib/markdown.ts).
 *
 * Audit: creating and editing a private note is not a sensitive mutation
 * (the Note row is its own record); deleting one is irreversible and is
 * audited as note.deleted, without its content.
 *
 * Writes and previews share a per-user budget (fails open if Redis is down).
 */

const WRITE_BUDGET = { limit: 120, windowMs: 10 * 60_000 };

async function spendWriteBudget(userId: string): Promise<void> {
  const hit = await hitRateLimit(`notes:${userId}`, WRITE_BUDGET);
  if (!hit.allowed) throw new RateLimitError("You're saving notes very quickly. Wait a minute and try again.");
}

/** A link target must be a published problem (or the note's existing link). */
async function linkableProblem(problemId: string | null, keep: string | null = null): Promise<string | null> {
  if (problemId === null) return null;
  if (problemId === keep) return keep;
  const problem = await db.problem.findFirst({
    where: { id: problemId, status: "PUBLISHED", liveVersionId: { not: null } },
    select: { id: true },
  });
  if (!problem) throw new ValidationError("That problem is not available to link. Choose another one.");
  return problem.id;
}

function revalidateNotes(id?: string) {
  revalidatePath("/notes");
  if (id) revalidatePath(`/notes/${id}`);
}

export async function createNote(input: NoteInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const data = noteInputSchema.parse(input);
    await spendWriteBudget(user.id);

    const existing = await db.note.count({ where: { userId: user.id } });
    if (existing >= MAX_NOTES_PER_USER) {
      throw new ValidationError(
        `You have ${MAX_NOTES_PER_USER} notes, the most a student can keep. Delete ones you no longer need first.`,
      );
    }
    const problemId = await linkableProblem(data.problemId);
    const note = await db.note.create({
      data: { userId: user.id, title: data.title, contentMd: data.contentMd, problemId },
      select: { id: true },
    });
    revalidateNotes();
    return { id: note.id };
  }, "createNote");
}

export async function updateNote(input: NoteUpdateInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const data = noteUpdateSchema.parse(input);
    await spendWriteBudget(user.id);

    const current = await db.note.findFirst({
      where: { id: data.id, userId: user.id },
      select: { id: true, problemId: true },
    });
    if (!current) throw new NotFoundError("That note was not found. It may have been deleted.");
    const problemId = await linkableProblem(data.problemId, current.problemId);

    const { count } = await db.note.updateMany({
      where: { id: current.id, userId: user.id },
      data: { title: data.title, contentMd: data.contentMd, problemId },
    });
    if (count === 0) throw new NotFoundError("That note was not found. It may have been deleted.");
    revalidateNotes(current.id);
    return { id: current.id };
  }, "updateNote");
}

export async function deleteNote(input: { id: string }): Promise<ActionResult<null>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const id = noteIdSchema.parse(input?.id);
    const { count } = await db.note.deleteMany({ where: { id, userId: user.id } });
    if (count === 0) throw new NotFoundError("That note was not found. It may already be deleted.");
    await audit({ actorId: user.id, action: "note.deleted", entityType: "Note", entityId: id, targetUserId: user.id });
    revalidateNotes(id);
    return null;
  }, "deleteNote");
}

/** The editor's Preview tab: the same sanitised rendering as the note page. */
export async function previewNote(input: { contentMd: string }): Promise<ActionResult<{ html: string }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const { contentMd } = notePreviewSchema.parse(input);
    await spendWriteBudget(user.id);
    return { html: renderMarkdown(contentMd) };
  }, "previewNote");
}
