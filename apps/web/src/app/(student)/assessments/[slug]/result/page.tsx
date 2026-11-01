import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { formatCampusTime, formatMarks } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { myAssessmentResult } from "@/server/queries/my-assessment-result";

export const metadata: Metadata = { title: "Your result" };

/**
 * A candidate's own result (Phase 12y).
 *
 * Only once staff have released it — the gate is in the query's WHERE
 * clause, so an unreleased paper has no row to find and this page cannot
 * be made to show one by a caller that forgot to check.
 *
 * What is NOT here, deliberately: a rank, a cohort position, an average, a
 * percentile, and anything at all about integrity. Being 41st of 60 is not
 * something a student can act on, and SPEC §5 keeps bands and "integrity
 * scores" off every student surface. What they get is their own mark, what
 * each question came to, and — when a question is still being judged —
 * the fact that the number can still go up.
 *
 * The breakdown names the outcome, never the right answer: a student who
 * reads "wrong" learns what they need to, while one who reads which option
 * was correct is holding the key to a question the next cohort will sit.
 */

const OUTCOME_LABEL: Record<string, string> = {
  correct: "Right",
  wrong: "Wrong",
  blank: "Left blank",
  corrupt: "Not recorded properly — your department has been told",
  accepted: "Accepted",
  partial: "Partly right",
  rejected: "Not accepted",
  pending: "Still being judged",
  unjudged: "The judge could not finish this — your department has been told",
};

export default async function MyAssessmentResultPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const result = await myAssessmentResult({ userId: user.id, slug });

  if (result === null) {
    return (
      <div className="p-6">
        <h1 className="font-display text-2xl font-semibold text-text">Your result</h1>
        <div className="mt-6">
          <EmptyState
            title="Not out yet"
            description="Your department has not released the results for this assessment. Nothing is wrong and there is nothing to do — this page will show your marks when they do."
          />
        </div>
        <p className="mt-4 text-sm">
          <Link href="/assessments" className="text-primary underline-offset-2 hover:underline">
            ← Your assessments
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6 p-6">
      <header className="space-y-1">
        <Link href="/assessments" className="text-sm text-primary underline-offset-2 hover:underline">
          ← Your assessments
        </Link>
        <h1 className="font-display text-2xl font-semibold text-text">{result.assessmentTitle}</h1>
        <p className="text-sm text-text-secondary">
          {result.submittedAt ? `Handed in ${formatCampusTime(result.submittedAt)}` : "Not handed in"} · released{" "}
          {formatCampusTime(result.releasedAt)}
          {result.attemptNumber > 1 ? ` · attempt ${result.attemptNumber}` : ""}
        </p>
      </header>

      <Card>
        <CardHeader title="Your mark" />
        <CardBody className="space-y-3">
          <p className="font-display text-4xl font-bold tabular-nums">
            {formatMarks(result.points)}
            <span className="text-xl font-normal text-muted"> / {formatMarks(result.maxPoints)}</span>
          </p>
          {result.percent !== null ? (
            <p className="text-sm text-text-secondary">{Math.round(result.percent)}%</p>
          ) : null}
          {result.provisional ? (
            <p className="rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm">
              One of your answers is still being judged, so this mark can still go up. Nothing is required from you.
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Question by question" subtitle="What each question came to." />
        <CardBody>
          <ul className="divide-y divide-border">
            {result.questions.map((question, index) => (
              <li key={`${question.kind}-${question.position}-${index}`} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
                <div>
                  <p className="text-sm font-medium">
                    {question.position}. {question.label}
                  </p>
                  <p className="text-xs text-text-secondary">{OUTCOME_LABEL[question.outcome] ?? question.outcome}</p>
                </div>
                <p className="tabular-nums text-sm">
                  {formatMarks(question.points)}
                  <span className="text-muted"> / {formatMarks(question.maxPoints)}</span>
                  {question.outcome === "pending" ? (
                    <Badge tone="warning" className="ml-2">judging</Badge>
                  ) : null}
                </p>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <p className="text-xs text-muted">
        This is your own result. It shows no rank and no comparison with anybody else, and your department sees the
        same marks you do. If you think a question was marked wrongly, speak to them — they can correct it.
      </p>
    </div>
  );
}
