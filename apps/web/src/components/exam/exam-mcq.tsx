"use client";

import { useId } from "react";
import type { ExamMcqView } from "@/server/queries/exam";

/**
 * One multiple-choice question, in a sitting (Phase 12r).
 *
 * No editor, no Run, no console: "save and next is enough", which is what
 * was asked for. A radio group, the stem, and the marks it carries.
 *
 * The options arrive in THIS candidate's order and the index they click is
 * what gets stored, so nothing here needs to know the author's order and
 * nothing here could reveal it. The correct answer is not on this page in
 * any form — `ExamMcqView` does not carry it and the query never selects
 * it — because a sitting is exactly where somebody reads the page source.
 *
 * A real `<fieldset>` with a `<legend>`, and real `<input type="radio">`
 * elements sharing a name: arrow keys move between options, the group is
 * one tab stop, and a screen reader says "2 of 4". A div with click
 * handlers would have needed all of that written by hand and would have
 * got some of it wrong.
 */
export function ExamMcq({
  mcq,
  chosen,
  onChoose,
  position,
  total,
}: {
  readonly mcq: ExamMcqView;
  /** The option this candidate has settled on, in the order shown. */
  readonly chosen: number | null;
  readonly onChoose: (index: number) => void;
  /** 1-based place in the palette. */
  readonly position: number;
  readonly total: number;
}) {
  const name = useId();
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8" aria-labelledby={`${name}-legend`}>
      <fieldset className="mx-auto max-w-3xl">
        <legend id={`${name}-legend`} className="mb-1 w-full">
          <span className="block text-xs font-medium tracking-wide text-text-secondary uppercase">
            Question {position} of {total} · {mcq.points} {mcq.points === 1 ? "mark" : "marks"}
          </span>
          {/* Sanitised by renderMarkdown, the same pipeline a statement goes
              through, so a stem may carry code spans and lists. */}
          <div
            className="prose-exam mt-3 text-base text-text [&_code]:rounded [&_code]:bg-surface [&_code]:px-1"
            dangerouslySetInnerHTML={{ __html: mcq.stemHtml }}
          />
        </legend>

        <ul className="mt-6 space-y-2">
          {mcq.options.map((option, index) => {
            const id = `${name}-${index}`;
            const picked = chosen === index;
            return (
              <li key={id}>
                <label
                  htmlFor={id}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 text-sm transition-colors ${
                    picked
                      ? "border-primary bg-primary-subtle text-text"
                      : "border-border bg-elevated text-text hover:bg-primary-subtle/60"
                  }`}
                >
                  <input
                    id={id}
                    type="radio"
                    name={name}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                    checked={picked}
                    onChange={() => onChoose(index)}
                  />
                  <span className="min-w-0">{option}</span>
                </label>
              </li>
            );
          })}
        </ul>

        <p className="mt-6 text-xs text-text-secondary">
          Your answer is saved as you pick it. There are no marks taken off for a wrong answer, so a considered guess
          costs nothing.
        </p>
      </fieldset>
    </section>
  );
}
