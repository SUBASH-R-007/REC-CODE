import {
  ACCOUNT_STATUS_FOR_STAGE,
  CANCELLED_LANES_ON_RESTRICT,
  INACTIVITY_AUDIT_ACTIONS,
  INACTIVITY_NOTIFICATION_KIND,
  INACTIVITY_STAGES,
  MENTOR_EMAIL_KIND,
  buildInactivityEvidence,
  canSelfClear,
  selfClearCounters,
  stageForCountedDays,
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
  mentorMessage,
  stageMessage,
  type StagePlan,
  type SweepHoldback,
} from "@recx/shared";
import { appendAuditEntriesInTx } from "./audit";
import type { Db, DbTx } from "./index";

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

// ── Performing a decision ────────────────────────────────────────────────

export interface AppliedDecision {
  readonly userId: string;
  readonly fromStage: RestrictionStage;
  readonly toStage: RestrictionStage;
  readonly eventId: bigint | null;
  /** Contest-lane submissions cancelled, for the job's best-effort queue removal. */
  readonly cancelledSubmissionIds: string[];
  readonly notifiedMentor: boolean;
  readonly adminReviewOpened: boolean;
  /** Set when another writer got there first, or the state moved underneath. */
  readonly skipped?: "already-moved" | "nothing-to-do" | "no-evidence";
}

/**
 * Perform one decision, in ONE transaction.
 *
 * What goes in it, and why each thing has to be inside rather than beside:
 *
 *   - the `AccountStatusEvent`, because `AccountRestriction_requires_event`
 *     is a deferred constraint trigger: at commit the stage must have its
 *     explanation, and a two-step write would leave a window where it does
 *     not;
 *   - `User.status`, because the already-shipped contest refusal reads it
 *     and a restriction whose status write landed separately would bite a
 *     moment late or not at all;
 *   - the `Notification`, because a student restricted with no message is a
 *     student who finds out by failing to enter a contest;
 *   - the `AuditLog` row, through `appendAuditEntriesInTx` so it joins the
 *     day's hash chain under the same advisory lock as every other audit
 *     write;
 *   - the contest-lane cancellation, because judge capacity spent on a lane
 *     the student may not enter is capacity taken from somebody who can.
 *
 * The Redis removal is NOT in here. It cannot be: a Redis call inside a
 * database transaction cannot be rolled back, and an unremoved job is
 * harmless anyway — the row is CANCELLED and the reconciler leaves it alone.
 * The job does it afterwards, best-effort, as every other enqueue in this
 * codebase does.
 *
 * Safe with two scheduler instances: an advisory lock on the user id
 * serialises them, and the stage is re-read inside the transaction, so the
 * second one finds the work done and reports `already-moved` rather than
 * writing a second rung. The per-day unique index is the backstop.
 */
