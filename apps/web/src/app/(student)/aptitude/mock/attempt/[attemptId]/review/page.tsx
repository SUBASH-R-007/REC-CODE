import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@recx/design";
import { APTITUDE_TOPIC_LABEL, formatCampusTime } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { sittingReviewFor } from "@/server/queries/aptitude-sitting";
import { PatternNotice } from "@/components/aptitude/pattern-notice";

export const metadata: Metadata = { title: "Mock result" };

/**
 * `/aptitude/mock/attempt/[attemptId]/review` — the result, and every
 * question with its working (Phase 7e).
 *
 * The only student path that may select the answer key, and the query checks
 * `status` and `finalizedAt` in its WHERE before it selects — the gate is in
 * the read, not in this component, which is why
 * `tests/repo/aptitude-answer-exposure.test.ts` can allow that one file.
 *
 * What the page says and how it says it is the point of the phase. A
 * candidate who missed one section's cutoff is told WHICH section and by how
 * much, because "not cleared" on its own teaches nothing. Every question
 * shows the working, right or wrong: the student who got it right by guessing
 * needs it as much as the one who got it wrong.
 */
export default async function MockReviewPage({ params }: { params: Promise<{ attemptId: string }> }) {
  const user = await requireUser();
  const { attemptId } = await params;
  const review = await sittingReviewFor(attemptId, user.id);
  if (!review) notFound();

  const bySection = new Map<number, typeof review.answers>();
  for (const answer of review.answers) {
    const position = answer.sectionState.position;
    bySection.set(position, [...(bySection.get(position) ?? []), answer]);
  }
  const failed = review.sectionStates.filter((state) => state.passedCutoff === false);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <Link href={`/aptitude/mock/${review.pattern.slug}`} className="text-sm text-text-secondary hover:underline">
          ← {review.pattern.name}
        </Link>
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {review.percent}% · {review.passedOverall ? "cleared" : "not cleared"}
        </h1>
        <PatternNotice notice={review.notice} />
        <p className="text-sm text-text-secondary">
          {review.totalRaw} of {review.totalMax} marks, finished {formatCampusTime(review.finalizedAt)}.
        </p>

        {review.passedOverall ? (
          <p className="max-w-3xl text-sm">
            You cleared every section&apos;s cutoff. That is what clearing this round means — not a high total.
          </p>
        ) : failed.length > 0 ? (
          <p className="max-w-3xl text-sm">
            You cleared {review.sectionsPassed} of {review.sectionStates.length} sections. A high total does not make
            up for a section below its cutoff, because the real round works the same way — so the useful thing to
            practise next is{" "}
            <strong>
              {failed
                .map((state) => state.section.label)
                .join(" and ")}
            </strong>
            .
          </p>
        ) : null}
      </header>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">Section by section</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <caption className="sr-only">Your score in each section, against its cutoff</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="py-2 pr-3">
                  Section
                </th>
                <th scope="col" className="py-2 pr-3">
                  Right
                </th>
                <th scope="col" className="py-2 pr-3">
                  Wrong
                </th>
                <th scope="col" className="py-2 pr-3">
                  Blank
                </th>
                <th scope="col" className="py-2 pr-3">
                  Score
                </th>
                <th scope="col" className="py-2">
                  Cutoff
                </th>
              </tr>
            </thead>
            <tbody>
              {review.sectionStates.map((state) => (
                <tr key={state.position} className="border-b border-border last:border-0">
                  <td className="py-2 pr-3 font-medium">{state.section.label}</td>
                  <td className="py-2 pr-3">{state.correctCount}</td>
                  <td className="py-2 pr-3">
                    {state.wrongCount}
                    {state.section.negativeMarkFraction > 0 && state.wrongCount > 0 ? (
                      <span className="ml-1 text-xs text-warning">(cost you marks)</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    {state.unansweredCount}
                    {state.unansweredCount > 0 ? <span className="ml-1 text-xs text-muted">(no penalty)</span> : null}
                  </td>
                  <td className="py-2 pr-3">
                    {state.percent}% <span className="text-xs text-muted">({state.rawScore}/{state.maxScore})</span>
                  </td>
                  <td className="py-2">
                    {/* In words as well as colour. */}
                    {state.section.cutoffPercent > 0 ? (
                      <Badge tone={state.passedCutoff ? "success" : "warning"}>
                        {state.passedCutoff ? `cleared ${state.section.cutoffPercent}%` : `needed ${state.section.cutoffPercent}%`}
                      </Badge>
                    ) : (
                      <span className="text-muted">no cutoff</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {[...bySection.entries()]
        .sort(([a], [b]) => a - b)
        .map(([position, answers]) => {
          const state = review.sectionStates.find((row) => row.position === position);
          return (
            <section key={position} className="space-y-4">
              <h2 className="font-display text-lg font-semibold">{state?.section.label ?? `Section ${position}`}</h2>
              <ol className="space-y-5">
                {answers.map((answer) => {
                  const question = answer.question;
                  const numeric = question.kind === "NUMERIC_ENTRY";
                  const blank = answer.selectedIndexes.length === 0 && answer.numericValue === null;
                  const seconds =
                    answer.answeredAtMs === null
                      ? null
                      : Math.max(0, Math.round((answer.answeredAtMs - answer.firstSeenAtMs) / 1000));
                  return (
                    <li key={`${position}-${answer.position}`} className="space-y-2 rounded-xl border border-border p-4">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                        <span>Question {answer.position + 1}</span>
                        <span aria-hidden="true">·</span>
                        <span>{APTITUDE_TOPIC_LABEL[question.topic]}</span>
                        <span aria-hidden="true">·</span>
                        <span>{question.displayCode}</span>
                        {seconds !== null ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{seconds}s</span>
                          </>
                        ) : null}
                        <Badge tone={blank ? "default" : answer.isCorrect ? "success" : "warning"}>
                          {blank ? "left blank" : answer.isCorrect ? "right" : "not right"}
                        </Badge>
                      </div>

                      {question.passage ? (
                        <details className="rounded-md border border-border bg-surface p-3">
                          <summary className="cursor-pointer text-sm font-medium">
                            The passage: {question.passage.title}
                          </summary>
                          <p className="mt-2 whitespace-pre-wrap text-sm">{question.passage.body}</p>
                        </details>
                      ) : null}

                      <p className="whitespace-pre-wrap text-sm font-medium">{question.stem}</p>

                      {numeric ? (
                        <p className="text-sm">
                          {blank ? (
                            <span className="text-muted">You left this blank.</span>
                          ) : (
                            <>You answered {answer.numericValue?.toString()}. </>
                          )}
                          The answer is <strong>{question.numericAnswer?.toString()}</strong>.
                        </p>
                      ) : (
                        <ol className="space-y-1 text-sm">
                          {question.options.map((option, index) => {
                            const isKey = question.correctOptionIndexes.includes(index);
                            const chose = answer.selectedIndexes.includes(index);
                            return (
                              <li
                                key={index}
                                className={`rounded-md border p-2 ${
                                  isKey
                                    ? "border-success/40 bg-success-subtle"
                                    : chose
                                      ? "border-danger/40 bg-danger-subtle"
                                      : "border-border"
                                }`}
                              >
                                <span className="whitespace-pre-wrap">{option}</span>
                                {isKey ? <span className="ml-2 text-xs font-medium text-success">correct</span> : null}
                                {chose && !isKey ? (
                                  <span className="ml-2 text-xs font-medium text-danger">you chose this</span>
                                ) : null}
                              </li>
                            );
                          })}
                        </ol>
                      )}

                      {/* A disclosure with an accessible name, not a tooltip,
                          and open by default for a question that went wrong —
                          that is the one the student is here for. */}
                      <details open={blank || answer.isCorrect === false} className="rounded-md bg-surface p-3">
                        <summary className="cursor-pointer text-sm font-medium">How it is done</summary>
                        <p className="mt-2 whitespace-pre-wrap text-sm">{question.explanation}</p>
                      </details>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
    </div>
  );
}
