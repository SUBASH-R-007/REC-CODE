import type { Metadata } from "next";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import {
  RETUNE_TRIGGER_MINIMUM,
  RETUNE_TRIGGER_RATE,
  getOverturnReport,
} from "@/server/queries/admin-integrity";
import { PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Integrity calibration" };
export const dynamic = "force-dynamic";

/**
 * `/super/integrity` — overturn rates per signal (Phase 6e).
 *
 * SPEC §5 is blunt about why this page exists:
 *
 *   Every threshold shipped is initial engineering judgement with zero
 *   calibration data. The retune loop and overturn-rate reporting are
 *   load-bearing, not nice-to-haves.
 *
 * So this is not a dashboard. It is the only evidence anybody will ever have
 * about whether the thresholds in `packages/shared/src/triage.ts` are any
 * good, and it comes with a WRITTEN TRIGGER rather than a judgement call: a
 * signal with at least {RETUNE_TRIGGER_MINIMUM} decided flags whose flags are
 * cleared at least {RETUNE_TRIGGER_RATE} of the time is flagging honest
 * students, and its threshold should move.
 *
 * A high clear rate is not a sign the system is working. It is a sign the
 * system is stopping people who did nothing wrong.
 */
export default async function SuperIntegrityPage() {
  await requireSuperAdminPage();
  const report = await getOverturnReport();

  return (
    <div>
      <PageHeader
        title="Integrity calibration"
        description={
          <>
            Every threshold in this system was engineering judgement with no calibration data behind it. This page is
            the only way anyone finds out whether they were right. A signal whose flags keep getting cleared is
            stopping honest students: at {RETUNE_TRIGGER_MINIMUM} or more decided flags and a clear rate of{" "}
            {Math.round(RETUNE_TRIGGER_RATE * 100)}% or higher, its threshold should move. That is the documented
            trigger, not a suggestion.
          </>
        }
      />

      <div className="flex flex-wrap gap-3">
        <Stat label="Flags raised" value={report.totals.flags} />
        <Stat label="Decided by a human" value={report.totals.decided} />
        <Stat
          label={`Auto-cleared at ${report.slaHours}h`}
          value={report.totals.autoCleared}
          tone={report.totals.autoCleared > 0 ? "text-warning" : undefined}
        />
        <Stat
          label="Open and past the deadline"
          value={report.totals.overdue}
          tone={report.totals.overdue > 0 ? "text-danger" : undefined}
        />
      </div>

      {report.totals.autoCleared > 0 ? (
        <p className="mt-4 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning">
          {report.totals.autoCleared} flag(s) published themselves because nobody reviewed them in time. That is the
          design working — the cost of a slow queue falls on the institution, not on a student&apos;s placement — but a
          rising number here is a staffing problem, and the students it affects never hear about it.
        </p>
      ) : null}

      <section className="mt-6">
        <h2 className="font-display text-lg font-semibold text-text">Per signal</h2>
        {report.rows.length === 0 ? (
          <p className="mt-2 text-sm text-text-secondary">
            No flags have been raised yet, so there is nothing to calibrate against. Until there is, every threshold
            here is still a guess.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-elevated text-xs uppercase text-text-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2">Signal</th>
                  <th scope="col" className="px-3 py-2">Flags</th>
                  <th scope="col" className="px-3 py-2">Cleared</th>
                  <th scope="col" className="px-3 py-2">Upheld</th>
                  <th scope="col" className="px-3 py-2">Overturned</th>
                  <th scope="col" className="px-3 py-2">Clear rate</th>
                  <th scope="col" className="px-3 py-2">Verdict on the threshold</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.signal} className="border-t border-border align-top">
                    <th scope="row" className="px-3 py-2 font-medium text-text">{row.signal}</th>
                    <td className="px-3 py-2 tabular-nums">{row.flags}</td>
                    <td className="px-3 py-2 tabular-nums">{row.cleared}</td>
                    <td className="px-3 py-2 tabular-nums">{row.upheld}</td>
                    <td className="px-3 py-2 tabular-nums">{row.overturned}</td>
                    <td className="px-3 py-2 tabular-nums">{Math.round(row.clearRate * 100)}%</td>
                    <td className="px-3 py-2 text-xs">
                      {row.needsRetune ? (
                        <span className="text-danger">
                          Retune: this signal is mostly flagging students who did nothing wrong.
                        </span>
                      ) : row.cleared + row.upheld + row.overturned < RETUNE_TRIGGER_MINIMUM ? (
                        <span className="text-text-secondary">
                          Not enough decided flags yet ({RETUNE_TRIGGER_MINIMUM} needed).
                        </span>
                      ) : (
                        <span className="text-text-secondary">Holding.</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-6 text-xs text-text-secondary">
        Low-band flags are bulk-cleared with a mandatory {Math.round(report.lowBandSampleRate * 100)}% random human
        sample. The sample is what stops the band that holds most flags from never being read by anybody — and it is
        where most of the numbers above come from.
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { readonly label: string; readonly value: number; readonly tone?: string }) {
  return (
    <p className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
      <span className={`block text-xl font-semibold tabular-nums ${tone ?? "text-text"}`}>{value}</span>
      <span className="text-text-secondary">{label}</span>
    </p>
  );
}
