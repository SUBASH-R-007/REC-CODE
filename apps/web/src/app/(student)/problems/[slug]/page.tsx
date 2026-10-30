import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { DifficultyBadge, Skeleton, SolveStatus } from "@recx/design";
import { aiUsable, getAiRuntime } from "@/lib/ai/settings";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { LANGUAGE_COOKIE } from "@/lib/drafts/keys";
import { pickInitialLanguage } from "@/lib/drafts/merge";
import { loadServerDrafts } from "@/lib/drafts/server";
import { slugSchema } from "@/lib/judge/submit-schema";
import { getProblemWorkspace } from "@/server/queries/problems";
import { HISTORY_LIMIT, recentSubmissions } from "@/server/queries/submissions";
import { ActivityTracker } from "@/components/help/activity-tracker";
import { EditorialPanel } from "@/components/help/editorial-panel";
import { AssistantPanel } from "@/components/help/assistant-panel";
import { HintsPanel } from "@/components/help/hints-panel";
import { BookmarkButton } from "@/components/problems/bookmark-button";
import { WorkspaceFrame } from "@/components/shell/workspace-frame";
import { ProblemDescription } from "@/components/workspace/problem-description";
import { SubmissionsTab } from "@/components/workspace/submissions-tab";
import { Workspace } from "@/components/workspace/workspace";

type Params = { params: Promise<{ slug: string }> };

async function load(rawSlug: string) {
  const slug = slugSchema.safeParse(rawSlug);
  return slug.success ? getProblemWorkspace(slug.data) : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  // Unpublished problems do not leak their titles through metadata.
  const problem = await load(slug);
  return { title: problem ? problem.title : "Problem not found" };
}

function PanelSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-4/5" />
    </div>
  );
}

/**
 * The coding workspace (full-bleed: <WorkspaceFrame> drops the shell's
 * sidebar, gutters and width cap). Everything on the statement side is
 * server-rendered here and handed to the client <Workspace>; the editor,
 * console and drafts are client-side. Hints and the editorial come from the
 * help chokepoint (their panels stream in under Suspense).
 */
export default async function ProblemPage({ params }: Params) {
  const user = await requireUser();
  const { slug } = await params;
  const problem = await load(slug);
  if (!problem) notFound();

  const key = { userId: user.id, problemId: problem.id };
  const [history, serverDrafts, bookmark, progress, cookieStore, aiRuntime] = await Promise.all([
    recentSubmissions(user.id, problem.id),
    loadServerDrafts(user.id, problem.id),
    db.bookmark.findUnique({ where: { userId_problemId: key }, select: { problemId: true } }),
    db.userProblemStatus.findUnique({ where: { userId_problemId: key }, select: { status: true } }),
    cookies(),
    getAiRuntime(),
  ]);
  // Whether the Assistant tab exists at all. The setting read is cache()d
  // per request, so asking here and again inside the panel is one query.
  const assistantAvailable = aiUsable(aiRuntime);

  const languageKeys = problem.languages.map((l) => l.key);
  const initialLanguage = pickInitialLanguage({
    preferred: cookieStore.get(LANGUAGE_COOKIE)?.value ?? null,
    available: languageKeys,
    serverDrafts,
  });
  // Only this problem's offered languages travel to the browser.
  const drafts = serverDrafts.filter((d) => languageKeys.includes(d.language));

  const customHint = problem.signature
    ? `One value per line, in parameter order: ${problem.signature.params.map((p) => p.name).join(", ")}.`
    : "This text is passed to your program on standard input.";
  const solve = progress?.status === "SOLVED" ? "solved" : progress?.status === "ATTEMPTED" ? "attempted" : null;

  const header = (
    <>
      <Link
        href="/problems"
        className="inline-flex h-(--ws-ctl) items-center gap-1 rounded-lg px-2 text-sm font-medium text-text-secondary transition-colors hover:bg-primary-subtle hover:text-text"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        Problems
      </Link>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="min-w-0 truncate font-display text-lg font-bold tracking-tight">
          <span className="mr-2 hidden font-mono text-xs font-medium text-muted sm:inline">{problem.displayCode}</span>
          {problem.title}
        </h1>
        <DifficultyBadge difficulty={problem.difficulty} />
        <SolveStatus status={solve} />
      </div>
      <BookmarkButton
        problemId={problem.id}
        bookmarked={bookmark !== null}
        label={problem.title}
        className="h-(--ws-ctl)! w-(--ws-ctl)!"
      />
    </>
  );

  return (
    <WorkspaceFrame className="max-lg:[@media(min-height:480px)]:h-[calc(100dvh-var(--shell-top,3.5rem))]">
      <ActivityTracker problemId={problem.id} />
      <Workspace
        problemId={problem.id}
        slug={problem.slug}
        languages={problem.languages}
        initialLanguage={initialLanguage}
        serverDrafts={drafts}
        sampleIndexes={problem.samples.map((s) => s.index)}
        defaultCustomInput={problem.samples[0]?.input ?? ""}
        customHint={customHint}
        header={header}
        submissionCount={history.length}
        panels={{
          description: <ProblemDescription problem={problem} statementHtml={problem.statementHtml} />,
          editorial: (
            <Suspense fallback={<PanelSkeleton />}>
              <EditorialPanel problemId={problem.id} versionId={problem.versionId} />
            </Suspense>
          ),
          submissions: <SubmissionsTab slug={problem.slug} rows={history} limit={HISTORY_LIMIT} />,
          hints: (
            <Suspense fallback={<PanelSkeleton />}>
              <HintsPanel problemId={problem.id} versionId={problem.versionId} />
            </Suspense>
          ),
          // The tab exists only when the assistant could actually answer: a
          // super-admin has it on and the deployment has a key. Omitting the
          // key omits the tab, rather than offering a button that refuses.
          ...(assistantAvailable
            ? {
                assistant: (
                  <Suspense fallback={<PanelSkeleton />}>
                    <AssistantPanel problemId={problem.id} />
                  </Suspense>
                ),
              }
            : {}),
        }}
      />
    </WorkspaceFrame>
  );
}
