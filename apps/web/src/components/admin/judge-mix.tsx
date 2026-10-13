import { BarChart3, Languages } from "lucide-react";
import { EmptyState, ProgressBar, VerdictBadge } from "@recx/design";
import { VERDICT_LABEL } from "@recx/shared";
import { formatRate, rate } from "@/lib/judge/metrics";
import type { LanguageMixRow, VerdictCount } from "@/server/queries/admin-judge";

const th = "px-3 py-2.5 text-right font-medium first:pl-5 first:text-left last:pr-5";
const td = "px-3 py-2.5 text-right first:pl-5 first:text-left last:pr-5";

/** Last 24 h of submissions by language, with acceptance rate among judged ones. */
export function LanguageMix({ rows, labels }: { rows: LanguageMixRow[]; labels: ReadonlyMap<string, string> }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        icon={<Languages className="h-5 w-5" />}
        title="No submissions in the last 24 hours"
        description="The language mix appears once students submit."
      />
    );
  }
  return (
    // Focusable, so a table wider than a phone scrolls from the keyboard.
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Language mix">
      <table className="w-full text-sm tabular-nums">
        <caption className="sr-only">Submissions by language, last 24 hours</caption>
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
            <th scope="col" className={th}>
              Language
            </th>
            <th scope="col" className={th}>
              Submissions
            </th>
            <th scope="col" className={th}>
              Judged
            </th>
            <th scope="col" className={th}>
              Accepted
            </th>
            <th scope="col" className={th}>
              AC rate
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.language} className="border-t border-border first:border-t-0">
              <th scope="row" className={`${td} font-medium text-text`}>
                {labels.get(r.language) ?? r.language}
                <span className="block font-mono text-xs font-normal text-muted">{r.language}</span>
              </th>
              <td className={td}>{r.submissions.toLocaleString("en-IN")}</td>
              <td className={td}>{r.judged.toLocaleString("en-IN")}</td>
              <td className={td}>{r.accepted.toLocaleString("en-IN")}</td>
              <td className={td}>{formatRate(rate(r.accepted, r.judged))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Verdicts of the last 24 h of submissions. Every verdict is a VerdictBadge. */
export function VerdictDistribution({ rows }: { rows: VerdictCount[] }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (total === 0) {
    return (
      <EmptyState
        compact
        icon={<BarChart3 className="h-5 w-5" />}
        title="No verdicts in the last 24 hours"
        description="The distribution appears once submissions are judged."
      />
    );
  }
  return (
    <ul className="space-y-3 px-5 pb-5" aria-label="Verdicts, last 24 hours">
      {rows.map((r) => (
        <li key={r.verdict} className="grid grid-cols-[minmax(0,12rem)_1fr_auto] items-center gap-3">
          <VerdictBadge verdict={r.verdict} size="sm" />
          <ProgressBar value={r.count} max={total} size="sm" label={`${VERDICT_LABEL[r.verdict]} share`} />
          <span className="w-24 text-right text-sm tabular-nums text-text-secondary">
            {r.count.toLocaleString("en-IN")} · {formatRate(rate(r.count, total), 0)}
          </span>
        </li>
      ))}
    </ul>
  );
}
