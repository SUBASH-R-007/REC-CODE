import "server-only";
import { MIN_PERCENTILE_COHORT, READINESS_TIERS, campusDay, type ReadinessTier } from "@recx/shared";
import { db } from "@/lib/db";

/**
 * What the placement cell reads (Phase 9d).
 *
 * This slice ships the overview only: which run the figures come from, how
 * many students it covered, and — the thing every officer surface has to
 * disclose — how much of each tier was measurable at all. The distributions,
 * the heatmap and the at-risk list arrive with the cohort dashboard.
 *
 * It returns AGGREGATES. No function here returns per-student rows, and that
 * is a rule rather than an accident of what this slice needed: a cohort
 * surface that could list students ordered by readiness is a ranking of
 * students by readiness, which SPEC §5 refuses. The drill-down in a later
 * slice reaches one student at a time, by id, and writes an audit row.
 */

export interface TierCoverage {
  readonly tier: ReadinessTier;
  /** Students with any measurable weight in this tier. */
  readonly measured: number;
  /** Students with none — shown as missing, never folded into a zero. */
  readonly unmeasurable: number;
  /**
   * The weight that was measurable, where every measured student agrees on
   * it. Null when they do not, which happens as soon as some students have
   * enough rated contests and others do not.
   */
  readonly availableWeight: number | null;
  /** The range, so an officer can see the disagreement rather than a null. */
  readonly availableWeightRange: { readonly min: number; readonly max: number } | null;
}

export interface PlacementOverview {
  /** The newest successful run, or null when none has finished. */
  readonly computedOn: string | null;
  readonly studentsEvaluated: number;
  readonly snapshots: number;
  readonly tiers: readonly TierCoverage[];
  /** Cohorts the run could not rank anybody in, from the run's own notes. */
  readonly notes: string | null;
  readonly minCohort: number;
}

const COLUMNS = {
  SERVICE: { score: "serviceScore", weight: "serviceAvailableWeight" },
  PRODUCT: { score: "productScore", weight: "productAvailableWeight" },
  TOP: { score: "topScore", weight: "topAvailableWeight" },
} as const satisfies Record<ReadinessTier, { score: string; weight: string }>;

export async function placementOverview(): Promise<PlacementOverview> {
  /**
   * The newest run with `ok = true`. A run that failed half way leaves `ok`
   * false, so a half-finished night is invisible here rather than
   * half-shown — which is why the column exists.
   */
  const run = await db.readinessRun.findFirst({
    where: { ok: true },
    orderBy: { computedOn: "desc" },
    select: { computedOn: true, studentsEvaluated: true, notes: true },
  });
  if (!run) {
    return {
      computedOn: null,
      studentsEvaluated: 0,
      snapshots: 0,
      tiers: READINESS_TIERS.map((tier) => ({
        tier,
        measured: 0,
        unmeasurable: 0,
        availableWeight: null,
        availableWeightRange: null,
      })),
      notes: null,
      minCohort: MIN_PERCENTILE_COHORT,
    };
  }

  const [snapshots, tiers] = await Promise.all([
    db.readinessSnapshot.count({ where: { computedOn: run.computedOn } }),
    Promise.all(READINESS_TIERS.map((tier) => coverageOf(tier, run.computedOn))),
  ]);

  return {
    computedOn: campusDay(run.computedOn),
    studentsEvaluated: run.studentsEvaluated,
    snapshots,
    tiers,
    notes: run.notes,
    minCohort: MIN_PERCENTILE_COHORT,
  };
}

/**
 * One tier's measurability across the whole run.
 *
 * Two aggregates and a min/max, never a row. The min/max is the honest way
 * to report a denominator that is not the same for everybody: as soon as some
 * students have eight rated contests and others do not, there is no single
 * "out of" for the cohort, and printing the most common one would be a
 * number that is wrong for a named fraction of the college.
 */
async function coverageOf(tier: ReadinessTier, computedOn: Date): Promise<TierCoverage> {
  const { score, weight } = COLUMNS[tier];
  const [measured, unmeasurable, range] = await Promise.all([
    db.readinessSnapshot.count({ where: { computedOn, [score]: { not: null } } }),
    db.readinessSnapshot.count({ where: { computedOn, [score]: null } }),
    db.readinessSnapshot.aggregate({
      where: { computedOn, [score]: { not: null } },
      _min: { [weight]: true },
      _max: { [weight]: true },
    } as never) as unknown as Promise<Record<"_min" | "_max", Record<string, number | null>>>,
  ]);

  const min = range._min[weight] ?? null;
  const max = range._max[weight] ?? null;
  return {
    tier,
    measured,
    unmeasurable,
    availableWeight: min !== null && min === max ? min : null,
    availableWeightRange: min !== null && max !== null ? { min, max } : null,
  };
}
