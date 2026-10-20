/**
 * Readiness: a preparation-coverage measure (Phase 9).
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 *
 * SPEC §5, and it is a mandatory UI framing rather than a disclaimer:
 * readiness is **a preparation-coverage measure, explicitly not a prediction
 * of being placed**. It has ZERO validation data at launch — nobody has yet
 * been through a placement cycle with these numbers, so the weights are a
 * considered guess and the spec says to recalibrate them against real
 * outcomes after the first cycle.
 *
 * Three consequences that are enforced in code rather than hoped for:
 *   - no student is ever gated out of a drive on it (any drive-eligibility
 *     use needs a human decision with an audit row);
 *   - a missing component renders as MISSING, never as zero, and the score
 *     is reported alongside the weight that was actually measurable;
 *   - `topicBreadth` is a MINIMUM and never a mean.
 *
 * ── WHY THE MINIMUM ─────────────────────────────────────────────────────
 *
 * The spec's own reason, carried across because it is the single most
 * important line in the phase: "Averaging lets a student look ready with 200
 * array problems and zero graphs, which is precisely the profile that fails
 * real interviews."
 *
 * Pure: no I/O, no Prisma, no ambient clock.
 */

import { TOPICS, type Topic } from "./topics";

/**
 * The version of the weights below.
 *
 * Every snapshot cites it, so a recalibration after the first placement
 * cycle — which SPEC §5 explicitly plans for — produces NEW numbers rather
 * than silently rewriting last year's. Bump it in the same change that
 * changes any weight or any target, or a stored breakdown will stop
 * explaining its own score.
 */
export const READINESS_RULES_VERSION = 1;

export const READINESS_TIERS = ["SERVICE", "PRODUCT", "TOP"] as const;
export type ReadinessTier = (typeof READINESS_TIERS)[number];

/** What each tier is, in the words a student would use. */
export const READINESS_TIER_LABEL: Record<ReadinessTier, string> = {
  SERVICE: "Service companies",
  PRODUCT: "Product companies",
  TOP: "Top-tier companies",
};

export const READINESS_TIER_EXAMPLES: Record<ReadinessTier, string> = {
  SERVICE: "The large campus recruiters — aptitude-heavy rounds and straightforward coding.",
  PRODUCT: "Mid-tier product companies — harder coding, and breadth across topics matters.",
  TOP: "The hardest interview loops — contest-grade problem solving and real depth.",
};

export const READINESS_COMPONENTS = [
  "APTITUDE_PERCENTILE",
  "VERBAL_PERCENTILE",
  "EASY_MEDIUM_COVERAGE",
  "MEDIUM_UNASSISTED_COVERAGE",
  "MEDIUM_HARD_UNASSISTED_COVERAGE",
  "TOPIC_BREADTH",
  "RATING_PERCENTILE",
  "MOCK_INTERVIEW_SCORE",
  "CONSISTENCY",
] as const;
export type ReadinessComponent = (typeof READINESS_COMPONENTS)[number];

/** What a student reads beside each component. */
export const COMPONENT_LABEL: Record<ReadinessComponent, string> = {
  APTITUDE_PERCENTILE: "Aptitude",
  VERBAL_PERCENTILE: "Verbal reasoning",
  EASY_MEDIUM_COVERAGE: "Easy and medium problems solved",
  MEDIUM_UNASSISTED_COVERAGE: "Medium problems solved without help",
  MEDIUM_HARD_UNASSISTED_COVERAGE: "Medium and hard problems solved without help",
  TOPIC_BREADTH: "Breadth across topics",
  RATING_PERCENTILE: "Contest rating",
  MOCK_INTERVIEW_SCORE: "Mock interviews",
  CONSISTENCY: "Practising regularly",
};

/**
 * The weights, exactly as SPEC §5 gives them.
 *
 * Each tier sums to 1.00, asserted by a test — not for tidiness, but because
 * a tier whose weights summed to 0.95 would silently cap every student in it
 * at 95 and nobody would be able to tell that from a cohort of students who
 * were 5 % short.
 */
