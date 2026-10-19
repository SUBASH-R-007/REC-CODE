/**
 * Counting inactive days, and deciding what that means (Phase 8c).
 *
 * Everything here is pure: no I/O, no Prisma, no ambient clock. That is
 * load-bearing rather than tidy — the numbers these functions return are the
 * numbers a disputed lockout is argued from months later, and an argument
 * that cannot be reproduced from its inputs is not an argument.
 *
 * The spec's reason, carried across verbatim because it is the whole design:
 * without the evidence, "the system disabled me" is unanswerable, and that is
 * the failure mode that destroys trust in a placement platform.
 */

import {
  calendarCovers,
  countedDaysBetween,
  daysInclusive,
  isCountedDay,
  leaveCoveredDays,
  mergeExclusions,
  type CalendarLookup,
  type ExclusionReason,
  type LeaveRow,
} from "./calendar";
import {
  ACTIVITY_SIGNAL_SOURCES,
  INACTIVITY_STAGES,
  nextStage,
  stageIndex,
  thresholdFor,
  type CountsAsActivity,
  type InactivityPolicyShape,
  type RestrictionStage,
} from "./inactivity-policy";
import { dayDifference } from "./time";
import { z } from "zod";

/** One day's activity, as `ActivityDay` holds it. */
export interface ActivityDayRow {
  readonly day: string;
  readonly submissions: number;
  readonly solved: number;
}

/**
 * How much activity a day showed, counting only the signals the policy has
 * switched on AND that this database can actually answer.
 *
 * The sum, not the maximum: `minActivityPerDay` is a quantity of work, and a
 * student who submitted twice and solved once did three things.
 */
export function activityOn(row: ActivityDayRow, counts: CountsAsActivity): number {
  let total = 0;
  if (counts.submission && ACTIVITY_SIGNAL_SOURCES.submission !== null) total += row.submissions;
  if (counts.solve && ACTIVITY_SIGNAL_SOURCES.solve !== null) total += row.solved;
  return total;
}

export interface CountInactiveDaysInput {
  /** The student's last recorded activity, as a campus day, or null. */
  readonly lastActiveDay: string | null;
  /** The day the sweep is evaluating — normally the day that just ended. */
  readonly evaluationDay: string;
  readonly cal: CalendarLookup;
  readonly leaves: readonly LeaveRow[];
  readonly activity: readonly ActivityDayRow[];
  readonly policy: InactivityPolicyShape;
  /**
   * How far back to look when `lastActiveDay` is null. A student who has
   * never submitted has no "last active" day, and counting from their
   * enrolment would hand a first-year a hundred inactive days on the morning
   * the policy switches on.
   */
  readonly windowStartDay: string;
}

export interface InactivityCount {
  readonly countedInactiveDays: number;
  readonly calendarDaysElapsed: number;
  readonly excludedDates: string[];
  readonly excludedReason: ExclusionReason[];
  readonly lastCountedDay: string | null;
  /** True when the calendar does not cover the window; nothing may escalate. */
  readonly calendarIncomplete: boolean;
}

/**
 * The counter.
 *
 * The window is `(from, evaluationDay]` — exclusive of the day the student
 * was last active, because they worked that day, and inclusive of the
 * evaluation day, because the 02:00 sweep judges the day that just ended.
 *
 * A day is excluded, and the reason recorded, when the calendar says the
 * college was shut or the term was not running, when the student was active
 * at or above `minActivityPerDay`, or when an approved leave covers it. What
 * is left is what counts.
 */
export function countInactiveDays(input: CountInactiveDaysInput): InactivityCount {
  const from = input.lastActiveDay ?? input.windowStartDay;
  if (dayDifference(from, input.evaluationDay) <= 0) {
    return {
      countedInactiveDays: 0,
      calendarDaysElapsed: Math.max(0, dayDifference(from, input.evaluationDay)),
      excludedDates: [],
      excludedReason: [],
      lastCountedDay: null,
      calendarIncomplete: false,
    };
  }

  const window = daysInclusive(from, input.evaluationDay).slice(1);
  const options = { excludeNonWorkingDays: input.policy.excludeNonWorkingDays };

  const activeDays = new Set(
    input.activity
      .filter((row) => activityOn(row, input.policy.countsAsActivity) >= input.policy.minActivityPerDay)
      .map((row) => row.day),
  );

  const leaveDays = input.policy.excludeApprovedLeave
    ? leaveCoveredDays(input.leaves, from, input.evaluationDay)
    : new Map<string, LeaveRow["kind"]>();

  const { excludedDates, excludedReason } = mergeExclusions({
    days: window,
    cal: input.cal,
    excludeNonWorkingDays: input.policy.excludeNonWorkingDays,
    activeDays,
    leaveDays,
  });

  const excluded = new Set(excludedDates);
  const counted = window.filter((day) => isCountedDay(day, input.cal, options) && !excluded.has(day));

  return {
    countedInactiveDays: counted.length,
    calendarDaysElapsed: window.length,
    excludedDates,
    excludedReason,
    lastCountedDay: counted.at(-1) ?? null,
    calendarIncomplete: !calendarCovers(from, input.evaluationDay, input.cal),
  };
}