export async function applyDecision(
  db: Db,
  decision: SweepDecision,
  options: { readonly now: Date; readonly evaluationDay: string },
): Promise<AppliedDecision> {
  const { candidate, plan } = decision;
  const base: AppliedDecision = {
    userId: candidate.userId,
    fromStage: candidate.stage,
    toStage: plan.toStage,
    eventId: null,
    cancelledSubmissionIds: [],
    notifiedMentor: false,
    adminReviewOpened: false,
  };

  if (plan.kind === "hold") {
    // Nothing moves — but the review item and the counters are still worth
    // writing, so `/admin/inactivity` is current and the dormancy chip can
    // show a count before anything has happened to the student.
    await recordHold(db, decision, options);
    return { ...base, skipped: "nothing-to-do", adminReviewOpened: plan.raisesAdminReview };
  }
  if (decision.evidence === null) return { ...base, skipped: "no-evidence" };

  const evidence = decision.evidence;
  const policy = decision.policy;
  const toStatus = decision.toStatus;

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`inactivity:${candidate.userId}`}))`;

    const live = await tx.user.findUnique({
      where: { id: candidate.userId },
      select: {
        id: true,
        status: true,
        firstName: true,
        lastName: true,
        collegeId: true,
        batchYear: true,
        departmentCode: true,
        restriction: { select: { stage: true, ownsAccountStatus: true, adminReviewOpenedAt: true } },
      },
    });
    if (!live) return { ...base, skipped: "nothing-to-do" };

    const liveStage = live.restriction?.stage ?? "NONE";
    if (liveStage !== candidate.stage) {
      // Another instance, a solve, or a staff member moved them between the
      // read and now. Their decision stands; ours was computed from a stale
      // snapshot and is not reapplied.
      return { ...base, skipped: "already-moved" };
    }

    const event = await tx.accountStatusEvent.create({
      data: {
        userId: candidate.userId,
        fromStage: candidate.stage,
        toStage: plan.toStage,
        fromStatus: live.status,
        toStatus: engineOwns(live.restriction?.ownsAccountStatus ?? false, live.status) ? toStatus : live.status,
        source: "INACTIVITY_SWEEP",
        policyVersion: policy?.version ?? null,
        evidence: evidence as never,
        triggeredBySystem: true,
        evaluationDate: new Date(`${options.evaluationDay}T00:00:00.000Z`),
        notifiedAt: options.now,
        /**
         * Written explicitly, from the SAME clock as `stageEnteredAt` below.
         *
         * `recx_refuse_restriction_without_event` requires an event with
         * `createdAt >= stageEnteredAt`. Leaving `createdAt` to the database
         * default compares the DATABASE clock against the APPLICATION clock,
         * and on this development machine the two drift by a few hundred
         * milliseconds in either direction — so a perfectly correct write
         * would be refused whenever the app clock ran ahead. In production
         * the app and the database are different machines, so this is not a
         * development artefact. The fifth time this trap has been sprung in
         * this repository (docs/CONVENTIONS.md).
         */
        createdAt: options.now,
      },
      select: { id: true },
    });

    const clearing = plan.toStage === "NONE";
    await tx.accountRestriction.upsert({
      where: { userId: candidate.userId },
      create: {
        userId: candidate.userId,
        stage: plan.toStage,
        stageEnteredAt: options.now,
        graceEndsAt: clearing ? null : plan.graceEndsAt,
        countedInactiveDays: clearing ? 0 : decision.count.countedInactiveDays,
        lastEvaluatedAt: options.now,
        policyVersion: policy?.version ?? null,
        ownsAccountStatus: !clearing && toStatus !== "ACTIVE",
        adminReviewOpenedAt: plan.raisesAdminReview ? options.now : null,
      },
      update: {
        stage: plan.toStage,
        stageEnteredAt: options.now,
        graceEndsAt: clearing ? null : plan.graceEndsAt,
        countedInactiveDays: clearing ? 0 : decision.count.countedInactiveDays,
        lastEvaluatedAt: options.now,
        policyVersion: policy?.version ?? null,
        ownsAccountStatus: !clearing && toStatus !== "ACTIVE",
        // A clear closes the review item; an escalation that wants one opens
        // it, and one already open stays open.
        adminReviewOpenedAt: clearing
          ? live.restriction?.adminReviewOpenedAt ?? null
          : plan.raisesAdminReview
            ? live.restriction?.adminReviewOpenedAt ?? options.now
            : live.restriction?.adminReviewOpenedAt ?? null,
        adminReviewClearedAt: clearing && live.restriction?.adminReviewOpenedAt ? options.now : null,
      },
    });

    /**
     * `User.status`, and ONLY while the engine owns it.
     *
     * An account a human suspended for something else must never be
     * un-suspended by a clear-on-solve, and an account already DISABLED by a
     * human must not be quietly downgraded to SOFT_RESTRICTED by a sweep. So
     * the engine writes the status when it is moving into a restricted state
     * from ACTIVE, or when it is clearing one it put there itself.
     */
    const mayWriteStatus = engineOwns(live.restriction?.ownsAccountStatus ?? false, live.status);
    if (mayWriteStatus && toStatus !== live.status) {
      await tx.user.update({ where: { id: candidate.userId }, data: { status: toStatus } });
    }

    const message = stageMessage(plan.toStage, decision.count.countedInactiveDays);
    await tx.notification.create({
      data: {
        userId: candidate.userId,
        kind: INACTIVITY_NOTIFICATION_KIND,
        title: message.title,
        body: message.body,
        link: message.link,
        createdAt: options.now,
      },
    });

    // Judge capacity is never spent on a lane the student may not enter.
    // CONTEST only: practice is not locked, and a practice solve is the
    // documented way out (docs/OPEN-QUESTIONS.md).
    let cancelledSubmissionIds: string[] = [];
    if (toStatus !== "ACTIVE") {
      const queued = await tx.submission.findMany({
        where: {
          userId: candidate.userId,
          lane: { in: [...CANCELLED_LANES_ON_RESTRICT] },
          status: { in: ["QUEUED", "JUDGING"] },
        },
        select: { id: true },
      });
      if (queued.length > 0) {
        await tx.submission.updateMany({
          where: { id: { in: queued.map((row) => row.id) } },
          data: { status: "CANCELLED" },
        });
        cancelledSubmissionIds = queued.map((row) => row.id);
      }
    }

    // The named human. The spec's point is that non-progress is visible to
    // somebody who can intervene, so this must never silently go nowhere:
    // the student's TA_MENTOR by cohort, and failing that the department
    // ADMIN rather than nobody.
    let notifiedMentor = false;
    if (policy?.notifyMentor && !clearing && stageIndexOf(plan.toStage) >= stageIndexOf("WARNED")) {
      const mentorId = await findMentor(tx, {
        batchYear: live.batchYear,
        departmentCode: live.departmentCode,
      });
      if (mentorId) {
        const mail = mentorMessage({
          collegeId: live.collegeId,
          name: `${live.firstName} ${live.lastName}`.trim(),
          stage: plan.toStage,
          countedDays: decision.count.countedInactiveDays,
        });
        await tx.emailOutbox.create({
          data: {
            kind: MENTOR_EMAIL_KIND,
            toUserId: mentorId,
            subject: mail.subject,
            bodyText: mail.body,
            entityType: "AccountStatusEvent",
            entityId: String(event.id),
          },
        });
        notifiedMentor = true;
      }
    }

    await appendAuditEntriesInTx(
      tx,
      [
        {
          actorId: null,
          action: clearing ? INACTIVITY_AUDIT_ACTIONS.cleared : INACTIVITY_AUDIT_ACTIONS.escalated,
          entityType: "AccountStatusEvent",
          entityId: String(event.id),
          targetUserId: candidate.userId,
          sensitivity: "SENSITIVE",
          metadata: {
            fromStage: candidate.stage,
            toStage: plan.toStage,
            countedInactiveDays: decision.count.countedInactiveDays,
            policyVersion: policy?.version ?? null,
            evaluationDate: options.evaluationDay,
            statusWritten: mayWriteStatus && toStatus !== live.status ? toStatus : null,
            cancelledContestSubmissions: cancelledSubmissionIds.length,
            notifiedMentor,
            raisesAdminReview: plan.raisesAdminReview,
          },
        },
      ],
      options.now,
    );

    return {
      ...base,
      fromStage: candidate.stage,
      eventId: event.id,
      cancelledSubmissionIds,
      notifiedMentor,
      adminReviewOpened: plan.raisesAdminReview,
    };
  });
}

/**
 * May the engine write `User.status` for this account?
 *
 * True when it already owns it, and true when the account is plainly ACTIVE
 * so there is nothing of anybody else's to overwrite. False for an account a
 * human put into SOFT_RESTRICTED or DISABLED — that status is theirs, and
 * the engine neither raises nor lowers it.
 */
function engineOwns(ownsAccountStatus: boolean, liveStatus: string): boolean {
  return ownsAccountStatus || liveStatus === "ACTIVE";
}

function stageIndexOf(stage: RestrictionStage): number {
  return INACTIVITY_STAGES.indexOf(stage);
}

/**
 * A student's named human: their TA_MENTOR by cohort, else the department
 * ADMIN, else nobody — and "nobody" is reported rather than assumed, so a
 * college with no mentors can see that the notification went nowhere.
 *
 * Most specific scope first, the same shape as policy resolution: a mentor
 * scoped to this department AND batch outranks one scoped to either alone.
 */
async function findMentor(
  tx: DbTx,
  cohort: { batchYear: number | null; departmentCode: string | null },
): Promise<string | null> {
  const rows = await tx.adminScope.findMany({
    where: {
      revokedAt: null,
      OR: [{ departmentCode: null }, { departmentCode: cohort.departmentCode ?? undefined }],
      AND: [{ OR: [{ batchYear: null }, { batchYear: cohort.batchYear ?? undefined }] }],
      admin: { role: { in: ["TA_MENTOR", "ADMIN"] }, status: "ACTIVE" },
    },
    select: { adminId: true, departmentCode: true, batchYear: true, admin: { select: { role: true } } },
  });
  if (rows.length === 0) return null;
  const score = (row: (typeof rows)[number]) =>
    (row.admin.role === "TA_MENTOR" ? 100 : 0) +
    (row.departmentCode !== null ? 10 : 0) +
    (row.batchYear !== null ? 1 : 0);
  return rows.reduce((best, row) => (score(row) > score(best) ? row : best)).adminId;
}

/**
 * A hold still updates the counters and the review item.
 *
 * Without this, a student at eight counted days would have no count recorded
 * anywhere, so the dormancy chip could not warn them before the rung they
 * are heading for — and `/admin/inactivity` would only ever show students the
 * job had already acted on, which is the opposite of a review queue.
 *
 * No event row: nothing moved, and `AccountStatusEvent_change_check` refuses
 * a no-op anyway.
 */
async function recordHold(
  db: Db,
  decision: SweepDecision,
  options: { readonly now: Date; readonly evaluationDay: string },
): Promise<void> {
  const { candidate, plan } = decision;
  const stage = candidate.stage;
  // A NONE row may carry no count (AccountRestriction_none_check), so a
  // student at NONE with nothing counted gets no row at all rather than a
  // row the constraint would refuse.
  if (stage === "NONE" && decision.count.countedInactiveDays === 0 && !plan.raisesAdminReview) return;

  await db.accountRestriction.upsert({
    where: { userId: candidate.userId },
    create: {
      userId: candidate.userId,
      stage,
      stageEnteredAt: candidate.stageEnteredAt ?? options.now,
      countedInactiveDays: stage === "NONE" ? 0 : decision.count.countedInactiveDays,
      graceEndsAt: stage === "NONE" ? null : candidate.graceEndsAt,
      lastEvaluatedAt: options.now,
      policyVersion: decision.policy?.version ?? null,
      adminReviewOpenedAt: plan.raisesAdminReview ? options.now : null,
    },
    update: {
      countedInactiveDays: stage === "NONE" ? 0 : decision.count.countedInactiveDays,
      lastEvaluatedAt: options.now,
      policyVersion: decision.policy?.version ?? null,
      ...(plan.raisesAdminReview ? { adminReviewOpenedAt: options.now, adminReviewClearedAt: null } : {}),
    },
  });
}

// ── Restoration (Phase 8e) ───────────────────────────────────────────────

export interface ClearedRestriction {
  readonly cleared: boolean;
  readonly fromStage: RestrictionStage;
  readonly statusRestored: boolean;
}

const NOT_CLEARED: ClearedRestriction = { cleared: false, fromStage: "NONE", statusRestored: false };

/**
 * Clear a restriction because the student did the thing the policy wanted.
 *
 * SPEC §5: "Solving one problem clears NUDGED / WARNED / SOFT_RESTRICTED
 * automatically." The cheapest possible exit from a restriction is doing the
 * work, and it needs no approval — anything requiring an admin turns a
 * ten-day lapse into a permanent exit, because the admin is busy and the
 * student gives up.
 *
 * Called INSIDE the submission's own transaction, so the solve and the
 * restoration either both happen or neither does. A student whose solve
 * committed and whose restoration did not would be a student told to solve a
 * problem, who solved one, and who is still paused.
 *
 * `DISABLED` is NOT cleared here. A disabled account cannot sign in, so it
 * cannot reach this path at all — but the guard is explicit anyway, because
 * `AccountStatusEvent_undisable_check` would refuse the row and a silent
 * refusal inside a submission transaction would lose the submission.
 */
export async function clearRestrictionOnSolve(
  tx: DbTx,
  input: { readonly userId: string; readonly problemId: string; readonly now: Date },
): Promise<ClearedRestriction> {
  const current = await tx.accountRestriction.findUnique({
    where: { userId: input.userId },
    select: { stage: true, ownsAccountStatus: true, adminReviewOpenedAt: true },
  });
  if (!current || current.stage === "NONE" || current.stage === "DISABLED") return NOT_CLEARED;

  const user = await tx.user.findUnique({ where: { id: input.userId }, select: { status: true } });
  if (!user) return NOT_CLEARED;

  await tx.accountStatusEvent.create({
    data: {
      userId: input.userId,
      fromStage: current.stage,
      toStage: "NONE",
      fromStatus: user.status,
      toStatus: current.ownsAccountStatus ? "ACTIVE" : user.status,
      source: "AUTO_CLEAR_ON_SOLVE",
      evidence: { clearedBy: input.problemId, clearedAt: input.now.toISOString() },
      triggeredBySystem: true,
      // One clock for both, since the deferred trigger compares this against
      // `stageEnteredAt` below.
      createdAt: input.now,
    },
  });

  await tx.accountRestriction.update({
    where: { userId: input.userId },
    data: {
      stage: "NONE",
      stageEnteredAt: input.now,
      graceEndsAt: null,
      countedInactiveDays: 0,
      ownsAccountStatus: false,
      lastEvaluatedAt: input.now,
      // A student who fixed it themselves closes the review item: a human
      // asked to look at somebody who is working again is a human whose time
      // was wasted.
      adminReviewClearedAt: current.adminReviewOpenedAt ? input.now : null,
    },
  });

  if (current.ownsAccountStatus) {
    await tx.user.update({ where: { id: input.userId }, data: { status: "ACTIVE" } });
  }

  return { cleared: true, fromStage: current.stage, statusRestored: current.ownsAccountStatus };
}

/**
 * Clear a restriction because the student asked, once per term, with no
 * approval at all.
 *
 * SPEC §7 says plainly "do not require admin approval to clear a soft
 * restriction", and the reason is the one above: approval turns a lapse into
 * an exit. So this is one button, acting only on the caller's own row.
 *
 * It carries the student as its ACTOR, which is true and is what their own
 * history should show — the only non-system source that is not a member of
 * staff.
 */
export async function selfClearRestriction(
  tx: DbTx,
  input: {
    readonly userId: string;
    readonly termKey: string;
    readonly now: Date;
  },
): Promise<ClearedRestriction & { readonly refusal?: string }> {
  const current = await tx.accountRestriction.findUnique({
    where: { userId: input.userId },
    select: {
      stage: true,
      ownsAccountStatus: true,
      selfClearedCount: true,
      selfClearedTermKey: true,
      adminReviewOpenedAt: true,
    },
  });
  if (!current) return { ...NOT_CLEARED, refusal: "Nothing is paused." };

  const allowed = canSelfClear({
    stage: current.stage,
    selfClearedCount: current.selfClearedCount,
    selfClearedTermKey: current.selfClearedTermKey,
    termKey: input.termKey,
  });
  if (!allowed.allowed) return { ...NOT_CLEARED, fromStage: current.stage, refusal: allowed.reason };

  const user = await tx.user.findUnique({ where: { id: input.userId }, select: { status: true } });
  if (!user) return NOT_CLEARED;

  await tx.accountStatusEvent.create({
    data: {
      userId: input.userId,
      fromStage: current.stage,
      toStage: "NONE",
      fromStatus: user.status,
      toStatus: current.ownsAccountStatus ? "ACTIVE" : user.status,
      source: "SELF_CLEAR",
      evidence: { clearedBy: "self", clearedAt: input.now.toISOString(), termKey: input.termKey },
      triggeredBySystem: false,
      actorId: input.userId,
      createdAt: input.now,
    },
  });

  const counters = selfClearCounters({
    stage: current.stage,
    selfClearedCount: current.selfClearedCount,
    selfClearedTermKey: current.selfClearedTermKey,
    termKey: input.termKey,
  });

  await tx.accountRestriction.update({
    where: { userId: input.userId },
    data: {
      stage: "NONE",
      stageEnteredAt: input.now,
      graceEndsAt: null,
      countedInactiveDays: 0,
      ownsAccountStatus: false,
      lastEvaluatedAt: input.now,
      selfClearedCount: counters.selfClearedCount,
      selfClearedTermKey: counters.selfClearedTermKey,
      adminReviewClearedAt: current.adminReviewOpenedAt ? input.now : null,
    },
  });

  if (current.ownsAccountStatus) {
    await tx.user.update({ where: { id: input.userId }, data: { status: "ACTIVE" } });
  }

  return { cleared: true, fromStage: current.stage, statusRestored: current.ownsAccountStatus };
}

/**
 * Reverse a restriction because a leave approved after the fact proves the
 * days should never have been counted.
 *
 * This is the one path that may take an account out of DISABLED without a
 * super-admin, and that is deliberate: the student did not become inactive
 * retroactively — the platform was wrong about them, and a correction that
 * needed a second human to approve it would mean the platform's mistake cost
 * the student a wait.
 *
 * It recounts rather than assuming: an approved leave that does not actually
 * bring the count below the threshold reverses nothing, and says so.
 */
export async function reverseForLeave(
  db: Db,
  input: {
    readonly userId: string;
    readonly leaveId: string;
    readonly now: Date;
    readonly evaluationDay: string;
    readonly count: InactivityCount;
    readonly policy: InactivityPolicyShape;
  },
): Promise<ClearedRestriction & { readonly refusal?: string }> {
  return db.$transaction(async (tx) => {
    const current = await tx.accountRestriction.findUnique({
      where: { userId: input.userId },
      select: { stage: true, ownsAccountStatus: true, adminReviewOpenedAt: true },
    });
    if (!current || current.stage === "NONE") {
      return { ...NOT_CLEARED, refusal: "Nothing was restricted." };
    }

    const deserved = stageForCountedDays(input.policy, input.count.countedInactiveDays);
    if (stageIndexOf(deserved) >= stageIndexOf(current.stage)) {
      // The leave does not change the outcome. Said rather than silently
      // doing nothing, so the approver learns that the days they excused
      // were not the days that counted.
      return {
        ...NOT_CLEARED,
        fromStage: current.stage,
        refusal: `Those days were excused, but ${input.count.countedInactiveDays} counted days remain, which is still ${deserved}.`,
      };
    }

    const user = await tx.user.findUnique({ where: { id: input.userId }, select: { status: true } });
    if (!user) return NOT_CLEARED;

    await tx.accountStatusEvent.create({
      data: {
        userId: input.userId,
        fromStage: current.stage,
        toStage: "NONE",
        fromStatus: user.status,
        toStatus: current.ownsAccountStatus ? "ACTIVE" : user.status,
        source: "LEAVE_REVERSAL",
        evidence: {
          clearedBy: input.leaveId,
          clearedAt: input.now.toISOString(),
          countedInactiveDays: input.count.countedInactiveDays,
          excludedDates: input.count.excludedDates,
          excludedReason: input.count.excludedReason,
          policyVersion: input.policy.version,
        },
        triggeredBySystem: true,
        createdAt: input.now,
      },
    });

    await tx.accountRestriction.update({
      where: { userId: input.userId },
      data: {
        stage: "NONE",
        stageEnteredAt: input.now,
        graceEndsAt: null,
        countedInactiveDays: 0,
        ownsAccountStatus: false,
        lastEvaluatedAt: input.now,
        policyVersion: input.policy.version,
        adminReviewClearedAt: current.adminReviewOpenedAt ? input.now : null,
      },
    });

    if (current.ownsAccountStatus) {
      await tx.user.update({ where: { id: input.userId }, data: { status: "ACTIVE" } });
    }

    return { cleared: true, fromStage: current.stage, statusRestored: current.ownsAccountStatus };
  });
}
