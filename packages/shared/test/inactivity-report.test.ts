import { describe, expect, it } from "vitest";
import {
  describeSweepMode,
  emptyHeldBy,
  inactivitySweepReportSchema,
  SWEEP_HOLDBACKS,
} from "../src/index";

/**
 * The sweep report as a contract between two packages (Phase 12w).
 *
 * The scheduler writes it to `SchedulerJobStatus.lastReport`; `/super/jobs`
 * parses it and shows a super-admin the figures they decide enforcement
 * from. Neither package imports the other, so the only thing holding the
 * two ends together is this schema — and the two properties that matter
 * are that it accepts what the job really writes, and that it never throws
 * away a row written by an older or newer scheduler than the page.
 */

/** A report as the job writes one today. */
const full = {
  evaluationDay: "2026-11-01",
  ran: true,
  considered: 7,
  wouldEscalate: 0,
  wouldClear: 0,
  held: 7,
  heldBy: { ...emptyHeldBy(), "open-attempt": 4, "assessment-within-72h": 3 },
  adminReview: 1,
  escalated: 0,
  cleared: 0,
  reportOnly: 1,
  reportOnlyPolicies: 1,
  racedAway: 0,
  mentorsNotified: 0,
  contestSubmissionsCancelled: 0,
  calendarIncomplete: true,
  sample: [
    {
      collegeId: "2116231001002",
      stage: "NONE",
      toStage: "NUDGED",
      kind: "hold",
      countedInactiveDays: 8,
      excludedDays: 2,
      holdback: "open-attempt",
      reason: "They are sitting an assessment right now.",
    },
  ],
  failed: false,
};

describe("the stored sweep report", () => {
  it("accepts the report the job writes", () => {
    const parsed = inactivitySweepReportSchema.safeParse(full);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.considered).toBe(7);
      expect(parsed.data.heldBy["open-attempt"]).toBe(4);
      expect(parsed.data.sample[0]?.holdback).toBe("open-attempt");
    }
  });

  it("reads a row written before a field existed, rather than failing on it", () => {
    /**
     * The real case: every `SchedulerJobStatus` row on this database was
     * written before 12w added `reportOnly` and `reportOnlyPolicies`. A
     * page that threw on those rows would show an operator nothing at the
     * moment they most want yesterday's figures.
     */
    const { reportOnly: _a, reportOnlyPolicies: _b, ...old } = full;
    const parsed = inactivitySweepReportSchema.safeParse(old);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.reportOnly).toBe(0);
      expect(parsed.data.reportOnlyPolicies).toBe(0);
    }
  });

  it("keeps a field a newer scheduler added, rather than refusing the row", () => {
    const parsed = inactivitySweepReportSchema.safeParse({ ...full, somethingNewer: 3 });
    expect(parsed.success).toBe(true);
  });

  it("knows every holdback the engine can report", () => {
    // The page lists them by name; a holdback added to the engine and not
    // to the schema would be silently dropped from the report a human
    // reads, which is the one place it has to appear.
    const parsed = inactivitySweepReportSchema.parse({
      ...full,
      heldBy: Object.fromEntries(SWEEP_HOLDBACKS.map((k, i) => [k, i + 1])),
    });
    for (const [i, key] of SWEEP_HOLDBACKS.entries()) {
      expect(parsed.heldBy[key]).toBe(i + 1);
    }
  });
});

describe("what mode a report was produced in", () => {
  it("says the engine only watched, when no policy enforces", () => {
    const mode = describeSweepMode(inactivitySweepReportSchema.parse(full));
    expect(mode.reportOnly).toBe(true);
    expect(mode.wrote).toBe(false);
    expect(mode.line).toMatch(/wrote none of it/i);
  });

  it("says it acted, when it wrote", () => {
    const mode = describeSweepMode(
      inactivitySweepReportSchema.parse({ ...full, reportOnlyPolicies: 0, escalated: 2 }),
    );
    expect(mode.reportOnly).toBe(false);
    expect(mode.wrote).toBe(true);
    expect(mode.line).toMatch(/^Enforcing: /);
  });

  it("tells a mixed night from either pure one, because policies are per cohort", () => {
    const mode = describeSweepMode(
      inactivitySweepReportSchema.parse({ ...full, reportOnlyPolicies: 1, escalated: 1 }),
    );
    expect(mode.line).toMatch(/partly report-only/i);
  });

  it("explains a tick that did not run, instead of showing zeroes as a result", () => {
    // Twenty-three hours of the day the sweep does nothing, and an
    // operator opening the page then must not read "0 considered" as "the
    // engine found nobody".
    const notYet = describeSweepMode(
      inactivitySweepReportSchema.parse({ ...full, ran: false, skipped: "not-the-hour", considered: 0 }),
    );
    expect(notYet.line).toMatch(/02:00/);

    const noPolicy = describeSweepMode(
      inactivitySweepReportSchema.parse({ ...full, ran: false, skipped: "no-active-policy", considered: 0 }),
    );
    expect(noPolicy.line).toMatch(/no policy is live/i);
  });
});
