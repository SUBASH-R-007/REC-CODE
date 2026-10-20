import type { Metadata } from "next";
import { Button } from "@recx/design";
import { IDENTIFYING_COLUMNS, PLACEMENT_EXPORT_COLUMNS, formatCampusDay } from "@recx/shared";
import { requirePlacementPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { cohortOptions, latestRunDay } from "@/server/queries/placement-cohort";
import { CohortFilter } from "@/components/placement/cohort-filter";
import { cohortSize, describeCohort, parseCohortFilter } from "@/lib/placement/filter";
import { campusDayDate } from "@recx/shared";

export const metadata: Metadata = { title: "Export the cohort" };

/**
 * `/placement-cell/export` — the CSV, with its cost stated first (Phase 9e).
 *
 * SPEC §6: the control names the row count and the column set BEFORE the
 * download starts. The reason is that "a CSV of readiness figures" and "a CSV
 * naming 4,312 students" are different things to leave on a laptop, and an
 * officer should know which one they are asking for while they can still
 * narrow it.
 *
 * A plain HTML form POSTing to the route: no JavaScript, so it works on any
 * connection, and a POST because the route WRITES a `PlacementExport` row. A
 * GET that recorded an export every time a tab was refreshed would make the
 * record useless.
 */
export default async function ExportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePlacementPage();
  const filter = parseCohortFilter(await searchParams);
  const computedOn = await latestRunDay();

  const [options, rowCount] = await Promise.all([
    computedOn ? cohortOptions(computedOn) : Promise.resolve({ departments: [], batches: [], sections: [] }),
    computedOn
      ? db.readinessSnapshot.count({
          where: {
            computedOn: campusDayDate(new Date(`${computedOn}T00:00:00.000Z`)),
            ...(filter.departmentCode ? { departmentCode: filter.departmentCode } : {}),
            ...(filter.batchYear ? { batchYear: filter.batchYear } : {}),
            ...(filter.section ? { section: filter.section } : {}),
          },
        })
      : Promise.resolve(0),
  ]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Export the cohort</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          A spreadsheet of the declared columns for the students the filter covers. Every readiness figure comes with
          the weight that was measurable for that student, and the file says so in its own first line — a spreadsheet
          forwarded three months from now has no caption to explain it.
        </p>
      </header>

      <CohortFilter
        basePath="/placement-cell/export"
        current={filter}
        options={options}
        total={cohortSize(options)}
      />

      <section className="space-y-3 rounded-xl border border-border p-5">
        <h2 className="font-display text-lg font-semibold">What you are about to download</h2>
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-text-secondary">Rows</dt>
            <dd className="font-display text-2xl font-bold tabular-nums">{rowCount}</dd>
          </div>
          <div>
            <dt className="text-text-secondary">Columns</dt>
            <dd className="font-display text-2xl font-bold tabular-nums">{PLACEMENT_EXPORT_COLUMNS.length}</dd>
          </div>
          <div>
            <dt className="text-text-secondary">Of those, naming a person</dt>
            {/*
              Stated on its own, because it is the number that decides how
              the file should be handled.
            */}
            <dd className="font-display text-2xl font-bold tabular-nums">{IDENTIFYING_COLUMNS.length}</dd>
          </div>
        </dl>
        <p className="text-sm text-text-secondary">
          {describeCohort(filter)}, from the run of{" "}
          {computedOn ? formatCampusDay(computedOn) : "— no run has finished"}. The download is recorded against your
          account with the filter, the column set and a digest of the file, so a copy found later can be traced back
          to this request.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-semibold">The columns</h2>
        <ul className="grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
          {PLACEMENT_EXPORT_COLUMNS.map((column) => (
            <li key={column.key} className="flex flex-wrap gap-x-2 border-b border-border py-1">
              <code className="text-xs">{column.key}</code>
              <span className="text-text-secondary">{column.describes}</span>
              {column.identifying ? <span className="text-xs font-semibold text-warning">names a person</span> : null}
            </li>
          ))}
        </ul>
        <p className="max-w-3xl text-xs text-muted">
          This list is the whole of it. There is no column for a student&rsquo;s code, their drafts, their notes,
          their accommodations, or anything about proctoring — and the export refuses a column that is not on this
          list rather than quietly leaving it out.
        </p>
      </section>

      {/* No JavaScript: a form, a POST, a file. */}
      <form method="post" action="/api/placement/export" className="space-y-3">
        <input type="hidden" name="dept" value={filter.departmentCode ?? ""} />
        <input type="hidden" name="batch" value={filter.batchYear ?? ""} />
        <input type="hidden" name="section" value={filter.section ?? ""} />
        <Button type="submit" disabled={rowCount === 0}>
          Download {rowCount} row{rowCount === 1 ? "" : "s"}
        </Button>
        {rowCount === 0 ? (
          <p className="text-sm text-text-secondary">
            Nobody matches this filter, so there is nothing to export. Widen it above.
          </p>
        ) : null}
      </form>
    </div>
  );
}
