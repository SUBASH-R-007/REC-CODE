import { dayDifference } from "./time";

/**
 * Level curve and streak logic — the LMS semantics (REC Learning
 * src/lib/gamification/xp.ts and streak.ts), reused rather than reinvented so
 * a student sees one XP / level / streak economy across both products.
 * Pure: no database access.
 */

/** Cumulative XP required to reach a level: round(75 · (n − 1)^1.5); level 1 starts at 0. */
export function xpThresholdForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(75 * Math.pow(level - 1, 1.5));
}

export function levelForXp(totalXp: number): number {
  if (totalXp <= 0) return 1;
  let level = 1;
  while (xpThresholdForLevel(level + 1) <= totalXp && level < 200) level += 1;
  return level;
}

export interface LevelProgress {
  level: number;
  currentLevelXp: number;
  nextLevelXp: number;
  /** XP earned within the current level. */
  intoLevel: number;
  /** XP needed to advance from this level to the next. */
  span: number;
  percent: number;
}

export function levelProgress(totalXp: number): LevelProgress {
  const level = levelForXp(totalXp);
  const currentLevelXp = xpThresholdForLevel(level);
  const nextLevelXp = xpThresholdForLevel(level + 1);
  const span = nextLevelXp - currentLevelXp;
  const intoLevel = totalXp - currentLevelXp;
  return {
    level,
    currentLevelXp,
    nextLevelXp,
    intoLevel,
    span,
    percent: span > 0 ? Math.min(100, Math.round((intoLevel / span) * 100)) : 100,
  };
}

/**
 * A streak day needs a qualifying activity — a judged submission — never
 * just signing in. Days are campus days ("yyyy-MM-dd", Asia/Kolkata).
 */
export interface StreakState {
  current: number;
  longest: number;
  lastActiveDate: string | null;
}

export function advanceStreak(state: StreakState, today: string): StreakState {
  if (state.lastActiveDate === null) {
    return { current: 1, longest: Math.max(1, state.longest), lastActiveDate: today };
  }
  const diff = dayDifference(state.lastActiveDate, today);
  if (diff <= 0) return state; // same day (or clock skew)
  if (diff === 1) {
    const current = state.current + 1;
    return { current, longest: Math.max(state.longest, current), lastActiveDate: today };
  }
  return { current: 1, longest: Math.max(state.longest, 1), lastActiveDate: today };
}

/** The streak to display today: 0 once a day has been missed. */
export function effectiveStreak(state: StreakState, today: string): number {
  if (!state.lastActiveDate) return 0;
  return dayDifference(state.lastActiveDate, today) <= 1 ? state.current : 0;
}

export const STREAK_MILESTONES = [7, 30, 100] as const;

export function crossedMilestone(previous: number, current: number): number | null {
  for (const milestone of STREAK_MILESTONES) {
    if (previous < milestone && current >= milestone) return milestone;
  }
  return null;
}

/**
 * Activity heatmap: lightness, never hue. Five steps of
 * color-mix(in srgb, var(--primary) {8,24,44,68,100}%, var(--surface)).
 */
export const HEATMAP_STEPS = [8, 24, 44, 68, 100] as const;

/** 0 = no activity, 1..5 = the HEATMAP_STEPS index + 1 (by problems solved that day). */
export function heatmapLevel(solved: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (solved <= 0) return 0;
  if (solved === 1) return 1;
  if (solved <= 2) return 2;
  if (solved <= 4) return 3;
  if (solved <= 7) return 4;
  return 5;
}

export const LEADERBOARD_SCOPES = ["COLLEGE", "DEPARTMENT", "BATCH", "SECTION"] as const;
export type LeaderboardScope = (typeof LEADERBOARD_SCOPES)[number];
