import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Pencil } from "lucide-react";
import { ButtonLink, Card } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/session";
import { renderMarkdown } from "@/lib/markdown";
import { DeleteNoteButton } from "@/components/notes/delete-note-button";
import { NOTE_MARKDOWN_CLASSES } from "@/components/notes/markdown-classes";
import { absoluteTime } from "@/components/problems/relative-time";
import { getOwnNote } from "../data";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const user = await getCurrentUser();
  const { id } = await params;
  const note = user ? await getOwnNote(id, user.id) : null;
  return { title: note ? (note.title ?? "Untitled note") : "Note not found" };
}

/** One of the viewer's notes, rendered through the sanitised Markdown helper. */
export default async function NotePage({ params }: Params) {
  const user = await requireUser();
  const { id } = await params;
  const note = await getOwnNote(id, user.id);
  if (!note) notFound();

  const heading = note.title ?? "Untitled note";
  const html = renderMarkdown(note.contentMd);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/notes"
        className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All notes
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight break-words">{heading}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Edited <time dateTime={note.updatedAt.toISOString()}>{absoluteTime(note.updatedAt)}</time>
            {note.problem && (
              <>
                {" · "}
                {note.problem.published ? (
                  <Link
                    href={`/problems/${note.problem.slug}`}
                    className="font-medium text-text underline underline-offset-2 hover:text-primary"
                  >
                    {note.problem.displayCode} · {note.problem.title}
                  </Link>
                ) : (
                  <span>
                    {note.problem.displayCode} · {note.problem.title} (no longer published)
                  </span>
                )}
              </>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <ButtonLink href={`/notes/${note.id}/edit`} variant="secondary">
            <Pencil className="h-4 w-4" aria-hidden />
            Edit
          </ButtonLink>
          <DeleteNoteButton id={note.id} title={heading} />
        </div>
      </div>

      <Card className="mt-6 p-5 sm:p-6">
        {/* Sanitised on the server by renderMarkdown() — allow-listed tags only. */}
        <div className={NOTE_MARKDOWN_CLASSES} dangerouslySetInnerHTML={{ __html: html }} />
      </Card>
    </div>
  );
}
