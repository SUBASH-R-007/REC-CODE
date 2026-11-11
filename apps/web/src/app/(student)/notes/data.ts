import "server-only";
import { cache } from "react";
import { db } from "@/lib/db";
import { noteIdSchema } from "@/components/notes/note-schema";
import type { NoteProblemOption } from "@/components/notes/note-editor";

/**
 * Reads for the /notes pages. Every note read is scoped to the viewer's own
 * user id: someone else's note id resolves to null, exactly like a missing
 * one (the page then 404s).
 */

const PUBLISHED = { status: "PUBLISHED", liveVersionId: { not: null } } as const;

export interface OwnNote {
  id: string;
  title: string | null;
  contentMd: string;
  problemId: string | null;
  createdAt: Date;
  updatedAt: Date;
  problem: { slug: string; displayCode: string; title: string; published: boolean } | null;
}

export const getOwnNote = cache(async (rawId: string, userId: string): Promise<OwnNote | null> => {
  const id = noteIdSchema.safeParse(rawId);
  if (!id.success) return null;
  const note = await db.note.findFirst({
    where: { id: id.data, userId },
    select: {
      id: true,
      title: true,
      contentMd: true,
      problemId: true,
      createdAt: true,
      updatedAt: true,
      problem: { select: { slug: true, displayCode: true, title: true, status: true, liveVersionId: true } },
    },
  });
  if (!note) return null;
  const { problem, ...rest } = note;
  return {
    ...rest,
    problem: problem
      ? {
          slug: problem.slug,
          displayCode: problem.displayCode,
          title: problem.title,
          published: problem.status === "PUBLISHED" && problem.liveVersionId !== null,
        }
      : null,
  };
});

/**
 * Problems a note may link to: every published problem, by display code.
 * A native <select> keeps this accessible; at Phase 3's catalogue size the
 * list is small. (Swap for a search combobox if it grows past ~500.)
 */
export async function linkableProblems(includeId?: string | null): Promise<NoteProblemOption[]> {
  const rows = await db.problem.findMany({
    where: includeId ? { OR: [PUBLISHED, { id: includeId }] } : PUBLISHED,
    orderBy: { displayCode: "asc" },
    select: { id: true, displayCode: true, title: true },
    take: 2_000,
  });
  return rows;
}

/** `?problem=<slug>` → the published problem's id (for prefill and filters). */
export async function publishedProblemBySlug(
  slug: string | undefined,
): Promise<{ id: string; slug: string; displayCode: string; title: string } | null> {
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 100) return null;
  return db.problem.findFirst({
    where: { slug, ...PUBLISHED },
    select: { id: true, slug: true, displayCode: true, title: true },
  });
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