/** `countedDaysBetween` re-exported under the name the sweep reads it by. */
export { countedDaysBetween };

// ── The evidence ─────────────────────────────────────────────────────────

/**
 * The eight keys `AccountStatusEvent_system_evidence_check` requires, plus
 * the three the open questions promised.
 *
 * A system transition cannot be recorded without this, which is the
 * load-bearing constraint of the phase. The three extras are not decoration:
 * `loginSignalAvailable` and `lessonSignalAvailable` are false because this
 * database cannot answer those signals, and recording that is what stops
 * somebody later reading a missing signal as inactivity. `calendarIncomplete`
 * is how a report explains why nobody moved.
 */
export const inactivityEvidenceSchema = z
  .object({
    lastActiveAt: z.string().nullable(),
    calendarDaysElapsed: z.number().int().min(0),
    countedInactiveDays: z.number().int().min(0),
    excludedDates: z.array(z.string()),
    excludedReason: z.array(z.string()),
    thresholdDays: z.number().int().min(0).nullable(),
    policyVersion: z.number().int().positive(),
    evaluatedAt: z.string(),
    loginSignalAvailable: z.boolean(),
    lessonSignalAvailable: z.boolean(),
    calendarIncomplete: z.boolean(),
  })
  .strict();

export type InactivityEvidence = z.infer<typeof inactivityEvidenceSchema>;

/**
 * The exact key list the CHECK requires, as data.
 *
 * A test asserts this equals the array in the migration SQL, so the database
 * constraint and the zod schema are provably the same list rather than two
 * lists somebody keeps in step by hand.
 */
export const REQUIRED_EVIDENCE_KEYS = [
  "lastActiveAt",
  "calendarDaysElapsed",
  "countedInactiveDays",
  "excludedDates",
  "excludedReason",
  "thresholdDays",
  "policyVersion",
  "evaluatedAt",
] as const;

export function buildInactivityEvidence(input: {
  readonly lastActiveAt: Date | null;
  readonly count: InactivityCount;
  readonly policy: InactivityPolicyShape;
  readonly toStage: RestrictionStage;
  readonly evaluatedAt: Date;
}): InactivityEvidence {
  return {
    lastActiveAt: input.lastActiveAt?.toISOString() ?? null,
    calendarDaysElapsed: input.count.calendarDaysElapsed,
    countedInactiveDays: input.count.countedInactiveDays,
    excludedDates: input.count.excludedDates,
    excludedReason: input.count.excludedReason,
    thresholdDays: thresholdFor(input.policy, input.toStage),
    policyVersion: input.policy.version,
    evaluatedAt: input.evaluatedAt.toISOString(),
    loginSignalAvailable: ACTIVITY_SIGNAL_SOURCES.login !== null,
    lessonSignalAvailable: ACTIVITY_SIGNAL_SOURCES.lesson !== null,
    calendarIncomplete: input.count.calendarIncomplete,
  };
}

// ── The holdbacks ────────────────────────────────────────────────────────

/**
 * Where a status event came from (mirrors the Prisma enum, in schema order).
 *
 * The three "system" sources carry no actor; SELF_CLEAR carries the student
 * and the two manual ones carry the staff member. Which is which is a CHECK,
 * not a convention.
 */
export const ACCOUNT_STATUS_SOURCES = [
  "INACTIVITY_SWEEP",
  "AUTO_CLEAR_ON_SOLVE",
  "SELF_CLEAR",
  "LEAVE_REVERSAL",
  "MANUAL_ADMIN",
  "MANUAL_SUPER",
] as const;
export type AccountStatusSource = (typeof ACCOUNT_STATUS_SOURCES)[number];