export const TIER_WEIGHTS: Record<ReadinessTier, Partial<Record<ReadinessComponent, number>>> = {
  SERVICE: {
    APTITUDE_PERCENTILE: 0.35,
    VERBAL_PERCENTILE: 0.2,
    EASY_MEDIUM_COVERAGE: 0.25,
    MOCK_INTERVIEW_SCORE: 0.1,
    CONSISTENCY: 0.1,
  },
  PRODUCT: {
    MEDIUM_UNASSISTED_COVERAGE: 0.3,
    TOPIC_BREADTH: 0.2,
    APTITUDE_PERCENTILE: 0.2,
    RATING_PERCENTILE: 0.15,
    MOCK_INTERVIEW_SCORE: 0.1,
    CONSISTENCY: 0.05,
  },
  TOP: {
    RATING_PERCENTILE: 0.35,
    MEDIUM_HARD_UNASSISTED_COVERAGE: 0.3,
    TOPIC_BREADTH: 0.2,
    MOCK_INTERVIEW_SCORE: 0.15,
  },
};

/**
 * Coverage and breadth targets per tier.
 *
 * `perTopic` is what `topicBreadth` divides by, and the two tiers that use it
 * want different depths: a product interview expects you to have met every
 * topic a few times, a top-tier loop expects real familiarity. SERVICE has
 * no `perTopic` because it has no `TOPIC_BREADTH` weight — a service round
 * does not ask about segment trees.
 */
export const TIER_TARGETS: Record<
  ReadinessTier,
  { readonly coverage: number; readonly perTopic: number | null }
> = {
  SERVICE: { coverage: 80, perTopic: null },
  PRODUCT: { coverage: 60, perTopic: 4 },
  TOP: { coverage: 50, perTopic: 8 },
};

/**
 * Why a component is missing. The distinction matters to the student: one of
 * these is their move to make and two are not.
 */
export const MISSING_REASONS = [
  /** Nothing in this plan produces it. Not the student's to fix. */
  "NO_SOURCE_YET",
  /** The source exists and they have not used it yet. Theirs to fix. */
  "NO_DATA_YET",
  /** Too few peers to rank against without identifying them. */
  "COHORT_TOO_SMALL",
] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];

export const MISSING_REASON_COPY: Record<MissingReason, string> = {
  NO_SOURCE_YET: "Not measured yet — this part of the platform is not built.",
  NO_DATA_YET: "No data yet. Try one and this starts counting.",
  COHORT_TOO_SMALL: "Too few people in your cohort to rank against yet.",
};

/** A component's state: a 0–1 value, or absent with a reason. */
export type ComponentValue =
  | { readonly state: "PRESENT"; readonly value: number }
  | { readonly state: "MISSING"; readonly reason: MissingReason };

export function present(value: number): ComponentValue {
  return { state: "PRESENT", value: clamp01(value) };
}

export function missing(reason: MissingReason): ComponentValue {
  return { state: "MISSING", reason };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  // The `+ 0` kills -0, which would render as "-0%" in a component table.
  return Math.min(1, Math.max(0, value)) + 0;
}

/** Everything the tier scores are computed from, for one student. */
export interface ReadinessInputs {
  readonly aptitudePercentile: ComponentValue;
  readonly verbalPercentile: ComponentValue;
  readonly ratingPercentile: ComponentValue;
  readonly mockInterviewScore: ComponentValue;
  readonly consistency: ComponentValue;
  /** Unassisted solves per topic, for `topicBreadth`. */
  readonly unassistedByTopic: Readonly<Partial<Record<Topic, number>>>;
  /** Solves counted however they were reached (SERVICE). */
  readonly easyMediumSolved: number;
  /** Solves reached without a hint or an editorial (PRODUCT, TOP). */
  readonly mediumUnassisted: number;
  readonly mediumHardUnassisted: number;
}

export interface TopicBreadth {
  readonly value: number;
  /** The topic that is holding the minimum down. */
  readonly limitingTopic: Topic;
  readonly limitingCount: number;
  readonly perTopicTarget: number;
}

/**
 * The MINIMUM across all fourteen topics of (unassisted solves ÷ target),
 * capped at 1.
 *
 * Never the mean. A student with 200 array problems and no graphs scores
 * zero here, which is the whole point: that profile looks ready on an
 * average and fails a real interview on the first graph question.
 *
 * The limiting topic is returned with it, because "your breadth is 0.17" is
 * useless and "graphs is holding you back, you have 1 of 4" is actionable.
 * Ties break on `TOPICS` order so the answer is stable between runs — a
 * next-action that changed every night for the same profile would teach a
 * student to ignore it.
 */
