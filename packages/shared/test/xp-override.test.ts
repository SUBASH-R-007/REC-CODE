import { describe, expect, it } from "vitest";
import {
  XP_RULES,
  XP_RULES_VERSION,
  applyDailyCaps,
  effectiveXpRules,
  solveXp,
  xpRulesOverrideSchema,
} from "../src";

describe("XP rules override", () => {
  it("defaults apply without an override", () => {
    expect(effectiveXpRules(null)).toEqual({ rules: XP_RULES, version: XP_RULES_VERSION });
  });

  it("merges only the overridden fields and carries the version", () => {
    const override = xpRulesOverrideSchema.parse({ version: XP_RULES_VERSION + 1, firstSolve: { EASY: 40 }, caps: { easyPerDay: 400 } });
    const { rules, version } = effectiveXpRules(override);
    expect(version).toBe(XP_RULES_VERSION + 1);
    expect(rules.firstSolve).toEqual({ EASY: 40, MEDIUM: 120, HARD: 250 });
    expect(rules.caps).toEqual({ easyPerDay: 400, totalPerDay: 2_000 });
    expect(solveXp({ difficulty: "EASY", firstSolve: true, assisted: false, dailyChallenge: false, revision: false }, rules)).toBe(40);
    expect(applyDailyCaps({ amount: 100, isEasy: true, earnedTodayTotal: 0, earnedTodayEasy: 380 }, rules)).toBe(20);
    expect(Object.isFrozen(rules.firstSolve)).toBe(true);
  });

  it("rejects unknown fields, out-of-range values and a version that is not newer", () => {
    expect(xpRulesOverrideSchema.safeParse({ version: XP_RULES_VERSION, firstSolve: { EASY: 40 } }).success).toBe(false);
    expect(xpRulesOverrideSchema.safeParse({ version: 9, assistedMultiplier: 1.5 }).success).toBe(false);
    expect(xpRulesOverrideSchema.safeParse({ version: 9, firstSolve: { EXPERT: 10 } }).success).toBe(false);
    expect(xpRulesOverrideSchema.safeParse({ version: 9, repeatSolve: 10 }).success).toBe(false);
  });
});
