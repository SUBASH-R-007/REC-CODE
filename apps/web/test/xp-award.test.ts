import { describe, expect, it } from "vitest";
import { XP_RULES } from "@recx/shared";
import { firstSolveAward, streakMilestoneAward, streakMilestoneXp, type DayXp } from "@/lib/progress/rules";

/**
 * XP amounts the progress engine awards: the shared rules (XP_RULES,
 * solveXp, applyDailyCaps) combined the way finalise uses them. Expected
 * values are derived from XP_RULES so a rules change shows up here as a
 * deliberate test update, never as a silent copy.
 */
const none: DayXp = { total: 0, easy: 0 };
const base = XP_RULES.firstSolve;
const caps = XP_RULES.caps;

const award = (patch: Partial<Parameters<typeof firstSolveAward>[0]>) =>
  firstSolveAward({ difficulty: "EASY", assisted: false, dailyChallenge: false, earnedToday: none, ...patch });

describe("first-solve XP", () => {
  it("pays the base amount by difficulty", () => {
    expect(award({ difficulty: "EASY" })).toEqual({ uncapped: base.EASY, amount: base.EASY, capped: false });
    expect(award({ difficulty: "MEDIUM" }).amount).toBe(base.MEDIUM);
    expect(award({ difficulty: "HARD" }).amount).toBe(base.HARD);
  });

  it("doubles on the daily challenge", () => {
    expect(award({ difficulty: "MEDIUM", dailyChallenge: true }).amount).toBe(
      base.MEDIUM * XP_RULES.dailyChallengeMultiplier,
    );
  });

  it("pays 40 % when assisted (tier-3 hint or editorial), rounded", () => {
    expect(award({ difficulty: "MEDIUM", assisted: true }).amount).toBe(
      Math.round(base.MEDIUM * XP_RULES.assistedMultiplier),
    );
    expect(award({ difficulty: "HARD", assisted: true, dailyChallenge: true }).amount).toBe(
      Math.round(base.HARD * XP_RULES.dailyChallengeMultiplier * XP_RULES.assistedMultiplier),
    );
  });

  it("caps Easy XP per day, and records that it did", () => {
    const nearlyCapped: DayXp = { total: caps.easyPerDay - 10, easy: caps.easyPerDay - 10 };
    expect(award({ difficulty: "EASY", earnedToday: nearlyCapped })).toEqual({
      uncapped: base.EASY,
      amount: 10,
      capped: true,
    });
    const capped: DayXp = { total: caps.easyPerDay, easy: caps.easyPerDay };
    expect(award({ difficulty: "EASY", earnedToday: capped })).toEqual({ uncapped: base.EASY, amount: 0, capped: true });
  });

  it("does not apply the Easy cap to Medium or Hard", () => {
    const easyCapped: DayXp = { total: caps.easyPerDay, easy: caps.easyPerDay };
    expect(award({ difficulty: "HARD", earnedToday: easyCapped })).toMatchObject({ amount: base.HARD, capped: false });
  });

  it("caps the day's total XP", () => {
    const nearly: DayXp = { total: caps.totalPerDay - 5, easy: 0 };
    expect(award({ difficulty: "HARD", earnedToday: nearly })).toEqual({ uncapped: base.HARD, amount: 5, capped: true });
    const full: DayXp = { total: caps.totalPerDay, easy: 0 };
    expect(award({ difficulty: "MEDIUM", earnedToday: full }).amount).toBe(0);
  });

  it("an Easy daily challenge is still Easy XP for the cap", () => {
    const easyNear: DayXp = { total: caps.easyPerDay - 30, easy: caps.easyPerDay - 30 };
    expect(award({ difficulty: "EASY", dailyChallenge: true, earnedToday: easyNear })).toEqual({
      uncapped: base.EASY * XP_RULES.dailyChallengeMultiplier,
      amount: 30,
      capped: true,
    });
  });
});

describe("streak milestone XP", () => {
  it("pays the one-off milestone table", () => {
    for (const [days, xp] of Object.entries(XP_RULES.streakMilestones)) {
      expect(streakMilestoneXp(Number(days))).toBe(xp);
    }
    expect(streakMilestoneXp(8)).toBe(0);
  });

  it("is not subject to the Easy cap", () => {
    const easyCapped: DayXp = { total: caps.easyPerDay, easy: caps.easyPerDay };
    expect(streakMilestoneAward(7, easyCapped)).toEqual({
      uncapped: streakMilestoneXp(7),
      amount: streakMilestoneXp(7),
      capped: false,
    });
  });

  it("is subject to the total daily cap", () => {
    const nearly: DayXp = { total: caps.totalPerDay - 12, easy: 0 };
    expect(streakMilestoneAward(30, nearly)).toEqual({ uncapped: streakMilestoneXp(30), amount: 12, capped: true });
    expect(streakMilestoneAward(100, { total: caps.totalPerDay, easy: 0 }).amount).toBe(0);
  });
});
