import {
  ACCOUNT_STATUS_FOR_STAGE,
  buildInactivityEvidence,
  calendarLookup,
  campusDay,
  countInactiveDays,
  planStageTransition,
  resolveInactivityPolicy,
  sweepHoldback,
  countsAsActivitySchema,
  type ActivityDayRow,
  type CalendarDayRow,
  type InactivityCount,
  type InactivityPolicyShape,
  type LeaveRow,
  type RestrictionStage,
  type StagePlan,
  type SweepHoldback,
} from "@recx/shared";
import type { Db } from "./index";

/**
 * Reading everything the inactivity sweep needs, and deciding what it means
 * (Phase 8c).
 *
 * The arithmetic is all in `@recx/shared` — this module only fetches. The
 * split is the point: the numbers that decide whether a student is restricted
 * have to be reproducible from their inputs by a test that touches no
 * database, because those numbers are what a disputed lockout is argued from.
 *
 * Nothing here writes. Slice 8c ships the DRY RUN first, as the spec asks,
 * and `evaluate()` returning a plan rather than performing it is what makes
 * the dry run the same code path as the live one rather than a second
 * implementation that could disagree with it.
 */

/** A @db.Date comes back as a UTC-midnight Date; this is its campus day. */
function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export interface SweepCandidate {
  readonly userId: string;
  readonly collegeId: string;
  readonly name: string;
  readonly status: "ACTIVE" | "SOFT_RESTRICTED" | "DISABLED" | "GRADUATED" | "ARCHIVED";
  readonly batchYear: number | null;
  readonly departmentCode: string | null;
  readonly lastActiveAt: Date | null;
  readonly stage: RestrictionStage;
  readonly stageEnteredAt: Date | null;
  readonly graceEndsAt: Date | null;
  readonly notifiedAt: Date | null;
  readonly selfClearedCount: number;
  readonly selfClearedTermKey: string | null;
  readonly hasOpenAttempt: boolean;
  readonly hasPendingAppeal: boolean;
  readonly hasAssessmentWithin72h: boolean;
}

interface CandidateRow {
  userId: string;
  collegeId: string;
  firstName: string;
  lastName: string;
  status: SweepCandidate["status"];
  batchYear: number | null;
  departmentCode: string | null;
  lastActiveAt: Date | null;
  stage: RestrictionStage | null;
  stageEnteredAt: Date | null;
  graceEndsAt: Date | null;
  notifiedAt: Date | null;
  selfClearedCount: number | null;
  selfClearedTermKey: string | null;
  hasOpenAttempt: boolean;
  hasPendingAppeal: boolean;
  hasAssessmentWithin72h: boolean;
}

/**
 * Students the sweep may look at, with every holdback resolved in the query.
 *
 * The holdbacks are computed HERE as well as in the pure `sweepHoldback()` —
 * not because one is a backup for the other, but because the query must not
 * drag ten thousand students into memory to discover that three of them are
 * sitting an exam. The pure function is what the planner reads and what the
 * tests exercise; these fragments are what makes the query cheap. A trigger
 * refuses the attempt case a third time.
 *
 * `GRADUATED` and `ARCHIVED` accounts are excluded outright: they are end
 * states, and an inactivity policy has nothing to say about somebody who has
 * left.
 *
 * The 72-hour assessment holdback is resolved against the cohort, because
 * `Assessment` carries audience scoping rather than per-student invitations —
 * so a cohort assessment holds back every student in the cohort. That
 * over-holds rather than under-holds, which is the correct direction.
 */
