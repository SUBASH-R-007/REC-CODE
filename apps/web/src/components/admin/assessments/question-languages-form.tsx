"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@recx/design";
import type { PaperLanguageView } from "@recx/shared";
import { setQuestionLanguages } from "@/server/actions/admin-assessments";

/**
 * Narrow one question to some of the paper's languages (Phase 13c).
 *
 * The paper says what it accepts; this says "answer THIS one in C",
 * which is a reasonable thing to ask of a question about pointers
 * without making the whole paper C.
 *
 * Drawn only when the paper accepts more than one language, because
 * narrowing a paper that offers a single language is a control with
 * nothing to do. Nothing ticked is the default and means every language
 * the paper accepts — stated in words beside the boxes, because an empty
 * row of checkboxes reads like a question nobody can answer.
 */
export function QuestionLanguagesForm({
  assessmentProblemId,
  position,
  paper,
  selected,
}: {
  readonly assessmentProblemId: string;
  /** The question's number, for the control's accessible name. */
  readonly position: number;
  /** What the paper accepts: the most this question can be narrowed to. */
  readonly paper: readonly PaperLanguageView[];
  readonly selected: readonly string[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<readonly string[]>(selected);
  const [error, setError] = useState<string | null>(null);

  if (paper.length < 2) return null;

  const save = (next: readonly string[]) => {
    setError(null);
    start(async () => {
      const result = await setQuestionLanguages({ assessmentProblemId, languages: [...next] });
      if (!result.ok) {
        setError(result.error);
        // Put the boxes back to what the server still holds, so the row
        // never shows a narrowing that was refused.
        setPicked(selected);
        return;
      }
      setPicked(result.data.languages);
      router.refresh();
    });
  };

  const toggle = (key: string) => {
    const next = picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key];
    setPicked(next);
    // Ticking every language is the same as ticking none; the action
    // refuses it, so send the clear it really means.
    save(next.length === paper.length ? [] : next);
  };

  return (
    <div className="space-y-1">
      <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1" disabled={pending}>
        <legend className="sr-only">Languages for question {position}</legend>
        {paper.map((language) => (
          <label key={language.key} className="inline-flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              className="h-3.5 w-3.5"
              checked={picked.includes(language.key)}
              onChange={() => toggle(language.key)}
            />
            <span title={language.label}>{language.shortLabel}</span>
          </label>
        ))}
        {/* Named for what it does, not for what it clears: it puts the
            question back to accepting whatever the paper accepts. */}
        {picked.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => save([])} loading={pending}>
            Any language
          </Button>
        ) : null}
      </fieldset>
      <p className="text-xs text-muted">
        {picked.length === 0 ? "Any language the paper accepts" : "Only these"}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
