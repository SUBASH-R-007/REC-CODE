import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, CircleAlert, Info } from "lucide-react";
import { Card, CardBody, CardHeader } from "@recx/design";
import { LANGUAGE_CATALOG, isLanguageKey } from "@recx/shared";
import { CONTENT_ORIGIN_LABEL } from "@recx/shared/authoring";
import { requirePageRole } from "@/lib/auth/guards";
import { renderMarkdown } from "@/lib/markdown";
import { getAdminProblem } from "@/server/queries/admin-problems";
import { CheckerForm, DetailsForm, HelpForm, JudgingForm, StarterCodeForm, TopicsForm } from "@/components/admin/problems/draft-forms";
import { COMPARE_MODE_OPTIONS, LANGUAGE_OPTIONS, ORIGIN_OPTIONS, TOPIC_OPTIONS, VERDICT_OPTIONS } from "@/components/admin/problems/options";
import { ProblemNav } from "@/components/admin/problems/problem-nav";
import { ReferenceSolutions } from "@/components/admin/problems/reference-solutions";
import { ReviewPanel } from "@/components/admin/problems/review-panel";
import { ROUTE_ID, parseRev } from "@/components/admin/problems/rev";
import { CreateRevisionButton } from "@/components/admin/problems/revision-actions";
import { StageBadge } from "@/components/admin/problems/stage-badge";
import { SuperProblemControls } from "@/components/admin/problems/super-controls";
import { DraftSeqProvider } from "@/components/admin/problems/use-action";

export const metadata: Metadata = { title: "Problem" };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const DATE = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

const REVIEW_ACTION_LABEL: Record<string, string> = {
  SUBMITTED: "Submitted for review",
  WITHDRAWN: "Withdrawn to draft",
  RETURNED: "Returned to the author",
  APPROVED: "Approved",
  APPROVAL_REVOKED: "Approval revoked",
};

const STATEMENT_CLASSES = [
  "text-sm leading-relaxed text-text",
  "[&_p]:my-3 [&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:font-semibold [&_h4]:mt-4 [&_h4]:font-semibold",
  "[&_code]:rounded-md [&_code]:bg-primary-subtle [&_code]:px-1 [&_code]:font-mono",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-border [&_pre]:bg-background [&_pre]:p-3 [&_pre]:text-xs",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5",
].join(" ");

function languageLabel(key: string): string {
  return isLanguageKey(key) ? LANGUAGE_CATALOG[key].label : key;
}

/**
 * One problem: its revisions with their review stages, the selected
 * revision (?rev=N, else the open draft, else the live one) — editable
 * section by section while it is a DRAFT, read-only otherwise — the review
 * actions, and (SUPER_ADMIN only) retire and delete requests.
 */
