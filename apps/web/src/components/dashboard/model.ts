import { CAMPUS_TIME_ZONE, campusDay, dayDifference, effectiveStreak, levelProgress, type LevelProgress } from "@recx/shared";

/**
 * Dashboard decisions as pure functions (no database, no clock reads):
 * the Continue card's choice, weekly-goal progress, the streak to show and
 * the week strip. Unit-tested in test/dashboard-*.test.ts.
 */

export type DashboardDifficulty = "EASY" | "MEDIUM" | "HARD";

export interface ProblemRef {
  id: string;
  slug: string;
  displayCode: string;
  title: string;
  difficulty: DashboardDifficulty;
}

export interface AttemptedCandidate {
  problem: ProblemRef;
  attempts: number;
  lastAttemptAt: Date;
}

export interface PlanCandidate {
  problem: ProblemRef;
  plan: { slug: string; title: string; kind: "SHEET" | "TRACK"; itemsDone: number; itemsTotal: number };
}

export interface DailyCandidate {
  problem: ProblemRef;
  /** The viewer has solved this problem (today or before). */
  solved: boolean;
  /** XP for a first solve today (2x). */
  xp: number;
}

export interface SuggestedCandidate {
  problem: ProblemRef;
  /** The viewer has never submitted anything. */
  firstEver: boolean;
}

export type ContinueAction =
  | ({ kind: "attempted" } & AttemptedCandidate)
  | ({ kind: "plan" } & PlanCandidate)
  | ({ kind: "daily" } & DailyCandidate)
  | ({ kind: "suggested" } & SuggestedCandidate)
  | { kind: "none" };

/**
 * ONE next action, in this order: the most recently attempted unsolved
 * problem; else the next unsolved item of an enrolled study plan; else
 * today's daily challenge (unless already solved); else a suggested Easy
 * problem; else nothing to do yet.
 */
export function selectContinue(candidates: {
  attempted?: AttemptedCandidate | null;
  plan?: PlanCandidate | null;
  daily?: DailyCandidate | null;
  suggested?: SuggestedCandidate | null;
}): ContinueAction {
  if (candidates.attempted) return { kind: "attempted", ...candidates.attempted };
  if (candidates.plan) return { kind: "plan", ...candidates.plan };
  if (candidates.daily && !candidates.daily.solved) return { kind: "daily", ...candidates.daily };
  if (candidates.suggested) return { kind: "suggested", ...candidates.suggested };
  return { kind: "none" };
}

/** Problems a student aims to solve each campus (ISO, Asia/Kolkata) week. */
export const WEEKLY_GOAL_PROBLEMS = 3;

export interface WeeklyGoal {
  solved: number;
  goal: number;
  met: boolean;
  /** 0..100, capped. */
  percent: number;
}

/** From the WEEK XpBucket's solved counters (null bucket = nothing yet). */
export function weeklyGoalProgress(
  bucket: { solvedEasy: number; solvedMedium: number; solvedHard: number } | null,
  goal: number = WEEKLY_GOAL_PROBLEMS,
): WeeklyGoal {
  const solved = bucket ? bucket.solvedEasy + bucket.solvedMedium + bucket.solvedHard : 0;
  const safeGoal = Math.max(1, goal);
  return {
    solved,
    goal: safeGoal,
    met: solved >= safeGoal,
    percent: Math.min(100, Math.round((solved / safeGoal) * 100)),
  };
}

export interface StreakView {
  current: number;
  longest: number;
  /** Active yesterday but not yet today: a submission today keeps it. */
  atRisk: boolean;
  activeToday: boolean;
}

/** "yyyy-MM-dd" of a @db.Date value (stored as UTC midnight). */
export function dateColumnDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function streakView(
  stats: { currentStreak: number; longestStreak: number; lastActiveDate: Date | null } | null,
  today: string,
): StreakView {
  if (!stats) return { current: 0, longest: 0, atRisk: false, activeToday: false };
  const last = stats.lastActiveDate ? dateColumnDay(stats.lastActiveDate) : null;
  const current = effectiveStreak({ current: stats.currentStreak, longest: stats.longestStreak, lastActiveDate: last }, today);
  const gap = last === null ? null : dayDifference(last, today);
  return {
    current,
    longest: Math.max(stats.longestStreak, current),
    atRisk: current > 0 && gap === 1,
    activeToday: gap === 0,
  };
}

export interface LevelView extends LevelProgress {
  xpTotal: number;
  /** XP still needed to reach the next level. */
  toNext: number;
}

export function levelView(xpTotal: number): LevelView {
  const xp = Math.max(0, xpTotal);
  const progress = levelProgress(xp);
  return { ...progress, xpTotal: xp, toNext: Math.max(0, progress.nextLevelXp - xp) };
}

export interface WeekDay {
  /** "yyyy-MM-dd" campus day. */
  day: string;
  /** "Mon" … "Sun". */
  short: string;
  /** "Monday 12 October". */
  long: string;
  submissions: number;
  solved: number;
  isToday: boolean;
  isFuture: boolean;
}

const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Monday of the ISO week containing the campus day `today`. */
export function weekStart(today: string): string {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7; // Mon = 1 … Sun = 7
  return addDays(today, 1 - weekday);
}

const longFormatter = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/** Monday..Sunday of the current campus week, with each day's activity. */
export function weekStrip(
  days: ReadonlyArray<{ day: string; submissions: number; solved: number }>,
  now: Date,
): WeekDay[] {
  const today = campusDay(now);
  const monday = weekStart(today);
  const byDay = new Map(days.map((d) => [d.day, d]));
  return WEEKDAY_SHORT.map((short, i) => {
    const day = addDays(monday, i);
    const activity = byDay.get(day);
    return {
      day,
      short,
      long: longFormatter.format(new Date(`${day}T00:00:00Z`)),
      submissions: activity?.submissions ?? 0,
      solved: activity?.solved ?? 0,
      isToday: day === today,
      isFuture: dayDifference(today, day) > 0,
    };
  });
}

/** The campus-day hour (0-23) for the greeting. */
export function campusHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-GB", { timeZone: CAMPUS_TIME_ZONE, hour: "numeric", hourCycle: "h23" }).format(now);
  return Number(hour) % 24;
}