export async function sweepCandidates(
  db: Db,
  options: { readonly now: Date; readonly limit: number; readonly afterUserId?: string },
): Promise<SweepCandidate[]> {
  const rows = await db.$queryRawUnsafe<CandidateRow[]>(
    `SELECT u."id" AS "userId", u."collegeId", u."firstName", u."lastName", u."status",
            u."batchYear", u."departmentCode", u."lastActiveAt",
            r."stage", r."stageEnteredAt", r."graceEndsAt", r."selfClearedCount", r."selfClearedTermKey",
            (SELECT max(e."notifiedAt") FROM "AccountStatusEvent" e
              WHERE e."userId" = u."id" AND e."toStage" = COALESCE(r."stage", 'NONE')) AS "notifiedAt",
            EXISTS (SELECT 1 FROM "AssessmentAttempt" a
                     WHERE a."userId" = u."id" AND a."status" IN ('IN_PROGRESS', 'DISCONNECTED')) AS "hasOpenAttempt",
            (
              EXISTS (SELECT 1 FROM "IntegrityAppeal" ap
                       WHERE ap."studentId" = u."id" AND ap."outcome" = 'PENDING')
              OR EXISTS (SELECT 1 FROM "IntegrityFlag" f
                          JOIN "AssessmentAttempt" t ON t."id" = f."attemptId"
                         WHERE t."userId" = u."id" AND f."status" = 'OPEN')
            ) AS "hasPendingAppeal",
            EXISTS (
              SELECT 1 FROM "Assessment" s
               WHERE s."status" IN ('PUBLISHED', 'OPEN')
                 AND s."opensAt" >= $1 AND s."opensAt" < $1 + interval '72 hours'
                 AND (s."audienceBatchYear" IS NULL OR s."audienceBatchYear" = u."batchYear")
                 AND (s."audienceDepartmentCode" IS NULL OR s."audienceDepartmentCode" = u."departmentCode")
                 AND (s."audienceSection" IS NULL OR s."audienceSection" = u."section")
            ) AS "hasAssessmentWithin72h"
       FROM "User" u
       LEFT JOIN "AccountRestriction" r ON r."userId" = u."id"
      WHERE u."role" = 'STUDENT'
        AND u."status" IN ('ACTIVE', 'SOFT_RESTRICTED', 'DISABLED')
        AND ($3::text IS NULL OR u."id" > $3::text)
      ORDER BY u."id"
      LIMIT $2`,
    options.now,
    options.limit,
    options.afterUserId ?? null,
  );

  return rows.map((row) => ({
    userId: row.userId,
    collegeId: row.collegeId,
    name: `${row.firstName} ${row.lastName}`.trim(),
    status: row.status,
    batchYear: row.batchYear,
    departmentCode: row.departmentCode,
    lastActiveAt: row.lastActiveAt,
    stage: row.stage ?? "NONE",
    stageEnteredAt: row.stageEnteredAt,
    graceEndsAt: row.graceEndsAt,
    notifiedAt: row.notifiedAt,
    selfClearedCount: row.selfClearedCount ?? 0,
    selfClearedTermKey: row.selfClearedTermKey,
    hasOpenAttempt: row.hasOpenAttempt,
    hasPendingAppeal: row.hasPendingAppeal,
    hasAssessmentWithin72h: row.hasAssessmentWithin72h,
  }));
}

/** Every active policy, for `resolveInactivityPolicy()` to choose from. */
export async function activePolicies(db: Db): Promise<InactivityPolicyShape[]> {
  const rows = await db.inactivityPolicy.findMany({ where: { isActive: true } });
  return rows.map((row) => ({
    version: row.version,
    isActive: row.isActive,
    batchYear: row.batchYear,
    departmentCode: row.departmentCode,
    nudgeAfterDays: row.nudgeAfterDays,
    warnAfterDays: row.warnAfterDays,
    softRestrictAfterDays: row.softRestrictAfterDays,
    disableAfterDays: row.disableAfterDays,
    autoDisableEnabled: row.autoDisableEnabled,
    graceDays: row.graceDays,
    countsAsActivity: countsAsActivitySchema.parse(row.countsAsActivity),
    minActivityPerDay: row.minActivityPerDay,
    excludeNonWorkingDays: row.excludeNonWorkingDays,
    excludeApprovedLeave: row.excludeApprovedLeave,
    notifyMentor: row.notifyMentor,
    notifyParentEmail: row.notifyParentEmail,
  }));
}

