import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { formatMarks } from "@recx/shared";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { formatCampusDateTime } from "@/lib/help/copy";
import { getAttemptScript, type ScriptAnswer } from "@/server/queries/admin-attempt-script";

export const metadata: Metadata = { title: "Answer script" };

/**
 * One candidate's answer script (Phase 13h.1).
 *
 * The marked paper, in the candidate's own numbering: what they were
 * asked, what they answered, and what it earned. See
 * `src/server/queries/admin-attempt-script.ts` for why it exists, why it
 * is empty while the paper is still being sat, and why every open writes
 * an audit row.
 *
 * No band and no integrity score, as everywhere beside a mark (SPEC §5):
 * what was watched during the sitting is one click away on the audit page,
 * and the verdict is on `/admin/integrity`, where a human reaches it with
 * the reasoning beside them.
 */

const OUTCOME: Record<string, { label: string; tone: "default" | "info" | "success" | "warning" | "danger" }> = {
  correct: { label: "Right", tone: "success" },
  wrong: { label: "Wrong", tone: "danger" },
  blank: { label: "Left blank", tone: "default" },
  corrupt: { label: "Not recorded properly", tone: "warning" },
  accepted: { label: "Accepted", tone: "success" },
  partial: { label: "Partly right", tone: "info" },
  rejected: { label: "Not accepted", tone: "danger" },
  pending: { label: "Still being judged", tone: "warning" },
  unjudged: { label: "The judge failed on it", tone: "warning" },
};

function Marks({ answer }: { answer: ScriptAnswer }) {
  return (
    <span className="tabular-nums text-sm">
      <strong>{formatMarks(answer.points)}</strong>
      <span className="text-muted"> / {formatMarks(answer.maxPoints)}</span>
    </span>
  );
}

