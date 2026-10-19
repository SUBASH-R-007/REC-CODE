import { describe, expect, it } from "vitest";
import {
  applyDailyCaps,
  aptitudeXp,
  MOCK_PERCENTILE_MIN_ATTEMPTS,
  mockXp,
  solveXp,
  XP_KEYS,
  XP_RULES,
  type SolveXpInput,
} from "../src/xp";

const solve = (patch: Partial<SolveXpInput>): number =>
  solveXp({ difficulty: "EASY", firstSolve: true, assisted: false, dailyChallenge: false, revision: false, ...patch });

describe("solveXp", () => {
  it("pays 50 / 120 / 250 for a first solve", () => {
    expect(solve({ difficulty: "EASY" })).toBe(50);
    expect(solve({ difficulty: "MEDIUM" })).toBe(120);
    expect(solve({ difficulty: "HARD" })).toBe(250);
  });

  it("doubles the daily challenge", () => {
    expect(solve({ difficulty: "EASY", dailyChallenge: true })).toBe(100);
    expect(solve({ difficulty: "HARD", dailyChallenge: true })).toBe(500);
  });

  it("pays 40% for an assisted solve (after a tier-3 hint or the editorial)", () => {
    expect(solve({ difficulty: "EASY", assisted: true })).toBe(20);
    expect(solve({ difficulty: "MEDIUM", assisted: true })).toBe(48);
    expect(solve({ difficulty: "HARD", assisted: true })).toBe(100);
  });

  it("stacks daily and assisted multipliers", () => {
    expect(solve({ difficulty: "HARD", assisted: true, dailyChallenge: true })).toBe(200);
  });

  it("pays nothing for a repeat solve", () => {
    for (const difficulty of ["EASY", "MEDIUM", "HARD"] as const) {
      expect(solve({ difficulty, firstSolve: false })).toBe(0);
      expect(solve({ difficulty, firstSolve: false, dailyChallenge: true, assisted: true })).toBe(0);
    }
    expect(XP_RULES.repeatSolve).toBe(0);
  });

  it("pays 25% (rounded) for a due revision re-solve", () => {
    expect(solve({ difficulty: "EASY", firstSolve: false, revision: true })).toBe(13);
    expect(solve({ difficulty: "MEDIUM", firstSolve: false, revision: true })).toBe(30);
    expect(solve({ difficulty: "HARD", firstSolve: false, revision: true })).toBe(63);
  });
});

describe("applyDailyCaps", () => {
  it("caps Easy XP at 600 a day", () => {
    expect(XP_RULES.caps.easyPerDay).toBe(600);
    expect(applyDailyCaps({ amount: 100, isEasy: true, earnedTodayTotal: 550, earnedTodayEasy: 550 })).toBe(50);
    expect(applyDailyCaps({ amount: 50, isEasy: true, earnedTodayTotal: 600, earnedTodayEasy: 600 })).toBe(0);
  });

  it("does not apply the Easy cap to Medium and Hard", () => {
    expect(applyDailyCaps({ amount: 250, isEasy: false, earnedTodayTotal: 600, earnedTodayEasy: 600 })).toBe(250);
  });

  it("caps total XP at 2000 a day", () => {
    expect(XP_RULES.caps.totalPerDay).toBe(2000);
    expect(applyDailyCaps({ amount: 250, isEasy: false, earnedTodayTotal: 1900, earnedTodayEasy: 0 })).toBe(100);
    expect(applyDailyCaps({ amount: 250, isEasy: false, earnedTodayTotal: 2000, earnedTodayEasy: 0 })).toBe(0);
  });

  it("applies whichever cap is tighter", () => {
    expect(applyDailyCaps({ amount: 100, isEasy: true, earnedTodayTotal: 1990, earnedTodayEasy: 100 })).toBe(10);
    expect(applyDailyCaps({ amount: 100, isEasy: true, earnedTodayTotal: 700, earnedTodayEasy: 580 })).toBe(20);
  });

  it("passes awards under both caps through unchanged and never goes negative", () => {
    expect(applyDailyCaps({ amount: 120, isEasy: false, earnedTodayTotal: 0, earnedTodayEasy: 0 })).toBe(120);
    expect(applyDailyCaps({ amount: 50, isEasy: true, earnedTodayTotal: 5000, earnedTodayEasy: 5000 })).toBe(0);
    expect(applyDailyCaps({ amount: -10, isEasy: false, earnedTodayTotal: 0, earnedTodayEasy: 0 })).toBe(0);
  });
});

// ── Aptitude and mock XP (Phase 7) ──────────────────────────────────────

