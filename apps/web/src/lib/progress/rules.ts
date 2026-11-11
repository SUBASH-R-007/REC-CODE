import {
  XP_PERIODS,
  XP_RULES,
  advanceStreak,
  applyDailyCaps,
  campusDay,
  crossedMilestone,
  periodKey,
  solveXp,
  type DifficultyKey,
  type StreakState,
  type Verdict,
  type XpPeriod,
  type XpRules,
} from "@recx/shared";

/**
 * The pure half of the progress engine (src/lib/progress/apply.ts writes what
 * these functions decide). No database access, no clock: every input is
 * passed in, so each rule is unit-tested on its own.
 *
 * Time. A submission's progress belongs to the campus (Asia/Kolkata) day on
 * which it was SUBMITTED, not the moment the judge finished: a student who
 * submits at 23:59:58 keeps their streak even if the verdict lands after
 * midnight or after a judge backlog. The same day drives the daily XP caps,
 * the daily-challenge check, ActivityDay and the WEEK / MONTH bucket keys.
 */

/** "yyyy-MM-dd" campus day as the UTC-midnight Date a `@db.Date` column stores. */
export function dayAsDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** A `@db.Date` value (UTC midnight) back to its "yyyy-MM-dd" day. */
export function dateAsDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// ── What a finalised submission changes ──────────────────────────────────

export interface PriorProblemStatus {
  status: "ATTEMPTED" | "SOLVED";
  firstAttemptAt: Date;
  lastAttemptAt: Date;
}

export interface ProgressFacts {
  verdict: Verdict;
  /**
   * The submission was re-judged by an admin (lane REJUDGE). Its first
   * judging was already counted, and the previous verdict is gone, so a
   * rejudge changes nothing except crediting a first solve the student was
   * denied. It never takes a solve away (no signal auto-penalises a student).
   */
  rejudge: boolean;
  /** Submission.createdAt — the moment of the student's activity. */
  submittedAt: Date;
  /** The user's UserProblemStatus for this problem before this submission (null: none yet). */
  prior: PriorProblemStatus | null;
  streak: StreakState;
}

export interface StreakChange {
  before: StreakState;
  after: StreakState;
  /**
   * A one-off streak milestone (7 / 30 / 100 days) reached for the first time
   * ever: the LONGEST streak crossed it. A streak that breaks and climbs back
   * past 7 does not pay twice (the XpEvent key is unique anyway).
   */
  milestone: number | null;
}

export interface ProgressPlan {
  /** Campus day of the submission ("yyyy-MM-dd"). */
  day: string;
  /** Counts as a judged attempt: attempts, submissions, streak, ProblemStat. */
  countAttempt: boolean;
  /** Counted and accepted (AC). */
  accepted: boolean;
  /** Counted and not accepted (WA, TLE, CE, PARTIAL …). */
  failed: boolean;
  /** No UserProblemStatus row existed: this user's first attempt at the problem. */
  firstAttempt: boolean;
  /** The first AC for this user and problem. A later AC keeps the first solve. */
  firstSolve: boolean;
  /** Null when the streak is not touched (a rejudge). */
  streak: StreakChange | null;
}

/**
 * What one finalised PRACTICE submission changes, or null when it changes
 * nothing: an internal error (excluded from scoring, never an attempt) or a
 * rejudge that credits no new solve.
 *
 * A judged submission — any verdict but IE, compile errors included — is an
 * attempt and the qualifying activity for the streak (signing in is not).
 */
export function planProgress(facts: ProgressFacts): ProgressPlan | null {
  if (facts.verdict === "IE") return null;
  const day = campusDay(facts.submittedAt);
  const ac = facts.verdict === "AC";
  const firstSolve = ac && facts.prior?.status !== "SOLVED";
  const firstAttempt = facts.prior === null;

  if (facts.rejudge) {
    if (!firstSolve) return null;
    return { day, countAttempt: false, accepted: false, failed: false, firstAttempt, firstSolve, streak: null };
  }

  const after = advanceStreak(facts.streak, day);
  return {
    day,
    countAttempt: true,
    accepted: ac,
    failed: !ac,
    firstAttempt,
    firstSolve,
    streak: { before: facts.streak, after, milestone: crossedMilestone(facts.streak.longest, after.longest) },
  };
}

