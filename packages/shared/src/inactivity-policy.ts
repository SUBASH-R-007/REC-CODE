/**
 * The inactivity policy: the ladder, the thresholds, and which policy applies
 * to whom (Phase 8b).
 *
 * SPEC §5 Phase 8 is titled "Inactivity as a policy engine, not a kill
 * switch", and three things in this file are that title made executable:
 *
 *   - `DEFAULT_INACTIVITY_POLICY.autoDisableEnabled` is false, so the
 *     shipped ladder cannot reach `DISABLED` at all;
 *   - every threshold is a stored, super-admin-configurable number rather
 *     than a constant here, so the college can tighten the policy without a
 *     deploy — which is why the fortnight floor on auto-disable is an advisory
 *     constant with copy attached and NOT a CHECK or a zod refusement;
 *   - `RESTRICTION_STAGE_LABEL` never uses the word "disabled", at any rung.
 *
 * Pure: no I/O, no Prisma, no ambient clock.
 */

import { z } from "zod";

/**
 * The ladder. Order is the whole meaning: an escalation moves exactly one
 * rung, and a restoration may drop straight to `NONE` because a restoration
 * is not a penalty and is never rate-limited.
 */
export const INACTIVITY_STAGES = ["NONE", "NUDGED", "WARNED", "SOFT_RESTRICTED", "DISABLED"] as const;
export type RestrictionStage = (typeof INACTIVITY_STAGES)[number];

/** The AccountStatus values this engine reads and writes (mirrors @recx/db). */
export const INACTIVITY_ACCOUNT_STATUSES = ["ACTIVE", "SOFT_RESTRICTED", "DISABLED"] as const;
export type InactivityAccountStatus = (typeof INACTIVITY_ACCOUNT_STATUSES)[number];

export function stageIndex(stage: RestrictionStage): number {
  return INACTIVITY_STAGES.indexOf(stage);
}

/** The next rung up, or null at the top. */
export function nextStage(stage: RestrictionStage): RestrictionStage | null {
  return INACTIVITY_STAGES[stageIndex(stage) + 1] ?? null;
}

/** The rung below, or null at `NONE`. */
export function previousStage(stage: RestrictionStage): RestrictionStage | null {
  const index = stageIndex(stage);
  return index <= 0 ? null : (INACTIVITY_STAGES[index - 1] ?? null);
}

/**
 * What a STUDENT is told. The word "disabled" appears at no rung, `DISABLED`
 * included.
 *
 * The spec says flatly "keep the word 'disabled' out of student-facing copy",
 * and the reason is not squeamishness: a student reading "your account is
 * disabled" believes they have been thrown off the platform and stops trying,
 * which is the exact outcome a policy about non-progress must not produce.
 * "Paused" is both gentler and more accurate — every one of these states is
 * reversible, and the top one is reversible by a human who can be asked.
 */
export const RESTRICTION_STAGE_LABEL: Record<RestrictionStage, string> = {
  NONE: "Active",
  NUDGED: "Quiet for a few days",
  WARNED: "Quiet for a while — worth a look",
  SOFT_RESTRICTED: "Paused for inactivity",
  DISABLED: "Paused — the placement cell can reopen it",
};

/**
 * What ADMINISTRATIVE reporting is told, where "Disabled" is the accurate
 * word and no student reads it.
 *
 * The same key set as the student map, asserted by a test: a rung with an
 * administrative name and no student name is a rung that would render blank
 * on a student's own page.
 */
export const RESTRICTION_STAGE_ADMIN_LABEL: Record<RestrictionStage, string> = {
  NONE: "None",
  NUDGED: "Nudged",
  WARNED: "Warned",
  SOFT_RESTRICTED: "Soft-restricted",
  DISABLED: "Disabled",
};

