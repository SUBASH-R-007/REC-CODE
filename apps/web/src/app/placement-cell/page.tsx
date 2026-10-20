import type { Metadata } from "next";
import { EmptyState } from "@recx/design";
import { READINESS_CALIBRATION_NOTE, READINESS_FRAMING, formatCampusDay } from "@recx/shared";
import { requirePlacementPage } from "@/lib/auth/guards";
import { placementOverview } from "@/server/queries/placement-overview";

export const metadata: Metadata = { title: "Placement cell" };

/**
 * `/placement-cell` — the overview (Phase 9d).
 *
 * This slice ships the role boundary and the honest denominator; the
 * distributions, the heatmap and the at-risk list arrive with the cohort
 * dashboard.
 *
 * The framing is on this page too, and that is the part the design's review
 * found missing the first time round. "Missing, never silently as zero" was
 * engineered into the student's card and into the database and then dropped
 * on the officer surfaces — where a 70 on a tier whose mock-interview
 * component is permanently unmeasured is a 70 OUT OF 85, and comparing it
 * against an absolute threshold of 70 would quietly mark a whole cohort as
 * under-prepared because of a component nobody has built.
 *
 * So every figure here is stated with what was measurable, and where the
 * cohort does not agree on that denominator the range is shown rather than
 * the most common value — a single "out of" would be wrong for a named
 * fraction of the college.
 */
export default async function PlacementCellPage() {
  await requirePlacementPage();
  const overview = await placementOverview();

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <h1 className="font-display text-2xl font-bold tracking-tight">Placement cell</h1>
        <p className="max-w-3xl text-sm">{READINESS_FRAMING}</p>
        <p className="max-w-3xl text-sm text-text-secondary">
          Nobody uses these figures to decide who may sit a drive. Eligibility is a human decision, recorded with its
          reason, and the platform never makes it.
        </p>
      </header>

      {overview.computedOn === null ? (
        <EmptyState
          title="No readiness run has finished yet"
          description="Readiness is computed overnight. Once a run completes, the figures and what was measurable in them appear here."
        />
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="font-display text-lg font-semibold">The newest run</h2>
            <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-text-secondary">Computed on</dt>
                <dd className="font-medium">{formatCampusDay(overview.computedOn)}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Students evaluated</dt>
                <dd className="font-medium tabular-nums">{overview.studentsEvaluated}</dd>
              </div>
              <div>
                <dt className="text-text-secondary">Snapshots stored</dt>
                <dd className="font-medium tabular-nums">{overview.snapshots}</dd>
              </div>
            </dl>
            {overview.notes ? (
              <p className="max-w-3xl rounded-lg border border-border bg-primary-subtle/40 p-3 text-sm">
                {overview.notes}. A cohort under {overview.minCohort} students is not ranked at all: a percentile
                against eleven people identifies them to anybody who can count.
              </p>
            ) : null}
          </section>

          <section className="space-y-3">
            <h2 className="font-display text-lg font-semibold">What was measurable</h2>
            <p className="max-w-3xl text-sm text-text-secondary">
              Read every score on this platform against these numbers, not against 100. The mock-interview component
              has no source at all yet, so no tier that includes it can reach 100 for anybody.
            </p>
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Measurable weight per readiness tier in the run of {formatCampusDay(overview.computedOn)}
              </caption>
              <thead>
                <tr className="border-b border-border text-left">
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Tier
                  </th>
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Measurable out of 100
                  </th>
                  <th scope="col" className="py-2 pr-3 font-semibold">
                    Students with a score
                  </th>
                  <th scope="col" className="py-2 font-semibold">
                    Students with nothing measurable
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.tiers.map((tier) => (
                  <tr key={tier.tier} className="border-b border-border last:border-0">
                    <th scope="row" className="py-2 pr-3 text-left font-medium">
                      {tier.tier}
                    </th>
                    <td className="py-2 pr-3 tabular-nums">
                      {tier.availableWeight !== null
                        ? tier.availableWeight
                        : tier.availableWeightRange
                          ? `${tier.availableWeightRange.min}–${tier.availableWeightRange.max} (it differs per student)`
                          : "—"}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{tier.measured}</td>
                    <td className="py-2 tabular-nums">{tier.unmeasurable}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="max-w-3xl text-xs text-text-secondary">
              Where the measurable weight differs per student, the range is shown rather than the commonest value: a
              single &ldquo;out of&rdquo; would be wrong for a named fraction of the college. A student with nothing
              measurable has no score, not a zero.
            </p>
          </section>

          <p className="max-w-3xl border-t border-border pt-5 text-xs text-muted">{READINESS_CALIBRATION_NOTE}</p>
        </>
      )}
    </div>
  );
}
