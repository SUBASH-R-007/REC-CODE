"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button } from "@recx/design";
import { advanceMockSection, finaliseMockAttempt, saveMockAnswer, serveMockQuestion } from "@/server/actions/aptitude";
import type { SittingView } from "@/server/queries/aptitude-sitting";
import { MockPalette, type PaletteEntry } from "@/components/aptitude/mock-palette";
import { PatternNotice } from "@/components/aptitude/pattern-notice";
import { SectionClock } from "@/components/aptitude/section-clock";

/**
 * Sitting a mock (Phase 7e).
 *
 * Everything authoritative is the server's: which question may be served
 * (`serveMockQuestion` raises the high-water mark), whether an answer may be
 * written (`canAnswer` plus a trigger), and how long is left (the clock
 * route). This component renders and asks; it decides nothing.
 *
 * The one rule a candidate feels most: where the section forbids going back
 * there is NO Previous control — absent and explained, never
 * present-and-disabled-in-silence, which is the version a screen-reader user
 * cannot make sense of (`docs/ACCESSIBILITY.md`).
 */

export function MockSitting({ view }: { view: SittingView }) {
  const router = useRouter();
  const formId = useId();
  const [index, setIndex] = useState(() => Math.min(view.highWaterIndex, Math.max(0, view.questions.length - 1)));
  const [chosen, setChosen] = useState<Record<number, number[]>>({});
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [marked, setMarked] = useState<Record<number, boolean>>({});
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "refused">("idle");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const stemRef = useRef<HTMLDivElement | null>(null);

  // Seed from what the server already has, so a reload is the same paper in
  // the same state.
  useEffect(() => {
    const seededChosen: Record<number, number[]> = {};
    const seededTyped: Record<number, string> = {};
    const seededMarked: Record<number, boolean> = {};
    for (const question of view.questions) {
      seededChosen[question.index] = [...question.chosenShownIndexes];
      seededTyped[question.index] = question.numericValue ?? "";
      seededMarked[question.index] = question.markedForReview;
    }
    setChosen(seededChosen);
    setTyped(seededTyped);
    setMarked(seededMarked);
  }, [view.questions]);

  const question = view.questions.find((entry) => entry.index === index) ?? view.questions[0];

  // Tell the server what it has served, which is what raises the high-water
  // mark — the column that makes `allowBackNavigation: false` enforceable.
  useEffect(() => {
    if (!question) return;
    void serveMockQuestion({ attemptId: view.attemptId, index: question.index });
  }, [question?.index, view.attemptId, question]);

  const entries = useMemo<PaletteEntry[]>(
    () =>
      view.questions.map((entry) => {
        const answered =
          (chosen[entry.index]?.length ?? 0) > 0 || (typed[entry.index] ?? "").trim().length > 0;
        const isMarked = marked[entry.index] ?? false;
        const reachable = view.allowBackNavigation
          ? entry.index <= view.highWaterIndex
          : entry.index === Math.max(view.highWaterIndex, index);
        return {
          index: entry.index,
          reachable,
          state: !reachable
            ? "locked"
            : answered && isMarked
              ? "answered-marked"
              : answered
                ? "answered"
                : isMarked
                  ? "marked"
                  : "unanswered",
        };
      }),
    [view.questions, view.allowBackNavigation, view.highWaterIndex, chosen, typed, marked, index],
  );

  const save = useCallback(
    (over: { shown?: number[]; value?: string; mark?: boolean } = {}) => {
      if (!question) return;
      const shown = over.shown ?? chosen[question.index] ?? [];
      const value = over.value ?? typed[question.index] ?? "";
      const mark = over.mark ?? marked[question.index] ?? false;
      setSaving("saving");
      setRefusal(null);
      void (async () => {
        const result = await saveMockAnswer({
          attemptId: view.attemptId,
          questionId: question.questionId,
          shownIndexes: question.kind === "NUMERIC_ENTRY" ? [] : shown,
          numericValue: question.kind === "NUMERIC_ENTRY" && value.trim() !== "" ? Number(value) : null,
          markedForReview: mark,
        });
        if (result.ok) setSaving("saved");
        else {
          setSaving("refused");
          setRefusal(result.error);
        }
      })();
    },
    [question, chosen, typed, marked, view.attemptId],
  );

  const goTo = (next: number) => {
    setIndex(next);
    setSaving("idle");
    stemRef.current?.focus();
  };

  const onExpired = useCallback(() => {
    // The section's clock ran out. The server has already stopped accepting
    // answers; refreshing shows the next section, or the result.
    router.refresh();
  }, [router]);

  const advance = () => {
    start(async () => {
      const result = await advanceMockSection({ attemptId: view.attemptId });
      if (result.ok) router.refresh();
      else setRefusal(result.error);
    });
  };

  const finish = () => {
    start(async () => {
      const result = await finaliseMockAttempt({ attemptId: view.attemptId });
      if (result.ok) router.push(`/aptitude/mock/attempt/${view.attemptId}/review`);
      else setRefusal(result.error);
    });
  };

  if (!question) {
    return (
      <p className="rounded-md border border-border p-4 text-sm">
        This section has no questions on your paper. Nothing you did caused this — tell the placement cell.
      </p>
    );
  }

  const numeric = question.kind === "NUMERIC_ENTRY";
  const single = question.kind === "SINGLE_CHOICE" || question.kind === "PASSAGE_GROUPED";
  const canGoBack = view.allowBackNavigation && index > 0;

  return (
    <div className="space-y-6">
      <header className="space-y-2 border-b border-border pb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-xs text-muted">
              {view.patternName} · section {view.sectionPosition} of {view.sectionCount}
            </p>
            <h1 className="font-display text-xl font-bold tracking-tight">{view.sectionLabel}</h1>
          </div>
          <SectionClock
            attemptId={view.attemptId}
            initialMs={view.msRemainingInSection}
            sectionLimitSec={Math.max(60, Math.round(view.msRemainingInSection / 1000) || 60)}
            onExpired={onExpired}
          />
        </div>

        {/* The scoring rule, as TEXT, in the section header — a scoring rule a
            student cannot read is not a fair rule. */}
        <p className="text-sm text-text-secondary">
          {view.questionCount} questions.{" "}
          {view.cutoffPercent > 0 ? `You need ${view.cutoffPercent}% in this section. ` : "No cutoff in this section. "}
          {view.negativeMarkFraction > 0
            ? `A wrong answer loses ${view.negativeMarkFraction * view.marksPerCorrect} mark. Leaving a question blank costs nothing.`
            : "Wrong answers do not lose marks."}
        </p>
        {!view.allowBackNavigation ? (
          <p className="text-sm text-warning">
            This section does not let you return to an earlier question, so there is no Previous control. That was
            stated on the cover page before you started.
          </p>
        ) : null}
        <PatternNotice notice={view.notice} />
      </header>

      {question.passage ? (
        <section
          role="region"
          aria-label={`Passage: ${question.passage.title}`}
          tabIndex={0}
          className="max-h-64 overflow-y-auto rounded-xl border border-border bg-surface p-4"
        >
          <h2 className="mb-2 text-sm font-semibold">{question.passage.title}</h2>
          <p className="whitespace-pre-wrap text-sm">{question.passage.body}</p>
        </section>
      ) : null}

      <form onSubmit={(event) => event.preventDefault()}>
        <fieldset disabled={view.sectionClosed}>
          <legend className="mb-3 space-y-1">
            <span className="text-xs text-muted">
              Question {question.index + 1} of {view.questionCount}
            </span>
            <span
              ref={stemRef as never}
              tabIndex={-1}
              className="block text-base font-medium whitespace-pre-wrap outline-none"
            >
              {question.stem}
            </span>
          </legend>

          {numeric ? (
            <label className="flex max-w-xs flex-col gap-1 text-sm">
              <span className="font-medium">Your answer</span>
              <input
                type="text"
                inputMode="decimal"
                value={typed[question.index] ?? ""}
                onChange={(event) => {
                  const value = event.target.value;
                  setTyped((current) => ({ ...current, [question.index]: value }));
                }}
                onBlur={() => save()}
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
              {question.options.map((option, shown) => {
                const picked = (chosen[question.index] ?? []).includes(shown);
                return (
                  <li key={shown}>
                    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface p-3 text-sm">
                      <input
                        type={single ? "radio" : "checkbox"}
                        name={`${formId}-q${question.index}`}
                        checked={picked}
                        onChange={() => {
                          const current = chosen[question.index] ?? [];
                          const next = single
                            ? [shown]
                            : current.includes(shown)
                              ? current.filter((i) => i !== shown)
                              : [...current, shown].sort((a, b) => a - b);
                          setChosen((all) => ({ ...all, [question.index]: next }));
                          save({ shown: next });
                        }}
                        className="mt-0.5"
                      />
                      <span className="flex-1 whitespace-pre-wrap">{option}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        {/* ABSENT, not disabled, where the section forbids it. */}
        {canGoBack ? (
          <Button type="button" variant="secondary" onClick={() => goTo(index - 1)}>
            Previous
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            const next = !(marked[question.index] ?? false);
            setMarked((all) => ({ ...all, [question.index]: next }));
            save({ mark: next });
          }}
        >
          {marked[question.index] ? "Unmark" : "Mark for review"}
        </Button>
        {index + 1 < view.questions.length ? (
          <Button type="button" onClick={() => goTo(index + 1)}>
            Next
          </Button>
        ) : null}

        <span aria-live="polite" className="text-xs text-text-secondary">
          {saving === "saving"
            ? "Saving…"
            : saving === "saved"
              ? "Saved"
              : saving === "refused"
                ? "Not saved"
                : ""}
        </span>
      </div>

      {refusal ? (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm text-warning">
          {refusal}
        </p>
      ) : null}

      <section className="space-y-3 border-t border-border pt-4">
        <h2 className="text-sm font-semibold">This section&apos;s questions</h2>
        <MockPalette entries={entries} current={index} onGo={goTo} />
      </section>

      <section className="space-y-2 border-t border-border pt-4">
        {view.isLastSection ? (
          <>
            <p className="text-sm text-text-secondary">
              Finishing scores every section and shows you each question with its working. You cannot come back to it.
            </p>
            <Button type="button" loading={pending} onClick={finish}>
              Finish and see the working
            </Button>
          </>
        ) : (
          <>
            <p className="text-sm text-text-secondary">
              Moving on closes this section for good and starts the next one&apos;s clock. Anything unanswered here
              stays unanswered — and costs you nothing extra.
            </p>
            <Button type="button" variant="secondary" loading={pending} onClick={advance}>
              Close this section and go on
            </Button>
          </>
        )}
        {view.sectionClosed ? (
          <Badge tone="info">This section has closed. Your answers in it are saved and scored.</Badge>
        ) : null}
      </section>
    </div>
  );
}
