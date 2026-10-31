import { describe, expect, it } from "vitest";
import { calendarLookup, daysInclusive, type CalendarDayRow, type LeaveRow } from "../src/calendar";
import { DEFAULT_INACTIVITY_POLICY, type InactivityPolicyShape } from "../src/inactivity-policy";
import {
  CANCELLED_LANES_ON_RESTRICT,
  REQUIRED_EVIDENCE_KEYS,
  RESTRICTION_EFFECTS,
  SELF_CLEAR_PER_TERM,
  SWEEP_HOLDBACKS,
  SWEEP_HOLDBACK_REASON,
  activityOn,
  buildInactivityEvidence,
  canSelfClear,
  countInactiveDays,
  dormancyChip,
  inactivityEvidenceSchema,
  planStageTransition,
  selfClearCounters,
  sweepHoldback,
  type ActivityDayRow,
  type InactivityCount,
} from "../src/inactivity";

const policy = (over: Partial<InactivityPolicyShape> = {}): InactivityPolicyShape => ({
  version: 7,
  ...DEFAULT_INACTIVITY_POLICY,
  ...over,
});

/** October 2026 as regular working days, with overrides. */
function october(overrides: Record<string, Partial<CalendarDayRow>> = {}) {
  return calendarLookup(
    daysInclusive("2026-09-25", "2026-11-05").map((date) => ({
      date,
      kind: "REGULAR" as const,
      isWorkingDay: true,
      ...overrides[date],
    })),
  );
}

const leave = (over: Partial<LeaveRow> & { startDate: string; endDate: string }): LeaveRow => ({
  id: "l1",
  kind: "MEDICAL",
  status: "APPROVED",
  ...over,
});

const active = (day: string, submissions = 1, solved = 0): ActivityDayRow => ({ day, submissions, solved });

const count = (over: Partial<Parameters<typeof countInactiveDays>[0]> = {}) =>
  countInactiveDays({
    lastActiveDay: "2026-10-01",
    evaluationDay: "2026-10-11",
    cal: october(),
    leaves: [],
    activity: [],
    policy: policy(),
    windowStartDay: "2026-09-25",
    ...over,
  });

describe("activityOn", () => {
  it("sums the signals the policy has switched on", () => {
    const counts = { submission: true, solve: true, login: false, lesson: true };
    expect(activityOn(active("2026-10-02", 2, 1), counts)).toBe(3);
  });

  it("drops a signal the policy has switched off", () => {
    expect(activityOn(active("2026-10-02", 2, 1), { submission: false, solve: true, login: false, lesson: true })).toBe(
      1,
    );
  });

  it("counts nothing for login or lesson even when they are on — there is no source", () => {
    // Not a policy decision: ActivityDay has no login column, and lessons
    // live in the LMS. The keys are accepted and ignored, and the evidence
    // records that they were unavailable.
    expect(activityOn(active("2026-10-02", 0, 0), { submission: true, solve: true, login: true, lesson: true })).toBe(0);
  });
});

describe("the window", () => {
  it("excludes the last active day and includes the evaluation day", () => {
    // They worked on the 1st, so the 1st is not held against them; the 11th
    // is over as far as an 02:00 sweep is concerned.
    const result = count({ lastActiveDay: "2026-10-01", evaluationDay: "2026-10-11" });
    expect(result.calendarDaysElapsed).toBe(10);
    expect(result.countedInactiveDays).toBe(10);
    expect(result.lastCountedDay).toBe("2026-10-11");
  });

  it("counts nothing when the student was active today", () => {
    const result = count({ lastActiveDay: "2026-10-11", evaluationDay: "2026-10-11" });
    expect(result).toMatchObject({ countedInactiveDays: 0, calendarDaysElapsed: 0, lastCountedDay: null });
  });

  it("counts nothing when the last active day is somehow in the future", () => {
    const result = count({ lastActiveDay: "2026-10-20", evaluationDay: "2026-10-11" });
    expect(result.countedInactiveDays).toBe(0);
  });

  it("falls back to the window start for a student who has never been active", () => {
    // Counting from enrolment would hand a first-year a hundred inactive days
    // on the morning the policy switched on.
    const result = count({ lastActiveDay: null, windowStartDay: "2026-10-06", evaluationDay: "2026-10-11" });
    expect(result.countedInactiveDays).toBe(5);
  });
});

