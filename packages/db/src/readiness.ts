import {
  APTITUDE_TOPIC_AREA,
  MIN_PERCENTILE_COHORT,
  READINESS_RATING_MIN_CONTESTS,
  TOPICS,
  campusDay,
  cohortKeyFor,
  histogram,
  missing,
  percentileRankSorted,
  present,
  scoreAllTiers,
  sortedPopulation,
  type AptitudeTopic,
  type ComponentValue,
  type ReadinessInputs,
  type ReadinessTier,
  type Topic,
} from "@recx/shared";
import type { Db } from "./index";

/**
 * Everything the nightly readiness run reads, and how it turns it into
 * inputs (Phase 9).
 *
 * The shape of this module is the one performance decision in the phase:
 * **a handful of whole-college passes, not a handful of queries per
 * student**. Five thousand students × six reads is thirty thousand queries a
 * night; the same information is six grouped scans. Everything below is
 * therefore keyed by user id in memory, and nothing in here runs inside a
 * per-student loop.
 *
 * The arithmetic is all in `@recx/shared` and none of it is here. That split
 * is what makes a disputed score checkable by a test that touches no
 * database — and a disputed score is the point of the whole phase.
 */

/** Below this many answered aptitude questions, an accuracy is noise. */
const APTITUDE_MIN_ANSWERED = 20;
/** The window `consistency` is measured over, per SPEC §5. */
export const CONSISTENCY_WINDOW_DAYS = 30;

export interface StudentRow {
  readonly userId: string;
  readonly collegeId: string;
  readonly batchYear: number | null;
  readonly departmentCode: string | null;
  readonly section: string | null;
}

/**
 * Every student readiness is computed for.
 *
 * `GRADUATED` and `ARCHIVED` are excluded: they are end states, and a
 * readiness figure for somebody who has left is a number nobody will act on
 * and a row that keeps appearing in a cohort distribution. `DISABLED` IS
 * included — an account paused for inactivity is exactly the one a mentor
 * may need the readiness of.
 */
export async function readinessCohort(db: Db): Promise<StudentRow[]> {
  const rows = await db.user.findMany({
    where: { role: "STUDENT", status: { in: ["ACTIVE", "SOFT_RESTRICTED", "DISABLED"] } },
    orderBy: { id: "asc" },
    select: { id: true, collegeId: true, batchYear: true, departmentCode: true, section: true },
  });
  return rows.map((row) => ({
    userId: row.id,
    collegeId: row.collegeId,
    batchYear: row.batchYear,
    departmentCode: row.departmentCode,
    section: row.section,
  }));
}

/** Per-difficulty solved counts, split by whether a hint was used. */
export interface SolveCounts {
  readonly easyMedium: number;
  readonly mediumUnassisted: number;
  readonly mediumHardUnassisted: number;
}

interface SolveRow {
  userId: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  assisted: boolean;
  n: number;
}

/**
 * The per-difficulty counts, in ONE grouped pass over the whole college.
 *
 * `UserStats` carries a single `assistedSolves` scalar, so it cannot answer
 * "medium unassisted" — the split needs `UserProblemStatus` joined to
 * `Problem`. One sequential scan grouped three ways, rather than one query
 * per student, and an index on `UserProblemStatus(status)` keeps it to the
 * solved rows.
 *
 * SERVICE's `easyMediumCoverage` counts a solve however it was reached and
 * the two higher tiers count only unassisted ones — the spec names the
 * components that way, and a service round asks whether you can write the
 * loop at all.
 */
export async function solveCounts(db: Db): Promise<Map<string, SolveCounts>> {
  const rows = await db.$queryRawUnsafe<SolveRow[]>(
    `SELECT ups."userId", p."difficulty"::text AS difficulty, ups."assisted", count(*)::int AS n
       FROM "UserProblemStatus" ups
       JOIN "Problem" p ON p."id" = ups."problemId"
      WHERE ups."status" = 'SOLVED'
      GROUP BY 1, 2, 3`,
  );

  const byUser = new Map<string, { easyMedium: number; mediumUnassisted: number; mediumHardUnassisted: number }>();
  for (const row of rows) {
    const acc = byUser.get(row.userId) ?? { easyMedium: 0, mediumUnassisted: 0, mediumHardUnassisted: 0 };
    if (row.difficulty === "EASY" || row.difficulty === "MEDIUM") acc.easyMedium += row.n;
    if (!row.assisted && row.difficulty === "MEDIUM") acc.mediumUnassisted += row.n;
    if (!row.assisted && (row.difficulty === "MEDIUM" || row.difficulty === "HARD")) {
      acc.mediumHardUnassisted += row.n;
    }
    byUser.set(row.userId, acc);
  }
  return byUser;
}

