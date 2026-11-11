import { describe, expect, it } from "vitest";
import {
  MOCK_CLOCK_LIMITS,
  announceAtSeconds,
  dueSectionAnnouncement,
  mockDurationSec,
  mockExpiresAt,
  msRemainingInSection,
  sectionAllowances,
  sectionEndsAt,
  sectionHasEnded,
} from "../src/mock-clock";
import { MOCK_PATTERN_SEEDS } from "../src/mock-pattern";

const START = new Date("2026-10-19T09:00:00.000Z");
const NONE = { extraTimePercent: 0, extraTimeMinutes: 0 };
const min = (m: number) => m * 60;

describe("the paper's duration", () => {
  it("is the sum of its sections", () => {
    expect(mockDurationSec([min(25), min(25), min(40)], NONE)).toBe(min(90));
  });

  it("adds extra time as a percentage of the whole paper", () => {
    expect(mockDurationSec([min(40), min(40)], { extraTimePercent: 25, extraTimeMinutes: 0 })).toBe(min(100));
  });

  it("adds flat extra minutes too", () => {
    expect(mockDurationSec([min(40)], { extraTimePercent: 0, extraTimeMinutes: 10 })).toBe(min(50));
  });

  it("reports the deadline, the duration and what the accommodation added", () => {
    const result = mockExpiresAt(START, [min(40), min(40)], { extraTimePercent: 25, extraTimeMinutes: 5 });
    expect(result.baseDurationSec).toBe(min(80));
    expect(result.durationSec).toBe(min(100) + min(5));
    expect(result.extraSec).toBe(min(25));
    expect(result.expiresAt.toISOString()).toBe("2026-10-19T10:45:00.000Z");
  });

  it("does not re-derive the accommodation arithmetic", () => {
    // One definition of "25% extra time", used by the assessment product and
    // by this one: accommodatedDurationSec() floors the percentage part and
    // then adds whole minutes, in that order.
    expect(mockDurationSec([101], { extraTimePercent: 10, extraTimeMinutes: 1 })).toBe(Math.floor(101 * 1.1) + 60);
  });
});

describe("distributing extra time across sections", () => {
  it("gives every section its own share, not all of it to the last", () => {
    // A candidate granted 25% extra must get 25% more in EVERY section, or
    // the accommodation arrives only once they have already run out of time
    // in the sections that mattered.
    const allowances = sectionAllowances([min(20), min(40)], { extraTimePercent: 25, extraTimeMinutes: 0 });
    expect(allowances.map((a) => a.allowedSec)).toEqual([min(25), min(50)]);
  });

  it("changes nothing without an accommodation", () => {
    const allowances = sectionAllowances([min(25), min(25), min(40)], NONE);
    expect(allowances.map((a) => a.allowedSec)).toEqual([min(25), min(25), min(40)]);
    expect(allowances.map((a) => a.position)).toEqual([1, 2, 3]);
  });

  it("never gives a section less than it declares", () => {
    for (const pattern of MOCK_PATTERN_SEEDS) {
      const limits = pattern.sections.map((s) => s.timeLimitSec);
      for (const terms of [NONE, { extraTimePercent: 25, extraTimeMinutes: 0 }, { extraTimePercent: 0, extraTimeMinutes: 20 }]) {
        for (const allowance of sectionAllowances(limits, terms)) {
          expect(allowance.allowedSec, pattern.slug).toBeGreaterThanOrEqual(allowance.baseSec);
        }
      }
    }
  });

  it("loses not one second of the grant to rounding", () => {
    // 1,350 seconds owed on a 90-minute paper must not become 1,348 because
    // three shares each rounded down.
    for (const pattern of MOCK_PATTERN_SEEDS) {
      const limits = pattern.sections.map((s) => s.timeLimitSec);
      const terms = { extraTimePercent: 17, extraTimeMinutes: 3 };
      const allowances = sectionAllowances(limits, terms);
      const summed = allowances.reduce((sum, a) => sum + a.allowedSec, 0);
      expect(summed, pattern.slug).toBe(mockDurationSec(limits, terms));
    }
  });

  it("puts the remainder on the last section", () => {
    // 10 extra seconds over three equal sections is 3 + 3 + 4.
    const allowances = sectionAllowances([100, 100, 100], { extraTimePercent: 0, extraTimeMinutes: 0 });
    expect(allowances.map((a) => a.allowedSec)).toEqual([100, 100, 100]);
    const withExtra = sectionAllowances([300, 300, 300], { extraTimePercent: 0, extraTimeMinutes: 1 });
    expect(withExtra.map((a) => a.allowedSec - a.baseSec)).toEqual([20, 20, 20]);
  });

  it("handles a paper with no sections without dividing by zero", () => {
    expect(sectionAllowances([], { extraTimePercent: 25, extraTimeMinutes: 0 })).toEqual([]);
  });
});