export function topicBreadth(
  unassistedByTopic: Readonly<Partial<Record<Topic, number>>>,
  perTopicTarget: number,
): TopicBreadth {
  let best: TopicBreadth | null = null;
  for (const topic of TOPICS) {
    const count = unassistedByTopic[topic] ?? 0;
    const value = perTopicTarget <= 0 ? 1 : clamp01(count / perTopicTarget);
    if (best === null || value < best.value) {
      best = { value, limitingTopic: topic, limitingCount: count, perTopicTarget };
    }
  }
  // TOPICS is non-empty, so `best` is always set; the fallback keeps the
  // type honest rather than asserting.
  return best ?? { value: 0, limitingTopic: TOPICS[0]!, limitingCount: 0, perTopicTarget };
}

/** A solved-count against a target, as a 0–1 coverage figure. */
export function coverage(solved: number, target: number): ComponentValue {
  if (target <= 0) return present(1);
  return present(solved / target);
}

export interface ComponentBreakdown {
  readonly component: ReadinessComponent;
  readonly label: string;
  readonly weight: number;
  readonly state: ComponentValue;
  /** How many of the tier's 100 points this component currently contributes. */
  readonly points: number;
  /** How many it is leaving on the table. Zero for a MISSING component. */
  readonly pointsAvailable: number;
  /** Only on TOPIC_BREADTH. */
  readonly limitingTopic?: Topic;
  readonly limitingCount?: number;
  readonly perTopicTarget?: number;
}

export interface TierScore {
  readonly tier: ReadinessTier;
  /** 0–100, over the components that could be measured. */
  readonly score: number;
  /**
   * The weight that WAS measurable, as 0–100.
   *
   * The honest denominator. `mockInterviewScore` has no source in this plan,
   * so no TOP score can exceed 85 and no SERVICE or PRODUCT score can exceed
   * 90 — and every surface that compares a score against a threshold has to
   * divide by this rather than by 100, or a whole cohort looks
   * under-prepared because of a component nobody has built.
   */
  readonly availableWeight: number;
  /** `score / availableWeight` as 0–100, for any threshold comparison. */
  readonly normalised: number;
  readonly components: readonly ComponentBreakdown[];
  readonly missing: readonly ComponentBreakdown[];
}

/** Round to one decimal, with -0 removed. */
function round1(value: number): number {
  return Math.round(value * 10) / 10 + 0;
}

/**
 * Score one tier.
 *
 * Weights are NOT renormalised over the present components. That is
 * deliberate and it is the honest choice: renormalising would make a student
 * who has never done a mock interview look exactly as ready as one who has
 * done five, by silently redistributing the missing 15 % across the
 * components they happen to have. Instead the score is lower and
 * `availableWeight` says why.
 */