export default async function AdminProblemPage({ params, searchParams }: Props) {
  const user = await requirePageRole("ADMIN", "SUPER_ADMIN");
  const { id } = await params;
  if (!ROUTE_ID.test(id)) notFound();
  const rev = parseRev((await searchParams).rev);
  const detail = await getAdminProblem({ id: user.id, role: user.role }, id, rev);
  if (!detail || (rev !== null && !detail.selected)) notFound();
  const { problem, selected: sel, revisions, openDraft } = detail;
  const isSuper = user.role === "SUPER_ADMIN";
  const neverPublished = revisions.every((r) => r.publishedAt === null);
  const errors = sel?.contentIssues.filter((i) => i.severity === "error") ?? [];
  const warnings = sel?.contentIssues.filter((i) => i.severity === "warning") ?? [];

  return (
    <div className="space-y-6">
      <ProblemNav problemId={problem.id} displayCode={problem.displayCode} title={problem.title} current="overview" rev={rev} />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h1 className="font-display text-2xl font-bold tracking-tight">{sel?.title ?? problem.title}</h1>
          <p className="font-mono text-xs text-muted">
            {problem.displayCode} · {problem.slug} · Problem.version {problem.version}
          </p>
          {sel && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-text-secondary">
              Revision {sel.revision} <StageBadge stage={sel.stage} />
            </p>
          )}
        </div>
        {openDraft && sel && openDraft.id !== sel.id && (
          <Link href={`/admin/problems/${problem.id}`} className="text-sm font-medium text-primary hover:underline">
            Go to the open draft (revision {openDraft.revision})
          </Link>
        )}
      </header>

      <Card>
        <CardHeader title="Revisions" subtitle="Published revisions are frozen. Editing starts a new draft revision." />
        <CardBody className="space-y-4">
          <div tabIndex={0} aria-label="Revisions" className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <caption className="sr-only">Revisions of {problem.title}</caption>
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-4">
                    Revision
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Stage
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Created
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Published
                  </th>
                  <th scope="col" className="py-2 pr-4">
                    Approved by
                  </th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="py-2 pr-4">
                      <Link
                        href={`/admin/problems/${problem.id}?rev=${r.revision}`}
                        aria-current={sel?.id === r.id ? "page" : undefined}
                        className="font-medium text-primary hover:underline"
                      >
                        r{r.revision}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      <StageBadge stage={r.stage} />
                    </td>
                    <td className="py-2 pr-4 text-text-secondary">{DATE.format(r.createdAt)}</td>
                    <td className="py-2 pr-4 text-text-secondary">{r.publishedAt ? DATE.format(r.publishedAt) : "—"}</td>
                    <td className="py-2 pr-4 text-text-secondary">{r.approvedBy ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!openDraft && problem.liveVersionId && problem.status !== "RETIRED" && <CreateRevisionButton problemId={problem.id} />}
          {problem.status === "RETIRED" && <p className="text-sm text-text-secondary">This problem is retired. It gets no new revisions.</p>}
          {isSuper && (
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Super-admin</p>
              <SuperProblemControls
                problemId={problem.id}
                problemVersion={problem.version}
                canRetire={problem.status === "PUBLISHED"}
                deletableVersion={openDraft}
                canRequestProblemDeletion={neverPublished}
              />
            </div>
          )}
        </CardBody>
      </Card>

      {!sel ? (
        <p className="text-sm text-text-secondary">This problem has no revisions.</p>
      ) : (
        <>
          {(errors.length > 0 || warnings.length > 0) && (
            <Card>
              <CardHeader title="Content checks" subtitle="Errors block review and publishing." />
              <CardBody>
                <ul className="space-y-2 text-sm">
                  {errors.map((i, n) => (
                    <li key={`e${n}`} className="flex items-start gap-2 text-danger">
                      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                      <span>
                        <span className="sr-only">Error: </span>
                        {i.message}
                      </span>
                    </li>
                  ))}
                  {warnings.map((i, n) => (
                    <li key={`w${n}`} className="flex items-start gap-2 text-warning">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                      <span>
                        <span className="sr-only">Warning: </span>
                        {i.message}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}

          {(sel.stage === "DRAFT" || sel.stage === "IN_REVIEW" || sel.stage === "APPROVED") && (
            <Card>
              <CardHeader
                title="Review"
                subtitle={
                  sel.stage === "DRAFT"
                    ? "Submit when the content is complete. A second admin reviews and approves it; validation must pass first."
                    : sel.stage === "IN_REVIEW"
                      ? `Submitted ${sel.submittedForReviewAt ? DATE.format(sel.submittedForReviewAt) : ""}${sel.people.submittedBy ? ` by ${sel.people.submittedBy}` : ""}.`
                      : `Approved by ${sel.people.approvedBy ?? "—"}. Publish it from the validation page.`
                }
              />
              <CardBody>
                <ReviewPanel versionId={sel.id} stage={sel.stage} editSeq={sel.editSeq} selfReview={sel.viewerIsAuthor} />
              </CardBody>
            </Card>
          )}

          {sel.editable ? (
            <DraftSeqProvider versionId={sel.id} editSeq={sel.editSeq}>
              <Card>
                <CardHeader title="Details and statement" subtitle="Statement edits do not invalidate validation." />
                <CardBody>
                  <DetailsForm
                    title={sel.title}
                    difficulty={sel.difficulty}
                    statementMd={sel.statementMd}
                    constraints={sel.constraints}
                    origin={sel.origin}
                    origins={ORIGIN_OPTIONS}
                  />
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Judging" subtitle="Changes here mean validation must run again." />
                <CardBody className="space-y-6">
                  <JudgingForm
                    ioMode={sel.ioMode}
                    functionSignatureJson={sel.functionSignatureJson}
                    compareMode={sel.compareMode}
                    floatEpsilon={sel.floatEpsilon}
                    scoringMode={sel.scoringMode}
                    stopOnFirstFailure={sel.stopOnFirstFailure}
                    timeLimitMs={sel.timeLimitMs}
                    memoryLimitMb={Math.round(sel.memoryLimitKb / 1024)}
                    compareModes={COMPARE_MODE_OPTIONS}
                  />
                  <CheckerForm checkerSource={sel.checkerSource} />
                </CardBody>
              </Card>
              <Card>
                <CardHeader
                  title="Reference solutions"
                  subtitle="A C++ model (expected AC) is mandatory; add deliberately-wrong solutions (expected WA / TLE) to prove the tests separate right from wrong."
                />
                <CardBody>
                  <ReferenceSolutions references={sel.references} languages={LANGUAGE_OPTIONS} verdicts={VERDICT_OPTIONS} />
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Starter code" />
                <CardBody>
                  <StarterCodeForm starters={sel.starters} languages={LANGUAGE_OPTIONS} />
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Hints and editorial" subtitle="Released in practice only, never in contests or assessments." />
                <CardBody>
                  <HelpForm hints={sel.hints} editorialMd={sel.editorialMd} />
                </CardBody>
              </Card>
            </DraftSeqProvider>
          ) : (
            <ReadOnlyRevision sel={sel} />
          )}

          <Card>
            <CardHeader title="Topics" subtitle="Topics belong to the problem, not to a revision." />
            <CardBody>
              <TopicsForm problemId={problem.id} topics={problem.topics} options={TOPIC_OPTIONS} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Review history" />
            <CardBody>
              {sel.reviews.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-text-secondary">
                  <Info className="h-4 w-4" aria-hidden />
                  No review activity on revision {sel.revision} yet.
                </p>
              ) : (
                <ol className="space-y-3 text-sm">
                  {sel.reviews.map((r, n) => (
                    <li key={n} className="rounded-xl border border-border p-3">
                      <p className="font-medium text-text">
                        {REVIEW_ACTION_LABEL[r.action] ?? r.action}
                        {r.actor ? ` — ${r.actor}` : ""}
                        <span className="ml-2 font-normal text-text-secondary">{DATE.format(r.createdAt)}</span>
                      </p>
                      {r.attestedOriginal && <p className="text-text-secondary">Attested: the content is originally authored.</p>}
                      {r.comment && <p className="mt-1 whitespace-pre-wrap text-text">{r.comment}</p>}
                    </li>
                  ))}
                </ol>
              )}
              <p className="mt-3 text-xs text-muted">
                Created by {sel.people.createdBy ?? "—"} · last edited by {sel.people.lastEditedBy ?? "—"} · origin{" "}
                {CONTENT_ORIGIN_LABEL[sel.origin]}
              </p>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}

type Selected = NonNullable<NonNullable<Awaited<ReturnType<typeof getAdminProblem>>>["selected"]>;

/** A frozen or in-review revision, shown read-only. */
function ReadOnlyRevision({ sel }: { sel: Selected }) {
  const html = renderMarkdown(sel.statementMd);
  return (
    <>
      <Card>
        <CardHeader
          title="Statement"
          subtitle={sel.stage === "IN_REVIEW" || sel.stage === "APPROVED" ? "In review: withdraw it to draft to edit." : "Frozen: create a new revision to change it."}
        />
        <CardBody>
          {/* Sanitised on the server by renderMarkdown() — allow-listed tags only. */}
          <div className={STATEMENT_CLASSES} dangerouslySetInnerHTML={{ __html: html }} />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Judging" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Input mode</dt>
              <dd>{sel.ioMode}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Compare mode</dt>
              <dd>{sel.compareMode}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Scoring</dt>
              <dd>{sel.scoringMode}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Base time limit</dt>
              <dd className="tabular-nums">{sel.timeLimitMs} ms</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Memory</dt>
              <dd className="tabular-nums">{Math.round(sel.memoryLimitKb / 1024)} MB</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted">Tests</dt>
              <dd className="tabular-nums">
                {sel.tests.total} ({sel.tests.samples} sample)
              </dd>
            </div>
          </dl>
          {sel.functionSignatureJson && (
            <pre tabIndex={0} aria-label="Function signature" className="mt-4 overflow-x-auto rounded-xl border border-border bg-background p-3 text-xs">
              {sel.functionSignatureJson}
            </pre>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Reference solutions" />
        <CardBody className="space-y-3">
          {sel.references.length === 0 && <p className="text-sm text-text-secondary">None.</p>}
          {sel.references.map((r) => (
            <details key={r.id} className="rounded-xl border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">
                {r.label ?? "Unlabelled"} · {languageLabel(r.language)} · expected {r.expectedVerdict}
                {r.measuredMs !== null ? ` · ${r.measuredMs} ms` : ""}
              </summary>
              <pre tabIndex={0} aria-label={`${r.label ?? "Solution"} code`} className="mt-2 max-h-96 overflow-auto rounded-lg bg-background p-3 text-xs">
                {r.source}
              </pre>
            </details>
          ))}
        </CardBody>
      </Card>
      {(sel.hints.length > 0 || sel.editorialMd) && (
        <Card>
          <CardHeader title="Hints and editorial" />
          <CardBody className="space-y-2 text-sm">
            {sel.hints.map((h, n) => (
              <p key={n}>
                <span className="font-medium">Hint {n + 1}:</span> {h}
              </p>
            ))}
            {sel.editorialMd && <p className="text-text-secondary">Editorial: {sel.editorialMd.length.toLocaleString("en-IN")} characters.</p>}
          </CardBody>
        </Card>
      )}
    </>
  );
}
