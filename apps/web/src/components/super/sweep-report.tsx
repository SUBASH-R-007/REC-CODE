import { Badge, EmptyState } from "@recx/design";
import {
  RESTRICTION_STAGE_ADMIN_LABEL,
  SWEEP_HOLDBACKS,
  SWEEP_HOLDBACK_REASON,
  describeSweepMode,
  type InactivitySweepReport,
  type InactivitySweepSample,
  type RestrictionStage,
} from "@recx/shared";

/**
 * What the inactivity sweep last found, on `/super/jobs` (Phase 12w).
 *
 * The 12w switch asks a super-admin to decide whether the nightly job may
 * act on a policy, and the honest basis for that decision is the report the
 * job already writes to `SchedulerJobStatus.lastReport` on every tick. Until
 * this component the page showed the scheduler's table — job, state, last
 * tick, failures — and not one figure from any report, so the only way to
 * read one was the scheduler's stdout. A product that asks somebody to
 * decide and then keeps the evidence in a log file is asking them to guess.
 *
 * It leads with the MODE, because every number below means something
 * different depending on it: under a report-only policy "4 would be paused"
 * is a forecast, and under an enforcing one it is a list of people whose
 * accounts changed last night.
 *
 * The sample is college ids, stages and counts — never a name, an address or
 * a mark, which is what the job puts in it (`docs/RUNBOOK.md` §2.13).
 */

const stageLabel = (stage: string) =>
  RESTRICTION_STAGE_ADMIN_LABEL[stage as RestrictionStage] ?? stage;

export function SweepReport({ report, at }: { report: InactivitySweepReport | null; at: string }) {
  if (report === null) {
    return (
      <EmptyState
        title="No report yet"
        description="The sweep has not finished a tick on this database. It runs once a campus day, at 02:00 Asia/Kolkata."
      />
    );
  }

  const mode = describeSweepMode(report);
  const held = SWEEP_HOLDBACKS.map((key) => ({ key, n: report.heldBy[key] ?? 0 })).filter((row) => row.n > 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* In words, never colour alone. */}
        {mode.reportOnly ? (
          <Badge tone="info">report-only</Badge>
        ) : mode.wrote ? (
          <Badge tone="warning">acted</Badge>
        ) : (
          <Badge tone="default">nothing to do</Badge>
        )}
        <p className="text-sm">{mode.line}</p>
      </div>
      <p className="text-xs text-muted">
        {report.evaluationDay === null ? "No campus day evaluated" : `Campus day ${report.evaluationDay}`} · last tick{" "}
        {at}
        {report.failed ? " · the tick FAILED" : ""}
      </p>

      {report.failed && report.error ? (
        <p role="alert" className="rounded-lg border border-danger/40 bg-danger-subtle p-3 text-sm">
          {report.error}
        </p>
      ) : null}

      {report.calendarIncomplete ? (
        <p className="rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm">
          The academic calendar does not cover the days being counted, so the engine held everybody back rather than
          counting an unentered day against them. Enter the term on the calendar page — this is the correct failure
          direction, and relaxing the rule is not the fix.
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {[
          { label: "Considered", value: report.considered, hint: "Students the sweep looked at." },
          { label: "Would move up a rung", value: report.wouldEscalate, hint: "On the ladder, if it were acting." },
          { label: "Would come back", value: report.wouldClear, hint: "Active again, so the pause lifts." },
          { label: "Held back", value: report.held, hint: "Left alone for a reason, listed below." },
          { label: "Handed to a human", value: report.adminReview, hint: "On the inactivity review queue." },
          { label: "Actually paused", value: report.escalated, hint: "Written. Zero while report-only." },
          { label: "Actually cleared", value: report.cleared, hint: "Written. Zero while report-only." },
          { label: "Writes withheld", value: report.reportOnly, hint: "Decisions a report-only policy did not write." },
        ].map((cell) => (
          <div key={cell.label} className="rounded-lg border border-border px-3 py-2">
            <dt className="text-xs text-text-secondary">{cell.label}</dt>
            <dd className="font-display text-xl font-semibold tabular-nums">{cell.value}</dd>
            <p className="text-xs text-muted">{cell.hint}</p>
          </div>
        ))}
      </dl>

      {held.length > 0 ? (
        <div>
          <h3 className="mb-2 font-display text-sm font-semibold">Why students were held back</h3>
          <ul className="space-y-1 text-sm">
            {held.map((row) => (
              <li key={row.key} className="flex flex-wrap gap-2">
                <span className="tabular-nums font-medium">{row.n}</span>
                <span>{SWEEP_HOLDBACK_REASON[row.key]}</span>
                <code className="font-mono text-xs text-muted">{row.key}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {report.sample.length > 0 ? (
        <div>
          <h3 className="mb-2 font-display text-sm font-semibold">
            The students it would have moved, or stopped at
          </h3>
          <div role="region" tabIndex={0} aria-label="Sweep sample" className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">A sample of the decisions in the last sweep</caption>
              <thead className="bg-primary-subtle/40 text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2">Roll number</th>
                  <th scope="col" className="px-3 py-2">Now</th>
                  <th scope="col" className="px-3 py-2">Would become</th>
                  <th scope="col" className="px-3 py-2">Counted days</th>
                  <th scope="col" className="px-3 py-2">Not counted</th>
                  <th scope="col" className="px-3 py-2">Why</th>
                </tr>
              </thead>
              <tbody>
                {report.sample.map((row: InactivitySweepSample, i: number) => (
                  <tr key={`${row.collegeId}-${i}`} className="border-t border-border align-top">
                    <th scope="row" className="px-3 py-2 font-mono text-xs">{row.collegeId}</th>
                    <td className="px-3 py-2">{stageLabel(row.stage)}</td>
                    <td className="px-3 py-2">
                      {row.kind === "hold" ? <span className="text-muted">no change</span> : stageLabel(row.toStage)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{row.countedInactiveDays}</td>
                    <td className="px-3 py-2 tabular-nums">{row.excludedDays}</td>
                    <td className="px-3 py-2 text-xs">{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">
            A sample, led by the students who would move — a page of &ldquo;nothing changed&rdquo; tells nobody
            anything. Roll numbers and counts only: no names, no addresses, no marks.
          </p>
        </div>
      ) : null}
    </div>
  );
}