describe("what is excluded, and why", () => {
  it("skips holidays, exam weeks, breaks and placement weeks", () => {
    const cal = october({
      "2026-10-02": { kind: "HOLIDAY", isWorkingDay: false },
      "2026-10-03": { kind: "EXAM_WEEK" },
      "2026-10-05": { kind: "SEMESTER_BREAK", isWorkingDay: false },
      "2026-10-06": { kind: "PLACEMENT_WEEK" },
    });
    const result = count({ cal });
    expect(result.countedInactiveDays).toBe(6);
    expect(result.excludedDates).toEqual(["2026-10-02", "2026-10-03", "2026-10-05", "2026-10-06"]);
    expect(result.excludedReason).toEqual(["HOLIDAY", "EXAM_WEEK", "SEMESTER_BREAK", "PLACEMENT_WEEK"]);
  });

  it("skips non-working days only while the toggle is on", () => {
    const cal = october({ "2026-10-04": { isWorkingDay: false }, "2026-10-11": { isWorkingDay: false } });
    expect(count({ cal }).countedInactiveDays).toBe(8);
    expect(count({ cal, policy: policy({ excludeNonWorkingDays: false }) }).countedInactiveDays).toBe(10);
  });

  it("skips a day the student worked, at or above the floor", () => {
    const result = count({ activity: [active("2026-10-05", 1), active("2026-10-07", 3)] });
    expect(result.countedInactiveDays).toBe(8);
    expect(result.excludedReason).toEqual(["ACTIVE", "ACTIVE"]);
  });

  it("COUNTS a day whose activity is below the floor", () => {
    // The boundary that matters: a student who opened one problem is not
    // thereby un-idle if the college asked for more than that.
    const strict = policy({ minActivityPerDay: 3 });
    const result = count({ policy: strict, activity: [active("2026-10-05", 2, 0)] });
    expect(result.countedInactiveDays).toBe(10);
    expect(result.excludedDates).toEqual([]);
  });

  it("skips a day exactly at the floor", () => {
    const strict = policy({ minActivityPerDay: 3 });
    const result = count({ policy: strict, activity: [active("2026-10-05", 2, 1)] });
    expect(result.countedInactiveDays).toBe(9);
  });

  it("skips days covered by an approved leave, only while the toggle is on", () => {
    const leaves = [leave({ startDate: "2026-10-03", endDate: "2026-10-07" })];
    expect(count({ leaves }).countedInactiveDays).toBe(5);
    expect(count({ leaves, policy: policy({ excludeApprovedLeave: false }) }).countedInactiveDays).toBe(10);
  });

  it("ignores a leave that is only REQUESTED", () => {
    const leaves = [leave({ startDate: "2026-10-03", endDate: "2026-10-07", status: "REQUESTED" })];
    expect(count({ leaves }).countedInactiveDays).toBe(10);
  });

  it("clips a leave that only half-covers the window", () => {
    const leaves = [leave({ startDate: "2026-09-20", endDate: "2026-10-05" })];
    const result = count({ leaves });
    expect(result.excludedDates).toEqual(["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(result.countedInactiveDays).toBe(6);
  });

  it("excludes a holiday inside a leave range ONCE, with one reason", () => {
    const cal = october({ "2026-10-04": { kind: "HOLIDAY", isWorkingDay: false } });
    const leaves = [leave({ startDate: "2026-10-03", endDate: "2026-10-05" })];
    const result = count({ cal, leaves });
    expect(result.excludedDates).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(result.excludedReason).toEqual(["MEDICAL_LEAVE", "HOLIDAY", "MEDICAL_LEAVE"]);
    expect(result.excludedDates.filter((d) => d === "2026-10-04")).toHaveLength(1);
    expect(result.countedInactiveDays).toBe(7);
  });

  it("keeps the two evidence arrays the same length, always", () => {
    const result = count({
      cal: october({ "2026-10-02": { kind: "HOLIDAY", isWorkingDay: false }, "2026-10-04": { isWorkingDay: false } }),
      leaves: [leave({ startDate: "2026-10-06", endDate: "2026-10-08" })],
      activity: [active("2026-10-10")],
    });
    expect(result.excludedDates).toHaveLength(result.excludedReason.length);
    expect(result.excludedDates).toEqual([...result.excludedDates].sort());
  });

  it("counts a whole quiet fortnight with nothing excluded", () => {
    const result = count({ lastActiveDay: "2026-10-01", evaluationDay: "2026-10-15" });
    expect(result).toMatchObject({ countedInactiveDays: 14, excludedDates: [], excludedReason: [] });
  });
});

describe("an incomplete calendar", () => {
  it("is reported, and every unentered day still counts", () => {
    // The harshest reading, which is exactly why nothing may escalate on it.
    const sparse = calendarLookup([{ date: "2026-10-02", kind: "REGULAR", isWorkingDay: true }]);
    const result = count({ cal: sparse });
    expect(result.calendarIncomplete).toBe(true);
    expect(result.countedInactiveDays).toBe(10);
  });

  it("is false when the window is covered", () => {
    expect(count().calendarIncomplete).toBe(false);
  });

  it("is false for an empty window", () => {
    expect(count({ lastActiveDay: "2026-10-11", cal: calendarLookup([]) }).calendarIncomplete).toBe(false);
  });
});

describe("the evidence", () => {
  const made = () =>
    buildInactivityEvidence({
      lastActiveAt: new Date("2026-10-01T04:30:00.000Z"),
      count: count({ cal: october({ "2026-10-04": { kind: "HOLIDAY", isWorkingDay: false } }) }),
      policy: policy(),
      toStage: "SOFT_RESTRICTED",
      evaluatedAt: new Date("2026-10-11T20:30:00.000Z"),
    });

  it("satisfies its own schema", () => {
    expect(inactivityEvidenceSchema.safeParse(made()).success).toBe(true);
  });

  it("carries every key the database CHECK requires", () => {
    const evidence = made() as Record<string, unknown>;
    for (const key of REQUIRED_EVIDENCE_KEYS) expect(evidence, key).toHaveProperty(key);
  });

  it("names the threshold the stage it reached actually fires at", () => {
    expect(made().thresholdDays).toBe(10);
  });

  it("records a null threshold for a stage the policy never reaches", () => {
    const evidence = buildInactivityEvidence({
      lastActiveAt: null,
      count: count(),
      policy: policy(),
      toStage: "DISABLED",
      evaluatedAt: new Date("2026-10-11T20:30:00.000Z"),
    });
    // autoDisableEnabled is false, so DISABLED has no threshold at all.
    expect(evidence.thresholdDays).toBeNull();
    expect(evidence.lastActiveAt).toBeNull();
  });

  it("says that login and lesson were unavailable, rather than that they were silent", () => {
    expect(made().loginSignalAvailable).toBe(false);
    expect(made().lessonSignalAvailable).toBe(false);
  });

  it("keeps the dates and reasons it was counted from", () => {
    const evidence = made();
    expect(evidence.excludedDates).toEqual(["2026-10-04"]);
    expect(evidence.excludedReason).toEqual(["HOLIDAY"]);
    expect(evidence.countedInactiveDays).toBe(9);
    expect(evidence.calendarDaysElapsed).toBe(10);
  });

  it("refuses an unknown key, so the shape cannot drift silently", () => {
    expect(inactivityEvidenceSchema.safeParse({ ...made(), mood: "bleak" }).success).toBe(false);
  });

  it("refuses a missing key", () => {
    const { thresholdDays: _dropped, ...rest } = made();
    expect(inactivityEvidenceSchema.safeParse(rest).success).toBe(false);
  });
});

describe("the holdbacks", () => {
  const none = {
    hasOpenAttempt: false,
    hasPendingAppeal: false,
    hasAssessmentWithin72h: false,
    calendarIncomplete: false,
    hasPolicy: true,
  };

  it("is null when nothing holds the student back", () => {
    expect(sweepHoldback(none)).toBeNull();
  });

  it.each([
    ["no-policy", { hasPolicy: false }],
    ["open-attempt", { hasOpenAttempt: true }],
    ["pending-appeal", { hasPendingAppeal: true }],
    ["assessment-within-72h", { hasAssessmentWithin72h: true }],
    ["calendar-incomplete", { calendarIncomplete: true }],
  ])("reports %s", (expected, over) => {
    expect(sweepHoldback({ ...none, ...over })).toBe(expected);
  });

  it("reports the most useful reason when several apply", () => {
    // "They are sitting an exam" is more use to an administrator than "the
    // calendar is incomplete", even when both are true.
    expect(sweepHoldback({ ...none, hasOpenAttempt: true, calendarIncomplete: true })).toBe("open-attempt");
  });

  it("gives every holdback a sentence", () => {
    for (const key of SWEEP_HOLDBACKS) expect(SWEEP_HOLDBACK_REASON[key].length).toBeGreaterThan(10);
  });
});

describe("planning one transition", () => {
  const NOW = new Date("2026-10-11T20:30:00.000Z");
  const plan = (over: Partial<Parameters<typeof planStageTransition>[0]> = {}) =>
    planStageTransition({
      stage: "NONE",
      count: { ...count(), countedInactiveDays: 3 } as InactivityCount,
      policy: policy(),
      holdback: null,
      notifiedAt: null,
      graceEndsAt: null,
      now: NOW,
      ...over,
    });

  const at = (days: number): InactivityCount => ({ ...count(), countedInactiveDays: days });

  it("escalates exactly one rung, even when the day count has passed several", () => {
    // 12 days deserves SOFT_RESTRICTED, but NONE may only reach NUDGED today.
    const result = plan({ stage: "NONE", count: at(12) });
    expect(result).toMatchObject({ kind: "escalate", toStage: "NUDGED" });
  });

  it("walks the ladder one rung per run", () => {
    expect(plan({ stage: "NUDGED", count: at(12) }).toStage).toBe("WARNED");
    expect(plan({ stage: "WARNED", count: at(12) }).toStage).toBe("SOFT_RESTRICTED");
  });

  it("holds at SOFT_RESTRICTED and raises a review when auto-disable is off", () => {
    const result = plan({ stage: "SOFT_RESTRICTED", count: at(40) });
    expect(result).toMatchObject({ kind: "hold", toStage: "SOFT_RESTRICTED", raisesAdminReview: true });
  });

  it("reaches DISABLED only once a human has turned the switch on", () => {
    const on = policy({ autoDisableEnabled: true });
    const result = plan({ stage: "SOFT_RESTRICTED", count: at(40), policy: on });
    expect(result).toMatchObject({ kind: "escalate", toStage: "DISABLED", raisesAdminReview: false });
  });

  it("holds when nothing has changed", () => {
    expect(plan({ stage: "NUDGED", count: at(3) })).toMatchObject({ kind: "hold", toStage: "NUDGED" });
  });

  it("holds below the first threshold", () => {
    expect(plan({ stage: "NONE", count: at(2) })).toMatchObject({ kind: "hold", toStage: "NONE" });
  });

  it("clears when the student is active again, whatever rung they were on", () => {
    for (const stage of ["NUDGED", "WARNED", "SOFT_RESTRICTED"] as const) {
      expect(plan({ stage, count: at(0) }), stage).toMatchObject({ kind: "clear", toStage: "NONE" });
    }
  });

  it("clears even while a holdback applies — a restoration is not a penalty", () => {
    // A student who has started working again must not stay paused because
    // their exam is on Thursday.
    const result = plan({ stage: "SOFT_RESTRICTED", count: at(0), holdback: "assessment-within-72h" });
    expect(result).toMatchObject({ kind: "clear", toStage: "NONE" });
  });

  it("holds for every holdback rather than escalating", () => {
    for (const holdback of SWEEP_HOLDBACKS) {
      const result = plan({ stage: "NONE", count: at(12), holdback });
      expect(result, holdback).toMatchObject({ kind: "hold", toStage: "NONE", holdback });
      expect(result.reason, holdback).toBe(SWEEP_HOLDBACK_REASON[holdback]);
    }
  });

  it("raises a review when the calendar is the thing holding it back", () => {
    expect(plan({ stage: "NONE", count: at(12), holdback: "calendar-incomplete" }).raisesAdminReview).toBe(true);
  });

  it("holds inside the grace period once the student has been told", () => {
    const result = plan({
      stage: "NUDGED",
      count: at(12),
      notifiedAt: new Date("2026-10-11T02:00:00.000Z"),
      graceEndsAt: new Date("2026-10-13T02:00:00.000Z"),
    });
    expect(result).toMatchObject({ kind: "hold", toStage: "NUDGED" });
    expect(result.reason).toMatch(/grace/);
  });

  it("escalates once the grace period has run out", () => {
    const result = plan({
      stage: "NUDGED",
      count: at(12),
      notifiedAt: new Date("2026-10-08T02:00:00.000Z"),
      graceEndsAt: new Date("2026-10-10T02:00:00.000Z"),
    });
    expect(result).toMatchObject({ kind: "escalate", toStage: "WARNED" });
  });

  it("does NOT sit out a grace period the student was never told about", () => {
    // Grace is keyed on notifiedAt, not on the stage: a student who was never
    // told has had no chance to act, so the clock has not started for them.
    const result = plan({
      stage: "NUDGED",
      count: at(12),
      notifiedAt: null,
      graceEndsAt: new Date("2026-10-13T02:00:00.000Z"),
    });
    expect(result).toMatchObject({ kind: "escalate", toStage: "WARNED" });
  });

  it("sets the next grace window from the policy", () => {
    const result = plan({ stage: "NONE", count: at(12) });
    expect(result.graceEndsAt?.getTime()).toBe(NOW.getTime() + 2 * 86_400_000);
  });

  it("holds at the ceiling of a policy whose upper rungs are null", () => {
    const short = policy({ softRestrictAfterDays: null, disableAfterDays: null });
    expect(plan({ stage: "WARNED", count: at(99), policy: short })).toMatchObject({
      kind: "hold",
      toStage: "WARNED",
      raisesAdminReview: false,
    });
  });

  it("never escalates past what the day count deserves", () => {
    // 5 days deserves WARNED. A student already WARNED stays there, rather
    // than stepping to SOFT_RESTRICTED because a run happened.
    expect(plan({ stage: "WARNED", count: at(5) })).toMatchObject({ kind: "hold", toStage: "WARNED" });
  });
});

describe("what a restriction does", () => {
  it("blocks the four things the spec lists, and names a mechanism for each", () => {
    expect(RESTRICTION_EFFECTS.blocks.map((e) => e.key)).toEqual([
      "contest-registration",
      "leaderboard-visibility",
      "xp-accrual",
      "rewards",
    ]);
  });

  it("does not block signing in, reading, solving or a scheduled assessment", () => {
    const keys = RESTRICTION_EFFECTS.doesNotBlock.map((e) => e.key);
    expect(keys).toContain("sign-in");
    expect(keys).toContain("read-problems");
    expect(keys).toContain("solve");
    expect(keys).toContain("scheduled-assessment");
  });

  it("keeps a student's own integrity report and their leave form reachable", () => {
    // Both are routes OUT. A route out that is behind the restriction is not
    // a route out.
    const keys = RESTRICTION_EFFECTS.doesNotBlock.map((e) => e.key);
    expect(keys).toContain("own-integrity-report");
    expect(keys).toContain("ask-for-leave");
  });

  it("gives every effect a sentence a student could read", () => {
    for (const effect of [...RESTRICTION_EFFECTS.blocks, ...RESTRICTION_EFFECTS.doesNotBlock]) {
      expect(effect.says.length, effect.key).toBeGreaterThan(10);
      expect(effect.says.toLowerCase(), effect.key).not.toContain("disabl");
    }
  });

  it("cancels the contest lane and nothing else", () => {
    // Practice is not a locked lane, and a practice solve is the documented
    // way out of the restriction.
    expect(CANCELLED_LANES_ON_RESTRICT).toEqual(["CONTEST"]);
  });
});

describe("self-service clearing", () => {
  const base = { stage: "SOFT_RESTRICTED" as const, selfClearedCount: 0, selfClearedTermKey: null, termKey: "AY2026" };

  it("allows a first clear with no approval at all", () => {
    expect(canSelfClear(base).allowed).toBe(true);
  });

  it("refuses a second clear in the same term, and says what else works", () => {
    const used = { ...base, selfClearedCount: SELF_CLEAR_PER_TERM, selfClearedTermKey: "AY2026" };
    const result = canSelfClear(used);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/Solving one problem/);
  });

  it("allows a clear again in a NEW term", () => {
    const used = { ...base, selfClearedCount: 1, selfClearedTermKey: "AY2025" };
    expect(canSelfClear(used).allowed).toBe(true);
  });

  it("refuses a disabled account, and points at a human", () => {
    const result = canSelfClear({ ...base, stage: "DISABLED" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/placement cell/);
  });

  it("has nothing to clear at NONE", () => {
    expect(canSelfClear({ ...base, stage: "NONE" }).allowed).toBe(false);
  });

  it("counts from one in a new term rather than carrying the old count", () => {
    expect(selfClearCounters({ ...base, selfClearedCount: 1, selfClearedTermKey: "AY2025" })).toEqual({
      selfClearedCount: 1,
      selfClearedTermKey: "AY2026",
    });
    expect(selfClearCounters(base)).toEqual({ selfClearedCount: 1, selfClearedTermKey: "AY2026" });
  });
});

describe("the dormancy chip", () => {
  it("is hidden for a student with nothing counting", () => {
    expect(dormancyChip({ stage: "NONE", countedInactiveDays: 0, policy: policy() }).show).toBe(false);
  });

  it("is hidden when no policy applies", () => {
    expect(dormancyChip({ stage: "NUDGED", countedInactiveDays: 4, policy: null }).show).toBe(false);
  });

  it("carries the whole sentence, and the way out", () => {
    const chip = dormancyChip({ stage: "NUDGED", countedInactiveDays: 3, policy: policy() });
    expect(chip.show).toBe(true);
    expect(chip.label).toBe("3 of 5 inactive days counted. Solve one problem to reset it.");
    expect(chip.nextStageAtDays).toBe(5);
  });

  it("says a paused account can be restored without anybody's approval", () => {
    const chip = dormancyChip({ stage: "SOFT_RESTRICTED", countedInactiveDays: 11, policy: policy() });
    expect(chip.tone).toBe("danger");
    expect(chip.label).toMatch(/nobody needs to approve that/);
  });

  it("never says 'disabled' to a student", () => {
    for (const stage of ["NONE", "NUDGED", "WARNED", "SOFT_RESTRICTED", "DISABLED"] as const) {
      const chip = dormancyChip({ stage, countedInactiveDays: 40, policy: policy() });
      expect(chip.label.toLowerCase(), stage).not.toContain("disabl");
    }
  });

  it("gets the singular right", () => {
    const chip = dormancyChip({ stage: "NUDGED", countedInactiveDays: 1, policy: policy() });
    expect(chip.label).toBe("1 of 5 inactive day counted. Solve one problem to reset it.");
  });

  it("drops the target when there is no rung above", () => {
    const chip = dormancyChip({ stage: "WARNED", countedInactiveDays: 6, policy: policy({ softRestrictAfterDays: null }) });
    expect(chip.nextStageAtDays).toBeNull();
    expect(chip.label).toBe("6 inactive days counted. Solve one problem to reset it.");
  });
});
