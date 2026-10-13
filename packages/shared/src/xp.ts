import { z } from "zod";
import { deepFreeze } from "./freeze";

/**
 * XP rules (prompt Phase 3). Every constant lives here and only here. The
 * super-admin may override values at runtime through PlatformSetting "xp"
 * (audited); this module supplies the defaults and the pure arithmetic.
 *
 * Bump XP_RULES_VERSION whenever a value changes: each XpEvent records the
 * rulesVersion it was computed under so a recompute is explainable.
 */
export const XP_RULES_VERSION = 1;

export const XP_RULES = deepFreeze({
  firstSolve: { EASY: 50, MEDIUM: 120, HARD: 250 },
  dailyChallengeMultiplier: 2,
  /** A solve after tier-3 hint or editorial: counts as solved, pays 40%. */
  assistedMultiplier: 0.4,
  /** A due revision re-solve pays 25%. */
  revisionMultiplier: 0.25,
  repeatSolve: 0,
  aptitude: { perCorrect: 10, dailyCap: 200 },
  mock: { base: 100, perPercentileAboveMedian: 1 },
  contest: { participation: 150, perPercentile: 2 },
  caps: {
    /** Without these the top of the board converges on Easy-grinding. */
    easyPerDay: 600,
    totalPerDay: 2_000,
  },
  /** One-off streak milestone awards (LMS semantics: 7, 30 and 100 days). */
  streakMilestones: { 7: 30, 30: 100, 100: 300 },
});

/** Ledger idempotency keys: one XpEvent per key, ever (XpEvent.idempotencyKey is unique). */
export const XP_KEYS = Object.freeze({
  solve: (userId: string, problemId: string) => `solve:${userId}:${problemId}`,
  streak: (userId: string, milestone: number) => `streak:${userId}:${milestone}`,
  contestParticipation: (contestId: string, userId: string) => `contest:${contestId}:${userId}:participation`,
  daily: (userId: string, day: string) => `daily:${userId}:${day}`,
  reversal: (eventId: bigint | number) => `reversal:${eventId}`,
});

export type DifficultyKey = keyof typeof XP_RULES.firstSolve;

export interface SolveXpInput {
  difficulty: DifficultyKey;
  firstSolve: boolean;
  assisted: boolean;
  dailyChallenge: boolean;
  revision: boolean;
}

export type XpRules = typeof XP_RULES;

/**
 * The super-admin override (PlatformSetting key "xp"), audited on write.
 * Only the listed fields may change; every field is optional and replaces
 * the default. `version` (> XP_RULES_VERSION) is recorded on every XpEvent
 * computed under it, so a recompute is explainable.
 */
export const xpRulesOverrideSchema = z
  .object({
    version: z.number().int().min(XP_RULES_VERSION + 1),
    firstSolve: z
      .object({
        EASY: z.number().int().min(0).max(1_000),
        MEDIUM: z.number().int().min(0).max(1_000),
        HARD: z.number().int().min(0).max(2_000),
      })
      .partial()
      .strict()
      .optional(),
    dailyChallengeMultiplier: z.number().min(1).max(5).optional(),
    assistedMultiplier: z.number().min(0).max(1).optional(),
    revisionMultiplier: z.number().min(0).max(1).optional(),
    caps: z
      .object({
        easyPerDay: z.number().int().min(0).max(10_000),
        totalPerDay: z.number().int().min(0).max(20_000),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();
export type XpRulesOverride = z.infer<typeof xpRulesOverrideSchema>;

/** Defaults merged with a validated override (an invalid one is ignored by the caller). */
export function effectiveXpRules(override: XpRulesOverride | null): { rules: XpRules; version: number } {
  if (!override) return { rules: XP_RULES, version: XP_RULES_VERSION };
  const rules = deepFreeze({
    ...XP_RULES,
    firstSolve: { ...XP_RULES.firstSolve, ...override.firstSolve },
    dailyChallengeMultiplier: override.dailyChallengeMultiplier ?? XP_RULES.dailyChallengeMultiplier,
    assistedMultiplier: override.assistedMultiplier ?? XP_RULES.assistedMultiplier,
    revisionMultiplier: override.revisionMultiplier ?? XP_RULES.revisionMultiplier,
    caps: { ...XP_RULES.caps, ...override.caps },
  }) as XpRules;
  return { rules, version: override.version };
}

/** Uncapped XP for a solve. Caps are applied by applyDailyCaps(). */
export function solveXp(input: SolveXpInput, rules: XpRules = XP_RULES): number {
  const base = rules.firstSolve[input.difficulty];
  if (input.revision) return Math.round(base * rules.revisionMultiplier);
  if (!input.firstSolve) return rules.repeatSolve;
  let amount = base;
  if (input.dailyChallenge) amount *= rules.dailyChallengeMultiplier;
  if (input.assisted) amount *= rules.assistedMultiplier;
  return Math.round(amount);
}

/** Clamp an award against what the user has already earned today. */
export function applyDailyCaps(
  input: {
    amount: number;
    isEasy: boolean;
    earnedTodayTotal: number;
    earnedTodayEasy: number;
  },
  rules: XpRules = XP_RULES,
): number {
  let allowed = Math.max(0, rules.caps.totalPerDay - input.earnedTodayTotal);
  if (input.isEasy) {
    allowed = Math.min(allowed, Math.max(0, rules.caps.easyPerDay - input.earnedTodayEasy));
  }
  return Math.max(0, Math.min(input.amount, allowed));
}
