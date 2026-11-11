"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@recx/design";
import { answerPractice, recordPracticeQuestionServed } from "@/server/actions/aptitude";

/**
 * One practice question, then the working (Phase 7e).
 *
 * This component is the phase's reason for existing. SPEC §5 makes worked
 * explanations mandatory at publish because the explanation is the product:
 * a student who got a percentage question wrong needs the steps, not a tick.
 *
 * Four accessibility requirements from `docs/ACCESSIBILITY.md`, none of them
 * polish:
 *
 *   * the options are native inputs inside a `<fieldset>` whose `<legend>`
 *     carries the question, so a screen-reader user hears what they are
 *     answering rather than four unlabelled radios;
 *   * numeric entry is `type="text" inputMode="decimal"`, never
 *     `type="number"` — a spinner and locale-dependent parsing are a
 *     correctness bug in a graded field;
 *   * the explanation is a region with an accessible name that enters the DOM
 *     only AFTER the answer is committed, and focus moves to it, because the
 *     answer is the thing the student came for;
 *   * right and wrong are said in WORDS as well as in colour.
 */

export interface PracticeQuestion {
  readonly id: string;
  readonly displayCode: string;
  readonly kind: "SINGLE_CHOICE" | "MULTI_CHOICE" | "NUMERIC_ENTRY" | "PASSAGE_GROUPED";
  readonly stem: string;
  readonly options: readonly string[];
  readonly numericUnit: string | null;
  readonly expectedSeconds: number;
  readonly passage: { readonly title: string; readonly body: string } | null;
}

interface Outcome {
  readonly correct: boolean;
  readonly correctOptionIndexes: readonly number[];
  readonly numericAnswer: string | null;
  readonly explanation: string;
  readonly xpAwarded: number;
  readonly xpReason: "paid" | "already_paid" | "daily_cap" | "wrong";
}

