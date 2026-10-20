import { CircleCheck, CircleMinus, CirclePlus, CircleX, Link2, PencilLine } from "lucide-react";
import type { PlannedLine, RosterCounts, RosterPlan } from "@/lib/admin/roster-plan";
import { TableFrame, TBODY_ROW, TD, TH, THEAD_ROW } from "@/components/admin/admin-ui";

/** At most this many lines per group are rendered (a 5,000-line file stays a light page). */
const SHOW_PER_GROUP = 200;

const FIELD_LABEL: Record<string, string> = {
  email: "Email",
  firstName: "First name",
  lastName: "Last name",
  batchYear: "Batch",
  departmentCode: "Department",
  section: "Section",
};

const show = (v: string | number | null) => (v === null || v === "" ? "—" : String(v));

function Group({
  title,
  icon,
  lines,
  render,
  columns,
}: {
  title: string;
  icon: React.ReactNode;
  lines: PlannedLine[];
  columns: string[];
  render: (l: PlannedLine) => React.ReactNode[];
}) {
  if (lines.length === 0) return null;
  const shown = lines.slice(0, SHOW_PER_GROUP);
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="flex items-center gap-2 px-5 font-display text-sm font-semibold">
        {icon}
        {title} <span className="font-normal text-text-secondary tabular-nums">({lines.length})</span>
      </h3>
      <TableFrame label={title}>
        <table className="w-full text-sm">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className={THEAD_ROW}>
              <th scope="col" className={TH}>
                Line
              </th>
              <th scope="col" className={TH}>
                Roll number
              </th>
              {columns.map((c) => (
                <th key={c} scope="col" className={TH}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.line} className={TBODY_ROW}>
                <td className={`${TD} tabular-nums`}>{l.line}</td>
                <td className={`${TD} font-mono text-xs`}>{l.collegeId ?? "—"}</td>
                {render(l).map((cell, i) => (
                  <td key={i} className={TD}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
      {lines.length > shown.length ? (
        <p className="px-5 text-xs text-text-secondary tabular-nums">
          Showing the first {shown.length} of {lines.length}.
        </p>
      ) : null}
    </section>
  );
}

export function RosterCountsList({ counts }: { counts: RosterCounts }) {
  const items: [string, number][] = [
    ["New students", counts.create],
    ["Profile updates", counts.update],
    ["LMS ids linked", counts.link],
    ["Unchanged", counts.unchanged],
    ["Skipped (account not active)", counts.skipped],
    ["Rejected", counts.rejected],
  ];
  return (
    <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-border bg-background px-3 py-2.5">
          <dt className="text-xs text-text-secondary">{label}</dt>
          <dd className="mt-0.5 font-display text-xl font-bold tabular-nums">{value.toLocaleString("en-IN")}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The dry-run diff, grouped by what each line would do. */
export function RosterDiff({ plan }: { plan: RosterPlan }) {
  const by = (kind: PlannedLine["outcome"]["kind"]) => plan.lines.filter((l) => l.outcome.kind === kind);
  return (
    <div className="space-y-8">
      <Group
        title="Rejected — nothing happens for these lines"
        icon={<CircleX className="h-4 w-4 text-danger" aria-hidden />}
        lines={by("REJECTED")}
        columns={["Why"]}
        render={(l) => [l.outcome.kind === "REJECTED" ? l.outcome.message : ""]}
      />
      <Group
        title="New students"
        icon={<CirclePlus className="h-4 w-4 text-success" aria-hidden />}
        lines={by("CREATE")}
        columns={["Name", "Cohort", "LMS id"]}
        render={(l) =>
          l.outcome.kind === "CREATE"
            ? [
                `${l.outcome.row.firstName} ${l.outcome.row.lastName}`,
                `${l.outcome.row.departmentCode} ${l.outcome.row.batchYear} · ${l.outcome.row.section ?? "no section"}`,
                <span key="lms" className="font-mono text-xs">
                  {l.outcome.row.lmsUserId}
                </span>,
              ]
            : []
        }
      />
      <Group
        title="Updates"
        icon={<PencilLine className="h-4 w-4 text-info" aria-hidden />}
        lines={by("UPDATE")}
        columns={["Changes"]}
        render={(l) =>
          l.outcome.kind === "UPDATE"
            ? [
                <ul key="changes" className="space-y-0.5 text-xs">
                  {l.outcome.changes.map((c) => (
                    <li key={c.field}>
                      {FIELD_LABEL[c.field] ?? c.field}: <span className="text-text-secondary line-through">{show(c.from)}</span>{" "}
                      <span aria-hidden>→</span>
                      <span className="sr-only">becomes</span> <span className="font-medium">{show(c.to)}</span>
                    </li>
                  ))}
                  {l.outcome.link ? (
                    <li className="inline-flex items-center gap-1">
                      <Link2 className="h-3.5 w-3.5" aria-hidden />
                      LMS id linked: <span className="font-mono">{l.outcome.row.lmsUserId}</span>
                    </li>
                  ) : null}
                </ul>,
              ]
            : []
        }
      />
      <Group
        title="Skipped — account not active"
        icon={<CircleMinus className="h-4 w-4 text-warning" aria-hidden />}
        lines={by("SKIPPED")}
        columns={["Why"]}
        render={() => ["The account is disabled, graduated or archived; an import never changes that."]}
      />
      <Group
        title="Unchanged"
        icon={<CircleCheck className="h-4 w-4 text-text-secondary" aria-hidden />}
        lines={by("UNCHANGED")}
        columns={[]}
        render={() => []}
      />
    </div>
  );
}