/**
 * Unassisted solves per topic, for `topicBreadth`.
 *
 * No join at all: `UserStats.topicSolved` and `topicAssisted` are already
 * per-topic JSON maps, and unassisted-per-topic is their difference. A
 * negative difference (a counter drifted) is floored at zero rather than
 * allowed to make a breadth value nonsense.
 */
export async function unassistedByTopic(db: Db): Promise<Map<string, Partial<Record<Topic, number>>>> {
  const rows = await db.userStats.findMany({ select: { userId: true, topicSolved: true, topicAssisted: true } });
  const byUser = new Map<string, Partial<Record<Topic, number>>>();
  for (const row of rows) {
    const solved = asCounts(row.topicSolved);
    const assisted = asCounts(row.topicAssisted);
    const counts: Partial<Record<Topic, number>> = {};
    for (const topic of TOPICS) {
      counts[topic] = Math.max(0, (solved[topic] ?? 0) - (assisted[topic] ?? 0));
    }
    byUser.set(row.userId, counts);
  }
  return byUser;
}

function asCounts(value: unknown): Partial<Record<Topic, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Partial<Record<Topic, number>> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(TOPICS as readonly string[]).includes(key)) continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(n)) out[key as Topic] = n;
  }
  return out;
}

export interface AptitudeAccuracy {
  /** Quantitative and logical together, as the spec's "aptitude". */
  readonly aptitude: { answered: number; correct: number };
  readonly verbal: { answered: number; correct: number };
}

/**
 * Aptitude accuracy per student, split into aptitude and verbal.
 *
 * SPEC §5 weights `aptitudePercentile` and `verbalPercentile` separately, and
 * `APTITUDE_TOPIC_AREA` is what splits them: QUANTITATIVE and LOGICAL are
 * "aptitude", VERBAL is "verbal". Read from `AptitudeUserTopicStat`, which
 * Phase 7 maintains per answered question — so it counts practice as well as
 * full mocks, which is right: a student who has only ever practised has
 * still demonstrated the thing being measured.
 */
export async function aptitudeAccuracy(db: Db): Promise<Map<string, AptitudeAccuracy>> {
  const rows = await db.aptitudeUserTopicStat.findMany({
    select: { userId: true, topic: true, attempted: true, correct: true },
  });
  const byUser = new Map<string, AptitudeAccuracy>();
  for (const row of rows) {
    const acc =
      byUser.get(row.userId) ?? { aptitude: { answered: 0, correct: 0 }, verbal: { answered: 0, correct: 0 } };
    const area = APTITUDE_TOPIC_AREA[row.topic as AptitudeTopic];
    const bucket = area === "VERBAL" ? acc.verbal : acc.aptitude;
    bucket.answered += row.attempted;
    bucket.correct += row.correct;
    byUser.set(row.userId, acc);
  }
  return byUser;
}

/** Contest rating, and how many rated contests it rests on. */
export async function ratings(db: Db): Promise<Map<string, { rating: number; contestsRated: number }>> {
  const rows = await db.userRating.findMany({ select: { userId: true, rating: true, contestsRated: true } });
  return new Map(rows.map((row) => [row.userId, { rating: row.rating, contestsRated: row.contestsRated }]));
}

export interface ActivityWindow {
  readonly activeDays: number;
  readonly lastActiveOn: string | null;
}

/**
 * Active days in the last thirty, and the last active day.
 *
 * SPEC §5: "consistency(active days in last 30 ÷ 30)". An active day is one
 * with a submission or a solve — NOT merely an `ActivityDay` row, which also
 * exists for a student who opened a problem and left. Measuring that would
 * measure browsing.
 *
 * `lastActiveOn` is copied into the snapshot so the officer at-risk list can
 * sort by it without joining `User` for five thousand rows.
 */
