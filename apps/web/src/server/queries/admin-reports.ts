import "server-only";
import { z } from "zod";
import { Prisma } from "@recx/db";
import { TOPIC_LABEL, TOPICS, type Topic } from "@recx/shared";
import { db } from "@/lib/db";
import { scopeCovers, scopedStudentSql, type StudentScope } from "@/lib/auth/scope";
import { lastCampusWeeks, type CampusWeek } from "@/lib/admin/campus-week";
import { cohortKey, type Cohort } from "@/lib/admin/cohort";

/**
 * /admin/reports: cohort-level figures, every one a scoped raw query joined
 * to "User" u through scopedStudentSql — the fence
 * (tests/repo/admin-scope.test.ts) refuses one that is not. Sources are the
 * maintained read models only: User, UserStats, the WEEK XpBucket,
 * ActivityDay, UserProblemStatus and StudyPlanEnrollment. Never the XP
 * ledger. Only current students count (ACTIVE and SOFT_RESTRICTED). No
 * export: a PII export is a super-admin PrivilegedOperation.
 */

const num = z.coerce.number();
const nullableNum = z.coerce.number().nullable();

function rowsOf<T extends z.ZodTypeAny>(schema: T, rows: unknown[]): z.output<T>[] {
  return rows.flatMap((r) => {
    const parsed = schema.safeParse(r);
    return parsed.success ? [parsed.data as z.output<T>] : [];
  });
}

/** Extra WHERE for one cohort, against the joined "User" alias u (no table named, so no scope needed here). */
function cohortFilter(cohort: Cohort | null): Prisma.Sql {
  if (!cohort) return Prisma.empty;
  const section = cohort.section === null ? Prisma.sql`u."section" IS NULL` : Prisma.sql`u."section" = ${cohort.section}`;
  return Prisma.sql`AND u."batchYear" = ${cohort.batchYear}::int AND u."departmentCode" = ${cohort.departmentCode} AND ${section}`;
}

const CURRENT = Prisma.sql`u."status" IN ('ACTIVE', 'SOFT_RESTRICTED')`;

export interface CohortSummaryRow {
  key: string | null;
  batchYear: number | null;
  departmentCode: string | null;
  section: string | null;
  students: number;
  active7: number;
  zeroSolve: number;
  medianSolved: number;
  solved: number;
  assisted: number;
}

export interface WeeklyPoint {
  week: CampusWeek;
  value: number;
}

export interface TopicRow {
  topic: Topic;
  label: string;
  solved: number;
  assisted: number;
  students: number;
}

export interface HardProblemRow {
  displayCode: string;
  title: string;
  attempters: number;
  solvers: number;
}

export interface PlanProgressRow {
  title: string;
  kind: "SHEET" | "TRACK";
  enrolled: number;
  completed: number;
  averagePercent: number;
}

export interface CohortReport {
  cohort: Cohort | null;
  weeks: CampusWeek[];
  summary: CohortSummaryRow[];
  weeklyActive: WeeklyPoint[];
  weeklySolves: WeeklyPoint[];
  difficulty: { easy: number; medium: number; hard: number };
  topics: TopicRow[];
  hardest: HardProblemRow[];
  plans: PlanProgressRow[];
  streaks: { bucket: string; students: number }[];
}

const summarySchema = z.object({
  batchYear: nullableNum,
  departmentCode: z.string().nullable(),
  section: z.string().nullable(),
  students: num,
  active7: num,
  zeroSolve: num,
  medianSolved: nullableNum,
  solved: num,
  assisted: num,
});

async function cohortSummary(scope: StudentScope, cohort: Cohort | null, now: Date): Promise<CohortSummaryRow[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db.$queryRaw<unknown[]>`
    SELECT u."batchYear", u."departmentCode", u."section",
           count(*)::int AS students,
           count(*) FILTER (WHERE u."lastActiveAt" >= ${since})::int AS active7,
           count(*) FILTER (WHERE COALESCE(s."solvedTotal", 0) = 0)::int AS "zeroSolve",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(s."solvedTotal", 0)) AS "medianSolved",
           COALESCE(sum(s."solvedTotal"), 0)::int AS solved,
           COALESCE(sum(s."assistedSolves"), 0)::int AS assisted
    FROM "User" u
    LEFT JOIN "UserStats" s ON s."userId" = u.id
    WHERE ${scopedStudentSql(scope, "u")} AND ${CURRENT} ${cohortFilter(cohort)}
    GROUP BY u."batchYear", u."departmentCode", u."section"
    ORDER BY u."batchYear" DESC NULLS LAST, u."departmentCode" ASC NULLS LAST, u."section" ASC NULLS LAST`;
  return rowsOf(summarySchema, rows).map((r) => ({
    ...r,
    key: cohortKey(r),
    medianSolved: r.medianSolved ?? 0,
  }));
}

