"use client";

import { useId } from "react";
import { EDITOR_KEYMAP_NOTICES } from "@recx/shared";
import { CodeEditor } from "@/components/editor/code-editor";
import type { EditorPrefs } from "@/components/editor/editor-types";
import type { ExamLanguageView, ExamQuestionView } from "@/components/exam/exam-session";

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
  languages,
  language,
  onLanguageChange,
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
  /**
   * Every language this paper accepts, with its labels already resolved on
   * the server (Phase 13a).
   */
  readonly languages: readonly ExamLanguageView[];
  /** The one this question is being answered in. */
  readonly language: string;
  readonly onLanguageChange: (key: string) => void;
}) {
  const noteId = useId();
  const languageId = useId();
  const active = languages.find((entry) => entry.key === language) ?? languages[0];

  return (
    <main className="flex min-w-0 flex-1 flex-col lg:flex-row">
      {/*
        `tabIndex={0}` because this pane SCROLLS and holds no focusable
        content of its own (Phase 12u).

        axe's `scrollable-region-focusable`, serious, and it only appears in
        a state the path-based axe suite could never reach: the statement
        fits until the run console opens, at which point this pane shrinks,
        starts scrolling, and becomes a region a keyboard-only candidate
        cannot read the bottom of — the bottom of their own question, in an
        exam, with a clock running. It already carries a name, so it is
        announced as "Question 1 of 2, region" and stepped into with Tab.
      */}
      <section
        aria-label={`Question ${position} of ${total}`}
        tabIndex={0}
        className="scroll-thin min-w-0 flex-1 overflow-auto border-b border-border p-6 lg:border-b-0 lg:border-r"
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
        {/**
          * The language this answer is written in (Phase 13a).
          *
          * A sitting used to have one language nobody chose — the first
          * enabled toolchain key, which is C++ — so a candidate who
          * writes Python sat down in front of a C++ editor and there was
          * nothing on the screen to change it. The department chooses what
          * the paper accepts; this is where the candidate chooses from it.
          *
          * A paper restricted to ONE language shows it as text. A dropdown
          * with a single option is a control that looks like a choice and
          * is not, and the one thing it would do is invite a click in the
          * middle of an exam.
          *
          * The full label, with the compiler and its version, because the
          * question a candidate actually has is "which compiler am I being
          * judged by" — and under exam conditions there is no /judge page
          * to go and read.
          */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2">
          {languages.length > 1 ? (
            <>
              <label htmlFor={languageId} className="text-xs font-medium text-text">
                Language
              </label>
              <select
                id={languageId}
                value={active?.key ?? language}
                onChange={(event) => onLanguageChange(event.target.value)}
                className="min-h-8 rounded-md border border-border bg-surface px-2 py-1 text-xs text-text"
              >
                {languages.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.shortLabel}
                  </option>
                ))}
              </select>
              <span className="text-xs text-text-secondary">{active?.label ?? language}</span>
            </>
          ) : (
            <span className="text-xs text-text-secondary">
              <span className="font-medium text-text">Language:</span> {active?.label ?? language}
            </span>
          )}
        </div>
        <p id={noteId} className="border-b border-border px-4 py-2 text-xs text-text-secondary">
          Tab indents. Press Esc then Tab to move focus out of the editor.
          {prefs.keymap !== "DEFAULT" ? ` ${EDITOR_KEYMAP_NOTICES.examDefault}` : ""}
          {languages.length > 1
            ? " Changing the language keeps what you have written, unless the editor still holds the starter."
            : ""}
        </p>
        <div className="min-h-0 flex-1">
          <CodeEditor
            value={source}
            onChange={onSourceChange}
            onInsertion={onInsertion}
            // The reason this is pinned: see the module comment.
            forceKind="codemirror"
            // The chosen language's grammar (Phase 13a), so the
            // highlighting follows the picker rather than the paper.
            language={active?.editorLanguage ?? "plaintext"}
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
