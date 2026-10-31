import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@recx/design";
import { APTITUDE_AREA_LABEL, APTITUDE_TOPIC_LABEL } from "@recx/shared";
import { requirePageRole } from "@/lib/auth/guards";
import { getAptitudeQuestion } from "@/server/queries/admin-aptitude";
import { AdminPageHeader, formatDateTime } from "@/components/admin/admin-ui";
import { QuestionActions } from "@/components/admin/aptitude/question-actions";

export const metadata: Metadata = { title: "Aptitude question" };

/**
 * `/admin/aptitude/[questionId]` — one question, with its key and its
 * working (Phase 7d).
 *
 * The one staff page that shows an answer key, which is why it is one
 * question rather than a list and why it lives behind the `admin-` query
 * module. `tests/repo/aptitude-answer-exposure.test.ts` allows
 * `admin-aptitude.ts` to select the key for exactly this; a page under
 * `(student)` could not.
 */
export default async function AptitudeQuestionPage({
  params,
}: {
  params: Promise<{ questionId: string }>;
}) {
  const actor = await requirePageRole("ADMIN", "SUPER_ADMIN");
  const { questionId } = await params;
  const question = await getAptitudeQuestion(questionId);
  if (!question) notFound();

  const numeric = question.kind === "NUMERIC_ENTRY";
  const stat = question.stat;

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title={question.displayCode}
        description={`${APTITUDE_TOPIC_LABEL[question.topic]} · ${APTITUDE_AREA_LABEL[question.area]} · ${question.kind
          .toLowerCase()
          .replaceAll("_", " ")} · ${question.difficulty.toLowerCase()}`}
        back={{ href: "/admin/aptitude", label: "Aptitude bank" }}
        actions={
          <Badge tone={question.status === "PUBLISHED" ? "success" : question.status === "RETIRED" ? "default" : "info"}>
            {question.status.toLowerCase().replace("_", " ")}
          </Badge>
        }
      />

      {question.passage ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Passage: {question.passage.title}</h2>
          <p className="whitespace-pre-wrap rounded-md border border-border bg-surface p-4 text-sm">
            {question.passage.body}
          </p>
          <p className="text-xs text-muted">{question.passage.wordCount} words</p>
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Question</h2>
        <p className="whitespace-pre-wrap rounded-md border border-border bg-surface p-4 text-sm">{question.stem}</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{numeric ? "Answer" : "Options"}</h2>
        {numeric ? (
          <p className="rounded-md border border-border bg-surface p-4 text-sm">
            {question.numericAnswer?.toString()}
            {question.numericUnit ? ` ${question.numericUnit}` : ""}
            <span className="ml-2 text-muted">
              within {question.numericTolerance?.toString() ?? "0"}
              {question.numericTolerance?.toString() === "0" ? " (exactly)" : ""}
            </span>
          </p>
        ) : (
          <ol className="space-y-1 text-sm">
            {question.options.map((option, index) => {
              const correct = question.correctOptionIndexes.includes(index);
              return (
                <li
                  key={index}
                  className={`rounded-md border p-3 ${correct ? "border-success/40 bg-success-subtle" : "border-border bg-surface"}`}
                >
                  <span className="mr-2 font-mono text-xs text-muted">{index + 1}</span>
                  {option}
                  {/* Marked in words as well as in colour: a reviewer using a
                      screen reader needs to hear which option is the key
                      (docs/ACCESSIBILITY.md §1). */}
                  {correct ? <span className="ml-2 text-xs font-medium text-success">Correct</span> : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-border p-4 text-sm">
          <h2 className="mb-2 text-sm font-semibold">How it has performed</h2>
          {stat && stat.timesAnswered > 0 ? (
            <ul className="space-y-1 text-text-secondary">
              <li>Served {stat.timesServed} times</li>
              <li>Answered {stat.timesAnswered} times</li>
              <li>
                Correct {stat.timesCorrect} times (
                {Math.round((stat.timesCorrect / stat.timesAnswered) * 1000) / 10}%)
              </li>
              <li>
                Average {Math.round(stat.totalSeconds / stat.timesAnswered)}s against an expected{" "}
                {question.expectedSeconds}s
              </li>
            </ul>
          ) : (
            <p className="text-text-secondary">
              Nobody has answered it yet. An accuracy near 99% or near 3% is how a dud question gets found, so this is
              worth coming back to.
            </p>
          )}
        </div>
        <div className="rounded-md border border-border p-4 text-sm">
          <h2 className="mb-2 text-sm font-semibold">Provenance</h2>
          <ul className="space-y-1 text-text-secondary">
            <li>Origin: {question.origin.toLowerCase().replace("_", " ")}</li>
            {question.sourceBatch ? <li>Batch: {question.sourceBatch}</li> : null}
            <li>Created {formatDateTime(question.createdAt)}</li>
            {question.publishedAt ? <li>Published {formatDateTime(question.publishedAt)}</li> : null}
            {question.retiredAt ? <li>Retired {formatDateTime(question.retiredAt)}</li> : null}
          </ul>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Worked explanation</h2>
        {question.explanation.trim().length === 0 ? (
          <p className="rounded-md border border-warning/30 bg-warning-subtle p-3 text-sm text-warning">
            This question has no worked explanation, so it cannot be published. A student who gets it wrong needs the
            working, not a tick.
          </p>
        ) : (
          <p className="whitespace-pre-wrap rounded-md border border-border bg-surface p-4 text-sm">
            {question.explanation}
          </p>
        )}
      </section>

      <QuestionActions
        questionId={question.id}
        status={question.status}
        canPublish={actor.role === "SUPER_ADMIN"}
        explanation={question.explanation}
      />
    </div>
  );
}
