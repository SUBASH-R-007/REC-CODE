import { AlertTriangle } from "lucide-react";
import type { JudgeLane } from "@recx/shared";
import { formatDurationMs, formatRate, rate, type LaneSummary } from "@/lib/judge/metrics";
import type { ValidationWindow } from "@/server/queries/admin-judge";

const LANE_LABEL: Record<JudgeLane, string> = {
  ASSESSMENT: "Assessment",
  CONTEST: "Contest",
  RUN: "Run",
  PRACTICE: "Practice",
  REJUDGE: "Rejudge",
};

const count = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-IN"));

const th = "px-3 py-2.5 text-right font-medium first:pl-5 first:text-left last:pr-5";
const td = "px-3 py-2.5 text-right first:pl-5 first:text-left last:pr-5";

/**
 * Per-lane queue depth (BullMQ, now) and the last hour's latency,
 * throughput and internal-error rate (Postgres).
 */
export function LaneTable({
  lanes,
  queueDepthAvailable,
  validation,
}: {
  lanes: LaneSummary[];
  queueDepthAvailable: boolean;
  validation: ValidationWindow;
}) {
  return (
    <div className="space-y-3">
      {!queueDepthAvailable && (
        <p className="flex items-center gap-2 rounded-xl border border-warning/25 bg-warning-subtle px-3 py-2 text-sm text-text">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
          Queue depth is unavailable: Redis could not be read. Latency below comes from the database.
        </p>
      )}
      {/* Focusable, so a table wider than a phone scrolls from the keyboard. */}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Judge lanes">
        <table className="w-full text-sm tabular-nums">
          <caption className="sr-only">Judge lanes: queue depth now and the last hour</caption>
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
              <th scope="col" className={th}>
                Lane
              </th>
              <th scope="col" className={th}>
                Waiting
              </th>
              <th scope="col" className={th}>
                Active
              </th>
              <th scope="col" className={th}>
                Delayed
              </th>
              <th scope="col" className={th}>
                Queued 1 h
              </th>
              <th scope="col" className={th}>
                Judged 1 h
              </th>
              <th scope="col" className={th}>
                p50 wait
              </th>
              <th scope="col" className={th}>
                p95 wait
              </th>
              <th scope="col" className={th}>
                IE rate
              </th>
            </tr>
          </thead>
          <tbody>
            {lanes.map((l) => (
              <tr key={l.lane} className="border-t border-border first:border-t-0">
                <th scope="row" className={`${td} font-medium text-text`}>
                  {LANE_LABEL[l.lane]}
                </th>
                <td className={td}>{count(l.depth?.waiting)}</td>
                <td className={td}>{count(l.depth?.active)}</td>
                <td className={td}>{count(l.depth?.delayed)}</td>
                <td className={td}>{count(l.queued)}</td>
                <td className={td}>{count(l.finished)}</td>
                <td className={td}>{formatDurationMs(l.p50Ms)}</td>
                <td className={td}>{formatDurationMs(l.p95Ms)}</td>
                <td className={`${td} ${l.internalErrors > 0 ? "font-medium text-danger" : ""}`}>
                  {formatRate(l.ieRate)}
                  {l.internalErrors > 0 && <span className="sr-only"> ({l.internalErrors} internal errors)</span>}
                </td>
              </tr>
            ))}
            <tr className="border-t border-border text-text-secondary">
              <th scope="row" className={`${td} font-medium`}>
                Validation
                <span className="block text-xs font-normal text-muted">authoring</span>
              </th>
              <td className={td} colSpan={3}>
                <span className="text-xs text-muted">counted in its lane</span>
              </td>
              <td className={td}>{count(validation.queued)}</td>
              <td className={td}>{count(validation.finished)}</td>
              <td className={td}>{formatDurationMs(validation.p50Ms)}</td>
              <td className={td}>{formatDurationMs(validation.p95Ms)}</td>
              <td className={td}>{formatRate(rate(validation.internalErrors, validation.finished))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Wait = time from queued to a worker taking the job; a job still waiting counts with its age so far. Judged =
        finished jobs among those queued in the last hour.
      </p>
    </div>
  );
}
