import "server-only";
import { TOPICS, campusDay, campusDayDate, type PlacementExportRow } from "@recx/shared";
import { db } from "@/lib/db";
import type { CohortFilter } from "@/server/queries/placement-cohort";

/**
 * The CSV's rows (Phase 9e).
 *
 * Its own module, separate from the aggregates in `placement-cohort.ts`, for
 * one reason: this is the only placement query that returns a row per
 * student, and keeping it apart means the no-ranking rule can be read off the
 * file boundary. There is no ordering by a score here either — the rows come
 * out by college id, which is the order a spreadsheet is useful in.
 *
 * Every column is on `PLACEMENT_EXPORT_COLUMNS`. The route asserts that; this
 * module simply never produces anything else, and the fence refuses a read of
 * a model that is not on the placement allowlist.
 */

const SNAPSHOT_SELECT = {
  userId: true,
  computedOn: true,
  rulesVersion: true,
  departmentCode: true,
  batchYear: true,
  section: true,
  serviceScore: true,
  serviceAvailableWeight: true,
  productScore: true,
  productAvailableWeight: true,
  topScore: true,
  topAvailableWeight: true,
  topicUnassisted: true,
  limitingTopicProduct: true,
  lastActiveOn: true,
} as const;

/** How many active days in the last thirty, which is what consistency reads. */
const ACTIVITY_WINDOW_DAYS = 30;

export async function buildExportRows(
  computedOn: string,
  filter: CohortFilter = {},
): Promise<PlacementExportRow[]> {
  const day = campusDayDate(new Date(`${computedOn}T00:00:00.000Z`));
  const snapshots = await db.readinessSnapshot.findMany({
    where: {
      computedOn: day,
      ...(filter.departmentCode ? { departmentCode: filter.departmentCode } : {}),
      ...(filter.batchYear ? { batchYear: filter.batchYear } : {}),
      ...(filter.section ? { section: filter.section } : {}),
    },
    select: SNAPSHOT_SELECT,
  });
  if (snapshots.length === 0) return [];

  const ids = snapshots.map((row) => row.userId);
  const from = new Date(day);
  from.setUTCDate(from.getUTCDate() - (ACTIVITY_WINDOW_DAYS - 1));

  const [users, stats, ratings, activity, assessments] = await Promise.all([
    db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, collegeId: true, firstName: true, lastName: true },
    }),
    db.userStats.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, solvedTotal: true, assistedSolves: true },
    }),
    db.userRating.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, rating: true, contestsRated: true },
    }),
    db.activityDay.groupBy({
      by: ["userId"],
      where: { userId: { in: ids }, date: { gte: from, lte: day } },
      _count: { userId: true },
    }),
    /**
     * Released scores only, which is what the spec's allowlist permits: an
     * unreleased score is a score the STUDENT has not seen, and an officer
     * discussing it with them would be discussing something they cannot
     * check.
     *
     * "Released" is the assessment being CLOSED or ARCHIVED and the sitting
     * having been handed in. A score from an assessment still OPEN is a score
     * of a sitting that may not be over, and a VOIDED or TERMINATED attempt
     * has a score that means nothing at all.
     */
    db.assessmentAttempt.findMany({
      where: {
        userId: { in: ids },
        status: { in: ["SUBMITTED", "AUTO_SUBMITTED"] },
        assessment: { status: { in: ["CLOSED", "ARCHIVED"] } },
        maxScore: { gt: 0 },
      },
      select: { userId: true, totalScore: true, maxScore: true },
    }),
  ]);

  const byUser = new Map(users.map((user) => [user.id, user]));
  const byStats = new Map(stats.map((row) => [row.userId, row]));
  const byRating = new Map(ratings.map((row) => [row.userId, row]));
  const byActivity = new Map(activity.map((row) => [row.userId, row._count.userId]));
  const byAssessment = new Map<string, { released: number; percentSum: number }>();
  for (const attempt of assessments) {
    const entry = byAssessment.get(attempt.userId) ?? { released: 0, percentSum: 0 };
    entry.released += 1;
    entry.percentSum += (attempt.totalScore / (attempt.maxScore || 1)) * 100;
    byAssessment.set(attempt.userId, entry);
  }

  const rows: PlacementExportRow[] = [];
  for (const snapshot of snapshots) {
    const user = byUser.get(snapshot.userId);
    if (!user) continue;
    const counts = topicCountsOf(snapshot.topicUnassisted);
    const stat = byStats.get(snapshot.userId);
    const rating = byRating.get(snapshot.userId);
    const assessment = byAssessment.get(snapshot.userId);

    rows.push({
      collegeId: user.collegeId,
      name: `${user.firstName} ${user.lastName}`.trim(),
      departmentCode: snapshot.departmentCode,
      batchYear: snapshot.batchYear,
      section: snapshot.section,

      serviceScore: snapshot.serviceScore,
      serviceAvailableWeight: snapshot.serviceAvailableWeight,
      productScore: snapshot.productScore,
      productAvailableWeight: snapshot.productAvailableWeight,
      topScore: snapshot.topScore,
      topAvailableWeight: snapshot.topAvailableWeight,
      readinessComputedOn: campusDay(snapshot.computedOn),
      rulesVersion: snapshot.rulesVersion,

      solvedTotal: stat?.solvedTotal ?? 0,
      // The split the whole scoring rests on: a hinted solve counts for
      // SERVICE and not for the two tiers above it.
      solvedUnassisted: Math.max(0, (stat?.solvedTotal ?? 0) - (stat?.assistedSolves ?? 0)),
      topicsTouched: TOPICS.filter((topic) => (counts[topic] ?? 0) > 0).length,
      limitingTopicProduct: snapshot.limitingTopicProduct,

      // Null rather than 0 for a student with no rated contests: a 0 rating
      // in a spreadsheet reads as "terrible", and an empty cell reads as
      // "none", which is the truth.
      rating: rating?.rating ?? null,
      contestsRated: rating?.contestsRated ?? 0,

      releasedAssessments: assessment?.released ?? 0,
      assessmentScoreAverage: assessment ? Math.round(assessment.percentSum / assessment.released) : null,

      lastActiveOn: snapshot.lastActiveOn ? campusDay(snapshot.lastActiveOn) : null,
      activeDaysLast30: byActivity.get(snapshot.userId) ?? 0,
    });
  }

  // By college id: the order a spreadsheet is useful in, and never by a
  // score — a CSV sorted by readiness is a ranking of named students, which
  // is the one output SPEC §5 forbids outright.
  return rows.sort((a, b) => String(a.collegeId).localeCompare(String(b.collegeId)));
}

/** The stored counts, narrowed to the taxonomy this build knows. */
function topicCountsOf(stored: unknown): Partial<Record<(typeof TOPICS)[number], number>> {
  const out: Partial<Record<(typeof TOPICS)[number], number>> = {};
  if (stored && typeof stored === "object") {
    const record = stored as Record<string, unknown>;
    for (const topic of TOPICS) {
      const value = record[topic];
      if (typeof value === "number") out[topic] = value;
    }
  }
  return out;
}
