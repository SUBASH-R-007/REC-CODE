import { CheckCircle2, EyeOff } from "lucide-react";
import { EmptyState, VerdictBadge } from "@recx/design";
import { displayFor } from "@/lib/judge/view";
import { formatAge } from "@/lib/judge/metrics";
import type { StuckSubmissionRow } from "@/server/queries/admin-judge";
import { RejudgeButton } from "@/components/admin/rejudge-button";

const th = "px-3 py-2.5 text-left font-medium first:pl-5 last:pr-5";
const td = "px-3 py-2.5 first:pl-5 last:pr-5 align-middle";

/**
 * Submissions needing attention, each with a one-click Rejudge. A row of a
 * student outside the viewer's AdminScope shows no identity and no Rejudge
 * (the action refuses it as well).
 */
export function StuckTable({
  rows,
  total,
  caption,
  emptyTitle,
  emptyDescription,
  now,
}: {
  rows: StuckSubmissionRow[];
  total: number;
  caption: string;
  emptyTitle: string;
  emptyDescription: string;
  now: Date;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        icon={<CheckCircle2 className="h-5 w-5" />}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }
  return (
    <div>
      {/* Focusable, so a table wider than a phone scrolls from the keyboard. */}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={caption}>
        <table className="w-full text-sm tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
              <th scope="col" className={th}>
                Submission
              </th>
              <th scope="col" className={th}>
                Student
              </th>
              <th scope="col" className={th}>
                Problem
              </th>
              <th scope="col" className={th}>
                State
              </th>
              <th scope="col" className={th}>
                Lane
              </th>
              <th scope="col" className={`${th} text-right`}>
                Attempts
              </th>
              <th scope="col" className={th}>
                Queued
              </th>
              <th scope="col" className={th}>
                Node
              </th>
              <th scope="col" className={th}>
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border first:border-t-0">
                <td className={`${td} font-mono text-xs`}>{r.id}</td>
                <td className={td}>
                  {r.inScope ? (
                    <>
                      <span className="block font-mono text-xs">{r.collegeId}</span>
                      <span className="block text-xs text-text-secondary">{r.studentName}</span>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
                      <EyeOff className="h-3.5 w-3.5" aria-hidden />
                      Outside your scope
                    </span>
                  )}
                </td>
                <td className={td}>
                  <span className="block font-mono text-xs">{r.problemCode}</span>
                  <span className="block max-w-48 truncate text-xs text-text-secondary">{r.problemTitle}</span>
                </td>
                <td className={td}>
                  <VerdictBadge verdict={displayFor(r.status, r.verdict)} size="sm" />
                </td>
                <td className={`${td} text-xs`}>
                  {r.lane.toLowerCase()}
                  <span className="block text-muted">{r.language}</span>
                </td>
                <td className={`${td} text-right`}>{r.attemptCount}</td>
                <td className={`${td} whitespace-nowrap text-xs`}>{formatAge(now.getTime() - r.queuedAt.getTime())} ago</td>
                <td className={`${td} font-mono text-xs`}>{r.nodeId ?? "—"}</td>
                <td className={`${td} text-right`}>
                  {r.inScope ? (
                    <RejudgeButton submissionId={r.id} label={`Rejudge submission ${r.id}`} />
                  ) : (
                    <span className="text-xs text-muted">No action</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > rows.length && (
        <p className="px-5 pt-3 text-xs text-muted tabular-nums">
          Showing {rows.length} of {total.toLocaleString("en-IN")}.
        </p>
      )}
    </div>
  );
}
