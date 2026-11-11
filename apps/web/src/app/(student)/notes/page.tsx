import type { Metadata } from "next";
import Link from "next/link";
import { Plus, StickyNote } from "lucide-react";
import { ButtonLink, EmptyState } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { NOTES_PAGE_SIZE } from "@/components/notes/limits";
import { noteExcerpt, noteIdSchema } from "@/components/notes/note-schema";
import { absoluteTime, relativeTime } from "@/components/problems/relative-time";
import { firstParam, publishedProblemBySlug } from "./data";

export const metadata: Metadata = { title: "Notes" };

type SearchParams = Promise<{ problem?: string | string[]; before?: string | string[] }>;

/**
 * The viewer's private notes, most recently edited first, 30 per page, with
 * an optional `?problem=<slug>` filter (the workspace can link here).
 * Excerpts are plain text; a note is rendered in full on its own page.
 */
export default async function NotesPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const params = await searchParams;
  const problem = await publishedProblemBySlug(firstParam(params.problem));
  const beforeId = noteIdSchema.safeParse(firstParam(params.before));

  const cursor = beforeId.success
    ? await db.note.findFirst({ where: { id: beforeId.data, userId: user.id }, select: { id: true } })
    : null;

  const rows = await db.note.findMany({
    where: { userId: user.id, ...(problem ? { problemId: problem.id } : {}) },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: NOTES_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
    select: {
      id: true,
      title: true,
      contentMd: true,
      updatedAt: true,
      problem: { select: { slug: true, displayCode: true, title: true } },
    },
  });
  const hasMore = rows.length > NOTES_PAGE_SIZE;
  const page = rows.slice(0, NOTES_PAGE_SIZE);
  const last = page.at(-1);
  const now = new Date();

  const filterQuery = problem ? `problem=${encodeURIComponent(problem.slug)}` : "";
  const newHref = problem ? `/notes/new?${filterQuery}` : "/notes/new";
  const pageHref = (before?: string) => {
    const query = [filterQuery, before ? `before=${encodeURIComponent(before)}` : ""].filter(Boolean).join("&");
    return query ? `/notes?${query}` : "/notes";
  };

  return (
    <div className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Notes</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {problem ? (
              <>
                Notes linked to{" "}
                <Link href={`/problems/${problem.slug}`} className="font-medium text-text underline underline-offset-2 hover:text-primary">
                  {problem.displayCode} · {problem.title}
                </Link>
                .{" "}
                <Link href="/notes" className="font-medium text-text underline underline-offset-2 hover:text-primary">
                  Show all notes
                </Link>
              </>
            ) : (
              "Private Markdown notes. Only you can see them."
            )}
          </p>
        </div>
        <ButtonLink href={newHref}>
          <Plus className="h-4 w-4" aria-hidden />
          New note
        </ButtonLink>
      </div>

      <h2 className="sr-only">{problem ? "Notes for this problem" : "Your notes"}</h2>
      {page.length === 0 ? (
        <EmptyState
          icon={<StickyNote className="h-6 w-6" />}
          title={cursor ? "No older notes" : problem ? "No notes for this problem yet" : "No notes yet"}
          description="Write down patterns, mistakes and ideas while they are fresh. Notes support Markdown and stay private to you."
          action={
            <ButtonLink href={cursor ? pageHref() : newHref} variant="outline">
              {cursor ? "Back to the newest" : "Write a note"}
            </ButtonLink>
          }
        />
      ) : (
        <ul className="mt-6 space-y-3">
          {page.map((note) => {
            const heading = note.title ?? "Untitled note";
            return (
              <li key={note.id}>
                <article
                  aria-labelledby={`note-${note.id}`}
                  className="relative rounded-2xl border border-border bg-surface p-4 shadow-card transition-colors focus-within:border-primary/40 hover:border-primary/40 sm:p-5"
                >
                  <h2 id={`note-${note.id}`} className="font-display text-base font-semibold tracking-tight">
                    <Link href={`/notes/${note.id}`} className="hover:text-primary hover:underline">
                      {heading}
                    </Link>
                  </h2>
                  {note.problem && (
                    <p className="mt-0.5 text-xs text-text-secondary">
                      <span className="font-mono">{note.problem.displayCode}</span> · {note.problem.title}
                    </p>
                  )}
                  <p className="mt-2 line-clamp-2 text-sm text-text-secondary">{noteExcerpt(note.contentMd)}</p>
                  <p className="mt-2 text-xs text-text-secondary">
                    Edited{" "}
                    <time dateTime={note.updatedAt.toISOString()} title={absoluteTime(note.updatedAt)}>
                      {relativeTime(note.updatedAt, now)}
                    </time>
                  </p>
                </article>
              </li>
            );
          })}
        </ul>
      )}

      {page.length > 0 && (hasMore || cursor) && (
        <nav aria-label="Note pages" className="mt-4 flex flex-wrap justify-between gap-3">
          {cursor ? (
            <ButtonLink href={pageHref()} variant="ghost">
              Newest
            </ButtonLink>
          ) : (
            <span />
          )}
          {hasMore && last && (
            <ButtonLink href={pageHref(last.id)} variant="outline">
              Older notes
            </ButtonLink>
          )}
        </nav>
      )}
    </div>
  );
}
