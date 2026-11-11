"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@recx/design";
import type { PaperLanguageView } from "@recx/shared";
import { setAssessmentLanguages } from "@/server/actions/admin-assessments";

/**
 * Which languages a paper is answered in (Phase 13a).
 *
 * Before this form a sitting had ONE language and nobody chose it: the
 * first enabled toolchain key, which is `cpp20`. A department running a
 * Python paper had to ask for C++ to be disabled across the whole
 * college, and a candidate who writes Java sat down in front of a C++
 * editor.
 *
 * Ticking NOTHING is a real answer and the form says what it means — every
 * enabled language — because an empty checkbox list otherwise reads like a
 * paper nobody can sit. That is also what every paper written before this
 * phase holds, so the wording has to be right.
 *
 * Only languages this platform can actually judge are offered. Promising
 * candidates Rust when the Rust toolchain is disabled would be an editor
 * whose every Run comes back "that language is not available right now",
 * discovered by a candidate rather than by the person choosing.
 */
export function AssessmentLanguagesForm({
  assessmentId,
  available,
  selected,
  published,
}: {
  readonly assessmentId: string;
  /**
   * Enabled, current toolchains — what the judge can run right now, with
   * their labels already resolved. A `type` import, deliberately: calling
   * the catalog's label helpers from a client component puts eleven
   * toolchains' compiler flags in the browser bundle.
   */
  readonly available: readonly PaperLanguageView[];
  readonly selected: readonly string[];
  /** The paper has left DRAFT: the copy says who an edit reaches. */
  readonly published: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<readonly string[]>(selected);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const toggle = (key: string) => {
    setError(null);
    setDone(null);
    setPicked((current) => (current.includes(key) ? current.filter((k) => k !== key) : [...current, key]));
  };

  const save = () => {
    setError(null);
    setDone(null);
    start(async () => {
      const result = await setAssessmentLanguages({ assessmentId, languages: [...picked] });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPicked(result.data.languages);
      setDone(
        result.data.languages.length === 0
          ? "Saved. This paper accepts every enabled language."
          : `Saved. Candidates may answer in ${result.data.languages
              .map((key) => available.find((language) => language.key === key)?.shortLabel ?? key)
              .join(", ")}.`,
      );
      router.refresh();
    });
  };

  if (available.length === 0) {
    return (
      <p className="text-sm text-danger">
        No toolchain is enabled on this platform, so there is nothing to choose from and nothing could be judged. A
        super-admin enables languages on the judge settings.
      </p>
    );
  }

  const dirty = picked.length !== selected.length || picked.some((key) => !selected.includes(key));

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-xs uppercase tracking-wide text-text-secondary">Accepted languages</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {available.map((language) => (
            <label key={language.key} className="flex items-start gap-2 rounded-lg border border-border p-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={picked.includes(language.key)}
                onChange={() => toggle(language.key)}
              />
              <span>
                <span className="font-medium">{language.shortLabel}</span>
                <span className="block text-xs text-text-secondary">{language.label}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="text-xs text-text-secondary">
        {picked.length === 0
          ? "Nothing ticked: candidates may answer in every language above, and the one they pick is recorded with their answer."
          : `Candidates choose one of these per question. ${picked.length} of ${available.length} ticked.`}
      </p>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm text-success">
          {done}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} disabled={!dirty}>
          Save the languages
        </Button>
        {dirty ? (
          <Button type="button" variant="outline" onClick={() => setPicked(selected)} disabled={pending}>
            Undo
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted">
        {published
          ? "This paper is published, so a change here reaches the candidates who start AFTER it. Anybody already sitting keeps the languages their paper was laid out with — the set is frozen into their attempt, like the questions themselves."
          : "A candidate's accepted set is frozen into their attempt when they start, so a later change never moves a sitting that is already running."}{" "}
        Saving is recorded against your name.
      </p>
    </form>
  );
}
