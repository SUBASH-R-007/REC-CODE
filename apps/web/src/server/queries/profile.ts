import "server-only";
import { cache } from "react";
import { z } from "zod";
import { Prisma, type Difficulty, type ProfileVisibility, type User } from "@recx/db";
import {
  LANGUAGE_CATALOG,
  TOPICS,
  TOPIC_LABEL,
  campusDay,
  effectiveStreak,
  isLanguageKey,
  levelProgress,
  type LevelProgress,
  type Topic,
} from "@recx/shared";
import { publicName } from "@recx/design";
import { db } from "@/lib/db";
import { HEATMAP_DAYS, addDays, type ActivityInput } from "@/components/profile/heatmap-model";
import { canViewProfile } from "@/components/profile/visibility";
import { readEditorPrefs, type EditorPrefs } from "@/components/profile/settings-schema";

/**
 * Profile reads: UserStats, ActivityDay, UserProblemStatus and UserBadge
 * only — never the XpEvent ledger. The public profile (/u/[handle]) exposes
 * ONLY solved counts, badges, the heatmap and the radar (plus the display
 * name, handle and the bio the student wrote for it): never email, roll
 * number, department, section, assessment scores, readiness, notes or drafts.
 */

/** A cohort median is shown only when at least this many students have solved the problem. */
export const MIN_COHORT_FOR_MEDIAN = 5;
/** Time-to-solve compares the viewer's most recent solves only (small N). */
export const TIME_TO_SOLVE_LIMIT = 10;

const countMapSchema = z.record(z.string(), z.number().int().nonnegative()).catch({});

export interface SolvedSummary {
  byDifficulty: Record<Difficulty, number>;
  total: number;
  /** Published problems per difficulty, for "12 of 40". */
  published: Record<Difficulty, number>;
}

export interface TopicCount {
  topic: Topic;
  label: string;
  unassisted: number;
  assisted: number;
}

export interface BadgeView {
  key: string;
  name: string;
  description: string;
  icon: string;
  awardedAt: Date | null;
}

export interface ProfileCore {
  solved: SolvedSummary;
  /** Campus days with activity inside the 365-day window. */
  activity: ActivityInput[];
  today: string;
  topics: TopicCount[];
  badges: BadgeView[];
}

type StatsRow = Awaited<ReturnType<typeof readStats>>;

async function readStats(userId: string) {
  return db.userStats.findUnique({
    where: { userId },
    select: {
      solvedEasy: true,
      solvedMedium: true,
      solvedHard: true,
      solvedTotal: true,
      assistedSolves: true,
      currentStreak: true,
      longestStreak: true,
      lastActiveDate: true,
      xpTotal: true,
      languageCounts: true,
      topicSolved: true,
      topicAssisted: true,
    },
  });
}

/** Published problems per difficulty. Shared by every profile render in a request. */
const publishedCounts = cache(async (): Promise<Record<Difficulty, number>> => {
  const rows = await db.problem.groupBy({
    by: ["difficulty"],
    where: { status: "PUBLISHED", liveVersionId: { not: null } },
    _count: { _all: true },
  });
  const counts: Record<Difficulty, number> = { EASY: 0, MEDIUM: 0, HARD: 0 };
  for (const row of rows) counts[row.difficulty] = row._count._all;
  return counts;
});

export function topicCounts(topicSolved: unknown, topicAssisted: unknown): TopicCount[] {
  const solved = countMapSchema.parse(topicSolved ?? {});
  const assisted = countMapSchema.parse(topicAssisted ?? {});
  return TOPICS.map((topic) => ({
    topic,
    label: TOPIC_LABEL[topic],
    unassisted: solved[topic] ?? 0,
    assisted: assisted[topic] ?? 0,
  }));
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

async function readActivity(userId: string, today: string): Promise<ActivityInput[]> {
  const start = addDays(today, -(HEATMAP_DAYS - 1));
  const rows = await db.activityDay.findMany({
    where: { userId, date: { gte: new Date(`${start}T00:00:00.000Z`) } },
    orderBy: { date: "asc" },
    select: { date: true, solved: true, submissions: true },
  });
  return rows.map((r) => ({ date: isoDay(r.date), solved: r.solved, submissions: r.submissions }));
}

async function readBadges(userId: string, includeLocked: boolean): Promise<BadgeView[]> {
  if (includeLocked) {
    const badges = await db.badge.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        key: true,
        name: true,
        description: true,
        icon: true,
        users: { where: { userId }, select: { awardedAt: true } },
      },
    });
    return badges.map((b) => ({
      key: b.key,
      name: b.name,
      description: b.description,
      icon: b.icon,
      awardedAt: b.users[0]?.awardedAt ?? null,
    }));
  }
  const earned = await db.userBadge.findMany({
    where: { userId },
    orderBy: [{ badge: { sortOrder: "asc" } }, { awardedAt: "asc" }],
    select: { awardedAt: true, badge: { select: { key: true, name: true, description: true, icon: true } } },
  });
  return earned.map((e) => ({ ...e.badge, awardedAt: e.awardedAt }));
}