export async function activityWindow(db: Db, evaluationDay: string): Promise<Map<string, ActivityWindow>> {
  const from = new Date(`${evaluationDay}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - (CONSISTENCY_WINDOW_DAYS - 1));
  const rows = await db.$queryRawUnsafe<Array<{ userId: string; activeDays: number; lastActiveOn: Date | null }>>(
    `SELECT a."userId",
            count(*) FILTER (WHERE a."date" >= $1::date)::int AS "activeDays",
            max(a."date") AS "lastActiveOn"
       FROM "ActivityDay" a
      WHERE a."submissions" + a."solved" > 0
      GROUP BY 1`,
    from.toISOString().slice(0, 10),
  );
  return new Map(
    rows.map((row) => [
      row.userId,
      {
        activeDays: row.activeDays,
        lastActiveOn: row.lastActiveOn ? row.lastActiveOn.toISOString().slice(0, 10) : null,
      },
    ]),
  );
}

/** Everything one run needs, loaded once. */
export interface ReadinessSources {
  readonly students: readonly StudentRow[];
  readonly solves: Map<string, SolveCounts>;
  readonly topics: Map<string, Partial<Record<Topic, number>>>;
  readonly aptitude: Map<string, AptitudeAccuracy>;
  readonly rating: Map<string, { rating: number; contestsRated: number }>;
  readonly activity: Map<string, ActivityWindow>;
  readonly evaluationDay: string;
}

export async function loadReadinessSources(db: Db, now: Date): Promise<ReadinessSources> {
  const evaluationDay = campusDay(now);
  const [students, solves, topics, aptitude, rating, activity] = await Promise.all([
    readinessCohort(db),
    solveCounts(db),
    unassistedByTopic(db),
    aptitudeAccuracy(db),
    ratings(db),
    activityWindow(db, evaluationDay),
  ]);
  return { students, solves, topics, aptitude, rating, activity, evaluationDay };
}

/**
 * A cohort's populations, sorted once, plus the frozen distribution.
 *
 * Built per cohort so each student is ranked against their own batch, and
 * sorted once so ranking five thousand students is a few thousand binary
 * searches rather than six million comparisons.
 */
export interface CohortPopulations {
  readonly cohortKey: string;
  readonly size: number;
  readonly aptitude: readonly number[];
  readonly verbal: readonly number[];
  readonly rating: readonly number[];
  readonly stats: Record<string, unknown>;
}

export function buildCohorts(sources: ReadinessSources): Map<string, CohortPopulations> {
  const groups = new Map<string, StudentRow[]>();
  for (const student of sources.students) {
    const key = cohortKeyFor(student.batchYear);
    groups.set(key, [...(groups.get(key) ?? []), student]);
  }

  const out = new Map<string, CohortPopulations>();
  for (const [cohortKey, members] of groups) {
    const aptitude: number[] = [];
    const verbal: number[] = [];
    const rating: number[] = [];
    for (const member of members) {
      const apt = sources.aptitude.get(member.userId);
      if (apt && apt.aptitude.answered >= APTITUDE_MIN_ANSWERED) {
        aptitude.push(apt.aptitude.correct / apt.aptitude.answered);
      }
      if (apt && apt.verbal.answered >= APTITUDE_MIN_ANSWERED) {
        verbal.push(apt.verbal.correct / apt.verbal.answered);
      }
      const rate = sources.rating.get(member.userId);
      if (rate && rate.contestsRated >= READINESS_RATING_MIN_CONTESTS) rating.push(rate.rating);
    }
    out.set(cohortKey, {
      cohortKey,
      size: members.length,
      aptitude: sortedPopulation(aptitude),
      verbal: sortedPopulation(verbal),
      rating: sortedPopulation(rating),
      /**
       * Frozen as DISTRIBUTIONS, never as raw values: a stored list of every
       * student's rating is a stored list of every student's rating, and a
       * histogram is all a re-derivation needs.
       */
      stats: {
        n: members.length,
        aptitude: histogram(aptitude, 0, 1),
        verbal: histogram(verbal, 0, 1),
        rating: rating.length > 0 ? histogram(rating, rating[0]!, rating.at(-1)!) : [],
        ranked: { aptitude: aptitude.length, verbal: verbal.length, rating: rating.length },
      },
    });
  }
  return out;
}

/**
 * One student's inputs.
 *
 * Every component that cannot be computed comes back MISSING with the reason
 * the student needs: `NO_DATA_YET` is theirs to fix, `COHORT_TOO_SMALL` and
 * `NO_SOURCE_YET` are not. Nothing is ever filled with a zero.
 */
export function inputsFor(
  student: StudentRow,
  sources: ReadinessSources,
  cohort: CohortPopulations,
): ReadinessInputs {
  const tooSmall = cohort.size < MIN_PERCENTILE_COHORT;
  const apt = sources.aptitude.get(student.userId);
  const rate = sources.rating.get(student.userId);
  const activity = sources.activity.get(student.userId);
  const solves = sources.solves.get(student.userId);

  const rank = (
    answered: number | undefined,
    correct: number | undefined,
    population: readonly number[],
    minimum: number,
  ): ComponentValue => {
    if (tooSmall) return missing("COHORT_TOO_SMALL");
    if (answered === undefined || answered < minimum) return missing("NO_DATA_YET");
    return present(percentileRankSorted((correct ?? 0) / answered, population));
  };

  return {
    aptitudePercentile: rank(apt?.aptitude.answered, apt?.aptitude.correct, cohort.aptitude, APTITUDE_MIN_ANSWERED),
    verbalPercentile: rank(apt?.verbal.answered, apt?.verbal.correct, cohort.verbal, APTITUDE_MIN_ANSWERED),
    /**
     * The order of these three answers is the honest one. A cohort too small
     * to rank in is not the student's problem and no number of contests
     * fixes it, so it is said first; below the floor says "keep going", and
     * only a student who has entered none at all is told to try one.
     */
    ratingPercentile: tooSmall
      ? missing("COHORT_TOO_SMALL")
      : rate && rate.contestsRated >= READINESS_RATING_MIN_CONTESTS
        ? present(percentileRankSorted(rate.rating, cohort.rating))
        : rate && rate.contestsRated > 0
          ? missing("TOO_FEW_RATED_CONTESTS")
          : missing("NO_DATA_YET"),
    /**
     * No source in this plan at any phase — the mock-interview scheduler is
     * Phase 11+. Permanently MISSING, which is why no TOP score can exceed
     * 85 and why every officer surface divides by `availableWeight`.
     */
    mockInterviewScore: missing("NO_SOURCE_YET"),
    consistency: present((activity?.activeDays ?? 0) / CONSISTENCY_WINDOW_DAYS),
    unassistedByTopic: sources.topics.get(student.userId) ?? {},
    easyMediumSolved: solves?.easyMedium ?? 0,
    mediumUnassisted: solves?.mediumUnassisted ?? 0,
    mediumHardUnassisted: solves?.mediumHardUnassisted ?? 0,
  };
}

export interface SnapshotRow {
  readonly userId: string;
  readonly cohortKey: string;
  readonly cohortSize: number;
  readonly batchYear: number | null;
  readonly departmentCode: string | null;
  readonly section: string | null;
  readonly serviceScore: number | null;
  readonly productScore: number | null;
  readonly topScore: number | null;
  readonly serviceAvailableWeight: number;
  readonly productAvailableWeight: number;
  readonly topAvailableWeight: number;
  readonly topicBreadthProduct: number | null;
  readonly topicBreadthTop: number | null;
  readonly limitingTopicProduct: Topic | null;
  readonly limitingTopicTop: Topic | null;
  readonly components: Record<string, unknown>;
  readonly topicUnassisted: Record<string, number>;
  readonly lastActiveOn: string | null;
}

/**
 * One student's row, computed and shaped for storage.
 *
 * The `components` JSON is keyed by TIER and then by component, because
 * `topicBreadth` is tier-specific: PRODUCT divides by 4 per topic and TOP by
 * 8, so a single entry genuinely cannot hold both. The whole purpose of
 * storing the breakdown is that a disputed score is recomputable years later
 * from the stored values and the rules version — and that fails for the two
 * tiers that use breadth if the JSON is keyed by component alone.
 */
export function snapshotFor(
  student: StudentRow,
  sources: ReadinessSources,
  cohort: CohortPopulations,
): SnapshotRow {
  const inputs = inputsFor(student, sources, cohort);
  const scores = scoreAllTiers(inputs);
  const activity = sources.activity.get(student.userId);

  const components: Record<string, unknown> = {};
  for (const tier of Object.keys(scores) as ReadinessTier[]) {
    const perComponent: Record<string, unknown> = {};
    for (const row of scores[tier].components) {
      perComponent[row.component] =
        row.state.state === "PRESENT"
          ? {
              state: "PRESENT",
              value: row.state.value,
              weight: row.weight,
              points: row.points,
              ...(row.limitingTopic ? { limitingTopic: row.limitingTopic, perTopicTarget: row.perTopicTarget } : {}),
            }
          : { state: "MISSING", reason: row.state.reason, weight: row.weight };
    }
    components[tier] = perComponent;
  }

  const breadth = (tier: "PRODUCT" | "TOP") => {
    const row = scores[tier].components.find((c) => c.component === "TOPIC_BREADTH");
    if (!row || row.state.state !== "PRESENT" || !row.limitingTopic) {
      return { value: null, topic: null };
    }
    return { value: Math.round(row.state.value * 100), topic: row.limitingTopic };
  };
  const product = breadth("PRODUCT");
  const top = breadth("TOP");

  const score = (tier: ReadinessTier) =>
    scores[tier].availableWeight === 0 ? null : Math.round(scores[tier].score);

  return {
    userId: student.userId,
    cohortKey: cohort.cohortKey,
    cohortSize: cohort.size,
    batchYear: student.batchYear,
    departmentCode: student.departmentCode,
    section: student.section,
    serviceScore: score("SERVICE"),
    productScore: score("PRODUCT"),
    topScore: score("TOP"),
    serviceAvailableWeight: Math.round(scores.SERVICE.availableWeight),
    productAvailableWeight: Math.round(scores.PRODUCT.availableWeight),
    topAvailableWeight: Math.round(scores.TOP.availableWeight),
    topicBreadthProduct: product.value,
    topicBreadthTop: top.value,
    limitingTopicProduct: product.topic,
    limitingTopicTop: top.topic,
    components,
    topicUnassisted: Object.fromEntries(
      TOPICS.map((topic) => [topic, inputs.unassistedByTopic[topic] ?? 0]),
    ) as Record<string, number>,
    lastActiveOn: activity?.lastActiveOn ?? null,
  };
}

/**
 * Write one batch of snapshots, idempotent per `(userId, computedOn)`.
 *
 * A rerun of the same campus day recomputes rather than duplicating, which
 * is what makes the job safe to re-run after a crash — and the
 * `ReadinessSnapshot_recompute_only` trigger refuses anything else.
 */
export async function writeSnapshots(
  db: Db,
  rows: readonly SnapshotRow[],
  options: { readonly computedOn: string; readonly rulesVersion: number },
): Promise<number> {
  if (rows.length === 0) return 0;
  const computedOn = new Date(`${options.computedOn}T00:00:00.000Z`);
  let written = 0;
  for (const row of rows) {
    const data = {
      rulesVersion: options.rulesVersion,
      cohortKey: row.cohortKey,
      cohortSize: row.cohortSize,
      batchYear: row.batchYear,
      departmentCode: row.departmentCode,
      section: row.section,
      serviceScore: row.serviceScore,
      productScore: row.productScore,
      topScore: row.topScore,
      serviceAvailableWeight: row.serviceAvailableWeight,
      productAvailableWeight: row.productAvailableWeight,
      topAvailableWeight: row.topAvailableWeight,
      topicBreadthProduct: row.topicBreadthProduct,
      topicBreadthTop: row.topicBreadthTop,
      limitingTopicProduct: row.limitingTopicProduct,
      limitingTopicTop: row.limitingTopicTop,
      components: row.components as never,
      topicUnassisted: row.topicUnassisted as never,
      lastActiveOn: row.lastActiveOn ? new Date(`${row.lastActiveOn}T00:00:00.000Z`) : null,
    };
    await db.readinessSnapshot.upsert({
      where: { userId_computedOn: { userId: row.userId, computedOn } },
      create: { userId: row.userId, computedOn, ...data },
      update: data,
    });
    written += 1;
  }
  return written;
}