/**
 * The stage → `User.status` mapping.
 *
 * Load-bearing rather than bookkeeping: the already-shipped contest refusal
 * reads `user.status === "SOFT_RESTRICTED"`
 * (`apps/web/src/server/actions/contests.ts`), so without this write the
 * restriction would bite nothing at all. `NUDGED` and `WARNED` map to
 * `ACTIVE` deliberately — they are a message to the student and to their
 * mentor, not a consequence.
 */
export const ACCOUNT_STATUS_FOR_STAGE: Record<RestrictionStage, InactivityAccountStatus> = {
  NONE: "ACTIVE",
  NUDGED: "ACTIVE",
  WARNED: "ACTIVE",
  SOFT_RESTRICTED: "SOFT_RESTRICTED",
  DISABLED: "DISABLED",
};

/** Does moving to this stage change `User.status` at all? */
export function stageMovesAccountStatus(from: RestrictionStage, to: RestrictionStage): boolean {
  return ACCOUNT_STATUS_FOR_STAGE[from] !== ACCOUNT_STATUS_FOR_STAGE[to];
}

/**
 * May a staff member (not a super-admin) clear this stage?
 *
 * The spec: "DISABLED → ACTIVE is Super-admin only." A department ADMIN may
 * de-escalate a nudge, a warning or a soft restriction — those are the cases
 * where somebody who knows the student can say "they were in hospital, let
 * them back on the board". Reopening a disabled account is not one of them.
 * Enforced three times over: here, in the action, and by a CHECK on the event
 * row.
 */
export function canStaffClear(stage: RestrictionStage): boolean {
  return stage !== "DISABLED" && stage !== "NONE";
}

/**
 * Which `ActivityDay` column each `countsAsActivity` key reads.
 *
 * `null` means the signal has no source in this database. The spec's field
 * list carries four keys and only two of them can be answered here, so rather
 * than quietly treating a missing signal as inactivity, the key is accepted,
 * ignored, and the evidence row records that it was unavailable. A student is
 * never counted idle because a signal we never collected did not fire.
 */
export const ACTIVITY_SIGNAL_SOURCES = {
  submission: "submissions",
  solve: "solved",
  /** No login column exists, and `lastActiveAt` is the window's own start. */
  login: null,
  /** Lessons live in the LMS; REC Code never creates a student record there. */
  lesson: null,
} as const satisfies Record<string, string | null>;

export type ActivitySignal = keyof typeof ACTIVITY_SIGNAL_SOURCES;

/** The signals that can actually be read, in a stable order. */
export const AVAILABLE_ACTIVITY_SIGNALS = (Object.keys(ACTIVITY_SIGNAL_SOURCES) as ActivitySignal[]).filter(
  (key) => ACTIVITY_SIGNAL_SOURCES[key] !== null,
);

export const countsAsActivitySchema = z
  .object({
    submission: z.boolean(),
    solve: z.boolean(),
    login: z.boolean(),
    lesson: z.boolean(),
  })
  .strict();

export type CountsAsActivity = z.infer<typeof countsAsActivitySchema>;

/**
 * The advisory floor on an auto-disable threshold, in days.
 *
 * NOT a constraint. The spec requires every threshold to be configurable
 * without a deploy, and a constant inside a CHECK is a constant that needs a
 * migration — the college's own stated wish (five days) would have become
 * unreachable by the one mechanism the spec says must not require a deploy.
 * So the fortnight argument lives where a human reads it: the settings page
 * shows `AUTO_DISABLE_FLOOR_REASON` above the field, and saving below the
 * floor requires typing `AUTO_DISABLE_CONFIRMATION` and audits at SECURITY.
 */
export const AUTO_DISABLE_FLOOR_DAYS = 14;
export const AUTO_DISABLE_CONFIRMATION = "I ACCEPT THIS THRESHOLD";
export const AUTO_DISABLE_FLOOR_REASON =
  "A threshold under a fortnight will reach a student who was simply ill. Dengue keeps somebody off a laptop for two weeks and typhoid for three, and neither of them did anything wrong.";

