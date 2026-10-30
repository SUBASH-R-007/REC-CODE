import type { Metadata } from "next";
import Link from "next/link";
import { Flag, ShieldCheck } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import { REPORT_REASON_LABEL, formatCampusTime } from "@recx/shared";
import { requireMentorPage } from "@/lib/auth/guards";
import { loadModerationQueue } from "@/server/queries/discussion";
import { ModerationActions, UnhideButton } from "@/components/discussion/moderation-actions";
import { HELP_PROSE } from "@/components/help/prose";

export const metadata: Metadata = { title: "Moderation" };

/**
 * `/mentor/moderation` — the report queue (Phase 12d).
 *
 * College-wide, not per mentee. `lib/auth/mentor-scope.ts` answers "whose
 * student is this" for a student's private data; this is about public
 * posts, and a queue narrowed to a mentor's own mentees would leave most of
 * the board unmoderated while looking staffed.
 *
 * The second list is the one that makes this honest: every post hidden in
 * the last 30 days, with who hid it and why, so a decision can be looked at
 * again by somebody who was not the one who made it. Moderation that only
 * ever shows the work still to do is moderation nobody audits.
 */
export default async function ModerationPage() {
  await requireMentorPage();
  const queue = await loadModerationQueue();

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Moderation</h1>
        <p className="max-w-2xl text-sm text-text-secondary">
          Posts and questions students have reported. Hiding a post needs a reason, and the author is shown it —
          nothing here deletes anything, so a decision can always be looked at again.
        </p>
      </header>

      <Card>
        <CardHeader
          title="Reported"
          subtitle={
            queue.open.length === 0
              ? `Nothing waiting · ${queue.decidedLast30Days} decided in the last 30 days`
              : `${queue.open.length} waiting, oldest first · ${queue.decidedLast30Days} decided in the last 30 days`
          }
        />
        <CardBody>
          {queue.open.length === 0 ? (
            <EmptyState
              compact
              icon={<ShieldCheck className="h-5 w-5" />}
              title="Nothing is waiting"
              description="Reports from students appear here, oldest first."
            />
          ) : (
            <ol className="space-y-4">
              {queue.open.map((report) => (
                <li key={report.id} className="rounded-2xl border border-border p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="warning">
                      <Flag className="h-3 w-3" aria-hidden />
                      {REPORT_REASON_LABEL[report.reason]}
                    </Badge>
                    <span className="text-xs text-muted">
                      reported by {report.reporter} · {formatCampusTime(report.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-text">{report.detail}</p>

                  {report.target.kind === "gone" ? (
                    <p className="mt-3 text-sm text-text-secondary">The thing reported is no longer there.</p>
                  ) : (
                    <div className="mt-3 rounded-xl border border-border bg-background p-3">
                      <p className="text-xs text-muted">
                        {report.target.kind === "post" ? "Post" : "Question"} by {report.target.author} on{" "}
                        <Link href={`/problems/${report.target.problemSlug}`} className="text-primary hover:underline">
                          {report.target.problemTitle}
                        </Link>
                        {report.target.kind === "post" && report.target.hidden ? " · already hidden" : ""}
                      </p>
                      {report.target.kind === "doubt" ? (
                        <p className="mt-1 font-display text-sm font-semibold">{report.target.title}</p>
                      ) : null}
                      <div
                        className={`${HELP_PROSE} mt-2`}
                        // Sanitised on the server by renderMarkdown().
                        dangerouslySetInnerHTML={{ __html: report.target.html }}
                      />
                    </div>
                  )}

                  <ModerationActions
                    reportId={report.id}
                    post={
                      report.target.kind === "post"
                        ? {
                            id: report.target.id,
                            hidden: report.target.hidden,
                            editorialQuality: report.target.editorialQuality,
                          }
                        : null
                    }
                  />
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Hidden in the last 30 days" subtitle="Every decision, with who made it and why." />
        <CardBody>
          {queue.recentlyHidden.length === 0 ? (
            <EmptyState compact title="Nothing has been hidden" description="Which is the state to hope for." />
          ) : (
            <ul className="space-y-3 text-sm">
              {queue.recentlyHidden.map((post) => (
                <li key={post.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0">
                  <div className="min-w-0">
                    <p>
                      <span className="font-medium">{post.author}</span> on{" "}
                      <Link href={`/problems/${post.problemSlug}`} className="text-primary hover:underline">
                        {post.problemTitle}
                      </Link>
                    </p>
                    <p className="text-xs text-muted">
                      hidden by {post.hiddenBy} · {formatCampusTime(post.hiddenAt)}
                    </p>
                    <p className="mt-1 text-text-secondary">{post.reason}</p>
                  </div>
                  <UnhideButton postId={post.id} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