async function weeklyActive(scope: StudentScope, cohort: Cohort | null, weeks: CampusWeek[]): Promise<WeeklyPoint[]> {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT to_char(date_trunc('week', a."date"), 'YYYY-MM-DD') AS monday, count(DISTINCT a."userId")::int AS value
    FROM "ActivityDay" a
    JOIN "User" u ON u.id = a."userId"
    WHERE a."date" >= ${weeks[0]!.monday}::date AND ${scopedStudentSql(scope, "u")} AND ${CURRENT} ${cohortFilter(cohort)}
    GROUP BY 1`;
  const byMonday = new Map(rowsOf(z.object({ monday: z.string(), value: num }), rows).map((r) => [r.monday, r.value]));
  return weeks.map((week) => ({ week, value: byMonday.get(week.monday) ?? 0 }));
}

async function weeklySolves(scope: StudentScope, cohort: Cohort | null, weeks: CampusWeek[]): Promise<WeeklyPoint[]> {
  const keys = weeks.map((w) => w.key);
  const rows = await db.$queryRaw<unknown[]>`
    SELECT b."periodKey" AS key,
           COALESCE(sum(b."solvedEasy" + b."solvedMedium" + b."solvedHard"), 0)::int AS value
    FROM "XpBucket" b
    JOIN "User" u ON u.id = b."userId"
    WHERE b."period" = 'WEEK' AND b."periodKey" = ANY(${keys}::text[])
      AND ${scopedStudentSql(scope, "u")} AND ${CURRENT} ${cohortFilter(cohort)}
    GROUP BY b."periodKey"`;
  const byKey = new Map(rowsOf(z.object({ key: z.string(), value: num }), rows).map((r) => [r.key, r.value]));
  return weeks.map((week) => ({ week, value: byKey.get(week.key) ?? 0 }));
}

async function difficultySplit(scope: StudentScope, cohort: Cohort | null) {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT COALESCE(sum(s."solvedEasy"), 0)::int AS easy,
           COALESCE(sum(s."solvedMedium"), 0)::int AS medium,
           COALESCE(sum(s."solvedHard"), 0)::int AS hard
    FROM "UserStats" s
    JOIN "User" u ON u.id = s."userId"
    WHERE ${scopedStudentSql(scope, "u")} AND ${CURRENT} ${cohortFilter(cohort)}`;
  return rowsOf(z.object({ easy: num, medium: num, hard: num }), rows)[0] ?? { easy: 0, medium: 0, hard: 0 };
}

async function topicCoverage(scope: StudentScope, cohort: Cohort | null): Promise<TopicRow[]> {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT t.topic,
           COALESCE(sum(t.solved), 0)::int AS solved,
           COALESCE(sum(t.assisted), 0)::int AS assisted,
           count(DISTINCT t."userId") FILTER (WHERE t.solved + t.assisted > 0)::int AS students
    FROM (
      SELECT s."userId", k.key AS topic,
             COALESCE((s."topicSolved" ->> k.key)::int, 0) AS solved,
             COALESCE((s."topicAssisted" ->> k.key)::int, 0) AS assisted
      FROM "UserStats" s
      JOIN "User" u ON u.id = s."userId"
      CROSS JOIN LATERAL (
        SELECT jsonb_object_keys(s."topicSolved") AS key
        UNION
        SELECT jsonb_object_keys(s."topicAssisted")
      ) k
      WHERE ${scopedStudentSql(scope, "u")} AND ${CURRENT} ${cohortFilter(cohort)}
    ) t
    GROUP BY t.topic`;
  const parsed = rowsOf(z.object({ topic: z.string(), solved: num, assisted: num, students: num }), rows);
  const byTopic = new Map(parsed.map((r) => [r.topic, r]));
  return TOPICS.map((topic) => {
    const r = byTopic.get(topic);
    return { topic, label: TOPIC_LABEL[topic], solved: r?.solved ?? 0, assisted: r?.assisted ?? 0, students: r?.students ?? 0 };
  });
}

/** Problems the cohort finds hardest: at least 5 attempters, lowest solve share first. */
async function hardestProblems(scope: StudentScope, cohort: Cohort | null): Promise<HardProblemRow[]> {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT p."displayCode", p."title",
           count(*)::int AS attempters,
           count(*) FILTER (WHERE ups."status" = 'SOLVED')::int AS solvers
    FROM "UserProblemStatus" ups
    JOIN "User" u ON u.id = ups."userId"
    JOIN "Problem" p ON p.id = ups."problemId"
    WHERE ${scopedStudentSql(scope, "u")} AND ${CURRENT} ${cohortFilter(cohort)}
    GROUP BY p.id, p."displayCode", p."title"
    HAVING count(*) >= 5
    ORDER BY (count(*) FILTER (WHERE ups."status" = 'SOLVED'))::float / count(*) ASC, count(*) DESC, p."displayCode" ASC
    LIMIT 15`;
  return rowsOf(z.object({ displayCode: z.string(), title: z.string(), attempters: num, solvers: num }), rows);
}