/** The sources that have no human actor, as the actor CHECK defines them. */
export const SYSTEM_STATUS_SOURCES: readonly AccountStatusSource[] = [
  "INACTIVITY_SWEEP",
  "AUTO_CLEAR_ON_SOLVE",
  "LEAVE_REVERSAL",
];

/** The sources permitted to take an account out of DISABLED. */
export const UNDISABLE_SOURCES: readonly AccountStatusSource[] = ["MANUAL_SUPER", "LEAVE_REVERSAL"];

export const SWEEP_HOLDBACKS = [
  "open-attempt",
  "pending-appeal",
  "assessment-within-72h",
  "calendar-incomplete",
  "no-policy",
] as const;
export type SweepHoldback = (typeof SWEEP_HOLDBACKS)[number];

/** Why a holdback exists, for the dry-run report and the admin queue. */
export const SWEEP_HOLDBACK_REASON: Record<SweepHoldback, string> = {
  "open-attempt": "They are sitting an assessment right now.",
  "pending-appeal": "They are waiting on a human decision about their integrity.",
  "assessment-within-72h": "They have an assessment inside 72 hours.",
  "calendar-incomplete": "The calendar does not cover the days being counted.",
  "no-policy": "No active policy applies to them.",
};

export interface SweepHoldbackInput {
  readonly hasOpenAttempt: boolean;
  readonly hasPendingAppeal: boolean;
  readonly hasAssessmentWithin72h: boolean;
  readonly calendarIncomplete: boolean;
  readonly hasPolicy: boolean;
}

/**
 * Whether this student may be escalated at all, and why not.
 *
 * Ordered most-specific-first so the report says the most useful thing: "they
 * are sitting an exam" is more use to an administrator than "the calendar is
 * incomplete", even when both are true.
 *
 * Each of these is checked three times over — here, in the candidate query's
 * `NOT EXISTS` fragments, and (for the attempt) by a trigger. The spec
 * repeats it as an anti-requirement, and the reason is the one that governs
 * this whole phase: locking a student out of a graded assessment because they
 * were ill is a worse failure than under-enforcing.
 */
export function sweepHoldback(input: SweepHoldbackInput): SweepHoldback | null {
  if (!input.hasPolicy) return "no-policy";
  if (input.hasOpenAttempt) return "open-attempt";
  if (input.hasPendingAppeal) return "pending-appeal";
  if (input.hasAssessmentWithin72h) return "assessment-within-72h";
  if (input.calendarIncomplete) return "calendar-incomplete";
  return null;
}

// ── The planner ──────────────────────────────────────────────────────────

export interface StagePlanInput {
  readonly stage: RestrictionStage;
  readonly count: InactivityCount;
  readonly policy: InactivityPolicyShape;
  readonly holdback: SweepHoldback | null;
  /** When the student was last told, and until when they have grace. */
  readonly notifiedAt: Date | null;
  readonly graceEndsAt: Date | null;
  readonly now: Date;
}

export interface StagePlan {
  readonly kind: "hold" | "escalate" | "clear";
  readonly toStage: RestrictionStage;
  readonly graceEndsAt: Date | null;
  readonly reason: string;
  /** True when the policy wanted a rung it is not allowed to reach. */
  readonly raisesAdminReview: boolean;
  readonly holdback: SweepHoldback | null;
}

/**
 * At most ONE rung per run, and never past the ceiling the policy allows.
 *
 * The spec asks for one transition per run and the database enforces it
 * (`recx_refuse_stage_jump`), but it has to be computed somewhere too, and
 * here is the only place that knows both the day count and the current stage.
 *
 * `DISABLED` is not reached by clamping after the fact: `thresholdFor()`
 * returns null for it while `autoDisableEnabled` is false, so there is no
 * arithmetic path to the top rung and no code that has to remember to clamp.
 * When the day count has passed what would have been the disable threshold,
 * the plan holds at `SOFT_RESTRICTED` and sets `raisesAdminReview` — which is
 * the spec's "the job stops at SOFT_RESTRICTED and raises an admin review
 * item", and the point of it: a human reads a list of names.
 */
