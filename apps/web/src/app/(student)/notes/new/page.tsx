import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth/guards";
import { NoteEditor } from "@/components/notes/note-editor";
import { firstParam, linkableProblems, publishedProblemBySlug } from "../data";

export const metadata: Metadata = { title: "New note" };

type SearchParams = Promise<{ problem?: string | string[] }>;

/** `/notes/new?problem=<slug>` pre-selects the linked problem. */
export default async function NewNotePage({ searchParams }: { searchParams: SearchParams }) {
  await requireUser();
  const [problem, problems] = await Promise.all([
    publishedProblemBySlug(firstParam((await searchParams).problem)),
    linkableProblems(),
  ]);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        href="/notes"
        className="inline-flex min-h-10 items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        All notes
      </Link>
      <h1 className="mt-2 font-display text-2xl font-bold tracking-tight">New note</h1>
      <p className="mt-1 text-sm text-text-secondary">Private to you. Markdown is supported.</p>
      <div className="mt-6">
        <NoteEditor problems={problems} defaultProblemId={problem?.id ?? null} />
      </div>
    </div>
  );
}
