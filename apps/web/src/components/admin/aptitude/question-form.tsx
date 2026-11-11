"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@recx/design";
import {
  APTITUDE_AREA_LABEL,
  APTITUDE_LIMITS,
  APTITUDE_TOPICS,
  APTITUDE_TOPIC_AREA,
  APTITUDE_TOPIC_LABEL,
  EXPLANATION_MIN_CHARS,
  type AptitudeQuestionKind,
} from "@recx/shared";
import { createAptitudeQuestion, updateAptitudeQuestion } from "@/server/actions/admin-aptitude";

/**
 * Writing one aptitude question (Phase 7d).
 *
 * The form mirrors `aptitudeQuestionSchema` field for field, because that
 * schema is also what the CSV importer finishes with — so a question an
 * author can save here is a question an import can create, and the two can
 * never drift into accepting different things.
 *
 * Three accessibility requirements from `docs/ACCESSIBILITY.md`, not polish:
 * the options are native inputs inside a `<fieldset>` whose `<legend>` says
 * what they are; the correct answer is chosen with the same control type the
 * candidate will use (a radio for single-choice, checkboxes for multi), so an
 * author sees what they are authoring; and every refusal is text next to the
 * field rather than a toast that disappears.
 */

export interface QuestionFormValues {
  readonly questionId?: string;
  readonly kind: AptitudeQuestionKind;
  readonly topic: string;
  readonly difficulty: "EASY" | "MEDIUM" | "HARD";
  readonly stem: string;
  readonly options: string[];
  readonly correctOptionIndexes: number[];
  readonly numericAnswer: string;
  readonly numericTolerance: string;
  readonly numericUnit: string;
  readonly explanation: string;
  readonly expectedSeconds: number;
  readonly origin: "FACULTY" | "SENIOR_STUDENT" | "AI_ASSISTED";
  readonly passageId: string | null;
}

export const EMPTY_QUESTION: QuestionFormValues = {
  kind: "SINGLE_CHOICE",
  topic: "PERCENTAGES",
  difficulty: "MEDIUM",
  stem: "",
  options: ["", "", "", ""],
  correctOptionIndexes: [],
  numericAnswer: "",
  numericTolerance: "0",
  numericUnit: "",
  explanation: "",
  expectedSeconds: 60,
  origin: "FACULTY",
  passageId: null,
};

