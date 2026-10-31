import "server-only";
import {
  APTITUDE_AREAS,
  APTITUDE_AREA_LABEL,
  APTITUDE_TOPIC_AREA,
  AT_RISK_QUIET_DAYS,
  AT_RISK_SERVICE_NORMALISED,
  MIN_PERCENTILE_COHORT,
  READINESS_TIERS,
  campusDay,
  campusDayDate,
  dayDifference,
  distribution,
  distributionCaption,
  heatmap,
  isAtRisk,
  normalise,
  topicCounts,
  weakestTopics,
  type AptitudeArea,
  type AptitudeTopic,
  type Distribution,
  type Heatmap,
  type ReadinessTier,
  type Topic,
} from "@recx/shared";
import { db } from "@/lib/db";
import { mentorsOf } from "@/lib/auth/mentor-scope";

/**
 * The cohort dashboard's reads (Phase 9e).
 *
 * Two rules shape every function here, and both are enforced by
 * `tests/repo/placement-fence.test.ts` rather than by care:
 *
 *   1. **Aggregates, not rows.** SPEC §5: "the dashboard never produces a
 *      shareable public ranking of students by readiness." The distributions,
 *      the heatmap and the aptitude gaps return counts; nothing in them can
 *      produce a list of students, so no page could sort one by accident.
 *   2. **No ORDER BY a score, anywhere.** The one list that does name
 *      students — the at-risk list — is ordered by DAYS QUIET, which is what
 *      the spec's rule is actually about. A list sorted by readiness would be
 *      a league table whatever it was called.
 *
 * Everything reads `ReadinessSnapshot`, which carries its own cohort columns,
 * so every aggregate is one index scan with no join to `User`. A student who
 * changes section later does not retroactively move a historical snapshot
 * into a cohort it was never scored against.
 */

export interface CohortFilter {
  readonly departmentCode?: string | null;
  readonly batchYear?: number | null;
  readonly section?: string | null;
}

/** The newest run with `ok = true`, which is the only run any surface reads. */
export async function latestRunDay(): Promise<string | null> {
  const run = await db.readinessRun.findFirst({
    where: { ok: true },
    orderBy: { computedOn: "desc" },
    select: { computedOn: true },
  });
  return run ? campusDay(run.computedOn) : null;
}

function whereFor(computedOn: string, filter: CohortFilter) {
  return {
    computedOn: campusDayDate(new Date(`${computedOn}T00:00:00.000Z`)),
    ...(filter.departmentCode ? { departmentCode: filter.departmentCode } : {}),
    ...(filter.batchYear ? { batchYear: filter.batchYear } : {}),
    ...(filter.section ? { section: filter.section } : {}),
  };
}

export interface CohortOption {
  readonly value: string;
  readonly count: number;
}

/** The filter's own choices, with how many students each covers. */
export async function cohortOptions(computedOn: string): Promise<{
  readonly departments: readonly CohortOption[];
  readonly batches: readonly CohortOption[];
  readonly sections: readonly CohortOption[];
}> {
  const where = whereFor(computedOn, {});
  const [departments, batches, sections] = await Promise.all([
    db.readinessSnapshot.groupBy({ by: ["departmentCode"], where, _count: { userId: true } }),
    db.readinessSnapshot.groupBy({ by: ["batchYear"], where, _count: { userId: true } }),
    db.readinessSnapshot.groupBy({ by: ["section"], where, _count: { userId: true } }),
  ]);
  const option = (value: unknown, count: number): CohortOption => ({
    // A null department or section is a real group, not a gap: dropping it
    // would make the filter's counts disagree with the cohort size.
    value: value === null || value === undefined ? "—" : String(value),
    count,
  });
  const sort = (rows: CohortOption[]) => rows.sort((a, b) => a.value.localeCompare(b.value));
  return {
    departments: sort(departments.map((r) => option(r.departmentCode, r._count.userId))),
    batches: sort(batches.map((r) => option(r.batchYear, r._count.userId))),
    sections: sort(sections.map((r) => option(r.section, r._count.userId))),
  };
}

export interface CohortDistributions {
  readonly computedOn: string;
  readonly size: number;
  readonly tiers: readonly { readonly dist: Distribution; readonly caption: string }[];
  /** Whether the cohort is big enough for percentiles to have been taken. */
  readonly rankable: boolean;
  readonly minCohort: number;
}

/**
 * The three distributions for one cohort.
 *
 * One query for all three tiers, because the three score columns live on the
 * same row: three separate `groupBy` passes would read the same index three
 * times for no benefit.
 */
