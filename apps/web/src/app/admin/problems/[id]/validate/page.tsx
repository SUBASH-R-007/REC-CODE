import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, CircleAlert, Clock, Info, XCircle } from "lucide-react";
import { Card, CardBody, CardHeader } from "@recx/design";
import { LANGUAGE_CATALOG, isLanguageKey } from "@recx/shared";
import { requirePageRole } from "@/lib/auth/guards";
import { getValidationReport } from "@/server/queries/admin-problems";
import { AutoRefresh } from "@/components/admin/auto-refresh";
import { ProblemNav } from "@/components/admin/problems/problem-nav";
import { ROUTE_ID, parseRev } from "@/components/admin/problems/rev";
import { StageBadge } from "@/components/admin/problems/stage-badge";
import { ValidationControls } from "@/components/admin/problems/validation-controls";

export const metadata: Metadata = { title: "Validation" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TIME = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

const PHASE_TEXT: Record<string, string> = {
  NOT_STARTED: "Validation has not run on the current content.",
  STAGE1_RUNNING: "Stage 1: model solutions are running at the CPU ceiling.",
  STAGE1_FAILED: "Stage 1 failed: a model solution did not pass.",
  STAGE2_NEEDED: "Stage 2: deliberately-wrong solutions are being queued at the derived limits.",
  STAGE2_RUNNING: "Stage 2: deliberately-wrong solutions are running at the derived limits.",
  COMPLETE: "Validation is complete.",
};

function languageLabel(key: string): string {
  return isLanguageKey(key) ? LANGUAGE_CATALOG[key].label : key;
}

/**
 * The validation report of a revision: what still blocks publishing (one
 * status region), every reference solution's expected and actual verdict
 * with its per-test strip and compile output, the derived per-language
 * limits, and the Validate / Publish controls. Refreshes itself while runs
 * are pending.
 */
export default async function ValidatePage({ params, searchParams }: Props) {
  const user = await requirePageRole("ADMIN", "SUPER_ADMIN");
  const { id } = await params;
  if (!ROUTE_ID.test(id)) notFound();
  const rev = parseRev((await searchParams).rev);
  const report = await getValidationReport({ id: user.id, role: user.role }, id, rev);
  if (!report) notFound();
  const { problem, readiness, references, limits } = report;
  const v = readiness.validation;
  const running = v.phase === "STAGE1_RUNNING" || v.phase === "STAGE2_RUNNING" || v.phase === "STAGE2_NEEDED";
  const live = readiness.frozen && readiness.stage === "PUBLISHED";

  return (
    <div className="space-y-6">
      <ProblemNav problemId={problem.id} displayCode={problem.displayCode} title={problem.title} current="validate" rev={rev} />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-bold tracking-tight">Validation</h1>
          <p className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
            Revision {readiness.revision} <StageBadge stage={readiness.stage} />
          </p>
        </div>
        {running && <AutoRefresh updatedLabel={`Updated ${TIME.format(new Date())} IST`} />}
      </header>

      <Card>
        <CardHeader title="Publish readiness" />
        <CardBody className="space-y-4">
          <div role="status" aria-live="polite" className="space-y-2 text-sm">
            {readiness.frozen ? (
              <p className="flex items-center gap-2 font-medium text-success">
                <CheckCircle2 className="h-4 w-4" aria-hidden />
                {live ? `Published revision ${readiness.revision}.` : `Revision ${readiness.revision} was published and has since been superseded or retired.`}
              </p>
            ) : (
              <>
                <p className="flex items-center gap-2 font-medium text-text">
                  {running ? <Clock className="h-4 w-4" aria-hidden /> : <Info className="h-4 w-4" aria-hidden />}
                  {PHASE_TEXT[v.phase] ?? v.phase}
                  {v.pending > 0 ? ` ${v.pending} run(s) pending.` : ""}
                </p>
                {readiness.blockers.length === 0 ? (
                  <p className="flex items-center gap-2 text-success">
                    <CheckCircle2 className="h-4 w-4" aria-hidden />
                    Ready to publish.
                  </p>
                ) : (
                  <>
                    <p className="font-medium text-text">Publishing is blocked:</p>
                    <ul className="space-y-1">
                      {readiness.blockers.map((b, n) => (
                        <li key={n} className="flex items-start gap-2 text-danger">
                          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                          <span>{b}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
            {v.notes.map((note, n) => (
              <p key={n} className="flex items-start gap-2 text-text-secondary">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {note}
              </p>
            ))}
          </div>
          {!readiness.frozen && (
            <ValidationControls
              versionId={readiness.versionId}
              canValidate={!readiness.frozen}
              publishable={readiness.publishable}
              expectedProblemVersion={readiness.problemVersion}
            />
          )}
          {!readiness.frozen && !readiness.approved && (
            <p className="text-sm text-text-secondary">
              Approval happens on the{" "}
              <Link href={`/admin/problems/${problem.id}${rev !== null ? `?rev=${rev}` : ""}`} className="text-primary hover:underline">
                problem page
              </Link>
              : a second admin approves once validation is complete.
            </p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Reference solutions" subtitle={`Only runs of the current content count (content generation ${v.judgeSeq}).`} />
        <CardBody>
          {references.length === 0 ? (
            <p className="text-sm text-text-secondary">No reference solutions yet.</p>
          ) : (
            <div role="region" tabIndex={0} aria-label="Validation results" className="overflow-x-auto">
              <table className="w-full min-w-[48rem] text-sm">
                <caption className="sr-only">Expected and actual verdict of every reference solution</caption>
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="py-2 pr-4">
                      Solution
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Expected
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Actual
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Outcome
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Worst time
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Per test
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {references.map((r) => (
                    <tr key={r.referenceId} className="border-t border-border align-top">
                      <td className="py-2 pr-4">
                        <div className="font-medium">{r.label ?? "Unlabelled"}</div>
                        <div className="font-mono text-xs text-muted">{languageLabel(r.language)}</div>
                        {!r.runnable && (
                          <div className="text-xs text-text-secondary">
                            Not run: {r.unrunnable === "no-harness" ? "this language has no function harness" : "this language is not enabled"}
                          </div>
                        )}
                        {r.run?.compileOutput && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-primary">Compiler output</summary>
                            <pre tabIndex={0} aria-label="Compiler output" className="mt-1 max-h-48 overflow-auto rounded-md bg-background p-2 text-[0.7rem]">
                              {r.run.compileOutput}
                            </pre>
                          </details>
                        )}
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.expected}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.run ? (r.run.verdict ?? r.run.status) : "—"}</td>
                      <td className="py-2 pr-4">
                        {!r.run ? (
                          <span className="text-muted">Not run</span>
                        ) : r.run.outcome === "MATCHED" ? (
                          <span className="inline-flex items-center gap-1 text-success">
                            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Matched
                          </span>
                        ) : r.run.outcome === "PENDING" ? (
                          <span className="inline-flex items-center gap-1 text-text-secondary">
                            <Clock className="h-3.5 w-3.5" aria-hidden /> Pending
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-danger">
                            <XCircle className="h-3.5 w-3.5" aria-hidden /> {r.run.outcome === "FAILED" ? "Judge failed" : "Mismatched"}
                          </span>
                        )}
                        {r.run?.firstFailingIndex !== null && r.run?.firstFailingIndex !== undefined && (
                          <div className="text-xs text-text-secondary">first failing test {r.run.firstFailingIndex}</div>
                        )}
                      </td>
                      <td className="py-2 pr-4 tabular-nums">{r.run?.measuredMs != null ? `${r.run.measuredMs} ms` : "—"}</td>
                      <td className="py-2 pr-4">
                        {r.run && r.run.strip.length > 0 ? (
                          <ol aria-label={`Per-test verdicts of ${r.label ?? "this solution"}`} className="flex max-w-[22rem] flex-wrap gap-0.5">
                            {r.run.strip.map((t) => (
                              <li
                                key={t.i}
                                title={`Test ${t.i}: ${t.v}`}
                                className={`rounded px-1 font-mono text-[0.65rem] ${t.v === "AC" ? "bg-success-subtle text-success" : t.v === "SKIPPED" ? "bg-primary-subtle/40 text-muted" : "bg-danger-subtle text-danger"}`}
                              >
                                {t.i}:{t.v}
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Derived limits" subtitle="Per enabled language: 2.5 × the slowest model, or the language's fallback multiplier." />
        <CardBody>
          {limits.length === 0 ? (
            <p className="text-sm text-text-secondary">Written when every model solution has matched (stage 1).</p>
          ) : (
            <div role="region" tabIndex={0} aria-label="Derived limits" className="overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <caption className="sr-only">Per-language time and memory limits</caption>
                <thead className="text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="py-2 pr-4">
                      Language
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Time limit
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Memory
                    </th>
                    <th scope="col" className="py-2 pr-4">
                      Basis
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {limits.map((l) => (
                    <tr key={l.language} className="border-t border-border">
                      <td className="py-2 pr-4">{languageLabel(l.language)}</td>
                      <td className="py-2 pr-4 tabular-nums">{l.timeLimitMs} ms</td>
                      <td className="py-2 pr-4 tabular-nums">{Math.round(l.memoryLimitKb / 1024)} MB</td>
                      <td className="py-2 pr-4 text-text-secondary">
                        {l.measuredModelMs === null ? "fallback multiplier" : `model ${l.measuredModelMs} ms on ${l.measuredOnGeneration ?? "unknown"}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {readiness.contentIssues.length > 0 && (
        <Card>
          <CardHeader title="Content checks" />
          <CardBody>
            <ul className="space-y-1 text-sm">
              {readiness.contentIssues.map((i, n) => (
                <li key={n} className={`flex items-start gap-2 ${i.severity === "error" ? "text-danger" : "text-warning"}`}>
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>
                    {i.severity === "error" ? "Error: " : "Warning: "}
                    {i.message}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
