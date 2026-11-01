import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardBody, CardHeader, EmptyState, StatCard } from "@recx/design";
import { formatMarks } from "@recx/shared";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { describeScope, isEmptyScope } from "@/lib/auth/scope-where";
import { formatCampusDateTime } from "@/lib/help/copy";
import { getAssessmentDetail } from "@/server/queries/admin-assessments";
import { getAssessmentResults } from "@/server/queries/admin-assessment-results";

export const metadata: Metadata = { title: "Assessment results" };

const TD = "px-3 py-2";

/**
 * What a paper came to (Phase 12y).
 *
 * The gap this fills: `/admin/assessments/[id]` has shown the terms, the
 * questions and the halls since 12a, and `/admin/invigilate` shows the room
 * while the paper is being sat — and once the clock ran out there was
 * nowhere in the product that said who sat it or what they scored. The
 * marks existed (the multiple-choice half markable since 12r, the coding
 * half judged onto `Submission` rows) and nothing added them up for a human.
 *
 * Written for the person who set the paper: the band of marks first, then
 * the candidates, then the question-by-question breakdown that tells an
 * examiner whether a question was hard or simply wrong. No integrity band
 * and no "integrity score" anywhere — SPEC §5 keeps those on the review
 * surface, where a person decides, and off a results table where they would
 * be read as part of the mark.
 */
