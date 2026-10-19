import { describe, expect, it } from "vitest";
import {
  ACCOUNT_STATUS_FOR_STAGE,
  ACTIVITY_SIGNAL_SOURCES,
  AUTO_DISABLE_CONFIRMATION,
  AUTO_DISABLE_FLOOR_DAYS,
  AUTO_DISABLE_FLOOR_REASON,
  AVAILABLE_ACTIVITY_SIGNALS,
  DEFAULT_INACTIVITY_POLICY,
  INACTIVITY_STAGES,
  RESTRICTION_STAGE_ADMIN_LABEL,
  RESTRICTION_STAGE_LABEL,
  canStaffClear,
  ceilingStage,
  countsAsActivitySchema,
  inactivityPolicySchema,
  nextStage,
  previousStage,
  resolveInactivityPolicy,
  scopeSpecificity,
  stageForCountedDays,
  stageIndex,
  stageMovesAccountStatus,
  thresholdFor,
  type InactivityPolicyShape,
} from "../src/inactivity-policy";

const policy = (over: Partial<InactivityPolicyShape> = {}): InactivityPolicyShape => ({
  version: 1,
  ...DEFAULT_INACTIVITY_POLICY,
  ...over,
});

describe("the ladder", () => {
  it("is in escalating order", () => {
    expect(INACTIVITY_STAGES).toEqual(["NONE", "NUDGED", "WARNED", "SOFT_RESTRICTED", "DISABLED"]);
    for (const [i, stage] of INACTIVITY_STAGES.entries()) expect(stageIndex(stage)).toBe(i);
  });

  it("steps one rung at a time, and stops at both ends", () => {
    expect(nextStage("NONE")).toBe("NUDGED");
    expect(nextStage("SOFT_RESTRICTED")).toBe("DISABLED");
    expect(nextStage("DISABLED")).toBeNull();
    expect(previousStage("NUDGED")).toBe("NONE");
    expect(previousStage("NONE")).toBeNull();
  });
});

describe("the copy", () => {
  it("never says 'disabled' to a student, at any rung", () => {
    // The spec: "Keep the word 'disabled' out of student-facing copy." A
    // student who reads it believes they have been thrown off and stops
    // trying, which is the exact outcome a policy about non-progress must
    // not cause. Every one of these states is reversible.
    for (const stage of INACTIVITY_STAGES) {
      expect(RESTRICTION_STAGE_LABEL[stage].toLowerCase(), stage).not.toContain("disabl");
    }
  });

  it("says it plainly in administrative reporting, where no student reads it", () => {
    expect(RESTRICTION_STAGE_ADMIN_LABEL.DISABLED).toBe("Disabled");
  });

  it("has the same rungs in both maps", () => {
    // A rung with an administrative name and no student name is a rung that
    // renders blank on a student's own page.
    expect(Object.keys(RESTRICTION_STAGE_LABEL).sort()).toEqual(Object.keys(RESTRICTION_STAGE_ADMIN_LABEL).sort());
    expect(Object.keys(RESTRICTION_STAGE_LABEL).sort()).toEqual([...INACTIVITY_STAGES].sort());
  });

  it("gives every rung a non-empty label", () => {
    for (const stage of INACTIVITY_STAGES) {
      expect(RESTRICTION_STAGE_LABEL[stage].length, stage).toBeGreaterThan(3);
      expect(RESTRICTION_STAGE_ADMIN_LABEL[stage].length, stage).toBeGreaterThan(2);
    }
  });
});

describe("the account status each stage implies", () => {
  it("leaves a nudge and a warning ACTIVE — they are a message, not a consequence", () => {
    expect(ACCOUNT_STATUS_FOR_STAGE.NONE).toBe("ACTIVE");
    expect(ACCOUNT_STATUS_FOR_STAGE.NUDGED).toBe("ACTIVE");
    expect(ACCOUNT_STATUS_FOR_STAGE.WARNED).toBe("ACTIVE");
  });

  it("maps the two stages that bite to the statuses the rest of the app already reads", () => {
    // contests.ts refuses registration on user.status === "SOFT_RESTRICTED".
    // Without this mapping written down, the restriction bites nothing.
    expect(ACCOUNT_STATUS_FOR_STAGE.SOFT_RESTRICTED).toBe("SOFT_RESTRICTED");
    expect(ACCOUNT_STATUS_FOR_STAGE.DISABLED).toBe("DISABLED");
  });

  it("knows which transitions touch User.status and which do not", () => {
    expect(stageMovesAccountStatus("NONE", "NUDGED")).toBe(false);
    expect(stageMovesAccountStatus("NUDGED", "WARNED")).toBe(false);
    expect(stageMovesAccountStatus("WARNED", "SOFT_RESTRICTED")).toBe(true);
    expect(stageMovesAccountStatus("SOFT_RESTRICTED", "NONE")).toBe(true);
    expect(stageMovesAccountStatus("SOFT_RESTRICTED", "DISABLED")).toBe(true);
  });
});

