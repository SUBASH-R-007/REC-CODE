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
  /**
   * Topic practice pays ONCE per question, ever, on the first correct answer
   * — so a re-sit cannot farm it. The ledger itself is the enforcement:
   * XpEvent.idempotencyKey is unique.
   */
  aptitude: (userId: string, questionId: string) => `aptitude:${userId}:${questionId}`,
  /** One payment per finalise, idempotent under a retried finalise. */
  mock: (mockAttemptId: string) => `mock:${mockAttemptId}`,
});

/**
 * How many finalised attempts a pattern needs before its percentile term is
 * meaningful.
 *
 * XP_RULES.mock is "base 100 + 1 per percentile above median", which needs a
 * cohort. A percentile over four attempts is noise and an XpEvent is
 * permanent, so below this only the base is awarded and the result page says
 * the percentile is not meaningful yet. The spec's own reasoning about contest
 * ratings ("not meaningful before ~8-12 contests") applied to a ledger row.
 */
export const MOCK_PERCENTILE_MIN_ATTEMPTS = 30;

/**
 * XP for one correct answer in TOPIC PRACTICE.
 *
 * Not inside a mock: a 120-question mock would otherwise pay up to 1,200 XP
 * through the per-correct rule AND XP_RULES.mock, and the 200/day aptitude cap
 * would silently become the real number — exactly the Easy-grinding failure
 * the caps exist to prevent (docs/OPEN-QUESTIONS.md).
 */
export function aptitudeXp(args: {
  readonly correct: boolean;
  readonly alreadyPaidForQuestion: boolean;
  /** XP already paid under the aptitude cap today. */
  readonly awardedToday: number;
  readonly rules?: Pick<XpRules, "aptitude">;
}): { xp: number; cappedBy: "none" | "already_paid" | "daily_cap" } {
  const rules = args.rules ?? XP_RULES;
  if (!args.correct) return { xp: 0, cappedBy: "none" };
  if (args.alreadyPaidForQuestion) return { xp: 0, cappedBy: "already_paid" };
  const room = Math.max(0, rules.aptitude.dailyCap - Math.max(0, args.awardedToday));
  const xp = Math.min(rules.aptitude.perCorrect, room);
  return { xp, cappedBy: xp < rules.aptitude.perCorrect ? "daily_cap" : "none" };
}

/**
 * XP for finalising a mock.
 *
 * The base is unconditional — sitting a full mock honestly is the behaviour
 * the phase wants, and a candidate who scores badly learns the most from it.
 * The percentile term is added only once the pattern has a cohort, and only
 * for the part ABOVE the median: it rewards doing better than the room, not
 * simply being in it.
 */
export function mockXp(args: {
  readonly percent: number;
  readonly medianPercent: number | null;
  readonly finalizedAttemptCount: number;
  readonly rules?: Pick<XpRules, "mock">;
}): { xp: number; percentileCounted: boolean; aboveMedian: number } {
  const rules = args.rules ?? XP_RULES;
  const enoughCohort = args.finalizedAttemptCount >= MOCK_PERCENTILE_MIN_ATTEMPTS && args.medianPercent !== null;
  if (!enoughCohort) return { xp: rules.mock.base, percentileCounted: false, aboveMedian: 0 };
  const aboveMedian = Math.max(0, Math.round(args.percent - (args.medianPercent ?? 0)));
  return {
    xp: rules.mock.base + aboveMedian * rules.mock.perPercentileAboveMedian,
    percentileCounted: true,
    aboveMedian,
  };
}

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
