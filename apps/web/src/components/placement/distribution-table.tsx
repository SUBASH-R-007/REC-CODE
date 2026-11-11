import { READINESS_TIER_LABEL, type Distribution } from "@recx/shared";

/**
 * A readiness distribution, as a bar chart AND as the same numbers in a table
 * (Phase 9e).
 *
 * SPEC §6 is explicit: the chart ships an accessible table of the same bucket
 * counts, not an `aria-label` summary. The reason is that a summary is a
 * sentence somebody wrote once, and a table is the data — a screen-reader
 * user comparing two sections needs to read the numbers, not somebody's
 * description of them.
 *
 * The bars are a redundant encoding. Every count is printed, and the caption
 * states the denominator and how many students had nothing measurable, which
 * is the fact a bar chart cannot show.
 */
export function DistributionTable({ dist, caption }: { dist: Distribution; caption: string }) {
  const max = Math.max(1, ...dist.buckets.map((bucket) => bucket.count));
  const label = READINESS_TIER_LABEL[dist.tier];

  return (
    <section className="space-y-3 rounded-xl border border-border p-4">
      <h3 className="font-display text-base font-semibold">{label}</h3>

      <table className="w-full border-collapse text-sm">
        <caption className="pb-2 text-left text-xs text-text-secondary">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-left">
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              Percentage of what was measurable
            </th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              Students
            </th>
            <th scope="col" className="py-1.5 font-semibold">
              <span className="sr-only">Share</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {dist.buckets.map((bucket) => (
            <tr key={bucket.label} className="border-b border-border last:border-0">
              <th scope="row" className="py-1.5 pr-3 text-left font-medium tabular-nums">
                {bucket.label}
              </th>
              <td className="py-1.5 pr-3 tabular-nums">{bucket.count}</td>
              <td className="w-1/2 py-1.5">
                {/*
                  Decorative: the number beside it carries the meaning, so
                  the bar is aria-hidden rather than given a label that would
                  be read out twice.
                */}
                <span aria-hidden="true" className="block h-2 rounded-full bg-primary-subtle">
                  <span
                    className="block h-2 rounded-full bg-primary"
                    style={{ width: `${Math.round((bucket.count / max) * 100)}%` }}
                  />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {dist.unmeasurable > 0 ? (
        <p className="text-xs text-text-secondary">
          {dist.unmeasurable} student{dist.unmeasurable === 1 ? "" : "s"} had nothing measurable in this tier, so they
          have no score rather than a zero and are not in the table above.
        </p>
      ) : null}
    </section>
  );
}
