import { TOPIC_LABEL, type Topic } from "./topics";

/**
 * The recommender (Phase 12f).
 *
 * SPEC §11: "the rule-based, explainable recommender (no ML — it has
 * neither the data nor an evaluation harness to beat a good rule, and it
 * cannot explain itself; always render the reason inline, and rotate
 * topics after 3 consecutive picks from the same one)".
 *
 * Three things follow, and the first is why this module is pure.
 *
 * **The reason is part of the recommendation, not decoration on top.**
 * `recommend()` returns the sentence with the pick, from the same data, so
 * there is no way to render one without the other and no second place
 * where the explanation could drift from the rule that produced it. A
 * recommender a student cannot argue with is one they learn to ignore.
 *
 * **The rules are ordered, and the order is the product.** Finish what you
 * started; then what a company whose drive is coming has actually been
 * asked; then what is due for revision; then the topic holding your
 * readiness back; then your plan; then the daily challenge; then anything.
 *
 * Two of those placements are arguments rather than conventions. FINISH is
 * top because a problem already in the student's head is the cheapest
 * thing they can finish tonight. DRIVE is above REVISE because a drive has
 * a date and a revision has a schedule: missing today's revision costs a
 * day on a ladder built to tolerate that, and missing the one problem a
 * company has been reported asking costs the interview.
 *
 * **Rotation is read from what the student DID, not from what we
 * suggested.** The spec says "rotate topics after 3 consecutive picks from
 * the same one"; this reads the topics of their last judged problems
 * instead. It is the same signal where it matters and a better one where
 * it differs: a student who ignored three array suggestions has not done
 * three array problems, and should not be rotated off arrays for it.
 */

export const RECOMMENDER_RULES = ["FINISH", "DRIVE", "REVISE", "WEAK_TOPIC", "PLAN", "DAILY", "FRESH"] as const;
export type RecommenderRule = (typeof RECOMMENDER_RULES)[number];

/** Consecutive problems in one topic before the weak-topic rule moves on. */
export const RECOMMEND_ROTATE_AFTER = 3;

/** How far ahead a drive has to be before it stops being today's business. */
export const RECOMMEND_DRIVE_HORIZON_DAYS = 21;

export interface RecommendProblem {
  readonly id: string;
  readonly slug: string;
  readonly displayCode: string;
  readonly title: string;
  readonly difficulty: "EASY" | "MEDIUM" | "HARD";
}

export interface WeakTopicCandidate {
  readonly topic: Topic;
  /** Unassisted solves in the topic, and the tier's per-topic target. */
  readonly have: number;
  readonly target: number;
  readonly problem: RecommendProblem;
}

export interface RecommendInputs {
  /** The most recently attempted problem they have not solved. */
  readonly unfinished: { readonly problem: RecommendProblem; readonly attempts: number; readonly lastAttemptAt: Date } | null;
  /** A revision card due today or overdue (Phase 12c). */
  readonly revision: { readonly problem: RecommendProblem; readonly overdueDays: number; readonly stepDays: number } | null;
  /** A drive inside the horizon, and an unsolved problem its company has been asked. */
  readonly drive:
    | {
        readonly companyName: string;
        readonly daysAway: number;
        /** Approved interviews in the archive that named this problem. */
        readonly askedCount: number;
        readonly problem: RecommendProblem;
      }
    | null;
  /** Weakest first. The engine takes the first one rotation allows. */
  readonly weakTopics: readonly WeakTopicCandidate[];
  readonly plan: {
    readonly title: string;
    readonly kind: "SHEET" | "TRACK";
    readonly done: number;
    readonly total: number;
    readonly problem: RecommendProblem;
  } | null;
  readonly daily: { readonly problem: RecommendProblem; readonly xp: number } | null;
  readonly fresh: { readonly problem: RecommendProblem; readonly firstEver: boolean } | null;
  /** Topics of their last judged problems, newest first (for rotation). */
  readonly recentTopics: readonly Topic[];
}

export interface Recommendation {
  readonly rule: RecommenderRule;
  readonly problem: RecommendProblem;
  /** Always rendered beside the pick. SPEC §11. */
  readonly reason: string;
  /** The topic the weak-topic rule skipped for rotation, when it did. */
  readonly rotatedAwayFrom: Topic | null;
}

/**
 * The topic the student has just done `RECOMMEND_ROTATE_AFTER` of in a
 * row, or null.
 *
 * Strictly consecutive and newest-first: three graph problems with a
 * string problem in the middle is not a rut, and the rule exists for ruts.
 */
