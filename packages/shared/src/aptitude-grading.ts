import { NUMERIC_COMPARE_SCALE, type AptitudeQuestionKind } from "./aptitude-question";

/**
 * Negative marking, per-section cutoffs and the all-or-nothing rule
 * (Phase 7). Pure arithmetic, and the thing this phase is gated on:
 *
 *   SPEC §5 — Done when: four gates green; a test asserts negative marking
 *   and per-section cutoffs compute correctly across all seeded patterns; a
 *   test asserts `allowBackNavigation: false` is enforced server-side, not
 *   just in the UI.
 *
 * This is the arithmetic a candidate will dispute, so every rule is stated
 * rather than implied. Four of them are genuinely ambiguous across recruiter
 * funnels and the spec settles none; each is recorded in
 * `docs/OPEN-QUESTIONS.md` with the narrower reading implemented here:
 *
 *   1. An UNANSWERED question scores exactly ZERO, never negative. Negative
 *      marking exists to discourage guessing; penalising a blank would punish
 *      running out of time instead, which is the opposite of what a section
 *      timer is for.
 *   2. MULTI_CHOICE is all-or-nothing on an exact set match, with the
 *      negative mark applied once for any wrong set. Partial credit needs a
 *      published formula a candidate can check their own marks against; the
 *      per-option conventions differ by recruiter and none is documented.
 *   3. A section's raw total carries its true signed sum (so a total is
 *      honest) while the REPORTED percent is floored at zero, and
 *      `passedCutoff` reads the floored percent — so a badly guessed section
 *      can never change another section's outcome, and no candidate is ever
 *      shown a negative percentage.
 *   4. There is NO overall cutoff. SPEC §5 lists "per-section cutoff" and
 *      nothing else, and an aggregate gate on top would be a rule the spec
 *      does not describe deciding whether someone clears a funnel.
 *
 * A numeric answer is compared at a FIXED decimal scale and never with float
 * equality: `0.1 + 0.2 <= 0.3` is false in binary floating point, and a
 * candidate who typed the right number must not lose a mark to that.
 */

/** How one question was answered. */
export type AnswerState = "CORRECT" | "WRONG" | "UNANSWERED";

/** A candidate's response to one question, as stored. */
export interface AnswerResponse {
  /** In the question's OWN option order (decision 12), not as shown. */
  readonly selectedIndexes: readonly number[];
  readonly numericValue: number | string | null;
}

/** The question's key, as stored. */
export interface AnswerKey {
  readonly kind: AptitudeQuestionKind;
  readonly correctOptionIndexes: readonly number[];
  readonly numericAnswer: number | string | null;
  readonly numericTolerance: number | string | null;
}

/** The scoring rule the section declares. */
export interface SectionScoring {
  readonly marksPerCorrect: number;
  /** A FRACTION of `marksPerCorrect` in [0, 1], never an absolute mark. */
  readonly negativeMarkFraction: number;
}

export interface GradedAnswer {
  readonly state: AnswerState;
  /** Null for an unanswered question: there is nothing to be right or wrong about. */
  readonly isCorrect: boolean | null;
  /** Signed. Positive for correct, negative or zero for wrong, exactly zero for unanswered. */
  readonly awarded: number;
}

/** Scaled integer arithmetic, so no comparison here is a float comparison. */
const SCALE = 10 ** NUMERIC_COMPARE_SCALE;
const scaled = (value: number | string): number => Math.round(Number(value) * SCALE);

/** Is a response present at all? Both shapes empty means unanswered. */
export function isAnswered(response: AnswerResponse): boolean {
  return response.selectedIndexes.length > 0 || response.numericValue !== null;
}

/**
 * Is this response right?
 *
 * MULTI_CHOICE requires the EXACT set: a strict subset of the key scores as
 * wrong, not as partially right (rule 2). A numeric response is right when it
 * is within the question's own tolerance, INCLUSIVELY — a candidate told
 * "within 0.01" who is exactly 0.01 away has done what they were asked.
 */
export function isResponseCorrect(key: AnswerKey, response: AnswerResponse): boolean {
  if (key.kind === "NUMERIC_ENTRY") {
    if (response.numericValue === null || key.numericAnswer === null) return false;
    const value = Number(response.numericValue);
    if (!Number.isFinite(value)) return false;
    const tolerance = key.numericTolerance === null ? 0 : Math.abs(scaled(key.numericTolerance));
    return Math.abs(scaled(value) - scaled(key.numericAnswer)) <= tolerance;
  }

  if (response.selectedIndexes.length === 0) return false;
  const wanted = new Set(key.correctOptionIndexes);
  const given = new Set(response.selectedIndexes);
  if (given.size !== wanted.size) return false;
  for (const index of wanted) if (!given.has(index)) return false;
  return true;
}

/**
 * Grade one answer.
 *
 * The single line in the phase most likely to be written wrongly, which is
 * why it is a pure function with a table-driven test over all six seeded
 * patterns.
 */