export async function cohortDistributions(
  computedOn: string,
  filter: CohortFilter = {},
): Promise<CohortDistributions> {
  const rows = await db.readinessSnapshot.findMany({
    where: whereFor(computedOn, filter),
    select: {
      serviceScore: true,
      serviceAvailableWeight: true,
      productScore: true,
      productAvailableWeight: true,
      topScore: true,
      topAvailableWeight: true,
    },
  });

  const per: Record<ReadinessTier, { score: number | null; availableWeight: number }[]> = {
    SERVICE: rows.map((r) => ({ score: r.serviceScore, availableWeight: r.serviceAvailableWeight })),
    PRODUCT: rows.map((r) => ({ score: r.productScore, availableWeight: r.productAvailableWeight })),
    TOP: rows.map((r) => ({ score: r.topScore, availableWeight: r.topAvailableWeight })),
  };

  const tiers = READINESS_TIERS.map((tier) => {
    const dist = distribution(tier, per[tier]);
    return { dist, caption: distributionCaption(dist) };
  });

  return {
    computedOn,
    size: rows.length,
    tiers,
    rankable: rows.length >= MIN_PERCENTILE_COHORT,
    minCohort: MIN_PERCENTILE_COHORT,
  };
}

/**
 * The 14-topic × section weakness grid.
 *
 * Reads only `section` and `topicUnassisted`. There is no user id in the
 * select list at all, which is the strongest form the no-ranking rule can
 * take here: the data a league table would need never leaves the database.
 */
export async function cohortHeatmap(
  computedOn: string,
  filter: CohortFilter = {},
  tier: ReadinessTier = "PRODUCT",
): Promise<{ readonly map: Heatmap; readonly weakest: ReturnType<typeof weakestTopics> }> {
  const rows = await db.readinessSnapshot.findMany({
    where: whereFor(computedOn, filter),
    select: { section: true, topicUnassisted: true },
  });
  const map = heatmap(
    rows.map((row) => ({ section: row.section, topicUnassisted: topicCounts(row.topicUnassisted) })),
    tier,
  );
  return { map, weakest: weakestTopics(map) };
}

export interface AtRiskRow {
  readonly userId: string;
  readonly name: string;
  readonly collegeId: string;
  readonly section: string | null;
  readonly departmentCode: string | null;
  readonly quietDays: number | null;
  readonly lastActiveOn: string | null;
  readonly serviceScore: number | null;
  readonly serviceAvailableWeight: number;
  readonly serviceNormalised: number | null;
  readonly reason: string;
  /** The named human, if one is already assigned, and the assignment. */
  readonly mentor: { readonly assignmentId: string; readonly name: string; readonly since: string } | null;
}

/**
 * The at-risk list.
 *
 * SPEC §5: "no activity 7+ days, or SERVICE readiness <40 within 6 months of
 * a drive", routed "to a named mentor for a conversation, never an automated
 * email".
 *
 * Ordered by `lastActiveOn ASC` — longest silent first — and NEVER by score.
 * Two reasons, and the second is the one that matters: a list ordered by
 * readiness is a ranking of students by readiness, which the spec forbids
 * outright; and days of silence is what an at-risk list is actually about, so
 * it is also the more useful order. Snapshot-day granularity is deliberate
 * too — a list that re-ordered itself between two page loads because somebody
 * submitted at 11:58 would be a list nobody could work through.
 *
 * `take` is a hard cap rather than a page: the surface is a worklist, and a
 * worklist nobody can finish is a worklist nobody starts. The page says how
 * many were not shown.
 */
export async function atRiskList(
  computedOn: string,
  filter: CohortFilter = {},
  options: { readonly driveWithinSixMonths?: boolean; readonly take?: number; readonly now?: Date } = {},
): Promise<{ readonly rows: readonly AtRiskRow[]; readonly total: number; readonly shown: number }> {
  const take = options.take ?? 200;
  const now = options.now ?? new Date();
  const today = campusDay(now);

  const candidates = await db.readinessSnapshot.findMany({
    where: whereFor(computedOn, filter),
    select: {
      userId: true,
      section: true,
      departmentCode: true,
      lastActiveOn: true,
      serviceScore: true,
      serviceAvailableWeight: true,
    },
    // The snapshot's own column, and nulls first: a student with no recorded
    // activity at all is the quietest of all, not the freshest.
    orderBy: [{ lastActiveOn: { sort: "asc", nulls: "first" } }, { userId: "asc" }],
  });

  const flagged: Array<{ row: (typeof candidates)[number]; quietDays: number | null; reason: string }> = [];
  for (const row of candidates) {
    const lastActiveOn = row.lastActiveOn ? campusDay(row.lastActiveOn) : null;
    const quietDays = lastActiveOn ? dayDifference(lastActiveOn, today) : null;
    const verdict = isAtRisk({
      // No recorded activity is treated as the longest silence the window
      // can express, so such a student is never quietly dropped.
      quietDays: quietDays ?? Number.MAX_SAFE_INTEGER,
      serviceNormalised: normalise({ score: row.serviceScore, availableWeight: row.serviceAvailableWeight }),
      driveWithinSixMonths: options.driveWithinSixMonths ?? false,
    });
    if (verdict.atRisk) {
      flagged.push({
        row,
        quietDays,
        reason:
          quietDays === null
            ? "No activity has ever been recorded for this student."
            : (verdict.reason ?? `No activity for ${quietDays} days.`),
      });
    }
  }

  const page = flagged.slice(0, take);
  const ids = page.map((entry) => entry.row.userId);
  const [users, mentors] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstName: true, lastName: true, collegeId: true },
    }),
    mentorsOf(ids),
  ]);
  const byId = new Map(users.map((user) => [user.id, user]));

  const rows = page.flatMap((entry): AtRiskRow[] => {
    const user = byId.get(entry.row.userId);
    if (!user) return [];
    const mentor = mentors.get(entry.row.userId);
    const lastActiveOn = entry.row.lastActiveOn ? campusDay(entry.row.lastActiveOn) : null;
    return [
      {
        userId: entry.row.userId,
        name: `${user.firstName} ${user.lastName}`.trim(),
        collegeId: user.collegeId,
        section: entry.row.section,
        departmentCode: entry.row.departmentCode,
        quietDays: entry.quietDays,
        lastActiveOn,
        serviceScore: entry.row.serviceScore,
        serviceAvailableWeight: entry.row.serviceAvailableWeight,
        serviceNormalised: normalise({
          score: entry.row.serviceScore,
          availableWeight: entry.row.serviceAvailableWeight,
        }),
        reason: entry.reason,
        mentor: mentor
          ? { assignmentId: mentor.assignmentId, name: mentor.name, since: campusDay(mentor.assignedAt) }
          : null,
      },
    ];
  });

  return { rows, total: flagged.length, shown: rows.length };
}