export function PracticeQuestionCard({ question, topicLabel }: { question: PracticeQuestion; topicLabel: string }) {
  const router = useRouter();
  const formId = useId();
  const seenAt = useRef(Date.now());
  const explanationRef = useRef<HTMLElement | null>(null);
  const [chosen, setChosen] = useState<number[]>([]);
  const [typed, setTyped] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const numeric = question.kind === "NUMERIC_ENTRY";
  const single = question.kind === "SINGLE_CHOICE" || question.kind === "PASSAGE_GROUPED";

  useEffect(() => {
    seenAt.current = Date.now();
    setChosen([]);
    setTyped("");
    setOutcome(null);
    setError(null);
    // Served, not answered: the two are different events, and the counters
    // depend on the difference.
    void recordPracticeQuestionServed({ questionId: question.id });
  }, [question.id]);

  useEffect(() => {
    if (outcome) explanationRef.current?.focus();
  }, [outcome]);

  const answerable = numeric ? typed.trim().length > 0 : chosen.length > 0;

  const submit = () => {
    setError(null);
    start(async () => {
      const now = Date.now();
      const result = await answerPractice({
        questionId: question.id,
        selectedIndexes: numeric ? [] : chosen,
        numericValue: numeric && typed.trim() !== "" ? Number(typed) : null,
        seenAtMs: 0,
        answeredAtMs: Math.max(0, now - seenAt.current),
      });
      if (result.ok) setOutcome(result.data);
      else setError(result.error);
    });
  };

  return (
    <div className="space-y-5">
      {question.passage ? (
        <section
          // A passage is one region with a name, reachable from the question,
          // and never duplicated once per question.
          role="region"
          aria-label={`Passage: ${question.passage.title}`}
          tabIndex={0}
          className="max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-4"
        >
          <h2 className="mb-2 text-sm font-semibold">{question.passage.title}</h2>
          <p className="whitespace-pre-wrap text-sm">{question.passage.body}</p>
        </section>
      ) : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (answerable && !outcome) submit();
        }}
      >
        <fieldset disabled={pending || outcome !== null} className="space-y-4">
          <legend className="mb-2 space-y-1">
            <span className="flex items-center gap-2 text-xs text-muted">
              <span>{topicLabel}</span>
              <span aria-hidden="true">·</span>
              <span>{question.displayCode}</span>
            </span>
            <span className="block text-base font-medium whitespace-pre-wrap">{question.stem}</span>
          </legend>

          {numeric ? (
            <label className="flex max-w-xs flex-col gap-1 text-sm">
              <span className="font-medium">Your answer</span>
              <input
                type="text"
                inputMode="decimal"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                aria-describedby={question.numericUnit ? `${formId}-unit` : undefined}
                className="h-11 rounded-md border border-border bg-surface px-3"
              />
              {question.numericUnit ? (
                <span id={`${formId}-unit`} className="text-xs text-muted">
                  In {question.numericUnit}.
                </span>
              ) : null}
            </label>
          ) : (
            <ul className="space-y-2">
              {question.options.map((option, index) => {
                const picked = chosen.includes(index);
                const isKey = outcome?.correctOptionIndexes.includes(index) ?? false;
                return (
                  <li key={index}>
                    <label
                      className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${
                        outcome && isKey
                          ? "border-success/50 bg-success-subtle"
                          : outcome && picked
                            ? "border-danger/50 bg-danger-subtle"
                            : "border-border bg-surface"
                      }`}
                    >
                      <input
                        type={single ? "radio" : "checkbox"}
                        name={`${formId}-answer`}
                        checked={picked}
                        onChange={() =>
                          setChosen((current) =>
                            single
                              ? [index]
                              : current.includes(index)
                                ? current.filter((i) => i !== index)
                                : [...current, index].sort((a, b) => a - b),
                          )
                        }
                        className="mt-0.5"
                      />
                      <span className="flex-1 whitespace-pre-wrap">{option}</span>
                      {/* In words, never colour alone. */}
                      {outcome && isKey ? (
                        <span className="text-xs font-medium text-success">Correct answer</span>
                      ) : null}
                      {outcome && picked && !isKey ? (
                        <span className="text-xs font-medium text-danger">You chose this</span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>

        {error ? (
          <p role="alert" className="mt-3 rounded-md border border-danger/30 bg-danger-subtle p-3 text-sm text-danger">
            {error}
          </p>
        ) : null}

        {outcome === null ? (
          <Button type="submit" className="mt-4" loading={pending} disabled={!answerable}>
            Check my answer
          </Button>
        ) : null}
      </form>

      {outcome ? (
        <section
          ref={explanationRef as never}
          tabIndex={-1}
          aria-label={outcome.correct ? "Correct, with the working" : "Not right, with the working"}
          className="space-y-3 rounded-xl border border-border bg-surface p-4"
        >
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={outcome.correct ? "success" : "warning"}>{outcome.correct ? "Correct" : "Not right"}</Badge>
            {numeric && outcome.numericAnswer !== null ? (
              <span className="text-sm">
                The answer is <strong>{outcome.numericAnswer}</strong>
                {question.numericUnit ? ` ${question.numericUnit}` : ""}.
              </span>
            ) : null}
            {outcome.xpAwarded > 0 ? <span className="text-sm text-success">+{outcome.xpAwarded} XP</span> : null}
            {outcome.xpReason === "already_paid" ? (
              <span className="text-xs text-muted">You have already earned XP for this question.</span>
            ) : null}
            {outcome.xpReason === "daily_cap" ? (
              <span className="text-xs text-muted">
                You have reached today&apos;s aptitude XP cap. The practice still counts toward your topic accuracy.
              </span>
            ) : null}
          </div>

          <div>
            <h2 className="mb-1 text-sm font-semibold">How it is done</h2>
            <p className="whitespace-pre-wrap text-sm">{outcome.explanation}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={() => router.refresh()}>
              Next question
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