export function saturatedTopic(recentTopics: readonly Topic[], after = RECOMMEND_ROTATE_AFTER): Topic | null {
  if (recentTopics.length < after) return null;
  const [first] = recentTopics;
  if (!first) return null;
  return recentTopics.slice(0, after).every((topic) => topic === first) ? first : null;
}

export function recommend(inputs: RecommendInputs): Recommendation | null {
  if (inputs.unfinished) {
    const { problem, attempts } = inputs.unfinished;
    return {
      rule: "FINISH",
      problem,
      reason:
        attempts === 1
          ? "You started this one and have not finished it. Picking up a problem you have already thought about beats starting a new one."
          : `You have had ${attempts} goes at this one. Picking up a problem you have already thought about beats starting a new one.`,
      rotatedAwayFrom: null,
    };
  }

  if (inputs.drive) {
    const { problem, companyName, daysAway, askedCount } = inputs.drive;
    const when = daysAway === 0 ? "is today" : daysAway === 1 ? "is tomorrow" : `is in ${daysAway} days`;
    const asked =
      askedCount === 1
        ? "one student reported being asked it there"
        : `${askedCount} students reported being asked it there`;
    return {
      rule: "DRIVE",
      problem,
      reason: `${companyName}'s drive ${when}, and ${asked}.`,
      rotatedAwayFrom: null,
    };
  }

  if (inputs.revision) {
    const { problem, overdueDays, stepDays } = inputs.revision;
    return {
      rule: "REVISE",
      problem,
      reason:
        overdueDays > 0
          ? `Due for revision ${overdueDays === 1 ? "yesterday" : `${overdueDays} days ago`}, on the ${stepDays}-day step. You solved it once; the point is whether you still can.`
          : `Due for revision today, on the ${stepDays}-day step. You solved it once; the point is whether you still can.`,
      rotatedAwayFrom: null,
    };
  }

  const saturated = saturatedTopic(inputs.recentTopics);
  const weak = inputs.weakTopics.find((candidate) => candidate.topic !== saturated) ?? null;
  if (weak) {
    const rotated = saturated !== null && inputs.weakTopics[0]?.topic === saturated;
    const gap = `${TOPIC_LABEL[weak.topic]} is the topic holding your readiness back — ${weak.have} of ${weak.target} unassisted solves.`;
    return {
      rule: "WEAK_TOPIC",
      problem: weak.problem,
      reason: rotated
        ? `${gap} (You have just done ${RECOMMEND_ROTATE_AFTER} ${TOPIC_LABEL[saturated!]} problems in a row, so this is a different topic.)`
        : gap,
      rotatedAwayFrom: rotated ? saturated : null,
    };
  }

  if (inputs.plan) {
    const { title, kind, done, total, problem } = inputs.plan;
    const what = kind === "SHEET" ? "sheet" : "track";
    return {
      rule: "PLAN",
      problem,
      // The progress is in the sentence rather than in a bar beside it:
      // "4 of 75" is the fact that decides whether to carry on tonight.
      reason: `Next in ${title} — ${done} of ${total} solved in this ${what}.`,
      rotatedAwayFrom: null,
    };
  }

  if (inputs.daily) {
    return {
      rule: "DAILY",
      problem: inputs.daily.problem,
      reason: `Today's challenge, and it pays double: ${inputs.daily.xp} XP for a first solve.`,
      rotatedAwayFrom: null,
    };
  }

  if (inputs.fresh) {
    return {
      rule: "FRESH",
      problem: inputs.fresh.problem,
      reason: inputs.fresh.firstEver
        ? "A good first problem. Solve it in the browser and the verdict comes back in seconds."
        : "Nothing is unfinished and nothing is due. This one is next in line.",
      rotatedAwayFrom: null,
    };
  }

  return null;
}

/** The short label above the pick, by rule. */
export const RECOMMENDER_EYEBROW: Readonly<Record<RecommenderRule, string>> = Object.freeze({
  FINISH: "Pick up where you left off",
  REVISE: "Due for revision",
  DRIVE: "Before the drive",
  WEAK_TOPIC: "Your weakest topic",
  PLAN: "Next in your plan",
  DAILY: "Today's daily challenge",
  FRESH: "Something new",
});

export const RECOMMENDER_CTA: Readonly<Record<RecommenderRule, string>> = Object.freeze({
  FINISH: "Continue solving",
  REVISE: "Solve it again",
  DRIVE: "Solve it",
  WEAK_TOPIC: "Solve it",
  PLAN: "Start problem",
  DAILY: "Solve today's challenge",
  FRESH: "Start solving",
});
