import "server-only";
import type { VerdictDisplay } from "@recx/shared";
import { campusDay, campusDayDate, isoWeekKey, solveXp } from "@recx/shared";
import { db } from "@/lib/db";
import { displayFor } from "@/lib/judge/view";
import {
  levelView,
  selectContinue,
  streakView,
  weekStart,
  weekStrip,
  weeklyGoalProgress,
  type ContinueAction,
  type DailyCandidate,
  type LevelView,
  type PlanCandidate,
  type ProblemRef,
  type StreakView,
  type WeekDay,
  type WeeklyGoal,
} from "@/components/dashboard/model";

/**
 * Everything /dashboard shows, for the signed-in viewer only. Reads the
 * maintained read models — UserStats, XpBucket (WEEK), ActivityDay,
 * UserProblemStatus, DailyChallenge, StudyPlanEnrollment — and the viewer's
 * last practice submissions. It never reads XpEvent (the append-only ledger
 * is not for pages: tests/repo/xp-ledger.test.ts).
 */

const PUBLISHED = { status: "PUBLISHED", liveVersionId: { not: null } } as const;
const PROBLEM_REF = { id: true, slug: true, displayCode: true, title: true, difficulty: true } as const;

/** Enrolled, unfinished plans searched for a "next item" (bounded). */
const PLAN_LOOKAHEAD = 3;

export interface RecentSubmission {
  id: string;
  display: VerdictDisplay;
  passed: number;
  total: number;
  languageLabel: string;
  createdAt: Date;
  problem: { slug: string; title: string; displayCode: string; published: boolean };
}

export interface EnrolledPlan {
  slug: string;
  title: string;
  kind: "SHEET" | "TRACK";
  itemsDone: number;
  itemsTotal: number;
  completed: boolean;
}

export interface DashboardData {
  continueAction: ContinueAction;
  weekly: WeeklyGoal;
  streak: StreakView;
  level: LevelView;
  week: WeekDay[];
  daily: DailyCandidate | null;
  recent: RecentSubmission[];
  plans: EnrolledPlan[];
  solvedTotal: number;
}