/** The calendar over a window, as the lookup `@recx/shared` wants. */
export async function calendarWindow(db: Db, fromDay: string, toDay: string): Promise<CalendarDayRow[]> {
  const rows = await db.calendarDay.findMany({
    where: { date: { gte: dayToDate(fromDay), lte: dayToDate(toDay) } },
    orderBy: { date: "asc" },
    select: { date: true, kind: true, isWorkingDay: true },
  });
  return rows.map((row) => ({ date: dayOf(row.date), kind: row.kind, isWorkingDay: row.isWorkingDay }));
}

/** Approved leaves overlapping a window, per student. */
export async function approvedLeavesInWindow(
  db: Db,
  userIds: readonly string[],
  fromDay: string,
  toDay: string,
): Promise<Map<string, LeaveRow[]>> {
  const byUser = new Map<string, LeaveRow[]>();
  if (userIds.length === 0) return byUser;
  const rows = await db.leaveException.findMany({
    where: {
      userId: { in: [...userIds] },
      status: "APPROVED",
      startDate: { lte: dayToDate(toDay) },
      endDate: { gte: dayToDate(fromDay) },
    },
    select: { id: true, userId: true, kind: true, status: true, startDate: true, endDate: true },
  });
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? [];
    list.push({
      id: row.id,
      kind: row.kind,
      status: row.status,
      startDate: dayOf(row.startDate),
      endDate: dayOf(row.endDate),
    });
    byUser.set(row.userId, list);
  }
  return byUser;
}

/** Activity days in a window, per student. */
export async function activityInWindow(
  db: Db,
  userIds: readonly string[],
  fromDay: string,
  toDay: string,
): Promise<Map<string, ActivityDayRow[]>> {
  const byUser = new Map<string, ActivityDayRow[]>();
  if (userIds.length === 0) return byUser;
  const rows = await db.activityDay.findMany({
    // The column is `date`; the pure counter's field is `day`. Named
    // differently on purpose in @recx/shared, where a "day" is a campus-day
    // STRING rather than a @db.Date, and conflating the two is how a window
    // ends up an hour wrong on one side of midnight.
    where: { userId: { in: [...userIds] }, date: { gte: dayToDate(fromDay), lte: dayToDate(toDay) } },
    select: { userId: true, date: true, submissions: true, solved: true },
  });
  for (const row of rows) {
    const list = byUser.get(row.userId) ?? [];
    list.push({ day: dayOf(row.date), submissions: row.submissions, solved: row.solved });
    byUser.set(row.userId, list);
  }
  return byUser;
}

export interface SweepDecision {
  readonly candidate: SweepCandidate;
  readonly policy: InactivityPolicyShape | null;
  readonly count: InactivityCount;
  readonly holdback: SweepHoldback | null;
  readonly plan: StagePlan;
  /** The evidence that would be written, built whether or not it is. */
  readonly evidence: ReturnType<typeof buildInactivityEvidence> | null;
  readonly toStatus: ReturnType<typeof statusFor>;
}

function statusFor(stage: RestrictionStage): "ACTIVE" | "SOFT_RESTRICTED" | "DISABLED" {
  return ACCOUNT_STATUS_FOR_STAGE[stage];
}

/**
 * How far back to look for a student who has never been active.
 *
 * Bounded so a policy switched on in October does not hand every first-year
 * a hundred inactive days for a term that had not started. 60 days is longer
 * than any threshold the settings page allows anyway, so it never clips a
 * real count.
 */
export const SWEEP_WINDOW_DAYS = 60;

export interface SweepContext {
  readonly policies: readonly InactivityPolicyShape[];
  readonly cal: ReturnType<typeof calendarLookup>;
  readonly leaves: Map<string, LeaveRow[]>;
  readonly activity: Map<string, ActivityDayRow[]>;
  readonly evaluationDay: string;
  readonly windowStartDay: string;
  readonly now: Date;
}