export function planStageTransition(input: StagePlanInput): StagePlan {
  const { policy, count, stage, now } = input;
  const deserved = highestReachableStage(policy, count.countedInactiveDays);

  // The policy wanted to go further than it is allowed to. True whether or
  // not anything moves this run, because the review item is about the
  // student's state and not about this tick.
  const wantedMore =
    policy.disableAfterDays !== null &&
    !policy.autoDisableEnabled &&
    count.countedInactiveDays >= policy.disableAfterDays;

  // A clear is never held back: a restoration is not a penalty, and a student
  // who has started working again must not stay paused because their exam is
  // on Thursday.
  if (deserved === "NONE" && stage !== "NONE") {
    return {
      kind: "clear",
      toStage: "NONE",
      graceEndsAt: null,
      reason: "They are active again.",
      raisesAdminReview: false,
      holdback: null,
    };
  }

  if (input.holdback !== null) {
    return {
      kind: "hold",
      toStage: stage,
      graceEndsAt: input.graceEndsAt,
      reason: SWEEP_HOLDBACK_REASON[input.holdback],
      raisesAdminReview: wantedMore || input.holdback === "calendar-incomplete",
      holdback: input.holdback,
    };
  }

  if (stageIndex(deserved) <= stageIndex(stage)) {
    return {
      kind: "hold",
      toStage: stage,
      graceEndsAt: input.graceEndsAt,
      reason: "Nothing has changed since the last run.",
      raisesAdminReview: wantedMore,
      holdback: null,
    };
  }

  // Grace: once a student has been TOLD, they get the policy's grace days
  // before the next rung. Keyed on notifiedAt, so a stage that was never
  // announced does not silently sit out its grace — a student who was never
  // told has had no chance to act.
  if (input.notifiedAt !== null && input.graceEndsAt !== null && input.graceEndsAt.getTime() > now.getTime()) {
    return {
      kind: "hold",
      toStage: stage,
      graceEndsAt: input.graceEndsAt,
      reason: "They were told recently and their grace period has not run out.",
      raisesAdminReview: wantedMore,
      holdback: null,
    };
  }

  const to = nextStage(stage);
  if (to === null || stageIndex(to) > stageIndex(deserved)) {
    return {
      kind: "hold",
      toStage: stage,
      graceEndsAt: input.graceEndsAt,
      reason: "Already at the highest stage this policy reaches.",
      raisesAdminReview: wantedMore,
      holdback: null,
    };
  }

  const graceEndsAt = new Date(now.getTime() + policy.graceDays * 86_400_000);
  return {
    kind: "escalate",
    toStage: to,
    graceEndsAt,
    reason: `${count.countedInactiveDays} counted inactive days.`,
    raisesAdminReview: wantedMore,
    holdback: null,
  };
}

/** The highest rung this day count reaches under this policy. */
function highestReachableStage(policy: InactivityPolicyShape, countedDays: number): RestrictionStage {
  let reached: RestrictionStage = "NONE";
  for (const stage of INACTIVITY_STAGES) {
    const days = thresholdFor(policy, stage);
    if (days !== null && countedDays >= days) reached = stage;
  }
  return reached;
}

// ── What a restriction does ──────────────────────────────────────────────

/**
 * The blocks / does-not-block list, as data, read by every consumer: the
 * contest action, the leaderboard query, `apply.ts` and the student copy.
 *
 * One list rather than four opinions. The spec's reason for the second half
 * is the sentence that governs the phase: locking a student out of a graded
 * assessment because they were ill is a worse failure than under-enforcing.
 */
export const RESTRICTION_EFFECTS = {
  blocks: [
    { key: "contest-registration", says: "You cannot enter a contest while this is paused." },
    { key: "leaderboard-visibility", says: "You are off the public leaderboard." },
    { key: "xp-accrual", says: "New XP is recorded but does not move your place on the boards." },
    { key: "rewards", says: "Badges and streak milestones are not awarded." },
  ],
  doesNotBlock: [
    { key: "sign-in", says: "You can sign in." },
    { key: "read-problems", says: "You can read every problem." },
    { key: "solve", says: "You can solve, and one solved problem clears this." },
    { key: "scheduled-assessment", says: "You can sit any assessment you are scheduled for." },
    { key: "own-integrity-report", says: "You can read your own sitting reports and appeal a decision." },
    { key: "ask-for-leave", says: "You can ask for days to be excused." },
  ],
} as const;

/**
 * The submission lanes a restriction cancels.
 *
 * The spec: "cancel queued and in-flight submissions for an account that has
 * just been restricted, so judge capacity is never spent on a locked lane."
 * The lane `SOFT_RESTRICTED` locks is the CONTEST lane — practice is not
 * locked, and a practice solve is the documented way out of the restriction,
 * so cancelling it would kill the exit route. Recorded in
 * `docs/OPEN-QUESTIONS.md`.
 */