export async function getDashboard(userId: string, now: Date = new Date()): Promise<DashboardData> {
  const today = campusDay(now);
  const monday = weekStart(today);
  const mondayDate = new Date(`${monday}T00:00:00.000Z`);
  const sundayDate = new Date(mondayDate.getTime() + 6 * 86_400_000);

  const [stats, weekBucket, activity, attempted, dailyRow, enrollments, recentRows, suggestedRow] = await Promise.all([
    db.userStats.findUnique({
      where: { userId },
      select: {
        xpTotal: true,
        currentStreak: true,
        longestStreak: true,
        lastActiveDate: true,
        solvedTotal: true,
        submissions: true,
      },
    }),
    db.xpBucket.findUnique({
      where: { period_periodKey_userId: { period: "WEEK", periodKey: isoWeekKey(now), userId } },
      select: { solvedEasy: true, solvedMedium: true, solvedHard: true },
    }),
    db.activityDay.findMany({
      where: { userId, date: { gte: mondayDate, lte: sundayDate } },
      select: { date: true, submissions: true, solved: true },
    }),
    db.userProblemStatus.findFirst({
      where: { userId, status: "ATTEMPTED", problem: PUBLISHED },
      orderBy: { lastAttemptAt: "desc" },
      select: { attempts: true, lastAttemptAt: true, problem: { select: PROBLEM_REF } },
    }),
    db.dailyChallenge.findUnique({
      where: { date: campusDayDate(now) },
      select: {
        problem: {
          select: {
            ...PROBLEM_REF,
            status: true,
            liveVersionId: true,
            statuses: { where: { userId }, select: { status: true } },
          },
        },
      },
    }),
    db.studyPlanEnrollment.findMany({
      where: { userId, plan: { published: true } },
      orderBy: { enrolledAt: "desc" },
      take: 6,
      select: {
        planId: true,
        itemsDone: true,
        itemsTotal: true,
        completedAt: true,
        plan: { select: { slug: true, title: true, kind: true } },
      },
    }),
    db.submission.findMany({
      where: { userId, origin: "PRACTICE" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        status: true,
        verdict: true,
        passedCases: true,
        totalCases: true,
        createdAt: true,
        languageConfig: { select: { label: true } },
        problem: { select: { slug: true, title: true, displayCode: true, status: true } },
      },
    }),
    // A first problem to try: an Easy one never attempted, else any unsolved one.
    db.problem
      .findFirst({
        where: { ...PUBLISHED, difficulty: "EASY", statuses: { none: { userId } } },
        orderBy: { displayCode: "asc" },
        select: PROBLEM_REF,
      })
      .then(
        (easy) =>
          easy ??
          db.problem.findFirst({
            where: { ...PUBLISHED, statuses: { none: { userId, status: "SOLVED" } } },
            orderBy: [{ difficulty: "asc" }, { displayCode: "asc" }],
            select: PROBLEM_REF,
          }),
      ),
  ]);

  // The next unsolved item of the most recently enrolled unfinished plans.
  const open = enrollments.filter((e) => e.completedAt === null && e.itemsDone < e.itemsTotal).slice(0, PLAN_LOOKAHEAD);
  const nextItems = await Promise.all(
    open.map((e) =>
      db.studyPlanItem.findFirst({
        where: {
          planId: e.planId,
          problem: { ...PUBLISHED, statuses: { none: { userId, status: "SOLVED" } } },
        },
        orderBy: [{ section: { sortOrder: "asc" } }, { sortOrder: "asc" }],
        select: { problem: { select: PROBLEM_REF } },
      }),
    ),
  );
  let plan: PlanCandidate | null = null;
  for (const [i, next] of nextItems.entries()) {
    const enrollment = open[i];
    if (!next || !enrollment) continue;
    plan = {
      problem: next.problem,
      plan: {
        slug: enrollment.plan.slug,
        title: enrollment.plan.title,
        kind: enrollment.plan.kind,
        itemsDone: enrollment.itemsDone,
        itemsTotal: enrollment.itemsTotal,
      },
    };
    break;
  }

  let daily: DailyCandidate | null = null;
  const dp = dailyRow?.problem;
  if (dp && dp.status === "PUBLISHED" && dp.liveVersionId !== null) {
    const problem: ProblemRef = {
      id: dp.id,
      slug: dp.slug,
      displayCode: dp.displayCode,
      title: dp.title,
      difficulty: dp.difficulty,
    };
    daily = {
      problem,
      solved: dp.statuses.some((s) => s.status === "SOLVED"),
      xp: solveXp({ difficulty: dp.difficulty, firstSolve: true, assisted: false, dailyChallenge: true, revision: false }),
    };
  }

  const continueAction = selectContinue({
    attempted: attempted ? { problem: attempted.problem, attempts: attempted.attempts, lastAttemptAt: attempted.lastAttemptAt } : null,
    plan,
    daily,
    suggested: suggestedRow ? { problem: suggestedRow, firstEver: (stats?.submissions ?? 0) === 0 } : null,
  });

  return {
    continueAction,
    weekly: weeklyGoalProgress(weekBucket),
    streak: streakView(stats, today),
    level: levelView(stats?.xpTotal ?? 0),
    week: weekStrip(
      activity.map((a) => ({ day: a.date.toISOString().slice(0, 10), submissions: a.submissions, solved: a.solved })),
      now,
    ),
    daily,
    recent: recentRows.map((r) => ({
      id: r.id,
      display: displayFor(r.status, r.verdict),
      passed: r.passedCases,
      total: r.totalCases,
      languageLabel: r.languageConfig.label.split(" (")[0] ?? r.languageConfig.label,
      createdAt: r.createdAt,
      problem: {
        slug: r.problem.slug,
        title: r.problem.title,
        displayCode: r.problem.displayCode,
        published: r.problem.status === "PUBLISHED",
      },
    })),
    plans: enrollments.map((e) => ({
      slug: e.plan.slug,
      title: e.plan.title,
      kind: e.plan.kind,
      itemsDone: e.itemsDone,
      itemsTotal: e.itemsTotal,
      completed: e.completedAt !== null || (e.itemsTotal > 0 && e.itemsDone >= e.itemsTotal),
    })),
    solvedTotal: stats?.solvedTotal ?? 0,
  };
}
