"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Field, Input, Select, cn, useToast } from "@recx/design";
import { NOTE_MAX_BYTES, NOTE_TITLE_MAX, formatNoteSize, utf8ByteLength } from "@/components/notes/limits";
import { NOTE_MARKDOWN_CLASSES } from "@/components/notes/markdown-classes";
import { createNote, previewNote, updateNote } from "@/server/actions/notes";

export interface NoteProblemOption {
  id: string;
  displayCode: string;
  title: string;
}

type Tab = "write" | "preview";

/**
 * Create / edit a private Markdown note. Write and Preview are an ARIA tab
 * pair (arrow keys move between them); the preview is rendered on the
 * server by the same sanitised helper as the note page. The size counter is
 * plain described-by text, not a live region, so typing is never chatty;
 * going over the limit shows one alert.
 */
export function NoteEditor({
  note,
  problems,
  defaultProblemId,
}: {
  /** Absent when creating. */
  note?: { id: string; title: string | null; contentMd: string; problemId: string | null };
  problems: NoteProblemOption[];
  defaultProblemId?: string | null;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const baseId = useId();
  const [title, setTitle] = useState(note?.title ?? "");
  const [problemId, setProblemId] = useState(note?.problemId ?? defaultProblemId ?? "");
  const [content, setContent] = useState(note?.contentMd ?? "");
  const [tab, setTab] = useState<Tab>("write");
  const [preview, setPreview] = useState<{ source: string; html: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [previewing, startPreview] = useTransition();
  const savedRef = useRef(false);
  const tabRefs = { write: useRef<HTMLButtonElement>(null), preview: useRef<HTMLButtonElement>(null) };

  const bytes = utf8ByteLength(content);
  const tooBig = bytes > NOTE_MAX_BYTES;
  const dirty =
    title !== (note?.title ?? "") || content !== (note?.contentMd ?? "") || problemId !== (note?.problemId ?? defaultProblemId ?? "");

  // Warn before leaving with unsaved text (closing the tab, reloading).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (savedRef.current) return;
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function selectTab(next: Tab) {
    setTab(next);
    if (next === "preview" && preview?.source !== content && !tooBig) {
      setPreviewError(null);
      startPreview(async () => {
        const result = await previewNote({ contentMd: content });
        if (result.ok) setPreview({ source: content, html: result.data.html });
        else setPreviewError(result.error);
      });
    }
  }

  function onTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next: Tab = e.key === "Home" ? "write" : e.key === "End" ? "preview" : tab === "write" ? "preview" : "write";
    selectTab(next);
    tabRefs[next].current?.focus();
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (tooBig) {
      setError(`Notes are limited to ${NOTE_MAX_BYTES / 1024} KB. Split this one into two.`);
      return;
    }
    if (content.trim().length === 0) {
      setError("Write something before saving.");
      setTab("write");
      return;
    }
    setError(null);
    startSave(async () => {
      const payload = { title, contentMd: content, problemId: problemId || null };
      const result = note ? await updateNote({ ...payload, id: note.id }) : await createNote(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      savedRef.current = true;
      toast(note ? "Note saved." : "Note created.", "success");
      router.push(`/notes/${result.data.id}`);
    });
  }

  const tabId = (t: Tab) => `${baseId}-tab-${t}`;
  const panelId = (t: Tab) => `${baseId}-panel-${t}`;
  const contentId = `${baseId}-content`;
  const helpId = `${baseId}-help`;
  const sizeId = `${baseId}-size`;

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="grid gap-5 md:grid-cols-2">
        <Field label="Title (optional)" htmlFor={`${baseId}-title`}>
          <Input
            id={`${baseId}-title`}
            value={title}
            maxLength={NOTE_TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Sliding window patterns"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Linked problem (optional)"
          htmlFor={`${baseId}-problem`}
          hint="The note is listed with the problem it belongs to."
        >
          <Select id={`${baseId}-problem`} value={problemId} onChange={(e) => setProblemId(e.target.value)}>
            <option value="">No linked problem</option>
            {problems.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayCode} · {p.title}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div>
        <div role="tablist" aria-label="Note editor" className="inline-flex gap-1 rounded-xl border border-border bg-surface p-1">
          {(["write", "preview"] as const).map((t) => (
            <button
              key={t}
              ref={tabRefs[t]}
              type="button"
              role="tab"
              id={tabId(t)}
              aria-selected={tab === t}
              aria-controls={panelId(t)}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => selectTab(t)}
              onKeyDown={onTabKeyDown}
              className={cn(
                "min-h-9 rounded-lg px-4 text-sm font-medium transition-colors",
                tab === t
                  ? "bg-primary-subtle font-semibold text-text ring-1 ring-primary/50"
                  : "text-text-secondary hover:bg-primary-subtle hover:text-text",
              )}
            >
              {t === "write" ? "Write" : "Preview"}
            </button>
          ))}
        </div>

        <div role="tabpanel" id={panelId("write")} aria-labelledby={tabId("write")} hidden={tab !== "write"} className="mt-3">
          <label htmlFor={contentId} className="mb-1.5 block text-sm font-medium text-text">
            Note
          </label>
          <textarea
            id={contentId}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={16}
            spellCheck
            aria-describedby={`${helpId} ${sizeId}`}
            aria-invalid={tooBig || undefined}
            className="min-h-72 w-full resize-y rounded-xl border border-border-strong bg-surface px-3.5 py-3 font-mono text-sm leading-relaxed text-text placeholder:text-muted focus:border-primary"
            placeholder={"## Idea\nTwo pointers from both ends…\n\n```cpp\n// code\n```"}
          />
          <div className="mt-1.5 flex flex-wrap justify-between gap-2 text-xs">
            <p id={helpId} className="text-text-secondary">
              Markdown: **bold**, `code`, lists, tables and links. Images and raw HTML are not shown.
            </p>
            <p id={sizeId} className={cn("tabular-nums", tooBig ? "font-semibold text-danger" : "text-text-secondary")}>
              {formatNoteSize(bytes)}
              {tooBig ? " — over the limit" : ""}
            </p>
          </div>
        </div>

        <div
          role="tabpanel"
          id={panelId("preview")}
          aria-labelledby={tabId("preview")}
          hidden={tab !== "preview"}
          tabIndex={0}
          className="mt-3 min-h-40 rounded-xl border border-border bg-surface p-4"
        >
          {tooBig ? (
            <p className="text-sm text-text-secondary">The note is over the size limit, so it cannot be previewed.</p>
          ) : previewing ? (
            <p className="text-sm text-text-secondary">Rendering the preview…</p>
          ) : previewError ? (
            <p className="text-sm text-danger">{previewError}</p>
          ) : content.trim().length === 0 ? (
            <p className="text-sm text-text-secondary">Nothing to preview yet.</p>
          ) : preview ? (
            // Sanitised on the server by renderMarkdown() — allow-listed tags only.
            <div className={NOTE_MARKDOWN_CLASSES} dangerouslySetInnerHTML={{ __html: preview.html }} />
          ) : null}
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={saving} disabled={tooBig}>
          {note ? "Save note" : "Create note"}
        </Button>
        <Link
          href={(note ? `/notes/${note.id}` : "/notes") as never}
          className="inline-flex h-10 items-center rounded-xl px-4 text-sm font-medium text-text-secondary transition-colors hover:bg-primary-subtle hover:text-text"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