/** The rule, as text, so the page states it rather than implying it. */
export const AT_RISK_RULE = `A student is on this list if nothing has been recorded for ${AT_RISK_QUIET_DAYS} days or more, or — within six months of a drive — if their SERVICE coverage is under ${AT_RISK_SERVICE_NORMALISED}% of what was measurable for them. It is a prompt for a conversation and nothing else: being here has no effect on the student's account, their leaderboard place or anything a recruiter sees.`;

export interface AptitudeGap {
  readonly section: string;
  readonly area: AptitudeArea;
  readonly areaLabel: string;
  readonly attempted: number;
  readonly correct: number;
  /** Accuracy as 0–100, or null when too few questions to mean anything. */
  readonly accuracy: number | null;
}

/** Below this, a section's accuracy in an area is not reported. */
export const APTITUDE_SECTION_MIN_ATTEMPTS = 50;

/**
 * Section-level aptitude gaps, through the Phase 7 per-topic stats.
 *
 * Per SECTION and per AREA, never per student: "section B is weak on verbal"
 * is a timetabling decision, and it is reachable without naming anybody. The
 * floor is on the SECTION's total attempts rather than on each student's,
 * because the figure is about the section.
 *
 * It joins `User` for the section, which the readiness aggregates avoid —
 * unavoidable here, because `AptitudeUserTopicStat` carries no cohort columns
 * of its own. Bounded by the number of students, not by the number of
 * questions.
 */
export async function aptitudeSectionGaps(filter: CohortFilter = {}): Promise<readonly AptitudeGap[]> {
  const rows = await db.aptitudeUserTopicStat.findMany({
    where: {
      user: {
        role: "STUDENT",
        ...(filter.departmentCode ? { departmentCode: filter.departmentCode } : {}),
        ...(filter.batchYear ? { batchYear: filter.batchYear } : {}),
        ...(filter.section ? { section: filter.section } : {}),
      },
    },
    select: { topic: true, attempted: true, correct: true, user: { select: { section: true } } },
  });

  const totals = new Map<string, { attempted: number; correct: number }>();
  for (const row of rows) {
    const section = row.user.section ?? "—";
    const area = APTITUDE_TOPIC_AREA[row.topic as AptitudeTopic];
    const key = `${section}\u0000${area}`;
    const entry = totals.get(key) ?? { attempted: 0, correct: 0 };
    entry.attempted += row.attempted;
    entry.correct += row.correct;
    totals.set(key, entry);
  }

  const out: AptitudeGap[] = [];
  const sections = [...new Set([...totals.keys()].map((key) => key.split("\u0000")[0]!))].sort();
  for (const section of sections) {
    for (const area of APTITUDE_AREAS) {
      const entry = totals.get(`${section}\u0000${area}`) ?? { attempted: 0, correct: 0 };
      out.push({
        section,
        area,
        areaLabel: APTITUDE_AREA_LABEL[area],
        attempted: entry.attempted,
        correct: entry.correct,
        accuracy:
          entry.attempted >= APTITUDE_SECTION_MIN_ATTEMPTS
            ? Math.round((entry.correct / entry.attempted) * 100)
            : null,
      });
    }
  }
  return out;
}

/** The fourteen topic keys, for a page that renders a grid header. */
export type { Topic };