/**
 * Load everything one batch of candidates needs, in four queries rather than
 * four per student.
 */
export async function loadSweepContext(
  db: Db,
  candidates: readonly SweepCandidate[],
  now: Date,
): Promise<SweepContext> {
  const evaluationDay = campusDay(now);
  const start = new Date(`${evaluationDay}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - SWEEP_WINDOW_DAYS);
  const windowStartDay = start.toISOString().slice(0, 10);
  const userIds = candidates.map((c) => c.userId);

  const [policies, days, leaves, activity] = await Promise.all([
    activePolicies(db),
    calendarWindow(db, windowStartDay, evaluationDay),
    approvedLeavesInWindow(db, userIds, windowStartDay, evaluationDay),
    activityInWindow(db, userIds, windowStartDay, evaluationDay),
  ]);

  return {
    policies,
    cal: calendarLookup(days),
    leaves,
    activity,
    evaluationDay,
    windowStartDay,
    now,
  };
}

/**
 * What the sweep would do to one student — the whole decision, with nothing
 * written.
 *
 * The live sweep (8d) performs exactly this plan. The dry run reports it.
 * One code path, so the report cannot describe a decision the live run would
 * not make.
 */
export function evaluate(candidate: SweepCandidate, context: SweepContext): SweepDecision {
  const policy = resolveInactivityPolicy(context.policies, {
    batchYear: candidate.batchYear,
    departmentCode: candidate.departmentCode,
  });

  const count = policy
    ? countInactiveDays({
        lastActiveDay: candidate.lastActiveAt ? campusDay(candidate.lastActiveAt) : null,
        evaluationDay: context.evaluationDay,
        cal: context.cal,
        leaves: context.leaves.get(candidate.userId) ?? [],
        activity: context.activity.get(candidate.userId) ?? [],
        policy,
        windowStartDay: context.windowStartDay,
      })
    : {
        countedInactiveDays: 0,
        calendarDaysElapsed: 0,
        excludedDates: [],
        excludedReason: [],
        lastCountedDay: null,
        calendarIncomplete: false,
      };

  const holdback = sweepHoldback({
    hasOpenAttempt: candidate.hasOpenAttempt,
    hasPendingAppeal: candidate.hasPendingAppeal,
    hasAssessmentWithin72h: candidate.hasAssessmentWithin72h,
    calendarIncomplete: count.calendarIncomplete,
    hasPolicy: policy !== null,
  });

  const plan = planStageTransition({
    stage: candidate.stage,
    count,
    policy: policy ?? FALLBACK_POLICY,
    holdback,
    notifiedAt: candidate.notifiedAt,
    graceEndsAt: candidate.graceEndsAt,
    now: context.now,
  });

  return {
    candidate,
    policy,
    count,
    holdback,
    plan,
    evidence:
      policy === null
        ? null
        : buildInactivityEvidence({
            lastActiveAt: candidate.lastActiveAt,
            count,
            policy,
            toStage: plan.toStage,
            evaluatedAt: context.now,
          }),
    toStatus: statusFor(plan.toStage),
  };
}

/**
 * Only ever reached when no policy applies, in which case `sweepHoldback`
 * has already returned `no-policy` and the planner holds. It exists so
 * `planStageTransition` keeps a non-null policy parameter rather than
 * growing a null branch that every caller has to think about.
 */
const FALLBACK_POLICY: InactivityPolicyShape = {
  version: 0,
  isActive: false,
  batchYear: null,
  departmentCode: null,
  nudgeAfterDays: null,
  warnAfterDays: null,
  softRestrictAfterDays: null,
  disableAfterDays: null,
  autoDisableEnabled: false,
  graceDays: 0,
  countsAsActivity: { submission: true, solve: true, login: false, lesson: true },
  minActivityPerDay: 1,
  excludeNonWorkingDays: true,
  excludeApprovedLeave: true,
  notifyMentor: false,
  notifyParentEmail: false,
};