export function gradeAnswer(key: AnswerKey, response: AnswerResponse, scoring: SectionScoring): GradedAnswer {
  if (!isAnswered(response)) {
    // Rule 1. Not "a smaller penalty" — exactly zero.
    return { state: "UNANSWERED", isCorrect: null, awarded: 0 };
  }
  if (isResponseCorrect(key, response)) {
    return { state: "CORRECT", isCorrect: true, awarded: round6(scoring.marksPerCorrect) };
  }
  return {
    state: "WRONG",
    isCorrect: false,
    awarded: round6(-scoring.negativeMarkFraction * scoring.marksPerCorrect),
  };
}

/** A section as its pattern declares it. */
export interface SectionRule extends SectionScoring {
  readonly key: string;
  readonly label: string;
  /** Seconds. */
  readonly timeLimitSec: number;
  readonly questionCount: number;
  /** Percent of the section's marks a candidate must reach, in [0, 100]. */
  readonly cutoffPercent: number;
  /**
   * SPEC §5. False means a candidate cannot return to an answered question,
   * and the gate requires it enforced SERVER-side — a client that forgets is
   * a client that hands back the advantage the setting exists to remove.
   */
  readonly allowBackNavigation: boolean;
}

export interface SectionResult {
  readonly key: string;
  readonly label: string;
  readonly correct: number;
  readonly wrong: number;
  readonly unanswered: number;
  /** The TRUE signed sum, which may be negative (rule 3). */
  readonly rawScore: number;
  readonly maxScore: number;
  /** The reported figure: `rawScore / maxScore`, clamped to [0, 100]. */
  readonly percent: number;
  readonly cutoffPercent: number;
  readonly passedCutoff: boolean;
}

/** The reported percent for a raw total: floored at zero, capped at 100. */
export function sectionPercent(rawScore: number, maxScore: number): number {
  if (maxScore <= 0) return 0;
  return round2(Math.min(100, Math.max(0, (rawScore / maxScore) * 100)));
}

/**
 * Score one section from its already-graded answers.
 *
 * `maxScore` comes from the section's declared `questionCount` and not from
 * the number of answer rows: a candidate who never reached the last five
 * questions is still being scored out of the whole section, which is what the
 * cutoff means.
 */
export function scoreSection(rule: SectionRule, graded: readonly GradedAnswer[]): SectionResult {
  let correct = 0;
  let wrong = 0;
  let rawScore = 0;
  for (const answer of graded) {
    if (answer.state === "CORRECT") correct++;
    else if (answer.state === "WRONG") wrong++;
    rawScore += answer.awarded;
  }
  const maxScore = round6(rule.questionCount * rule.marksPerCorrect);
  const percent = sectionPercent(rawScore, maxScore);
  return {
    key: rule.key,
    label: rule.label,
    correct,
    wrong,
    // Every question the section declares that was not answered, including
    // the ones the candidate never saw.
    unanswered: Math.max(0, rule.questionCount - correct - wrong),
    rawScore: round6(rawScore),
    maxScore,
    percent,
    cutoffPercent: rule.cutoffPercent,
    // `>=`: a cutoff of 60 is cleared BY 60. A candidate who scores exactly
    // the published cutoff has met it, and a strict comparison would fail
    // them on a rule nobody wrote down.
    passedCutoff: percent >= rule.cutoffPercent,
  };
}

export interface MockResult {
  readonly sections: readonly SectionResult[];
  /** The true signed total. */
  readonly totalRaw: number;
  readonly totalMax: number;
  /** Clamped to [0, 100], so no candidate is shown a negative percentage. */
  readonly percent: number;
  readonly sectionsPassed: number;
  /**
   * True only when EVERY section cleared its own cutoff.
   *
   * A candidate at 90% quant and 10% verbal is screened out by the real
   * funnel; a mock that averaged them to 50% and said "pass" would tell them
   * the exact opposite of the truth, which is the whole reason the placement
   * cell wants this round simulated. There is no overall cutoff on top
   * (rule 4).
   */
  readonly passedOverall: boolean;
  /** The sections that were not cleared, in pattern order. */
  readonly failedSections: readonly string[];
}

export function scoreMock(
  rules: readonly SectionRule[],
  gradedBySection: Readonly<Record<string, readonly GradedAnswer[]>>,
): MockResult {
  const sections = rules.map((rule) => scoreSection(rule, gradedBySection[rule.key] ?? []));
  const totalRaw = round6(sections.reduce((sum, section) => sum + section.rawScore, 0));
  const totalMax = round6(sections.reduce((sum, section) => sum + section.maxScore, 0));
  const failedSections = sections.filter((section) => !section.passedCutoff).map((section) => section.key);
  return {
    sections,
    totalRaw,
    totalMax,
    percent: sectionPercent(totalRaw, totalMax),
    sectionsPassed: sections.length - failedSections.length,
    passedOverall: failedSections.length === 0,
    failedSections,
  };
}

/**
 * Marks, to the scale the database stores.
 *
 * The `+ 0` is not decoration: `-0.25 * 0` is `-0` in JavaScript, so a
 * section with no negative marking would award a wrong answer NEGATIVE zero —
 * which renders as "-0" in a mark column and compares unequal to 0 under
 * `Object.is`. A candidate should never see a minus sign they did not earn.
 */
function round6(value: number): number {
  return Math.round(value * SCALE) / SCALE + 0;
}

/** Percentages, to two places: a third place is noise a candidate would query. */
function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}