/** The attempt window after this submission: first/last only ever widen (out-of-order finalises). */
export function attemptWindow(prior: PriorProblemStatus | null, at: Date): { firstAttemptAt: Date; lastAttemptAt: Date } {
  if (!prior) return { firstAttemptAt: at, lastAttemptAt: at };
  return {
    firstAttemptAt: prior.firstAttemptAt.getTime() <= at.getTime() ? prior.firstAttemptAt : at,
    lastAttemptAt: prior.lastAttemptAt.getTime() >= at.getTime() ? prior.lastAttemptAt : at,
  };
}

// ── XP ───────────────────────────────────────────────────────────────────

/** XP already earned on the campus day (ActivityDay.xp / xpEasy). */
export interface DayXp {
  total: number;
  easy: number;
}

export interface XpAward {
  /** What the rules pay before the daily caps. */
  uncapped: number;
  /** What is actually awarded (0 when fully capped). */
  amount: number;
  /** The daily caps took something off. */
  capped: boolean;
}

/**
 * A first solve: base XP by difficulty, 2x on the day's daily challenge, 40 %
 * when assisted, then the daily caps (Easy 600 / day, total 2,000 / day).
 * Repeat solves pay nothing and never reach this function.
 */
export function firstSolveAward(
  input: {
    difficulty: DifficultyKey;
    assisted: boolean;
    dailyChallenge: boolean;
    earnedToday: DayXp;
  },
  rules: XpRules = XP_RULES,
): XpAward {
  const uncapped = solveXp(
    {
      difficulty: input.difficulty,
      firstSolve: true,
      assisted: input.assisted,
      dailyChallenge: input.dailyChallenge,
      revision: false,
    },
    rules,
  );
  const amount = applyDailyCaps(
    {
      amount: uncapped,
      isEasy: input.difficulty === "EASY",
      earnedTodayTotal: input.earnedToday.total,
      earnedTodayEasy: input.earnedToday.easy,
    },
    rules,
  );
  return { uncapped, amount, capped: amount < uncapped };
}

/** The one-off XP for a streak milestone (0 for a day count that is not a milestone). */
export function streakMilestoneXp(milestone: number, rules: XpRules = XP_RULES): number {
  const table: Readonly<Record<number, number | undefined>> = rules.streakMilestones;
  return table[milestone] ?? 0;
}

/**
 * A streak milestone award. Decision: it is NOT subject to the Easy cap (it is
 * not Easy-problem XP and never adds to ActivityDay.xpEasy) but IS subject to
 * the total daily cap, like every other XP; it is bucketed for the
 * leaderboards like solve XP. A milestone is reached on the day's first
 * judged submission, so in practice the day's total is still low.
 */
export function streakMilestoneAward(milestone: number, earnedToday: DayXp, rules: XpRules = XP_RULES): XpAward {
  const uncapped = streakMilestoneXp(milestone, rules);
  const amount = applyDailyCaps(
    {
      amount: uncapped,
      isEasy: false,
      earnedTodayTotal: earnedToday.total,
      earnedTodayEasy: earnedToday.easy,
    },
    rules,
  );
  return { uncapped, amount, capped: amount < uncapped };
}

/**
 * A due revision re-solve: 25 % of the problem's first-solve XP, then the
 * daily caps.
 *
 * Deliberately NOT multiplied by anything else. The daily-challenge doubling
 * and the assisted reduction both describe how the problem was solved the
 * FIRST time; a revision is a different act — remembering it — and a rate
 * that depended on what happened months ago would be impossible to explain
 * on the page that pays it. An Easy revision still counts against the Easy
 * cap, because Easy-grinding is exactly what that cap is for.
 */
