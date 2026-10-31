"use client";

import { useId } from "react";
import { EDITOR_KEYMAP_NOTICES } from "@recx/shared";
import { CodeEditor } from "@/components/editor/code-editor";
import type { EditorPrefs } from "@/components/editor/editor-types";
import type { ExamQuestionView } from "@/components/exam/exam-session";

/**
 * One question's pane (Phase 6c): the statement, its samples and the editor.
 *
 * The editor is pinned to CodeMirror. SPEC §5 requires editor telemetry to
 * come from "CodeMirror 6 transaction annotations (updateListener +
 * transactionFilter), not DOM events", because CM6 reports the exact inserted
 * character count and whether the origin was `input.type`, `input.paste` or
 * programmatic — and Monaco has no equivalent. A wider screen must not buy a
 * nicer editor at the cost of the signal, so the exam does not take Monaco
 * even where the rest of the product would.
 *
 * The statement is server-sanitised HTML from the frozen `ProblemVersion`
 * (the same pipeline the practice workspace uses), so the exam renders
 * exactly the revision the candidate is judged against.
 */
export function ExamQuestion({
  question,
  source,
  onSourceChange,
  onInsertion,
  position,
  total,
  prefs,
}: {
  readonly question: ExamQuestionView;
  readonly source: string;
  readonly onSourceChange: (next: string) => void;
  readonly onInsertion: (change: { chars: number; origin: string | null }) => void;
  readonly position: number;
  readonly total: number;
  /**
   * The candidate's own font size and tab size (Phase 12j). The KEYMAP is
   * deliberately not theirs here: what this editor records about typing is
   * defined in terms of CodeMirror's own transaction origins, and a
   * keymap's register commands are a paste path those origins do not
   * describe. Comfort settings change no signal, so they apply.
   */
  readonly prefs: EditorPrefs;
}) {
  const noteId = useId();

  return (
    <main className="flex min-w-0 flex-1 flex-col lg:flex-row">
      <section
        aria-label={`Question ${position} of ${total}`}
        className="min-w-0 flex-1 overflow-auto border-b border-border p-6 lg:border-b-0 lg:border-r"
      >
        <h1 className="font-display text-lg font-semibold text-text">
          {position}. {question.title}
        </h1>
        <p className="mt-1 text-xs text-text-secondary tabular-nums">
          {question.points} {question.points === 1 ? "mark" : "marks"}
        </p>
        <div
          className="prose-exam mt-4 text-sm leading-relaxed text-text"
          // Sanitised server-side from the frozen revision.
          dangerouslySetInnerHTML={{ __html: question.statementHtml }}
        />
        {question.samples.length > 0 ? (
          <div className="mt-6 flex flex-col gap-4">
            <h2 className="text-sm font-semibold text-text">Samples</h2>
            {question.samples.map((sample, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium text-text-secondary">Input</p>
                  <pre className="mt-1 overflow-auto rounded-md border border-border bg-surface p-2 font-mono text-xs text-text">
                    {sample.input}
                  </pre>
                </div>
                <div>
                  <p className="text-xs font-medium text-text-secondary">Expected output</p>
                  <pre className="mt-1 overflow-auto rounded-md border border-border bg-surface p-2 font-mono text-xs text-text">
                    {sample.output}
                  </pre>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-label="Your answer" className="flex min-h-80 min-w-0 flex-1 flex-col">
        <p id={noteId} className="border-b border-border px-4 py-2 text-xs text-text-secondary">
          Tab indents. Press Esc then Tab to move focus out of the editor.
          {prefs.keymap !== "DEFAULT" ? ` ${EDITOR_KEYMAP_NOTICES.examDefault}` : ""}
        </p>
        <div className="min-h-0 flex-1">
          <CodeEditor
            value={source}
            onChange={onSourceChange}
            onInsertion={onInsertion}
            // The reason this is pinned: see the module comment.
            forceKind="codemirror"
            language={question.language}
            label={`Code editor for question ${position}`}
            describedBy={noteId}
            prefs={{ ...prefs, keymap: "DEFAULT" }}
            className="h-full"
          />
        </div>
      </section>
    </main>
  );
}