async function planProgress(scope: StudentScope, cohort: Cohort | null): Promise<PlanProgressRow[]> {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT sp."title", sp."kind"::text AS kind,
           count(*)::int AS enrolled,
           count(*) FILTER (WHERE e."completedAt" IS NOT NULL)::int AS completed,
           COALESCE(avg(CASE WHEN e."itemsTotal" > 0 THEN 100.0 * e."itemsDone" / e."itemsTotal" ELSE 0 END), 0) AS "averagePercent"
    FROM "StudyPlanEnrollment" e
    JOIN "User" u ON u.id = e."userId"
    JOIN "StudyPlan" sp ON sp.id = e."planId"
    WHERE ${scopedStudentSql(scope, "u")} AND ${CURRENT} ${cohortFilter(cohort)}
    GROUP BY sp.id, sp."title", sp."kind", sp."sortOrder"
    ORDER BY sp."sortOrder" ASC, sp."title" ASC`;
  return rowsOf(
    z.object({ title: z.string(), kind: z.enum(["SHEET", "TRACK"]), enrolled: num, completed: num, averagePercent: num }),
    rows,
  ).map((r) => ({ ...r, averagePercent: Math.round(r.averagePercent) }));
}

const STREAK_BUCKETS = ["No streak", "1–2 days", "3–6 days", "7–29 days", "30+ days"] as const;

async function streakBuckets(scope: StudentScope, cohort: Cohort | null) {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT CASE
             WHEN COALESCE(s."currentStreak", 0) = 0 THEN 0
             WHEN s."currentStreak" <= 2 THEN 1
             WHEN s."currentStreak" <= 6 THEN 2
             WHEN s."currentStreak" <= 29 THEN 3
             ELSE 4
           END AS bucket,
           count(*)::int AS students
    FROM "User" u
    LEFT JOIN "UserStats" s ON s."userId" = u.id
    WHERE ${scopedStudentSql(scope, "u")} AND ${CURRENT} ${cohortFilter(cohort)}
    GROUP BY 1`;
  const counts = new Map(rowsOf(z.object({ bucket: num, students: num }), rows).map((r) => [r.bucket, r.students]));
  return STREAK_BUCKETS.map((bucket, i) => ({ bucket, students: counts.get(i) ?? 0 }));
}

/**
 * The whole report. A `cohort` the scope does not cover is ignored (the
 * report falls back to the whole scope) rather than refused, so a stale link
 * shows only what the viewer may see.
 */
export async function getCohortReport(
  scope: StudentScope,
  options: { cohort?: Cohort | null; weeks?: number },
  now = new Date(),
): Promise<CohortReport> {
  const requested = options.cohort ?? null;
  const cohort = requested && scopeCovers(scope, requested) ? requested : null;
  const weeks = lastCampusWeeks(now, options.weeks ?? 8);
  const [summary, active, solves, difficulty, topics, hardest, plans, streaks] = await Promise.all([
    cohortSummary(scope, cohort, now),
    weeklyActive(scope, cohort, weeks),
    weeklySolves(scope, cohort, weeks),
    difficultySplit(scope, cohort),
    topicCoverage(scope, cohort),
    hardestProblems(scope, cohort),
    planProgress(scope, cohort),
    streakBuckets(scope, cohort),
  ]);
  return {
    cohort,
    weeks,
    summary,
    weeklyActive: active,
    weeklySolves: solves,
    difficulty,
    topics,
    hardest,
    plans,
    streaks,
  };
}