export function QuestionForm({ initial, readOnly = false }: { initial: QuestionFormValues; readOnly?: boolean }) {
  const [values, setValues] = useState<QuestionFormValues>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const formId = useId();

  const numeric = values.kind === "NUMERIC_ENTRY";
  const single = values.kind === "SINGLE_CHOICE" || values.kind === "PASSAGE_GROUPED";
  const set = <K extends keyof QuestionFormValues>(key: K, value: QuestionFormValues[K]) => {
    setSaved(false);
    setValues((current) => ({ ...current, [key]: value }));
  };

  const submit = () => {
    setError(null);
    start(async () => {
      const payload = {
        ...(values.questionId ? { questionId: values.questionId } : {}),
        kind: values.kind,
        area: APTITUDE_TOPIC_AREA[values.topic as keyof typeof APTITUDE_TOPIC_AREA],
        topic: values.topic,
        difficulty: values.difficulty,
        stem: values.stem,
        options: numeric ? [] : values.options.map((option) => option.trim()).filter((option) => option.length > 0),
        correctOptionIndexes: numeric ? [] : values.correctOptionIndexes,
        numericAnswer: numeric && values.numericAnswer.trim() !== "" ? Number(values.numericAnswer) : null,
        numericTolerance: numeric && values.numericTolerance.trim() !== "" ? Number(values.numericTolerance) : null,
        numericUnit: numeric ? values.numericUnit.trim() || null : null,
        explanation: values.explanation,
        expectedSeconds: values.expectedSeconds,
        origin: values.origin,
        sourceBatch: null,
        passageId: values.passageId,
      };
      const result = values.questionId
        ? await updateAptitudeQuestion(payload)
        : await createAptitudeQuestion(payload);
      if (result.ok) {
        setSaved(true);
        if (!values.questionId) setValues(EMPTY_QUESTION);
      } else {
        setError(result.error);
      }
    });
  };

  const toggleCorrect = (index: number) => {
    setSaved(false);
    setValues((current) => {
      if (single) return { ...current, correctOptionIndexes: [index] };
      const next = current.correctOptionIndexes.includes(index)
        ? current.correctOptionIndexes.filter((i) => i !== index)
        : [...current.correctOptionIndexes, index].sort((a, b) => a - b);
      return { ...current, correctOptionIndexes: next };
    });
  };

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (!readOnly) submit();
      }}
    >
      {readOnly ? (
        <p className="rounded-md border border-border bg-surface p-3 text-sm text-text-secondary">
          This question is published. Students have already been scored on it, so its wording, options and answer are
          frozen — you can still improve the worked explanation below, or retire it and add a new question.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Kind</span>
          <select
            value={values.kind}
            disabled={readOnly}
            onChange={(event) => set("kind", event.target.value as AptitudeQuestionKind)}
            className="h-9 rounded-md border border-border bg-surface px-2"
          >
            <option value="SINGLE_CHOICE">Single choice</option>
            <option value="MULTI_CHOICE">Multi choice</option>
            <option value="NUMERIC_ENTRY">Numeric entry</option>
            <option value="PASSAGE_GROUPED">Passage question</option>
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Topic</span>
          <select
            value={values.topic}
            disabled={readOnly}
            onChange={(event) => set("topic", event.target.value)}
            className="h-9 rounded-md border border-border bg-surface px-2"
          >
            {APTITUDE_TOPICS.map((topic) => (
              <option key={topic} value={topic}>
                {APTITUDE_TOPIC_LABEL[topic]} — {APTITUDE_AREA_LABEL[APTITUDE_TOPIC_AREA[topic]]}
              </option>
            ))}
          </select>
          {/* The area is derived from the topic rather than chosen: the
              mapping is the one thing that cannot be wrong, and a form that
              lets an author disagree with it is a form that produces a
              question the CHECK refuses. */}
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Difficulty</span>
          <select
            value={values.difficulty}
            disabled={readOnly}
            onChange={(event) => set("difficulty", event.target.value as "EASY")}
            className="h-9 rounded-md border border-border bg-surface px-2"
          >
            <option value="EASY">Easy</option>
            <option value="MEDIUM">Medium</option>
            <option value="HARD">Hard</option>
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Question</span>
        <textarea
          value={values.stem}
          disabled={readOnly}
          rows={4}
          maxLength={APTITUDE_LIMITS.stem.max}
          onChange={(event) => set("stem", event.target.value)}
          className="rounded-md border border-border bg-surface p-3"
          placeholder="What is 10% of 250?"
        />
      </label>

      {numeric ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Answer</span>
            {/* Text with inputMode decimal, never type="number": a spinner
                and locale-dependent parsing are a correctness bug in a
                graded field (docs/ACCESSIBILITY.md). */}
            <input
              type="text"
              inputMode="decimal"
              value={values.numericAnswer}
              disabled={readOnly}
              onChange={(event) => set("numericAnswer", event.target.value)}
              className="h-9 rounded-md border border-border bg-surface px-3"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Tolerance</span>
            <input
              type="text"
              inputMode="decimal"
              value={values.numericTolerance}
              disabled={readOnly}
              onChange={(event) => set("numericTolerance", event.target.value)}
              aria-describedby={`${formId}-tolerance`}
              className="h-9 rounded-md border border-border bg-surface px-3"
            />
            <span id={`${formId}-tolerance`} className="text-xs text-muted">
              An answer within this distance counts. Zero means exactly.
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Unit</span>
            <input
              type="text"
              value={values.numericUnit}
              disabled={readOnly}
              maxLength={32}
              onChange={(event) => set("numericUnit", event.target.value)}
              className="h-9 rounded-md border border-border bg-surface px-3"
              placeholder="km/h"
            />
          </label>
        </div>
      ) : (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            Options, and which of them is correct
            {single ? " (exactly one)" : " (two or more)"}
          </legend>
          {values.options.map((option, index) => (
            <div key={index} className="flex items-center gap-3">
              <input
                type={single ? "radio" : "checkbox"}
                name={`${formId}-correct`}
                checked={values.correctOptionIndexes.includes(index)}
                disabled={readOnly}
                onChange={() => toggleCorrect(index)}
                aria-label={`Option ${index + 1} is correct`}
              />
              <input
                type="text"
                value={option}
                disabled={readOnly}
                maxLength={APTITUDE_LIMITS.option.max}
                onChange={(event) => {
                  const next = [...values.options];
                  next[index] = event.target.value;
                  set("options", next);
                }}
                aria-label={`Option ${index + 1}`}
                className="h-9 flex-1 rounded-md border border-border bg-surface px-3 text-sm"
              />
            </div>
          ))}
          {!readOnly && values.options.length < APTITUDE_LIMITS.options.max ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => set("options", [...values.options, ""])}>
              Add an option
            </Button>
          ) : null}
        </fieldset>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Worked explanation</span>
        <textarea
          value={values.explanation}
          rows={6}
          maxLength={APTITUDE_LIMITS.explanation.max}
          onChange={(event) => set("explanation", event.target.value)}
          aria-describedby={`${formId}-explanation`}
          className="rounded-md border border-border bg-surface p-3"
          placeholder="Ten percent is one tenth of the number, so 250 divided by ten is 25."
        />
        <span id={`${formId}-explanation`} className="text-xs text-muted">
          Required to publish, at least {EXPLANATION_MIN_CHARS} characters. A student who got this wrong needs the
          working, not a tick — so write the steps, not the answer.
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Expected time (seconds)</span>
          <input
            type="text"
            inputMode="numeric"
            value={String(values.expectedSeconds)}
            disabled={readOnly}
            onChange={(event) => set("expectedSeconds", Number(event.target.value.replace(/[^0-9]/g, "")) || 0)}
            aria-describedby={`${formId}-seconds`}
            className="h-9 rounded-md border border-border bg-surface px-3"
          />
          <span id={`${formId}-seconds`} className="text-xs text-muted">
            What this should take. It is the aid that tells a section author whether 25 questions fit in 25 minutes.
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Origin</span>
          <select
            value={values.origin}
            disabled={readOnly}
            onChange={(event) => set("origin", event.target.value as "FACULTY")}
            className="h-9 rounded-md border border-border bg-surface px-2"
          >
            <option value="FACULTY">Faculty</option>
            <option value="SENIOR_STUDENT">Senior student</option>
            <option value="AI_ASSISTED">AI assisted</option>
          </select>
        </label>
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-danger/30 bg-danger-subtle p-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="rounded-md border border-success/30 bg-success-subtle p-3 text-sm text-success">
          Saved as a draft. It needs a second pair of eyes before it can be published.
        </p>
      ) : null}

      {readOnly ? null : (
        <Button type="submit" loading={pending}>
          {values.questionId ? "Save the question" : "Create the question"}
        </Button>
      )}
    </form>
  );
}