export function revisionAward(difficulty: DifficultyKey, earnedToday: DayXp, rules: XpRules = XP_RULES): XpAward {
  const uncapped = solveXp({ difficulty, firstSolve: false, assisted: false, dailyChallenge: false, revision: true }, rules);
  const amount = applyDailyCaps(
    {
      amount: uncapped,
      isEasy: difficulty === "EASY",
      earnedTodayTotal: earnedToday.total,
      earnedTodayEasy: earnedToday.easy,
    },
    rules,
  );
  return { uncapped, amount, capped: amount < uncapped };
}

/** The three XpBucket keys a moment belongs to: ALL_TIME "all", MONTH "2026-10", WEEK "2026-W41". */
export function bucketKeys(at: Date): Array<{ period: XpPeriod; periodKey: string }> {
  return XP_PERIODS.map((period) => ({ period, periodKey: periodKey(period, at) }));
}

/** Solved-by-difficulty counter increments for a first solve (all zero otherwise). */
export function solvedIncrements(
  difficulty: DifficultyKey,
  firstSolve: boolean,
): { solvedEasy: number; solvedMedium: number; solvedHard: number } {
  const one = firstSolve ? 1 : 0;
  return {
    solvedEasy: difficulty === "EASY" ? one : 0,
    solvedMedium: difficulty === "MEDIUM" ? one : 0,
    solvedHard: difficulty === "HARD" ? one : 0,
  };
}

// ── Badges and notifications ─────────────────────────────────────────────

export interface BadgeCounters {
  solvedTotal: number;
  solvedMedium: number;
  solvedHard: number;
  longestStreak: number;
}

/**
 * The progress badges this engine awards. The catalogue rows (name,
 * description, icon) are seeded by content; a key missing from the catalogue
 * is skipped and logged, never created here. Assisted solves count: an
 * assisted solve is still a solve.
 */
export const PROGRESS_BADGES = Object.freeze([
  { key: "first-solve", counter: "solvedTotal", threshold: 1 },
  { key: "ten-solves", counter: "solvedTotal", threshold: 10 },
  { key: "fifty-solves", counter: "solvedTotal", threshold: 50 },
  { key: "first-medium", counter: "solvedMedium", threshold: 1 },
  { key: "first-hard", counter: "solvedHard", threshold: 1 },
  { key: "streak-7", counter: "longestStreak", threshold: 7 },
  { key: "streak-30", counter: "longestStreak", threshold: 30 },
] as const satisfies ReadonlyArray<{ key: string; counter: keyof BadgeCounters; threshold: number }>);

export type ProgressBadgeKey = (typeof PROGRESS_BADGES)[number]["key"];

/** Badges whose threshold this submission crossed. Awarded once (UserBadge is keyed by user + badge). */
export function badgesCrossed(before: BadgeCounters, after: BadgeCounters): ProgressBadgeKey[] {
  return PROGRESS_BADGES.filter((b) => before[b.counter] < b.threshold && after[b.counter] >= b.threshold).map(
    (b) => b.key,
  );
}

/** Notification.kind values written by the progress engine. */
export const PROGRESS_NOTIFICATION_KIND = Object.freeze({
  badge: "BADGE_EARNED",
  streak: "STREAK_MILESTONE",
});

/** Where progress notifications point: the student's home (dashboard). */
export const PROGRESS_NOTIFICATION_LINK = "/dashboard";

export interface NotificationText {
  title: string;
  body: string;
}

export function badgeNotification(badge: { name: string; description: string }): NotificationText {
  return { title: `You earned the ${badge.name} badge`, body: badge.description };
}

export function streakNotification(milestone: number, award: XpAward): NotificationText {
  const title = `You earned a ${milestone}-day streak`;
  if (award.amount > 0) {
    const partly = award.capped ? " (reduced by today's XP limit)" : "";
    return { title, body: `${milestone} days in a row with a judged submission: +${award.amount} XP${partly}.` };
  }
  return {
    title,
    body: `${milestone} days in a row with a judged submission. No bonus XP was added because you reached today's XP limit.`,
  };
}
