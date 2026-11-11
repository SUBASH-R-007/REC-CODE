import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardBody, CardHeader } from "@recx/design";
import { VITALS_SAMPLE_RATE, VITAL_METRICS, campusDay, type VitalMetric } from "@recx/shared";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { readVitals, reportingCohorts } from "@/lib/vitals/read";
import { PageHeader, Notice } from "@/components/super/ui";

export const metadata: Metadata = { title: "Field vitals · Super-admin" };
export const dynamic = "force-dynamic";

/**
 * `/super/vitals` — what the browsers actually measured (Phase 16l,
 * `docs/ROADMAP.md` §3.4).
 *
 * The entry is titled "Field vitals cannot be read by cohort", and the gap
 * was wider: since Phase 10d the histograms have accumulated in Redis with
 * **no surface at all**. Collected, retained five weeks, never read. So this
 * page is half of the entry and the cohort filter is the other half.
 *
 * What it shows is the p75 bucket per metric per route for one day, because
 * that is the shape the data is stored in: a histogram per route per day,
 * with boundaries chosen so `docs/CAPACITY.md`'s budgets ARE boundaries.
 * `vitalPercentile` therefore answers "the p75 is in the 2000–2500 bucket"
 * and the page says exactly that rather than interpolating a number the
 * counts cannot support.
 *
 * One in four page loads reports, so a quiet day is thin and the page says
 * how many samples it is reading rather than drawing a confident grid over
 * nine of them.
 */
export default async function SuperVitalsPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string | string[]; cohort?: string | string[] }>;
}) {
  await requireSuperAdminPage();

  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const today = campusDay(new Date());
  // A day from the query, validated by shape: this reads a Redis key, so the
  // caller never chooses the key's text.
  const wantedDay = first(params.day);
  const day = wantedDay && /^\d{4}-\d{2}-\d{2}$/.test(wantedDay) ? wantedDay : today;
  const wantedCohort = first(params.cohort);
  const cohort = wantedCohort && /^(\d{4}|UNKNOWN)$/.test(wantedCohort) ? wantedCohort : null;

  const [reading, cohorts] = await Promise.all([readVitals({ day, cohort }), reportingCohorts(day)]);

  const byRoute = new Map<string, Map<VitalMetric, { bucket: string | null; total: number }>>();
  for (const cell of reading.cells) {
    const row = byRoute.get(cell.route) ?? new Map();
    row.set(cell.metric, { bucket: cell.bucket, total: cell.total });
    byRoute.set(cell.route, row);
  }

  const href = (next: { day?: string; cohort?: string | null }) => {
    const query = new URLSearchParams();
    query.set("day", next.day ?? day);
    const c = next.cohort === undefined ? cohort : next.cohort;
    if (c) query.set("cohort", c);
    return `/super/vitals?${query.toString()}`;
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Field vitals"
        description="What real browsers measured, per route per day. One page load in four reports; there is no user id in any of it."
      />

      <Card>
        <CardHeader
          title={`${day}${cohort ? ` · batch ${cohort}` : " · everybody"}`}
          subtitle={`${reading.samples} sample${reading.samples === 1 ? "" : "s"} read. The p75 is shown as the bucket it falls in, which is how the data is stored.`}
          action={cohort ? <Badge>batch {cohort}</Badge> : <Badge tone="success">all batches</Badge>}
        />
        <CardBody className="space-y-4">
          {reading.samples === 0 ? (
            <Notice
              tone="warning"
              title={cohort ? `No reports from batch ${cohort} on ${day}` : `No reports on ${day}`}
            >
              One page load in four reports, and a histogram expires five weeks after its last write. A quiet day, a
              day before this deployment was used, or a Redis that was restarted all look like this.
            </Notice>
          ) : null}

          <nav aria-label="Cohort" className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              href={href({ cohort: null })}
              className={cohort === null ? "font-semibold text-primary" : "text-text-secondary hover:underline"}
            >
              All batches
            </Link>
            {cohorts.map((entry) => (
              <Link
                key={entry}
                href={href({ cohort: entry })}
                className={cohort === entry ? "font-semibold text-primary" : "text-text-secondary hover:underline"}
              >
                {entry === "UNKNOWN" ? "No batch recorded" : `Batch ${entry}`}
              </Link>
            ))}
          </nav>

          {reading.cells.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">
                  The 75th-percentile bucket per route and metric for {day}
                  {cohort ? `, batch ${cohort}` : ""}
                </caption>
                <thead>
                  <tr className="border-b border-border text-left">
                    <th scope="col" className="py-2 pr-4 font-medium">
                      Route
                    </th>
                    {VITAL_METRICS.map((metric) => (
                      <th scope="col" key={metric} className="py-2 pr-4 font-medium">
                        {metric}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...byRoute.entries()].map(([route, row]) => (
                    <tr key={route} className="border-b border-border/60">
                      <th scope="row" className="py-2 pr-4 text-left font-mono text-xs font-normal">
                        {route}
                      </th>
                      {VITAL_METRICS.map((metric) => {
                        const cell = row.get(metric);
                        return (
                          <td key={metric} className="py-2 pr-4 tabular-nums">
                            {cell && cell.bucket !== null ? (
                              <>
                                <span className="font-medium">{cell.bucket}</span>
                                <span className="ml-1 text-xs text-muted">({cell.total})</span>
                              </>
                            ) : (
                              <span className="text-muted">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What this can and cannot tell you" />
        <CardBody>
          <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">
            <li>
              A cohort here is a <strong>batch year</strong> and nothing else — the same definition the placement
              percentiles use. It answers &quot;is this year&apos;s intake seeing it, or everybody?&quot;
            </li>
            <li>
              It cannot answer &quot;is it one lab?&quot;. That needs a location, and nothing in this platform
              collects one.
            </li>
            <li>
              There is no user id in any of it, so &quot;which students see a slow editor&quot; stays unanswerable
              by design (<code className="font-mono text-xs">docs/SECURITY.md</code> §7).
            </li>
            <li>
              Every metric is attributed to the route the document was <em>loaded</em> with, so a client-side
              navigation&apos;s layout shift lands on the page the visit started from.
            </li>
            <li>
              {Math.round(VITALS_SAMPLE_RATE * 100)}% of page loads report, and a day&apos;s histogram expires five
              weeks after its last write.
            </li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
