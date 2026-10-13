import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth/guards";
import { NoteEditor } from "@/components/notes/note-editor";
import { getOwnNote, linkableProblems } from "../../data";

export const metadata: Metadata = { title: "Edit note" };

type Params = { params: Promise<{ id: string }> };

export default async function EditNotePage({ params }: Params) {
  const user = await requireUser();
  const { id } = await params;
  const note = await getOwnNote(id, user.id);
  if (!note) notFound();
  // Keep a link to a problem that has since been unpublished selectable.
  const problems = await linkableProblems(note.problemId);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href={`/notes/${note.id}`}
        className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to the note
      </Link>
      <h1 className="mt-2 font-display text-2xl font-bold tracking-tight">Edit note</h1>
      <div className="mt-6">
        <NoteEditor
          note={{ id: note.id, title: note.title, contentMd: note.contentMd, problemId: note.problemId }}
          problems={problems}
        />
      </div>
    </div>
  );
}
