import { describe, expect, it } from "vitest";
import { applyDailyCaps, solveXp, XP_RULES, type SolveXpInput } from "../src/xp";

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