export default async function AssessmentResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { scope } = await requireAdminScopePage();
  const { id } = await params;
  const [assessment, results] = await Promise.all([
    getAssessmentDetail(id),
    getAssessmentResults(scope, id),
  ]);
  if (!assessment) notFound();

  const percent = (value: number | null) => (value === null ? "—" : `${Math.round(value)}%`);

  return (
    <div className="max-w-5xl space-y-6">
      <header className="space-y-2">
        <Link href={`/admin/assessments/${id}`} className="text-sm text-primary underline-offset-2 hover:underline">
          ← {assessment.title}
        </Link>
        <h1 className="font-display text-2xl font-bold tracking-tight">Results</h1>
        <p className="text-sm text-text-secondary">
          Out of <strong>{formatMarks(results.maxPoints)}</strong> marks · {assessment.slug}
        </p>
        <p className="text-sm text-muted">{describeScope(scope)}</p>
      </header>

      {isEmptyScope(scope) ? (
        <EmptyState
          title="You have no student scope"
          description="An administrator needs an active scope grant to see candidates. Ask a super-admin for one — this page is empty because of your access, not because nobody sat the paper."
        />
      ) : results.rows.length === 0 ? (
        <EmptyState
          title="Nobody has sat this paper yet"
          description="Results appear here as candidates hand in. A sitting still in progress is listed without a mark, because an unfinished paper has no result."
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Finished" value={results.finished} hint="Handed in, auto-submitted or ended." />
            <StatCard label="Still sitting" value={results.inProgress} hint="No mark yet, by design." />
            <StatCard label="Average" value={percent(results.averagePercent)} hint="Of the finished sittings." />
            <StatCard label="Median" value={percent(results.medianPercent)} />
          </div>

          {results.provisional > 0 ? (
            <p className="rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm">
              <strong>{results.provisional}</strong>{" "}
              {results.provisional === 1 ? "result is" : "results are"} provisional: a question is still being judged,
              so the mark can still go up. It is marked on the row.
            </p>
          ) : null}
          {results.needsAttention > 0 ? (
            <p className="rounded-lg border border-danger/40 bg-danger-subtle p-3 text-sm">
              <strong>{results.needsAttention}</strong>{" "}
              {results.needsAttention === 1 ? "answer needs" : "answers need"} a person: the judge failed on it, or the
              answer recorded was not one of the options shown. Neither is the candidate&apos;s fault and neither is
              scored as wrong — rejudge from <Link className="underline" href="/admin/judge">the judge page</Link>, or
              correct the paper.
            </p>
          ) : null}

          <Card>
            <CardHeader title={`Candidates (${results.rows.length})`} subtitle="Oldest sitting first." />
            <CardBody>
              <div role="region" tabIndex={0} aria-label="Candidates" className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[48rem] text-left text-sm">
                  <caption className="sr-only">Every candidate who sat this paper, with their marks</caption>
                  <thead className="bg-primary-subtle/40 text-xs uppercase tracking-wide text-text-secondary">
                    <tr>
                      <th scope="col" className={TD}>Roll number</th>
                      <th scope="col" className={TD}>Candidate</th>
                      <th scope="col" className={TD}>Sitting</th>
                      <th scope="col" className={TD}>Handed in</th>
                      <th scope="col" className={TD}>Marks</th>
                      <th scope="col" className={TD}>%</th>
                      <th scope="col" className={TD}>Of which code</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.rows.map((row) => (
                      <tr key={row.attemptId} className="border-t border-border align-top">
                        <th scope="row" className={`${TD} font-mono text-xs`}>{row.collegeId}</th>
                        <td className={TD}>
                          {row.name}
                          {row.hall ? <span className="block text-xs text-muted">{row.hall}{row.seatLabel ? ` · ${row.seatLabel}` : ""}</span> : null}
                        </td>
                        <td className={TD}>
                          <span className="text-xs">{row.status.replace(/_/g, " ").toLowerCase()}</span>
                          {row.attemptNumber > 1 ? (
                            <span className="block text-xs text-muted">attempt {row.attemptNumber}</span>
                          ) : null}
                        </td>
                        <td className={`${TD} text-xs`}>
                          {row.submittedAt ? formatCampusDateTime(row.submittedAt) : "—"}
                        </td>
                        <td className={`${TD} tabular-nums`}>
                          {row.result === null ? (
                            <span className="text-muted">still sitting</span>
                          ) : (
                            <>
                              <strong>{formatMarks(row.result.points)}</strong>
                              <span className="text-muted"> / {formatMarks(row.result.maxPoints)}</span>
                              {row.result.provisional ? (
                                <Badge tone="warning" className="ml-2">provisional</Badge>
                              ) : null}
                            </>
                          )}
                        </td>
                        <td className={`${TD} tabular-nums`}>{row.result ? percent(row.result.percent) : "—"}</td>
                        <td className={`${TD} text-xs`}>
                          {row.result === null
                            ? "—"
                            : `${row.result.coding.accepted} accepted · ${row.result.coding.partial} partial · ${row.result.coding.rejected} wrong · ${row.result.coding.blank} blank`}
                          {row.result && row.result.mcq.maxPoints > 0 ? (
                            <span className="block text-muted">
                              MCQ {row.result.mcq.correct}/{row.result.mcq.marks.length} right
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Question by question"
              subtitle="Over the finished sittings. A question everybody missed is usually a question, not a cohort."
            />
            <CardBody>
              <div role="region" tabIndex={0} aria-label="Question statistics" className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <caption className="sr-only">How the cohort did on each question</caption>
                  <thead className="bg-primary-subtle/40 text-xs uppercase tracking-wide text-text-secondary">
                    <tr>
                      <th scope="col" className={TD}>#</th>
                      <th scope="col" className={TD}>Question</th>
                      <th scope="col" className={TD}>Marks</th>
                      <th scope="col" className={TD}>Full</th>
                      <th scope="col" className={TD}>Part</th>
                      <th scope="col" className={TD}>None</th>
                      <th scope="col" className={TD}>Blank</th>
                      <th scope="col" className={TD}>Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.questions.map((q) => (
                      <tr key={`${q.kind}-${q.position}`} className="border-t border-border">
                        <td className={`${TD} tabular-nums`}>{q.position}</td>
                        <td className={TD}>
                          {q.kind === "mcq" ? <Badge tone="info" className="mr-2">choice</Badge> : null}
                          {q.label}
                        </td>
                        <td className={`${TD} tabular-nums`}>{formatMarks(q.maxPoints)}</td>
                        <td className={`${TD} tabular-nums`}>{q.fullMarks}</td>
                        <td className={`${TD} tabular-nums`}>{q.kind === "mcq" ? "—" : q.partial}</td>
                        <td className={`${TD} tabular-nums`}>{q.zero}</td>
                        <td className={`${TD} tabular-nums`}>{q.blank}</td>
                        <td className={`${TD} tabular-nums`}>{q.open > 0 ? q.open : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted">
                <strong>Blank</strong> is a question nobody answered — which on a timed paper usually means they never
                reached it. <strong>Open</strong> is still being judged, or the judge failed on it; neither is counted
                as a wrong answer.
              </p>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