function solvedSummary(stats: StatsRow, published: Record<Difficulty, number>): SolvedSummary {
  const byDifficulty = {
    EASY: stats?.solvedEasy ?? 0,
    MEDIUM: stats?.solvedMedium ?? 0,
    HARD: stats?.solvedHard ?? 0,
  };
  return { byDifficulty, total: stats?.solvedTotal ?? byDifficulty.EASY + byDifficulty.MEDIUM + byDifficulty.HARD, published };
}

async function loadCore(
  userId: string,
  options: { includeLockedBadges: boolean },
  now: Date,
): Promise<{ core: ProfileCore; stats: StatsRow }> {
  const today = campusDay(now);
  const [stats, published, activity, badges] = await Promise.all([
    readStats(userId),
    publishedCounts(),
    readActivity(userId, today),
    readBadges(userId, options.includeLockedBadges),
  ]);
  return {
    stats,
    core: {
      solved: solvedSummary(stats, published),
      activity,
      today,
      topics: topicCounts(stats?.topicSolved, stats?.topicAssisted),
      badges,
    },
  };
}

// ── The student's own profile ──────────────────────────────────────────

export interface LanguageShare {
  key: string;
  label: string;
  count: number;
}

export interface TimeToSolveRow {
  title: string;
  href: string | null;
  difficulty: Difficulty;
  assisted: boolean;
  yourSeconds: number;
  /** null when fewer than MIN_COHORT_FOR_MEDIAN students have a timed solve. */
  medianSeconds: number | null;
  solvers: number;
}

export interface OwnProfile extends ProfileCore {
  name: { firstName: string; lastName: string };
  handle: string;
  bio: string | null;
  visibility: ProfileVisibility;
  leaderboardOptOut: boolean;
  level: LevelProgress;
  xpTotal: number;
  streak: { current: number; longest: number };
  languages: LanguageShare[];
  assisted: { assisted: number; unassisted: number };
  timeToSolve: TimeToSolveRow[];
}

/** "C++20 (GCC 13.2.0)" → "C++20". */
export function languageLabel(key: string): string {
  if (!isLanguageKey(key)) return key;
  return LANGUAGE_CATALOG[key].label.split(" (")[0] ?? key;
}