export default async function AttemptScriptPage({
  params,
}: {
  params: Promise<{ id: string; attemptId: string }>;
}) {
  const { user, scope } = await requireAdminScopePage();
  const { id, attemptId } = await params;
  const script = await getAttemptScript(user.id, scope, attemptId);
  if (!script || script.assessmentId !== id) notFound();

  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-2">
        <Link
          href={`/admin/assessments/${id}/results`}
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          ← {script.assessmentTitle} · results
        </Link>
        <h1 className="font-display text-2xl font-bold tracking-tight">
          {script.name} <span className="font-mono text-base font-normal text-muted">{script.collegeId}</span>
        </h1>
        <p className="text-sm text-text-secondary">
          Answer script · {script.status.replace(/_/g, " ").toLowerCase()}
          {script.attemptNumber > 1 ? ` · attempt ${script.attemptNumber}` : ""} · started{" "}
          {formatCampusDateTime(script.startedAt)}
          {script.submittedAt ? ` · handed in ${formatCampusDateTime(script.submittedAt)}` : " · not handed in"}
          {script.hall ? ` · ${script.hall}${script.seatLabel ? ` · ${script.seatLabel}` : ""}` : ""}
        </p>
        <p className="text-sm">
          <Link
            href={`/admin/assessments/${id}/results/${script.attemptId}`}
            className="text-primary underline-offset-2 hover:underline"
          >
            What was watched during this sitting →
          </Link>
        </p>
        <p className="rounded-lg border border-border p-3 text-xs text-text-secondary">
          Your name and the time are recorded in the audit log every time this page is opened. The questions are
          numbered as this candidate saw them, which is not the order they were written in — their own number is
          beside each one.
        </p>
      </header>

      {!script.finished ? (
        <EmptyState
          title="This paper is still being sat"
          description="A script appears here once the sitting is over. While the clock is running, the live view is the invigilation page for the hall — reading a candidate's answers mid-paper is invigilation, and it belongs where an invigilator is already watching."
        />
      ) : script.layoutUnreadable ? (
        <EmptyState
          title="The stored paper will not parse"
          description="This sitting's frozen paper is a broken record, so nothing can be laid out from it and nothing here is guessed at. The marks for this candidate are incomplete for the same reason — the results page says so on their row."
        />
      ) : script.answers.length === 0 ? (
        <EmptyState
          title="Nothing was recorded for this sitting"
          description="The paper's questions are no longer the ones this candidate was shown, or the sitting ended before anything was stored."
        />
      ) : (
        <>
          <p className="text-sm">
            <strong className="tabular-nums">{formatMarks(script.points)}</strong>
            <span className="text-muted"> / {formatMarks(script.maxPoints)}</span> over{" "}
            {script.answers.length} {script.answers.length === 1 ? "question" : "questions"}.{" "}
            <span className="text-muted">
              A question still being judged earns nothing yet and is not a zero.
            </span>
          </p>

          {script.answers.map((answer) => {
            const outcome = OUTCOME[answer.outcome] ?? { label: answer.outcome, tone: "default" as const };
            return (
              <Card key={`${answer.kind}-${answer.position}`}>
                <CardHeader
                  title={`Question ${answer.position}${
                    answer.kind === "coding" ? ` · ${answer.displayCode} ${answer.title}` : " · choice"
                  }`}
                  subtitle={`Written as question ${answer.sourcePosition} on the paper`}
                  action={
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={outcome.tone}>{outcome.label}</Badge>
                      <Marks answer={answer} />
                    </span>
                  }
                />
                <CardBody>
                  {answer.kind === "mcq" ? (
                    <>
                      <p className="whitespace-pre-wrap text-sm text-text">{answer.stem}</p>
                      <ul className="mt-3 space-y-1.5">
                        {answer.options.map((option, index) => (
                          <li
                            key={index}
                            className={`flex items-start gap-2 rounded-lg border p-2 text-sm ${
                              option.chosen
                                ? option.correct
                                  ? "border-success/50 bg-success-subtle"
                                  : "border-danger/50 bg-danger-subtle"
                                : option.correct
                                  ? "border-success/40"
                                  : "border-border"
                            }`}
                          >
                            <span className="min-w-0 flex-1 whitespace-pre-wrap">{option.text}</span>
                            {option.chosen ? <Badge tone="info">Their answer</Badge> : null}
                            {option.correct ? <Badge tone="success">Correct</Badge> : null}
                          </li>
                        ))}
                      </ul>
                      {answer.outcome === "corrupt" ? (
                        <p className="mt-3 rounded-lg border border-warning/40 bg-warning-subtle p-2 text-sm">
                          What was stored for this question is not one of the options this candidate was shown. That
                          is not a wrong answer and it is not scored as one — it needs a person.
                        </p>
                      ) : null}
                      {answer.explanation ? (
                        <p className="mt-3 text-sm text-text-secondary">
                          <strong>Author&apos;s note:</strong> {answer.explanation}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <dl className="grid gap-3 text-sm sm:grid-cols-4">
                        <div>
                          <dt className="text-xs uppercase tracking-wide text-muted">Answered in</dt>
                          <dd className="mt-0.5">
                            {answer.language ? answer.language.label : <span className="text-muted">—</span>}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs uppercase tracking-wide text-muted">Accepted</dt>
                          <dd className="mt-0.5 text-xs">
                            {answer.accepted.length === 0 ? (
                              <span className="text-muted">any enabled language</span>
                            ) : (
                              answer.accepted.map((l) => l.shortLabel).join(", ")
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs uppercase tracking-wide text-muted">Tests passed</dt>
                          <dd className="mt-0.5 tabular-nums">
                            {answer.totalCases > 0 ? (
                              `${answer.passedCases} / ${answer.totalCases}`
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs uppercase tracking-wide text-muted">Handed in</dt>
                          <dd className="mt-0.5 text-xs">
                            {answer.handedInAt ? (
                              <>
                                {formatCampusDateTime(answer.handedInAt)}
                                {answer.handedIn > 1 ? (
                                  <span className="block text-muted">
                                    {answer.handedIn} times; the last one counts
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <span className="text-muted">never</span>
                            )}
                          </dd>
                        </div>
                      </dl>

                      <p className="mt-3 text-xs">
                        <Link
                          href={`/problems/${answer.slug}`}
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          The question as it was set →
                        </Link>
                      </p>

                      {answer.compileOutput ? (
                        <div className="mt-3">
                          <p className="text-xs uppercase tracking-wide text-muted">What the compiler said</p>
                          <pre className="mt-1 max-h-48 overflow-auto rounded-lg border border-border bg-elevated p-2 font-mono text-xs whitespace-pre-wrap">
                            {answer.compileOutput}
                          </pre>
                        </div>
                      ) : null}

                      {answer.source === null ? (
                        <p className="mt-3 text-sm text-muted">
                          {answer.purged
                            ? "Their program is no longer stored: sources are purged at the retention boundary, and the verdict above is what remains of it."
                            : "Nothing was handed in for this question."}
                        </p>
                      ) : (
                        <div className="mt-3">
                          <p className="text-xs uppercase tracking-wide text-muted">
                            Their program{" "}
                            <span className="normal-case tabular-nums">({answer.sourceBytes} bytes)</span>
                          </p>
                          <pre className="mt-1 max-h-[32rem] overflow-auto rounded-lg border border-border bg-elevated p-3 font-mono text-xs">
                            <code>{answer.source}</code>
                          </pre>
                        </div>
                      )}
                    </>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </>
      )}
    </div>
  );
}