describe("XP keys", () => {
  it("pays topic practice once per question, ever", () => {
    // A re-sit cannot farm it: XpEvent.idempotencyKey is unique, so the
    // ledger itself is the enforcement rather than a check in an action.
    expect(XP_KEYS.aptitude("u1", "q1")).toBe("aptitude:u1:q1");
    expect(XP_KEYS.aptitude("u1", "q2")).not.toBe(XP_KEYS.aptitude("u1", "q1"));
  });

  it("pays a mock once per sitting, idempotent under a retried finalise", () => {
    expect(XP_KEYS.mock("ma1")).toBe("mock:ma1");
  });
});

describe("aptitudeXp", () => {
  it("pays nothing for a wrong answer", () => {
    expect(aptitudeXp({ correct: false, alreadyPaidForQuestion: false, awardedToday: 0 })).toEqual({
      xp: 0,
      cappedBy: "none",
    });
  });

  it("pays the per-correct rate for a first correct answer", () => {
    expect(aptitudeXp({ correct: true, alreadyPaidForQuestion: false, awardedToday: 0 }).xp).toBe(
      XP_RULES.aptitude.perCorrect,
    );
  });

  it("pays nothing the second time the same question is answered correctly", () => {
    const result = aptitudeXp({ correct: true, alreadyPaidForQuestion: true, awardedToday: 0 });
    expect(result).toEqual({ xp: 0, cappedBy: "already_paid" });
  });

  it("stops at the daily cap, and says so", () => {
    const nearly = XP_RULES.aptitude.dailyCap - 4;
    const result = aptitudeXp({ correct: true, alreadyPaidForQuestion: false, awardedToday: nearly });
    expect(result.xp).toBe(4);
    expect(result.cappedBy).toBe("daily_cap");
  });

  it("pays nothing once the cap is reached", () => {
    expect(aptitudeXp({ correct: true, alreadyPaidForQuestion: false, awardedToday: XP_RULES.aptitude.dailyCap }).xp).toBe(0);
  });

  it("never pays a negative amount, even from a corrupt running total", () => {
    expect(aptitudeXp({ correct: true, alreadyPaidForQuestion: false, awardedToday: 10_000 }).xp).toBe(0);
    expect(aptitudeXp({ correct: true, alreadyPaidForQuestion: false, awardedToday: -50 }).xp).toBe(
      XP_RULES.aptitude.perCorrect,
    );
  });
});

describe("mockXp", () => {
  it("pays the base for a finalised sitting whatever the score", () => {
    // Sitting a full mock honestly is the behaviour the phase wants, and a
    // candidate who scores badly learns the most from it.
    expect(mockXp({ percent: 4, medianPercent: null, finalizedAttemptCount: 0 })).toEqual({
      xp: XP_RULES.mock.base,
      percentileCounted: false,
      aboveMedian: 0,
    });
  });

  it("ignores the percentile term until the pattern has a cohort", () => {
    // A percentile over four attempts is noise, and an XpEvent is permanent.
    const result = mockXp({ percent: 90, medianPercent: 50, finalizedAttemptCount: MOCK_PERCENTILE_MIN_ATTEMPTS - 1 });
    expect(result.xp).toBe(XP_RULES.mock.base);
    expect(result.percentileCounted).toBe(false);
  });

  it("adds the percentile term once the cohort is big enough", () => {
    const result = mockXp({ percent: 90, medianPercent: 50, finalizedAttemptCount: MOCK_PERCENTILE_MIN_ATTEMPTS });
    expect(result.percentileCounted).toBe(true);
    expect(result.aboveMedian).toBe(40);
    expect(result.xp).toBe(XP_RULES.mock.base + 40 * XP_RULES.mock.perPercentileAboveMedian);
  });

  it("rewards doing better than the room, never worse", () => {
    // Below the median the term is zero, not negative: XP is earned, and a
    // ledger row that subtracts for a bad practice attempt would teach a
    // candidate to stop practising.
    const result = mockXp({ percent: 20, medianPercent: 50, finalizedAttemptCount: 100 });
    expect(result.aboveMedian).toBe(0);
    expect(result.xp).toBe(XP_RULES.mock.base);
  });

  it("needs a median as well as a cohort", () => {
    expect(mockXp({ percent: 90, medianPercent: null, finalizedAttemptCount: 500 }).percentileCounted).toBe(false);
  });

  it("holds the cohort floor at 30, carrying the spec's own rating reasoning", () => {
    expect(MOCK_PERCENTILE_MIN_ATTEMPTS).toBe(30);
  });
});