describe("who may clear what", () => {
  it("lets staff de-escalate a nudge, a warning or a soft restriction", () => {
    expect(canStaffClear("NUDGED")).toBe(true);
    expect(canStaffClear("WARNED")).toBe(true);
    expect(canStaffClear("SOFT_RESTRICTED")).toBe(true);
  });

  it("refuses staff a disabled account — the spec makes that super-admin only", () => {
    expect(canStaffClear("DISABLED")).toBe(false);
  });

  it("has nothing to clear at NONE", () => {
    expect(canStaffClear("NONE")).toBe(false);
  });
});

describe("the activity signals", () => {
  it("names the ActivityDay column for each readable signal", () => {
    expect(ACTIVITY_SIGNAL_SOURCES.submission).toBe("submissions");
    expect(ACTIVITY_SIGNAL_SOURCES.solve).toBe("solved");
  });

  it("records that login and lesson have NO source rather than guessing one", () => {
    // A student is never counted idle because a signal we never collected
    // did not fire. ActivityDay has no login column, and lessons live in the
    // LMS.
    expect(ACTIVITY_SIGNAL_SOURCES.login).toBeNull();
    expect(ACTIVITY_SIGNAL_SOURCES.lesson).toBeNull();
    expect(AVAILABLE_ACTIVITY_SIGNALS).toEqual(["submission", "solve"]);
  });

  it("covers exactly the keys the policy schema accepts", () => {
    const parsed = countsAsActivitySchema.parse(DEFAULT_INACTIVITY_POLICY.countsAsActivity);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(ACTIVITY_SIGNAL_SOURCES).sort());
  });

  it("refuses an unknown signal key", () => {
    expect(
      countsAsActivitySchema.safeParse({ submission: true, solve: true, login: false, lesson: true, vibes: true })
        .success,
    ).toBe(false);
  });
});

describe("the shipped default", () => {
  it("cannot reach DISABLED", () => {
    // SPEC: no account is hard-disabled by a cron job. The switch is off, so
    // there is no arithmetic path to the top rung at all.
    expect(DEFAULT_INACTIVITY_POLICY.autoDisableEnabled).toBe(false);
    expect(stageForCountedDays(policy(), 10_000)).toBe("SOFT_RESTRICTED");
    expect(ceilingStage(policy())).toBe("SOFT_RESTRICTED");
    expect(thresholdFor(policy(), "DISABLED")).toBeNull();
  });

  it("is honest about the college's five-day wish: day 5 is WARNED, not restricted", () => {
    // Recorded in docs/OPEN-QUESTIONS.md rather than papered over. The
    // design's draft claimed day 5 "reads restricted in administrative
    // reporting", which is arithmetically false against its own defaults.
    expect(stageForCountedDays(policy(), 5)).toBe("WARNED");
    expect(RESTRICTION_STAGE_ADMIN_LABEL[stageForCountedDays(policy(), 5)]).toBe("Warned");
  });

  it("reaches each rung on its own threshold and not before", () => {
    expect(stageForCountedDays(policy(), 0)).toBe("NONE");
    expect(stageForCountedDays(policy(), 2)).toBe("NONE");
    expect(stageForCountedDays(policy(), 3)).toBe("NUDGED");
    expect(stageForCountedDays(policy(), 4)).toBe("NUDGED");
    expect(stageForCountedDays(policy(), 5)).toBe("WARNED");
    expect(stageForCountedDays(policy(), 9)).toBe("WARNED");
    expect(stageForCountedDays(policy(), 10)).toBe("SOFT_RESTRICTED");
  });

  it("reaches DISABLED only once a human turns the switch on", () => {
    const on = policy({ autoDisableEnabled: true });
    expect(thresholdFor(on, "DISABLED")).toBe(30);
    expect(stageForCountedDays(on, 29)).toBe("SOFT_RESTRICTED");
    expect(stageForCountedDays(on, 30)).toBe("DISABLED");
    expect(ceilingStage(on)).toBe("DISABLED");
  });

  it("treats a null threshold as a rung that never fires", () => {
    const noNudge = policy({ nudgeAfterDays: null });
    expect(thresholdFor(noNudge, "NUDGED")).toBeNull();
    expect(stageForCountedDays(noNudge, 3)).toBe("NONE");
    expect(stageForCountedDays(noNudge, 5)).toBe("WARNED");
  });

  it("keeps the parent-email switch off, and the schema refuses turning it on", () => {
    expect(DEFAULT_INACTIVITY_POLICY.notifyParentEmail).toBe(false);
    const result = inactivityPolicySchema.safeParse({ ...DEFAULT_INACTIVITY_POLICY, notifyParentEmail: true });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/third-party personal data/);
  });
});