export function languageShares(languageCounts: unknown): LanguageShare[] {
  const counts = countMapSchema.parse(languageCounts ?? {});
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ key, label: languageLabel(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * Cohort median time-to-solve for a handful of problems: one grouped
 * percentile query over UserProblemStatus (index problemId, status).
 */
export function cohortMedianSql(problemIds: readonly string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT s."problemId",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY s."activeSecondsToSolve")::float8 AS "median",
           count(*)::int AS "solvers"
    FROM "UserProblemStatus" s
    WHERE s."problemId" IN (${Prisma.join(problemIds)})
      AND s."status" = 'SOLVED'::"ProblemProgress"
      AND s."activeSecondsToSolve" IS NOT NULL
    GROUP BY s."problemId"`;
}

async function readTimeToSolve(userId: string): Promise<TimeToSolveRow[]> {
  const mine = await db.userProblemStatus.findMany({
    where: { userId, status: "SOLVED", activeSecondsToSolve: { not: null } },
    orderBy: { firstAcceptedAt: "desc" },
    take: TIME_TO_SOLVE_LIMIT,
    select: {
      problemId: true,
      assisted: true,
      activeSecondsToSolve: true,
      problem: { select: { title: true, slug: true, difficulty: true, status: true } },
    },
  });
  if (mine.length === 0) return [];
  const medians = await db.$queryRaw<Array<{ problemId: string; median: number; solvers: number }>>(
    cohortMedianSql(mine.map((m) => m.problemId)),
  );
  const byProblem = new Map(medians.map((m) => [m.problemId, m]));
  return mine.map((m) => {
    const cohort = byProblem.get(m.problemId);
    const solvers = cohort?.solvers ?? 0;
    return {
      title: m.problem.title,
      href: m.problem.status === "PUBLISHED" ? `/problems/${m.problem.slug}` : null,
      difficulty: m.problem.difficulty,
      assisted: m.assisted,
      yourSeconds: m.activeSecondsToSolve ?? 0,
      medianSeconds: cohort && solvers >= MIN_COHORT_FOR_MEDIAN ? Math.round(cohort.median) : null,
      solvers,
    };
  });
}

export async function getOwnProfile(user: User, now: Date = new Date()): Promise<OwnProfile> {
  const [{ core, stats }, timeToSolve] = await Promise.all([
    loadCore(user.id, { includeLockedBadges: true }, now),
    readTimeToSolve(user.id),
  ]);
  const streak = effectiveStreak(
    {
      current: stats?.currentStreak ?? 0,
      longest: stats?.longestStreak ?? 0,
      lastActiveDate: stats?.lastActiveDate ? isoDay(stats.lastActiveDate) : null,
    },
    core.today,
  );
  const total = core.solved.total;
  const assisted = Math.min(total, stats?.assistedSolves ?? 0);
  return {
    ...core,
    name: { firstName: user.firstName, lastName: user.lastName },
    handle: user.handle,
    bio: user.bio,
    visibility: user.visibility,
    leaderboardOptOut: user.leaderboardOptOut,
    level: levelProgress(stats?.xpTotal ?? 0),
    xpTotal: stats?.xpTotal ?? 0,
    streak: { current: streak, longest: Math.max(stats?.longestStreak ?? 0, streak) },
    languages: languageShares(stats?.languageCounts),
    assisted: { assisted, unassisted: total - assisted },
    timeToSolve,
  };
}

// ── The public profile ─────────────────────────────────────────────────

export interface PublicProfile extends ProfileCore {
  /** publicName(): "Priya S." — never the full name. */
  name: string;
  /** Initial letters only, for the decorative avatar. */
  avatar: { firstName: string; lastName: string };
  handle: string;
  bio: string | null;
  visibility: ProfileVisibility;
  isOwner: boolean;
}

const handleSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/);

function decodeHandle(raw: string): string | null {
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const parsed = handleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The profile behind /u/[handle] as `viewerId` may see it, or null — for a
 * handle that does not exist and for one the viewer may not see alike (the
 * page turns both into the same 404). Cached per request so the page and its
 * metadata share one lookup.
 */
export const findPublicProfile = cache(
  async (rawHandle: string, viewerId: string | null): Promise<PublicProfile | null> => {
    const handle = decodeHandle(rawHandle);
    if (!handle) return null;
    const owner = await db.user.findUnique({
      where: { handle },
      select: { id: true, firstName: true, lastName: true, handle: true, bio: true, visibility: true, status: true },
    });
    if (!owner || !canViewProfile(owner, viewerId)) return null;
    const { core } = await loadCore(owner.id, { includeLockedBadges: false }, new Date());
    return {
      ...core,
      // Assisted solves are the owner's private mirror, not public profile data.
      topics: core.topics.map((t) => ({ ...t, assisted: 0 })),
      name: publicName(owner.firstName, owner.lastName),
      avatar: { firstName: owner.firstName.charAt(0), lastName: owner.lastName.charAt(0) },
      handle: owner.handle,
      bio: owner.bio,
      visibility: owner.visibility,
      isOwner: viewerId === owner.id,
    };
  },
);

// ── Settings ───────────────────────────────────────────────────────────

export interface ProfileSettings {
  handle: string;
  visibility: ProfileVisibility;
  leaderboardOptOut: boolean;
  bio: string;
  editor: EditorPrefs;
}

export function profileSettingsOf(user: Pick<User, "handle" | "visibility" | "leaderboardOptOut" | "bio" | "editorPrefs">): ProfileSettings {
  return {
    handle: user.handle,
    visibility: user.visibility,
    leaderboardOptOut: user.leaderboardOptOut,
    bio: user.bio ?? "",
    editor: readEditorPrefs(user.editorPrefs),
  };
}