export function scoreTier(tier: ReadinessTier, inputs: ReadinessInputs): TierScore {
  const weights = TIER_WEIGHTS[tier];
  const targets = TIER_TARGETS[tier];
  const breakdown: ComponentBreakdown[] = [];

  for (const component of READINESS_COMPONENTS) {
    const weight = weights[component];
    if (weight === undefined) continue;

    let state: ComponentValue;
    let extra: Partial<ComponentBreakdown> = {};

    switch (component) {
      case "APTITUDE_PERCENTILE":
        state = inputs.aptitudePercentile;
        break;
      case "VERBAL_PERCENTILE":
        state = inputs.verbalPercentile;
        break;
      case "RATING_PERCENTILE":
        state = inputs.ratingPercentile;
        break;
      case "MOCK_INTERVIEW_SCORE":
        state = inputs.mockInterviewScore;
        break;
      case "CONSISTENCY":
        state = inputs.consistency;
        break;
      case "EASY_MEDIUM_COVERAGE":
        // SERVICE only, and it counts a solve HOWEVER it was reached: the
        // spec names this component without "Unassisted" while naming the
        // other two with it, and a service round asks whether you can write
        // the loop at all.
        state = coverage(inputs.easyMediumSolved, targets.coverage);
        break;
      case "MEDIUM_UNASSISTED_COVERAGE":
        state = coverage(inputs.mediumUnassisted, targets.coverage);
        break;
      case "MEDIUM_HARD_UNASSISTED_COVERAGE":
        state = coverage(inputs.mediumHardUnassisted, targets.coverage);
        break;
      case "TOPIC_BREADTH": {
        const target = targets.perTopic;
        if (target === null) {
          state = missing("NO_SOURCE_YET");
          break;
        }
        const breadth = topicBreadth(inputs.unassistedByTopic, target);
        state = present(breadth.value);
        extra = {
          limitingTopic: breadth.limitingTopic,
          limitingCount: breadth.limitingCount,
          perTopicTarget: breadth.perTopicTarget,
        };
        break;
      }
    }

    const value = state.state === "PRESENT" ? state.value : 0;
    breakdown.push({
      component,
      label: COMPONENT_LABEL[component],
      weight,
      state,
      points: state.state === "PRESENT" ? round1(weight * value * 100) : 0,
      // A MISSING component is not a gap the student can close, so it offers
      // no points available. Telling them otherwise would send them looking
      // for something that does not exist.
      pointsAvailable: state.state === "PRESENT" ? round1(weight * (1 - value) * 100) : 0,
      ...extra,
    });
  }

  const score = round1(breakdown.reduce((sum, row) => sum + row.points, 0));
  const availableWeight = round1(
    breakdown.filter((row) => row.state.state === "PRESENT").reduce((sum, row) => sum + row.weight * 100, 0),
  );

  return {
    tier,
    score,
    availableWeight,
    normalised: availableWeight === 0 ? 0 : round1((score / availableWeight) * 100),
    components: breakdown,
    missing: breakdown.filter((row) => row.state.state === "MISSING"),
  };
}

export interface NextAction {
  readonly points: number;
  readonly component: ReadinessComponent;
  readonly label: string;
  /** "graphs, 6 unassisted mediums" — what to actually go and do. */
  readonly detail: string;
  /** "+9 points available: graphs, 6 unassisted mediums" */
  readonly sentence: string;
}

/**
 * The three largest gaps and one concrete next action.
 *
 * SPEC §5 gives the literal format: `"+9 points available: graphs, 6
 * unassisted mediums"`. The points figure is what makes it a decision rather
 * than a nag — a student looking at four weaknesses needs to know which one
 * is worth the evening.
 *
 * Gaps and the next action are ranked by the SAME points figure, so the
 * headline and the list can never disagree.
 */
export function largestGaps(score: TierScore, howMany = 3): ComponentBreakdown[] {
  return [...score.components]
    .filter((row) => row.pointsAvailable > 0)
    .sort((a, b) => b.pointsAvailable - a.pointsAvailable || a.component.localeCompare(b.component))
    .slice(0, howMany);
}

export function nextAction(tier: ReadinessTier, score: TierScore, inputs: ReadinessInputs): NextAction | null {
  const top = largestGaps(score, 1)[0];
  if (!top) return null;
  const targets = TIER_TARGETS[tier];
  const detail = actionDetail(top, targets, inputs);
  return {
    points: top.pointsAvailable,
    component: top.component,
    label: top.label,
    detail,
    sentence: `+${formatPoints(top.pointsAvailable)} points available: ${detail}`,
  };
}

function formatPoints(points: number): string {
  return Number.isInteger(points) ? String(points) : points.toFixed(1);
}

/** What to go and do, in the fewest concrete words. */
function actionDetail(
  row: ComponentBreakdown,
  targets: { readonly coverage: number; readonly perTopic: number | null },
  inputs: ReadinessInputs,
): string {
  /**
   * "54 more medium problems without a hint" — the HEAD noun inflects, not
   * the phrase. Appending an s to the whole thing gives "medium problem
   * without a hints", which is the kind of sentence that makes a student
   * trust nothing else on the page.
   */
  const short = (have: number, want: number, one: string, many: string, tail = "") => {
    const left = Math.max(0, Math.ceil(want - have));
    return `${left} more ${left === 1 ? one : many}${tail}`;
  };

  switch (row.component) {
    case "TOPIC_BREADTH": {
      const topic = row.limitingTopic;
      const target = row.perTopicTarget ?? targets.perTopic ?? 0;
      const have = row.limitingCount ?? 0;
      const left = Math.max(0, target - have);
      return `${topicWord(topic)}, ${left} unassisted ${left === 1 ? "problem" : "problems"}`;
    }
    case "EASY_MEDIUM_COVERAGE":
      return short(inputs.easyMediumSolved, targets.coverage, "easy or medium problem", "easy or medium problems");
    case "MEDIUM_UNASSISTED_COVERAGE":
      return short(
        inputs.mediumUnassisted,
        targets.coverage,
        "medium problem",
        "medium problems",
        " without a hint",
      );
    case "MEDIUM_HARD_UNASSISTED_COVERAGE":
      return short(
        inputs.mediumHardUnassisted,
        targets.coverage,
        "medium or hard problem",
        "medium or hard problems",
        " without a hint",
      );
    case "APTITUDE_PERCENTILE":
      return "aptitude practice — one topic set";
    case "VERBAL_PERCENTILE":
      return "verbal reasoning practice";
    case "RATING_PERCENTILE":
      return "enter the next rated contest";
    case "CONSISTENCY":
      return "practise on more days — even one problem counts";
    case "MOCK_INTERVIEW_SCORE":
      return "a mock interview";
  }
}