export interface InactivityPolicyShape {
  readonly version: number;
  readonly isActive: boolean;
  readonly batchYear: number | null;
  readonly departmentCode: string | null;
  readonly nudgeAfterDays: number | null;
  readonly warnAfterDays: number | null;
  readonly softRestrictAfterDays: number | null;
  readonly disableAfterDays: number | null;
  readonly autoDisableEnabled: boolean;
  readonly graceDays: number;
  readonly countsAsActivity: CountsAsActivity;
  readonly minActivityPerDay: number;
  readonly excludeNonWorkingDays: boolean;
  readonly excludeApprovedLeave: boolean;
  readonly notifyMentor: boolean;
  readonly notifyParentEmail: boolean;
}

const threshold = z.number().int().min(1).max(365).nullable();

/**
 * The zod mirror of the table's CHECKs. Two rules, and only two:
 *
 *   - the non-null thresholds are non-decreasing up the ladder (a null means
 *     that rung never fires);
 *   - auto-disable needs a disable threshold, or the policy cannot be
 *     evaluated at all.
 *
 * There is deliberately no numeric floor here either — see
 * `AUTO_DISABLE_FLOOR_DAYS`.
 */
export const inactivityPolicySchema = z
  .object({
    isActive: z.boolean(),
    batchYear: z.number().int().min(2000).max(2100).nullable(),
    departmentCode: z.string().trim().min(2).max(16).nullable(),
    nudgeAfterDays: threshold,
    warnAfterDays: threshold,
    softRestrictAfterDays: threshold,
    disableAfterDays: threshold,
    autoDisableEnabled: z.boolean(),
    graceDays: z.number().int().min(0).max(30),
    countsAsActivity: countsAsActivitySchema,
    minActivityPerDay: z.number().int().min(1).max(20),
    excludeNonWorkingDays: z.boolean(),
    excludeApprovedLeave: z.boolean(),
    notifyMentor: z.boolean(),
    notifyParentEmail: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ladder: Array<[keyof typeof value, number | null]> = [
      ["nudgeAfterDays", value.nudgeAfterDays],
      ["warnAfterDays", value.warnAfterDays],
      ["softRestrictAfterDays", value.softRestrictAfterDays],
      ["disableAfterDays", value.disableAfterDays],
    ];
    let previous: { key: keyof typeof value; days: number } | null = null;
    for (const [key, days] of ladder) {
      if (days === null) continue;
      if (previous && days < previous.days) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${String(key)} (${days}) cannot be sooner than ${String(previous.key)} (${previous.days})`,
        });
      }
      previous = { key, days };
    }

    if (value.autoDisableEnabled && value.disableAfterDays === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["disableAfterDays"],
        message: "Automatic disabling needs a threshold, or the policy cannot be evaluated.",
      });
    }

    if (value.notifyParentEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notifyParentEmail"],
        message:
          "A parent address is third-party personal data and the consent record it needs is not built. This stays off.",
      });
    }
  });

/**
 * The policy that ships.
 *
 * Counted day 3 is a nudge, day 5 a warning to the student and their mentor,
 * day 10 a soft restriction, and `DISABLED` is unreachable because
 * `autoDisableEnabled` is false. The college's stated wish was "five days,
 * then disabled"; this is not that, and the gap is recorded in
 * `docs/OPEN-QUESTIONS.md` rather than papered over — a super-admin who wants
 * day 5 to restrict sets `softRestrictAfterDays: 5` and needs no deploy,
 * which is the spec's own answer to the question.
 */
export const DEFAULT_INACTIVITY_POLICY: Omit<InactivityPolicyShape, "version"> = {
  isActive: true,
  batchYear: null,
  departmentCode: null,
  nudgeAfterDays: 3,
  warnAfterDays: 5,
  softRestrictAfterDays: 10,
  disableAfterDays: 30,
  autoDisableEnabled: false,
  graceDays: 2,
  countsAsActivity: { submission: true, solve: true, login: false, lesson: true },
  minActivityPerDay: 1,
  excludeNonWorkingDays: true,
  excludeApprovedLeave: true,
  notifyMentor: true,
  notifyParentEmail: false,
};

/** The threshold at which a stage fires, or null when that rung never does. */
export function thresholdFor(policy: InactivityPolicyShape, stage: RestrictionStage): number | null {
  switch (stage) {
    case "NUDGED":
      return policy.nudgeAfterDays;
    case "WARNED":
      return policy.warnAfterDays;
    case "SOFT_RESTRICTED":
      return policy.softRestrictAfterDays;
    case "DISABLED":
      return policy.autoDisableEnabled ? policy.disableAfterDays : null;
    case "NONE":
      return null;
  }
}

/**
 * The highest stage this many counted days reaches.
 *
 * `DISABLED` is unreachable while `autoDisableEnabled` is false — not
 * clamped afterwards but absent from `thresholdFor`, so there is no arithmetic
 * path to it and no code that has to remember to clamp.
 */
export function stageForCountedDays(policy: InactivityPolicyShape, countedDays: number): RestrictionStage {
  let reached: RestrictionStage = "NONE";
  for (const stage of INACTIVITY_STAGES) {
    const days = thresholdFor(policy, stage);
    if (days !== null && countedDays >= days) reached = stage;
  }
  return reached;
}

/** The highest stage this policy can ever reach, whatever the day count. */
export function ceilingStage(policy: InactivityPolicyShape): RestrictionStage {
  let highest: RestrictionStage = "NONE";
  for (const stage of INACTIVITY_STAGES) {
    if (thresholdFor(policy, stage) !== null) highest = stage;
  }
  return highest;
}

export interface PolicyScope {
  readonly batchYear: number | null;
  readonly departmentCode: string | null;
}

/**
 * How specific a policy's scope is: 3 = department and batch, 2 = batch,
 * 1 = department, 0 = global.
 *
 * Batch outranks department deliberately. A whole batch sits the same
 * placement season together, so a batch-wide policy is the one that reflects
 * where those students are in their course; a department-wide one is a
 * standing preference.
 */
export function scopeSpecificity(policy: InactivityPolicyShape): number {
  if (policy.batchYear !== null && policy.departmentCode !== null) return 3;
  if (policy.batchYear !== null) return 2;
  if (policy.departmentCode !== null) return 1;
  return 0;
}

function matchesScope(policy: InactivityPolicyShape, scope: PolicyScope): boolean {
  if (policy.batchYear !== null && policy.batchYear !== scope.batchYear) return false;
  if (policy.departmentCode !== null && policy.departmentCode !== scope.departmentCode) return false;
  return true;
}

/**
 * The one policy that applies to a student: most specific scope first,
 * department+batch > batch > department > global, tie-broken on the highest
 * version.
 *
 * Total, and `null` only when no active policy exists at all — in which case
 * the sweep does nothing, which is the right answer. An engine that invented
 * a default when a college had configured none would be an engine restricting
 * students under rules nobody chose.
 *
 * The version tie-break exists because the table's partial unique index
 * already allows at most one ACTIVE policy per scope; the tie-break is what
 * keeps this function single-valued if that index is ever relaxed, rather
 * than silently depending on row order.
 */
export function resolveInactivityPolicy(
  policies: readonly InactivityPolicyShape[],
  scope: PolicyScope,
): InactivityPolicyShape | null {
  const candidates = policies.filter((policy) => policy.isActive && matchesScope(policy, scope));
  if (candidates.length === 0) return null;
  return candidates.reduce((best, policy) => {
    const bySpecificity = scopeSpecificity(policy) - scopeSpecificity(best);
    if (bySpecificity !== 0) return bySpecificity > 0 ? policy : best;
    return policy.version > best.version ? policy : best;
  });
}
