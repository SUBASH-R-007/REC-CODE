/**
 * Per-candidate randomisation (Phase 6c). Pure, and deterministic for a
 * given seed — which is the whole point.
 *
 * SPEC §5:
 *
 *   seed = HMAC-SHA256(assessment.secret, attemptId), feeding xoshiro128**.
 *   Resolve: question selection against an AssessmentBlueprint [...]; MCQ
 *   option order (excluding fixedPosition options like "None of the above");
 *   hidden-test execution order; and, where a problem ships a TestGenerator +
 *   reference solution, per-candidate test data generated at session-prepare
 *   time [...]. Freeze the whole resolution into AssessmentAttempt.layout so
 *   a reload or resume returns an identical paper.
 *
 *   Randomisation is the only anti-cheating control that costs the honest
 *   student nothing and has no bypass — the server simply never sends the
 *   same paper twice.
 *
 * The HMAC lives in apps/web (it needs a secret and node:crypto); this module
 * takes the resulting 32-bit seed and does the arithmetic, so the resolution
 * is unit-testable without a key and reproducible from a stored seed when a
 * paper is disputed.
 */

/**
 * xoshiro128**, the generator the spec names. Four 32-bit words of state,
 * seeded by splitmix32 from one integer so a single seed still gives a
 * well-distributed state.
 *
 * Why not `Math.random()`: a disputed paper has to be reproducible years
 * later from `AssessmentAttempt.seed` alone, and `Math.random()` is neither
 * seedable nor stable across engines. Why not a one-liner LCG: the low bits
 * of a small LCG are visibly patterned, and "question 1 is always the easy
 * one" is a pattern candidates would find within a semester.
 */
export function xoshiro128ss(seed: number): () => number {
  // splitmix32, to spread one integer into four words.
  let x = seed >>> 0;
  const next32 = () => {
    x = (x + 0x9e37_79b9) >>> 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
  let s0 = next32();
  let s1 = next32();
  let s2 = next32();
  let s3 = next32();
  // An all-zero state is a fixed point; one bit avoids it.
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  return () => {
    const result = (Math.imul(Math.imul(s1, 5) >>> 0, 9) >>> 0) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = ((s3 << 11) | (s3 >>> 21)) >>> 0;
    // [0, 1) with 32 bits of resolution.
    return result / 4_294_967_296;
  };
}

/**
 * Fisher-Yates, with the generator supplied. Returns a new array; the input
 * is untouched, because the caller's list is the assessment's own order and
 * is used elsewhere.
 */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A 32-bit seed for one question, derived from the attempt's seed and the
 * question's own position — so the hidden-test order for question 3 is fixed
 * whatever happens to the other questions, and re-deriving one question's
 * paper does not require replaying the whole resolution.
 */
export function questionSeed(attemptSeed: number, position: number): number {
  let z = (attemptSeed + Math.imul(position, 0x9e37_79b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/** One question as the candidate will see it. */
export interface LayoutQuestion {
  /** The AssessmentProblem row. */
  readonly questionId: string;
  /** The frozen ProblemVersion the candidate is judged against. */
  readonly problemVersionId: string;
  /** The assessment's own 1-based position, kept for staff and the report. */
  readonly sourcePosition: number;
  readonly points: number;
  /** Seeds this question's hidden-test order and any generated test data. */
  readonly seed: number;
}

/**
 * The frozen paper. Stored whole in `AssessmentAttempt.layout`, so a reload,
 * a resume or a dispute three months later returns an identical paper —
 * `layout` is in the write-once tuple the `AssessmentAttempt_machine` trigger
 * refuses to change.
 */
export interface AttemptLayout {
  /** Schema version, so a later phase can add fields and still read this. */
  readonly v: 1;
  readonly questions: readonly LayoutQuestion[];
}

export interface AssessmentQuestionInput {
  readonly id: string;
  readonly problemVersionId: string;
  readonly position: number;
  readonly points: number;
}

/**
 * Resolve one candidate's paper.
 *
 * Phase 6c randomises ORDER and derives a per-question seed. Question
 * SELECTION against an `AssessmentBlueprint` (2×EASY + 2×MEDIUM + 1×HARD
 * from pools ≥5× the needed count) needs a model that does not exist yet and
 * is recorded in docs/OPEN-QUESTIONS.md; when it arrives it changes what goes
 * into `questions` and nothing about this shape, which is why the layout is
 * versioned.
 */
export function resolveLayout(args: {
  readonly questions: readonly AssessmentQuestionInput[];
  readonly seed: number;
  /** False keeps the assessment's own order (an ordered paper, or staff preview). */
  readonly randomiseOrder?: boolean;
}): AttemptLayout {
  const ordered = [...args.questions].sort((a, b) => a.position - b.position);
  const random = xoshiro128ss(args.seed);
  const sequence = args.randomiseOrder === false ? ordered : shuffled(ordered, random);
  return {
    v: 1,
    questions: sequence.map((question) => ({
      questionId: question.id,
      problemVersionId: question.problemVersionId,
      sourcePosition: question.position,
      points: question.points,
      // Keyed on the question's own source position, not its shuffled index,
      // so a candidate's test order for a given problem is stable even if the
      // order resolution ever changes.
      seed: questionSeed(args.seed, question.position),
    })),
  };
}

/** Narrow a stored `layout` jsonb back to a paper. Throws on anything else. */
export function parseAttemptLayout(value: unknown): AttemptLayout {
  const layout = value as Partial<AttemptLayout> | null;
  if (!layout || layout.v !== 1 || !Array.isArray(layout.questions)) {
    throw new Error("stored attempt layout is not a v1 layout");
  }
  for (const question of layout.questions) {
    if (
      typeof question?.questionId !== "string" ||
      typeof question?.problemVersionId !== "string" ||
      typeof question?.sourcePosition !== "number" ||
      typeof question?.seed !== "number"
    ) {
      throw new Error("stored attempt layout has a malformed question");
    }
  }
  return layout as AttemptLayout;
}
