import { UserCog } from "lucide-react";
import { Badge, EmptyState } from "@recx/design";
import type { JudgeCaps } from "@/lib/judge/caps";
import type { QuotaOverrideRow } from "@/server/queries/admin-judge";
import { QuotaOverrideForm } from "@/components/admin/quota-override-form";

const IST_DATE_TIME = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Kolkata",
});

const DEFAULT_ROWS: { key: keyof JudgeCaps; label: string; unit: string }[] = [
  { key: "inFlightSubmissions", label: "Submissions being judged at once", unit: "" },
  { key: "inFlightRuns", label: "Runs at once", unit: "" },
  { key: "practicePerDay", label: "Practice submissions per day", unit: "resets at midnight IST" },
  { key: "runsPerHour", label: "Runs per hour", unit: "trailing hour" },
  { key: "cpuMinutesPerDay", label: "CPU-minutes of judging per day", unit: "resets at midnight IST" },
];

function capCell(value: number | null, fallback: number) {
  return value === null ? <span className="text-muted">{fallback} (default)</span> : <span className="font-medium">{value}</span>;
}

const th = "px-3 py-2.5 text-left font-medium first:pl-5 last:pr-5";
const td = "px-3 py-2.5 first:pl-5 last:pr-5 align-top";

/** Default caps, active per-student overrides and (super admin) the grant form. */
export function CapsPanel({
  defaults,
  overrides,
  canGrant,
}: {
  defaults: JudgeCaps;
  overrides: QuotaOverrideRow[];
  canGrant: boolean;
}) {
  return (
    <div className="space-y-6">
      <dl className="grid gap-3 px-5 sm:grid-cols-2 lg:grid-cols-5">
        {DEFAULT_ROWS.map((row) => (
          <div key={row.key} className="rounded-xl border border-border bg-background px-3 py-2.5">
            <dt className="text-xs text-text-secondary">{row.label}</dt>
            <dd className="mt-0.5 font-display text-xl font-bold tabular-nums">{defaults[row.key]}</dd>
            {row.unit && <dd className="text-xs text-muted">{row.unit}</dd>}
          </div>
        ))}
      </dl>

      <section aria-labelledby="active-overrides">
        <h3 id="active-overrides" className="px-5 font-display text-sm font-semibold tracking-tight">
          Active overrides
        </h3>
        {overrides.length === 0 ? (
          <EmptyState
            compact
            icon={<UserCog className="h-5 w-5" />}
            title="No active overrides"
            description="Every student is on the default caps."
          />
        ) : (
          // Focusable, so a table wider than a phone scrolls from the keyboard.
          <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Active overrides">
            <table className="w-full text-sm tabular-nums">
              <caption className="sr-only">Active judge cap overrides</caption>
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className={th}>
                    Student
                  </th>
                  <th scope="col" className={th}>
                    Practice / day
                  </th>
                  <th scope="col" className={th}>
                    Runs / hour
                  </th>
                  <th scope="col" className={th}>
                    CPU-min / day
                  </th>
                  <th scope="col" className={th}>
                    Expires
                  </th>
                  <th scope="col" className={th}>
                    Reason
                  </th>
                </tr>
              </thead>
              <tbody>
                {overrides.map((o) => (
                  <tr key={o.id} className="border-t border-border first:border-t-0">
                    <td className={td}>
                      <span className="block font-mono text-xs">{o.collegeId}</span>
                      <span className="block text-xs text-text-secondary">{o.studentName}</span>
                      {!o.inEffect && (
                        <Badge className="mt-1">Replaced by a newer override</Badge>
                      )}
                    </td>
                    <td className={td}>{capCell(o.practicePerDay, defaults.practicePerDay)}</td>
                    <td className={td}>{capCell(o.runsPerHour, defaults.runsPerHour)}</td>
                    <td className={td}>{capCell(o.cpuMinutesPerDay, defaults.cpuMinutesPerDay)}</td>
                    <td className={`${td} whitespace-nowrap text-xs`}>
                      {o.expiresAt ? `${IST_DATE_TIME.format(o.expiresAt)} IST` : "Until replaced"}
                    </td>
                    <td className={`${td} text-xs text-text-secondary`}>
                      <span className="block max-w-72 break-words">{o.reason}</span>
                      <span className="block text-muted">
                        {o.grantedBy} · {IST_DATE_TIME.format(o.createdAt)} IST
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="grant-override" className="border-t border-border px-5 pt-5">
        <h3 id="grant-override" className="font-display text-sm font-semibold tracking-tight">
          Grant an override
        </h3>
        {canGrant ? (
          <div className="mt-3">
            <QuotaOverrideForm
              defaults={{
                practicePerDay: defaults.practicePerDay,
                runsPerHour: defaults.runsPerHour,
                cpuMinutesPerDay: defaults.cpuMinutesPerDay,
              }}
            />
          </div>
        ) : (
          <p className="mt-2 text-sm text-text-secondary">
            Only a super admin can change a student&apos;s judge caps. Ask one to grant the override; it is recorded in
            the audit log.
          </p>
        )}
      </section>
    </div>
  );
}
