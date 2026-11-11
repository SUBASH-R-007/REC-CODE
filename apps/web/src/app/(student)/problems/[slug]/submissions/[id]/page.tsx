import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { ButtonLink, Card, VerdictBadge, publicName } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { slugSchema } from "@/lib/judge/submit-schema";
import { getSubmissionDetail } from "@/server/queries/submissions";
import { absoluteTime } from "@/components/problems/relative-time";
import {
  CompileOutput,
  ResultNotes,
  ResultSummary,
  TestResults,
} from "@/components/workspace/result-view";
import { SourceView } from "@/components/workspace/source-view";
import { SubmissionLive } from "@/components/workspace/submission-live";

type Params = { params: Promise<{ slug: string; id: string }> };

export const metadata: Metadata = { title: "Submission" };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Statement typography for the pinned revision (same rules as the workspace statement). */
const PINNED_STATEMENT_CLASSES = [
  "mt-3 text-sm leading-relaxed text-text",
  "[&_p]:my-3 [&_strong]:font-semibold [&_em]:italic",
  "[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:font-display [&_h3]:font-semibold [&_h4]:mt-4 [&_h4]:font-semibold",
  "[&_code]:rounded-md [&_code]:bg-primary-subtle [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.85em]",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-border [&_pre]:bg-background [&_pre]:p-3 [&_pre]:text-xs",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
  "[&_table]:my-3 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:px-2 [&_th]:border [&_th]:border-border [&_th]:px-2",
  "[&_a]:text-primary [&_a]:underline",
].join(" ");

/**
 * One submission in full: verdict, score and subtasks, the per-test table
 * (hidden tests show only number, verdict, time and memory — the view
 * enforces it), compiler output for a CE, and the submitted code, read-only
 * with cheap server-side highlighting (no editor on this page). Owner or
 * staff only; anyone else gets the not-found page. Judge node and
 * calibration details are not shown.
 */
export default async function SubmissionPage({ params }: Params) {
  const user = await requireUser();
  const { slug: rawSlug, id } = await params;
  const slug = slugSchema.safeParse(rawSlug);
  if (!slug.success || !ID.test(id)) notFound();

  const detail = await getSubmissionDetail(id, slug.data, { id: user.id, role: user.role });
  if (!detail) notFound();
  const { view, problem } = detail;
  const workspaceHref = `/problems/${problem.slug}`;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-1 text-sm text-text-secondary">
          <li>
            <Link href="/problems" className="rounded-md px-1 hover:text-text hover:underline">
              Problems
            </Link>
          </li>
          <li aria-hidden>
            <ChevronRight className="h-3.5 w-3.5" />
          </li>
          <li>
            <Link href={workspaceHref} className="rounded-md px-1 hover:text-text hover:underline">
              {problem.title}
            </Link>
          </li>
          <li aria-hidden>
            <ChevronRight className="h-3.5 w-3.5" />
          </li>
          <li aria-current="page" className="px-1 font-medium text-text">
            Submission
          </li>
        </ol>
      </nav>

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted">{problem.displayCode}</p>
          <h1 className="font-display text-2xl font-bold tracking-tight">Submission · {problem.title}</h1>
          {detail.owner && (
            <p className="mt-1 text-sm text-text-secondary">
              Submitted by {publicName(detail.owner.firstName, detail.owner.lastName)}
            </p>
          )}
        </div>
        <ButtonLink href={workspaceHref} variant="outline">
          Back to the problem
        </ButtonLink>
      </header>

      <Card className="space-y-4 p-5">
        <h2 className="sr-only">Result</h2>
        {view.terminal ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <VerdictBadge
                verdict={view.display}
                {...(view.display === "PARTIAL" ? { passed: view.passed, total: view.total } : {})}
              />
            </div>
            <ResultSummary view={view} />
          </>
        ) : (
          <SubmissionLive id={view.id} sampleIndexes={detail.sampleIndexes} />
        )}
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Problem version</dt>
            <dd className="text-text">Revision {detail.pinned.revision}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Language</dt>
            <dd className="font-mono text-text">{view.languageLabel}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Submitted</dt>
            <dd className="text-text">
              <time dateTime={view.createdAt}>{absoluteTime(new Date(view.createdAt))}</time>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Judged</dt>
            <dd className="text-text">
              {view.judgedAt ? (
                <time dateTime={view.judgedAt}>{absoluteTime(new Date(view.judgedAt))}</time>
              ) : (
                "Not yet"
              )}
            </dd>
          </div>
        </dl>
      </Card>

      <section aria-labelledby="submission-problem" className="space-y-2">
        <h2 id="submission-problem" className="font-display text-lg font-semibold">
          Problem version
        </h2>
        <p className="text-sm text-text-secondary">
          Judged against revision {detail.pinned.revision}
          {detail.liveRevision !== null && detail.liveRevision !== detail.pinned.revision
            ? `. The problem has since changed: it is now at revision ${detail.liveRevision}.`
            : "."}
        </p>
        <details className="rounded-xl border border-border bg-surface p-4">
          <summary className="cursor-pointer text-sm font-medium text-text">Problem as judged</summary>
          {/* The pinned (frozen) revision's statement, sanitised on the server by renderMarkdown(). */}
          <div className={PINNED_STATEMENT_CLASSES} dangerouslySetInnerHTML={{ __html: detail.pinned.statementHtml }} />
        </details>
      </section>

      {view.terminal && view.verdict === "CE" && (
        <section aria-labelledby="submission-compile" className="space-y-2">
          <h2 id="submission-compile" className="font-display text-lg font-semibold">
            Compile error
          </h2>
          <CompileOutput view={view} />
        </section>
      )}

      {view.terminal && view.tests.length + (view.scoring?.subtasks.length ?? 0) > 0 && (
        <section aria-labelledby="submission-tests" className="space-y-3">
          <h2 id="submission-tests" className="font-display text-lg font-semibold">
            Tests
          </h2>
          <TestResults view={view} headingLevel={3} />
          <ResultNotes view={view} />
        </section>
      )}

      <section aria-labelledby="submission-code" className="space-y-2">
        <h2 id="submission-code" className="font-display text-lg font-semibold">
          Submitted code
        </h2>
        {detail.source !== null ? (
          <SourceView source={detail.source} language={detail.editorLanguage} label={`Submitted code, ${view.languageLabel}`} />
        ) : detail.sourceWithheld ? (
          <p className="text-sm text-text-secondary">Only the student and super-admins can see the code of a submission.</p>
        ) : (
          <p className="text-sm text-text-secondary">The code of this submission has been archived and is no longer shown here.</p>
        )}
      </section>
    </div>
  );
}