/** "GRAPHS" → "graphs", for a sentence a student reads. */
function topicWord(topic: Topic | undefined): string {
  if (!topic) return "a topic you have not touched";
  return topic.toLowerCase().replace(/_/g, " ");
}

/** Every tier at once, which is what the student's card renders. */
export function scoreAllTiers(inputs: ReadinessInputs): Record<ReadinessTier, TierScore> {
  return {
    SERVICE: scoreTier("SERVICE", inputs),
    PRODUCT: scoreTier("PRODUCT", inputs),
    TOP: scoreTier("TOP", inputs),
  };
}

/**
 * The framing copy, as a constant.
 *
 * SPEC §5 calls this a MANDATORY UI framing, so it is a constant that a copy
 * test can assert is rendered rather than a paragraph somebody might trim in
 * a redesign. The second sentence is the one that matters: a student who
 * reads a number as a prediction will either coast on a high one or give up
 * on a low one, and both are worse than not showing it.
 */
export const READINESS_FRAMING =
  "This measures how much of the preparation you have covered. It is not a prediction of whether you will be placed, and nobody uses it to decide who can sit a drive.";

export const READINESS_CALIBRATION_NOTE =
  "These weights have not been checked against real placement outcomes yet — the first cycle with this platform is the one that will calibrate them.";

/** The distribution buckets, over the NORMALISED score. See the resolutions. */
export const DISTRIBUTION_BUCKETS = [
  { label: "0–19", min: 0, max: 19 },
  { label: "20–39", min: 20, max: 39 },
  { label: "40–59", min: 40, max: 59 },
  { label: "60–79", min: 60, max: 79 },
  { label: "80–100", min: 80, max: 100 },
] as const;

export function bucketOf(normalised: number): string {
  for (const bucket of DISTRIBUTION_BUCKETS) {
    if (normalised >= bucket.min && normalised <= bucket.max) return bucket.label;
  }
  return DISTRIBUTION_BUCKETS[DISTRIBUTION_BUCKETS.length - 1]!.label;
}

/**
 * The at-risk rule, on the NORMALISED score.
 *
 * SPEC §5: "no activity 7+ days, or SERVICE readiness <40 within 6 months of
 * a drive". Normalised, for the reason in `availableWeight`: a raw 40 on a
 * tier capped at 90 is a different thing from 40 out of 100, and an at-risk
 * list that confused them would route half a cohort to a mentor.
 */
export const AT_RISK_QUIET_DAYS = 7;
export const AT_RISK_SERVICE_NORMALISED = 40;

export function isAtRisk(input: {
  readonly quietDays: number;
  readonly serviceNormalised: number | null;
  readonly driveWithinSixMonths: boolean;
}): { atRisk: boolean; reason: string | null } {
  if (input.quietDays >= AT_RISK_QUIET_DAYS) {
    return { atRisk: true, reason: `No activity for ${input.quietDays} days.` };
  }
  if (
    input.driveWithinSixMonths &&
    input.serviceNormalised !== null &&
    input.serviceNormalised < AT_RISK_SERVICE_NORMALISED
  ) {
    return {
      atRisk: true,
      reason: `Service readiness ${input.serviceNormalised}% of what is measurable, with a drive inside six months.`,
    };
  }
  return { atRisk: false, reason: null };
}