/**
 * The account statuses a restriction puts somebody into.
 *
 * One list, read by the leaderboard query, the XP apply path and the student
 * copy — because "is this student restricted?" answered three ways is three
 * answers that drift. GRADUATED and ARCHIVED are deliberately NOT here: they
 * are end states, and whatever the boards do about them is not this phase's
 * business to change.
 */
export const RESTRICTED_STATUSES = ["SOFT_RESTRICTED", "DISABLED"] as const;
export type RestrictedStatus = (typeof RESTRICTED_STATUSES)[number];

export function isRestrictedStatus(status: string): boolean {
  return (RESTRICTED_STATUSES as readonly string[]).includes(status);
}

export const CANCELLED_LANES_ON_RESTRICT = ["CONTEST"] as const;

// ── Self-service clearing ────────────────────────────────────────────────

export interface SelfClearInput {
  readonly stage: RestrictionStage;
  readonly selfClearedCount: number;
  readonly selfClearedTermKey: string | null;
  readonly termKey: string;
}

export const SELF_CLEAR_PER_TERM = 1;

/**
 * May this student clear their own restriction, right now?
 *
 * The spec is emphatic that this needs no approval: anything requiring an
 * admin turns a ten-day lapse into a permanent exit, because the admin is
 * busy and the student gives up. So the only gate is "once per term", and the
 * term key is stored beside the count so the reset is real rather than a cron
 * guess.
 *
 * `DISABLED` is not self-clearable — that one needs a human, which is the
 * whole reason it is a separate rung.
 */
export function canSelfClear(input: SelfClearInput): { allowed: boolean; reason: string } {
  if (input.stage === "NONE") {
    return { allowed: false, reason: "Nothing is paused." };
  }
  if (input.stage === "DISABLED") {
    return {
      allowed: false,
      reason: "This one needs somebody from the placement cell to reopen it. Write to them and they will.",
    };
  }
  if (input.selfClearedTermKey === input.termKey && input.selfClearedCount >= SELF_CLEAR_PER_TERM) {
    return {
      allowed: false,
      reason: "You have already restored your own account once this term. Solving one problem clears it too.",
    };
  }
  return { allowed: true, reason: "" };
}

/** The count and term key after a self-clear, for the write. */
export function selfClearCounters(input: SelfClearInput): { selfClearedCount: number; selfClearedTermKey: string } {
  const sameTerm = input.selfClearedTermKey === input.termKey;
  return {
    selfClearedCount: sameTerm ? input.selfClearedCount + 1 : 1,
    selfClearedTermKey: input.termKey,
  };
}

// ── The dashboard chip ───────────────────────────────────────────────────

export interface DormancyChip {
  readonly show: boolean;
  readonly countedInactiveDays: number;
  readonly nextStageAtDays: number | null;
  readonly tone: "info" | "warning" | "danger";
  /** The whole sentence, for the aria-label. Never colour alone. */
  readonly label: string;
}

/**
 * The countdown on `/dashboard`.
 *
 * Shown only once something is actually counting, because a chip reading "0
 * of 10 inactive days" on a student's first morning is a threat rather than
 * information. The label carries the whole sentence AND the way out, since a
 * countdown with no exit is just anxiety.
 */
export function dormancyChip(input: {
  readonly stage: RestrictionStage;
  readonly countedInactiveDays: number;
  readonly policy: InactivityPolicyShape | null;
}): DormancyChip {
  const hidden: DormancyChip = {
    show: false,
    countedInactiveDays: input.countedInactiveDays,
    nextStageAtDays: null,
    tone: "info",
    label: "",
  };
  if (input.policy === null) return hidden;
  if (input.countedInactiveDays <= 0 && input.stage === "NONE") return hidden;

  const upcoming = nextStage(input.stage);
  const nextAt = upcoming === null ? null : thresholdFor(input.policy, upcoming);
  const tone =
    input.stage === "SOFT_RESTRICTED" || input.stage === "DISABLED"
      ? "danger"
      : input.stage === "WARNED"
        ? "warning"
        : "info";

  const days = input.countedInactiveDays;
  const plural = days === 1 ? "day" : "days";
  const label =
    input.stage === "SOFT_RESTRICTED"
      ? `Your account is paused after ${days} inactive ${plural}. Solve one problem to restore it — nobody needs to approve that.`
      : nextAt === null
        ? `${days} inactive ${plural} counted. Solve one problem to reset it.`
        : `${days} of ${nextAt} inactive ${plural} counted. Solve one problem to reset it.`;

  return { show: true, countedInactiveDays: days, nextStageAtDays: nextAt, tone, label };
}