describe("the auto-disable floor is advice, not a constraint", () => {
  it("is a number with copy attached, and a confirmation phrase", () => {
    expect(AUTO_DISABLE_FLOOR_DAYS).toBe(14);
    expect(AUTO_DISABLE_CONFIRMATION).toBe("I ACCEPT THIS THRESHOLD");
    expect(AUTO_DISABLE_FLOOR_REASON).toMatch(/ill/i);
  });

  it("does NOT make the schema refuse a shorter threshold", () => {
    // The spec requires every threshold to be configurable without a deploy.
    // A floor baked into a refusement would make the college's own stated
    // wish unreachable by the one mechanism the spec protects.
    const short = inactivityPolicySchema.safeParse({
      ...DEFAULT_INACTIVITY_POLICY,
      autoDisableEnabled: true,
      disableAfterDays: 5,
      softRestrictAfterDays: 5,
      warnAfterDays: 3,
      nudgeAfterDays: 3,
    });
    expect(short.success).toBe(true);
  });
});

describe("the policy schema mirrors the CHECKs", () => {
  it("accepts the shipped default", () => {
    expect(inactivityPolicySchema.safeParse(DEFAULT_INACTIVITY_POLICY).success).toBe(true);
  });

  it("refuses thresholds that go backwards up the ladder", () => {
    const result = inactivityPolicySchema.safeParse({
      ...DEFAULT_INACTIVITY_POLICY,
      nudgeAfterDays: 10,
      warnAfterDays: 5,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/cannot be sooner than/);
  });

  it("accepts equal thresholds — two rungs on the same day is a choice, not an error", () => {
    expect(
      inactivityPolicySchema.safeParse({
        ...DEFAULT_INACTIVITY_POLICY,
        nudgeAfterDays: 5,
        warnAfterDays: 5,
      }).success,
    ).toBe(true);
  });

  it("skips a null rung when checking the order", () => {
    expect(
      inactivityPolicySchema.safeParse({
        ...DEFAULT_INACTIVITY_POLICY,
        nudgeAfterDays: 3,
        warnAfterDays: null,
        softRestrictAfterDays: 10,
      }).success,
    ).toBe(true);
  });

  it("refuses auto-disable with no threshold to evaluate", () => {
    const result = inactivityPolicySchema.safeParse({
      ...DEFAULT_INACTIVITY_POLICY,
      autoDisableEnabled: true,
      disableAfterDays: null,
    });
    expect(result.success).toBe(false);
  });

  it("bounds grace, the activity floor and the scope", () => {
    expect(inactivityPolicySchema.safeParse({ ...DEFAULT_INACTIVITY_POLICY, graceDays: 31 }).success).toBe(false);
    expect(inactivityPolicySchema.safeParse({ ...DEFAULT_INACTIVITY_POLICY, graceDays: 0 }).success).toBe(true);
    expect(inactivityPolicySchema.safeParse({ ...DEFAULT_INACTIVITY_POLICY, minActivityPerDay: 0 }).success).toBe(false);
    expect(inactivityPolicySchema.safeParse({ ...DEFAULT_INACTIVITY_POLICY, minActivityPerDay: 21 }).success).toBe(
      false,
    );
    expect(inactivityPolicySchema.safeParse({ ...DEFAULT_INACTIVITY_POLICY, departmentCode: "C" }).success).toBe(false);
    expect(inactivityPolicySchema.safeParse({ ...DEFAULT_INACTIVITY_POLICY, departmentCode: "CSE" }).success).toBe(
      true,
    );
  });

  it("refuses a threshold of zero or over a year", () => {
    expect(inactivityPolicySchema.safeParse({ ...DEFAULT_INACTIVITY_POLICY, nudgeAfterDays: 0 }).success).toBe(false);
    expect(inactivityPolicySchema.safeParse({ ...DEFAULT_INACTIVITY_POLICY, disableAfterDays: 366 }).success).toBe(
      false,
    );
  });

  it("refuses an unknown field", () => {
    expect(inactivityPolicySchema.safeParse({ ...DEFAULT_INACTIVITY_POLICY, severity: "high" }).success).toBe(false);
  });
});

describe("resolving which policy applies", () => {
  const global = policy({ version: 1 });
  const dept = policy({ version: 2, departmentCode: "CSE" });
  const batch = policy({ version: 3, batchYear: 2027 });
  const both = policy({ version: 4, batchYear: 2027, departmentCode: "CSE" });
  const scope = { batchYear: 2027, departmentCode: "CSE" };

  it("scores specificity department+batch > batch > department > global", () => {
    expect(scopeSpecificity(both)).toBe(3);
    expect(scopeSpecificity(batch)).toBe(2);
    expect(scopeSpecificity(dept)).toBe(1);
    expect(scopeSpecificity(global)).toBe(0);
  });

  it("picks the most specific match", () => {
    expect(resolveInactivityPolicy([global, dept, batch, both], scope)?.version).toBe(4);
    expect(resolveInactivityPolicy([global, dept, batch], scope)?.version).toBe(3);
    expect(resolveInactivityPolicy([global, dept], scope)?.version).toBe(2);
    expect(resolveInactivityPolicy([global], scope)?.version).toBe(1);
  });

  it("does not care what order the rows arrive in", () => {
    const shuffled = [both, global, batch, dept];
    expect(resolveInactivityPolicy(shuffled, scope)?.version).toBe(4);
    expect(resolveInactivityPolicy([...shuffled].reverse(), scope)?.version).toBe(4);
  });

  it("ignores a policy scoped to somebody else", () => {
    const other = policy({ version: 9, batchYear: 2026, departmentCode: "ECE" });
    expect(resolveInactivityPolicy([global, other], scope)?.version).toBe(1);
    expect(resolveInactivityPolicy([other], scope)).toBeNull();
  });

  it("ignores an inactive policy however specific it is", () => {
    const retired = policy({ version: 9, batchYear: 2027, departmentCode: "CSE", isActive: false });
    expect(resolveInactivityPolicy([global, retired], scope)?.version).toBe(1);
  });

  it("breaks a same-scope tie on the highest version", () => {
    // The table's partial unique index already allows one active policy per
    // scope; this keeps the function single-valued if that is ever relaxed,
    // rather than silently depending on row order.
    const older = policy({ version: 5, batchYear: 2027 });
    const newer = policy({ version: 11, batchYear: 2027 });
    expect(resolveInactivityPolicy([older, newer], scope)?.version).toBe(11);
    expect(resolveInactivityPolicy([newer, older], scope)?.version).toBe(11);
  });

  it("returns null when nothing is active at all, so the sweep does nothing", () => {
    // An engine that invented a default where a college configured none
    // would be an engine restricting students under rules nobody chose.
    expect(resolveInactivityPolicy([], scope)).toBeNull();
    expect(resolveInactivityPolicy([policy({ isActive: false })], scope)).toBeNull();
  });

  it("matches a global policy for a student with no cohort recorded", () => {
    expect(resolveInactivityPolicy([global, batch], { batchYear: null, departmentCode: null })?.version).toBe(1);
  });

  it("does not let a batch policy catch a student whose batch is unknown", () => {
    expect(resolveInactivityPolicy([batch], { batchYear: null, departmentCode: "CSE" })).toBeNull();
  });
});
