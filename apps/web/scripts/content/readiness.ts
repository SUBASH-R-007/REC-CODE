import type { Db } from "@recx/db";
import {
  buildCohorts,
  loadReadinessSources,
  snapshotFor,
  writeSnapshots,
  type SnapshotRow,
} from "@recx/db/readiness";
import { READINESS_RULES_VERSION, cohortKeyFor } from "@recx/shared";

/**
 * Seeding one readiness run (Phase 9c).
 *
 * `/placement` renders nothing but its "not worked out yet" state until a
 * nightly run has happened, so a dev or e2e database without this is one
 * where the whole surface is invisible — including to the accessibility scan,
 * which would then be scanning an empty state and reporting it as a pass.
 *
 * It runs the REAL pipeline rather than inventing plausible rows: the same
 * `loadReadinessSources` / `buildCohorts` / `snapshotFor` / `writeSnapshots`
 * the 02:30 job calls. Two reasons. A seeded row that bypassed `snapshotFor`
 * could store a score the honesty constraints would have refused, and nobody
 * would find out until production. And the seed then exercises the adapter
 * against real seeded data on every `pnpm seed`, which is the cheapest
 * regression test the input layer has.
 *
 * Idempotent: the run row is keyed by campus day and the snapshots upsert on
 * `(userId, computedOn)`, so re-seeding recomputes rather than duplicating.
 *
 * Expect most percentile components to come back MISSING in a seeded
 * database: a seed has far fewer than the thirty students a percentile needs
 * before it stops being a disguised ranking. That is the honest result and
 * it is useful — the seeded card exercises both the measured and the
 * not-measured rendering paths.
 */

export interface ReadinessSeedResult {
  readonly computedOn: string;
  readonly students: number;
  readonly snapshots: number;
  readonly cohortsTooSmall: readonly string[];
  /** How many students had each tier unmeasurable. The honesty counter. */
  readonly unmeasurable: { readonly service: number; readonly product: number; readonly top: number };
}

export async function syncSeededReadiness(db: Db, now = new Date()): Promise<ReadinessSeedResult> {
  const sources = await loadReadinessSources(db, now);
  const computedOn = new Date(`${sources.evaluationDay}T00:00:00.000Z`);

  if (sources.students.length === 0) {
    return {
      computedOn: sources.evaluationDay,
      students: 0,
      snapshots: 0,
      cohortsTooSmall: [],
      unmeasurable: { service: 0, product: 0, top: 0 },
    };
  }

  const cohorts = buildCohorts(sources);
  const cohortStats = Object.fromEntries([...cohorts.values()].map((c) => [c.cohortKey, c.stats]));

  // The run row first: a snapshot has a foreign key to it. Both ends of the
  // window come from one clock — the column's CURRENT_TIMESTAMP default is
  // the DATABASE's, and `ReadinessRun_window_check` refuses a finishedAt
  // that lands before it (docs/CONVENTIONS.md, the WSL clock drift).
  const startedAt = now;
  await db.readinessRun.upsert({
    where: { computedOn },
    create: { computedOn, rulesVersion: READINESS_RULES_VERSION, startedAt, cohortStats: cohortStats as never },
    update: {
      rulesVersion: READINESS_RULES_VERSION,
      startedAt,
      finishedAt: null,
      ok: false,
      cohortStats: cohortStats as never,
    },
  });

  const rows: SnapshotRow[] = [];
  const unmeasurable = { service: 0, product: 0, top: 0 };
  for (const student of sources.students) {
    const cohort = cohorts.get(cohortKeyFor(student.batchYear));
    if (!cohort) continue;
    const row = snapshotFor(student, sources, cohort);
    if (row.serviceScore === null) unmeasurable.service += 1;
    if (row.productScore === null) unmeasurable.product += 1;
    if (row.topScore === null) unmeasurable.top += 1;
    rows.push(row);
  }

  const snapshots = await writeSnapshots(db, rows, {
    computedOn: sources.evaluationDay,
    rulesVersion: READINESS_RULES_VERSION,
  });

  const cohortsTooSmall = [...cohorts.values()]
    .filter((cohort) => cohort.size < 30)
    .map((cohort) => `${cohort.cohortKey} (${cohort.size})`)
    .sort();

  await db.readinessRun.update({
    where: { computedOn },
    data: {
      finishedAt: new Date(startedAt.getTime() + 1000),
      ok: true,
      studentsEvaluated: rows.length,
      notes: cohortsTooSmall.length > 0 ? `Cohorts too small to rank in: ${cohortsTooSmall.join(", ")}` : null,
    },
  });

  return {
    computedOn: sources.evaluationDay,
    students: rows.length,
    snapshots,
    cohortsTooSmall,
    unmeasurable,
  };
}