describe("a section's window", () => {
  const expiresAt = new Date(START.getTime() + min(90) * 1_000);

  it("runs for its allowance when the paper has the time", () => {
    const window = sectionEndsAt({ now: START, allowedSec: min(25), attemptExpiresAt: expiresAt });
    expect(window.endsAt.toISOString()).toBe("2026-10-19T09:25:00.000Z");
    expect(window.cappedByAttempt).toBe(false);
    expect(window.cappedBySec).toBe(0);
  });

  it("is capped by the paper's own deadline, and REPORTS the cap", () => {
    // A candidate entering the last section with four minutes of paper left
    // has a four-minute section, and the header says so instead of showing a
    // twenty-minute clock that will be cut off.
    const now = new Date(expiresAt.getTime() - min(4) * 1_000);
    const window = sectionEndsAt({ now, allowedSec: min(20), attemptExpiresAt: expiresAt });
    expect(window.endsAt.toISOString()).toBe(expiresAt.toISOString());
    expect(window.cappedByAttempt).toBe(true);
    expect(window.cappedBySec).toBe(min(16));
  });

  it("does not report a cap when the two land on the same instant", () => {
    const now = new Date(expiresAt.getTime() - min(20) * 1_000);
    const window = sectionEndsAt({ now, allowedSec: min(20), attemptExpiresAt: expiresAt });
    expect(window.cappedByAttempt).toBe(false);
  });

  it("gives a zero-length section when the paper is already over", () => {
    const window = sectionEndsAt({ now: new Date(expiresAt.getTime() + 1_000), allowedSec: min(20), attemptExpiresAt: expiresAt });
    expect(window.endsAt.toISOString()).toBe(expiresAt.toISOString());
    expect(msRemainingInSection(window.endsAt, new Date(expiresAt.getTime() + 1_000))).toBe(0);
  });
});

describe("the time remaining", () => {
  it("never goes negative", () => {
    const endsAt = new Date(START.getTime() + 1_000);
    expect(msRemainingInSection(endsAt, START)).toBe(1_000);
    expect(msRemainingInSection(endsAt, new Date(START.getTime() + 60_000))).toBe(0);
  });

  it("is zero for a section that has not started", () => {
    expect(msRemainingInSection(null, START)).toBe(0);
  });

  it("knows when a section has ended, and that an unstarted one has not", () => {
    const endsAt = new Date(START.getTime() + 1_000);
    expect(sectionHasEnded(endsAt, START)).toBe(false);
    expect(sectionHasEnded(endsAt, endsAt)).toBe(true);
    expect(sectionHasEnded(null, START)).toBe(false);
  });
});

describe("what the timer says, and when", () => {
  it("speaks at the four moments and no others", () => {
    expect(MOCK_CLOCK_LIMITS.announceSeconds).toEqual([600, 300, 60, 10]);
  });

  it("drops a threshold the section is too short to reach", () => {
    // Announcing "ten minutes remaining" at the start of a ten-minute section
    // is noise; announcing it in a five-minute section is a lie.
    expect(announceAtSeconds(min(25))).toEqual([600, 300, 60, 10]);
    expect(announceAtSeconds(min(10))).toEqual([300, 60, 10]);
    expect(announceAtSeconds(min(5))).toEqual([60, 10]);
    expect(announceAtSeconds(30)).toEqual([10]);
    expect(announceAtSeconds(5)).toEqual([]);
  });

  it("announces each threshold exactly once across a whole section", () => {
    const limitSec = min(25);
    const spoken: number[] = [];
    for (let second = limitSec; second > 0; second--) {
      const due = dueSectionAnnouncement(second * 1_000, (second - 1) * 1_000, limitSec);
      if (due !== null) spoken.push(due);
    }
    expect(spoken).toEqual([600, 300, 60, 10]);
  });

  it("speaks only the MOST urgent threshold a frozen tab crossed", () => {
    // Reading out a stale "ten minutes remaining" is worse than silence.
    expect(dueSectionAnnouncement(min(11) * 1_000, 30_000, min(25))).toBe(60);
    expect(dueSectionAnnouncement(min(11) * 1_000, 5_000, min(25))).toBe(10);
  });

  it("says nothing when the clock has not moved, or has moved backwards", () => {
    // A granted extension moves the deadline out; it must not re-announce.
    expect(dueSectionAnnouncement(60_000, 60_000, min(25))).toBeNull();
    expect(dueSectionAnnouncement(30_000, min(10) * 1_000, min(25))).toBeNull();
  });

  it("says nothing between thresholds", () => {
    expect(dueSectionAnnouncement(400_000, 350_000, min(25))).toBeNull();
  });

  it("polls at five seconds, never 250 milliseconds", () => {
    // SPEC §7. The clock is a server read, and one per candidate per 250 ms
    // across a college is a load nobody budgeted for.
    expect(MOCK_CLOCK_LIMITS.pollMs).toBe(5_000);
  });
});
