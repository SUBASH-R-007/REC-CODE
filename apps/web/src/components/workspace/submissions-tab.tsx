import Link from "next/link";
import { FileCode2 } from "lucide-react";
import { EmptyState, VerdictBadge } from "@recx/design";
import { formatMemoryKb, formatScore, formatTimeMs } from "@/lib/judge/view";
import type { HistoryRow } from "@/server/queries/submissions";
import { absoluteTime, relativeTime } from "@/components/problems/relative-time";
import { ShowResultButton } from "@/components/workspace/show-result-button";

/**
 * The Submissions tab: the viewer's last practice submissions to this
 * problem (server-rendered; the workspace calls router.refresh() when a new
 * verdict lands). Each row opens in the console, or as a full page with the
 * submitted code.
 */
export function SubmissionsTab({ slug, rows, limit }: { slug: string; rows: HistoryRow[]; limit: number }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        title="No submissions yet"
        description="Submit your solution and every attempt will be listed here with its verdict."
      />
    );
  }
  const now = new Date();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">
          Your last {rows.length} submissions to this problem, newest first
          {rows.length >= limit ? ` (only the latest ${limit} are listed)` : ""}
        </caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="py-2 pr-2 font-medium">
              Verdict
            </th>
            <th scope="col" className="py-2 pr-2 font-medium">
              Language
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              Time
            </th>
            <th scope="col" className="py-2 pr-2 text-right font-medium">
              Memory
            </th>
            <th scope="col" className="py-2 pr-2 font-medium">
              Submitted
            </th>
            <th scope="col" className="py-2 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const when = absoluteTime(row.createdAt);
            return (
              <tr key={row.id} className="border-t border-border">
                <td className="py-2 pr-2">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <VerdictBadge
                      verdict={row.display}
                      size="sm"
                      {...(row.display === "PARTIAL" ? { passed: row.passed, total: row.total } : {})}
                    />
                    {row.score !== null && row.maxScore !== null && row.maxScore > 0 && (
                      <span className="font-mono text-text-secondary tabular-nums">
                        {formatScore(row.score, row.maxScore)}
                        <span className="sr-only"> points</span>
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2 pr-2 whitespace-nowrap text-text-secondary">{row.languageLabel.split(" (")[0]}</td>
                <td className="py-2 pr-2 text-right font-mono whitespace-nowrap">{formatTimeMs(row.maxTimeMs)}</td>
                <td className="py-2 pr-2 text-right font-mono whitespace-nowrap">{formatMemoryKb(row.maxMemoryKb)}</td>
                <td className="py-2 pr-2 whitespace-nowrap text-text-secondary">
                  <time dateTime={row.createdAt.toISOString()} title={when}>
                    {relativeTime(row.createdAt, now)}
                  </time>
                </td>
                <td className="py-1">
                  <div className="flex items-center justify-end gap-1">
                    <ShowResultButton kind="submission" id={row.id} label={`Show the submission from ${when} in the console`} />
                    <Link
                      href={`/problems/${slug}/submissions/${row.id}`}
                      aria-label={`Open the submission from ${when}, with its code`}
                      title="Open with code"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-primary-subtle hover:text-text"
                    >
                      <FileCode2 className="h-4 w-4" aria-hidden />
                    </Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
