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
/**
 * What a candidate is asked to produce (Phase 16f).
 *
 * `CODE` is a program, which is every question laid out before this field
 * existed and most questions after it. `ANSWER` is an output-only problem:
 * the submission IS the answer, worked out however the candidate likes and
 * typed into a box — no compiler, no run, no language to choose.
 *
 * A KIND rather than a language, deliberately. `answer1` is a
 * `SubmitLanguageKey` and not in `LANGUAGE_CATALOG`, precisely so that
 * nothing treats it as a toolchain; widening `LanguageKey` to carry it
 * would spread "this might not be a program" through every route that
 * validates one. One field, read in the four places that care, is the
 * smaller change and the honest one.
 */
export const EXAM_QUESTION_KINDS = ["CODE", "ANSWER"] as const;
export type ExamQuestionKind = (typeof EXAM_QUESTION_KINDS)[number];

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
  /**
   * The languages THIS question may be answered in (Phase 13c), frozen
   * with everything else.
   *
   * Absent means "whatever the paper accepts", which is what every
   * question laid out before this field existed means and what most
   * questions mean anyway. Present, it is already narrowed to the paper's
   * set -- a question cannot accept something the paper does not, because
   * the paper is what the candidate was told before the clock started.
   */
  readonly languages?: readonly string[];
  /**
   * `ANSWER` for an output-only question (Phase 16f); absent means CODE.
   *
   * Frozen with the rest of the layout, like the version ids and the
   * languages: a problem republished mid-sitting must not turn a code
   * editor into an answer box under somebody who is part way through.
   */
  readonly kind?: ExamQuestionKind;
}

/**
 * The frozen paper. Stored whole in `AssessmentAttempt.layout`, so a reload,
 * a resume or a dispute three months later returns an identical paper —
 * `layout` is in the write-once tuple the `AssessmentAttempt_machine` trigger
 * refuses to change.
 */
export interface AttemptLayout {
  /**
   * Schema version, so a later phase can add fields and still read this.
   *
   * v2 (Phase 12r) is v1 plus `mcqs`. It is a new VERSION rather than an
   * optional field on v1 for one reason: `parseAttemptLayout` ignores keys
   * it does not know, so a v1 reader handed a layout carrying MCQs would
   * accept it and silently serve a paper missing those questions — a
   * candidate sitting an exam short of half its marks, with nothing
   * anywhere saying so. A v1 reader handed a v2 layout refuses it instead,
   * which is a visible failure an invigilator can act on. A paper with no
   * MCQs is still written as v1, so nothing already stored changes.
   */
  readonly v: 1 | 2;
  readonly questions: readonly LayoutQuestion[];
  /** Present only on v2, and only when the paper holds MCQs. */
  readonly mcqs?: readonly LayoutMcq[];
  /**
   * The toolchain key this paper is answered in, frozen with everything
   * else (Phase 12r.4).
   *
   * It used to be derived per request as "the first enabled language",
   * which meant a sitting could change language underneath the candidate:
   * an administrator enabling a toolchain whose key sorts earlier, while
   * someone was part way through, would move the whole paper to it. The
   * starter code in the editor, the language the submission is created
   * with and the language the Run route accepts all follow from it, so
   * the candidate's editor would be holding C++ while the server had
   * decided the paper was C.
   *
   * A layout is the write-once record of what a candidate was asked, and
   * the language they were asked in belongs in it for the same reason the
   * frozen version ids do.
   *
   * Optional because attempts started before this field existed do not
   * carry it; readers fall back to deriving it, which is what they did
   * for all of those attempts anyway.
   */
  readonly language?: string;
  /**
   * Every language this paper may be answered in, frozen with it (Phase
   * 13a).
   *
   * `language` above is the one the editor opens in; this is the set the
   * candidate may choose from and the set the run, snapshot and submit
   * paths accept. It is frozen for the reason `language` is: an
   * administrator who narrows the paper's accepted list while somebody is
   * part way through must not strand them in a language the server has
   * stopped accepting -- with their answer written in it and a clock
   * running.
   *
   * Optional, because attempts started before this field existed do not
   * carry it. A reader falls back to `[language]`, which is exactly what
   * those sittings allowed: one language, fixed.
   */
  readonly languages?: readonly string[];
}

/** One multiple-choice question on a candidate's paper (Phase 12r). */
export interface LayoutMcq {
  /** The AssessmentMcq row. */
  readonly mcqId: string;
  /** The assessment's own 1-based position, shared with the coding questions. */
  readonly sourcePosition: number;
  readonly points: number;
  /**
   * The order this candidate sees the options in, as indexes into the
   * stored `options`. Shuffling the options is the only randomisation an
   * MCQ gets, and it is what stops a neighbour's "it's the third one"
   * being useful. The stored order is never shown.
   */
  readonly optionOrder: readonly number[];
}

export interface AssessmentQuestionInput {
  readonly id: string;
  readonly problemVersionId: string;
  readonly position: number;
  readonly points: number;
  /** Phase 13c: the languages this question narrows the paper to, if any. */
  readonly languages?: readonly string[];
  /** Phase 16f: `ANSWER` for an output-only question. Absent means CODE. */
  readonly kind?: ExamQuestionKind;
}

/** An MCQ of the paper, as the assessment stores it (Phase 12r). */
export interface AssessmentMcqInput {
  readonly id: string;
  readonly position: number;
  readonly points: number;
  /** How many options it has; the text is not needed to lay a paper out. */
  readonly optionCount: number;
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
  /** The paper's MCQs (Phase 12r). Absent or empty keeps the layout at v1. */
  readonly mcqs?: readonly AssessmentMcqInput[];
  /** The toolchain key the paper is answered in (Phase 12r.4). */
  readonly language?: string;
  /** Every key it MAY be answered in (Phase 13a); frozen with the paper. */
  readonly languages?: readonly string[];
}): AttemptLayout {
  const ordered = [...args.questions].sort((a, b) => a.position - b.position);
  const random = xoshiro128ss(args.seed);
  const sequence = args.randomiseOrder === false ? ordered : shuffled(ordered, random);
  /**
   * The MCQs are laid out from their OWN generator, seeded per question,
   * rather than from `random` above. Drawing them from the shared stream
   * would make a coding question's shuffle depend on how many MCQs the
   * paper happens to hold, so adding one MCQ would silently re-order every
   * candidate's coding questions — and the seeds are what make a paper
   * reproducible for an appeal.
   */
  const mcqs = [...(args.mcqs ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((mcq) => ({
      mcqId: mcq.id,
      sourcePosition: mcq.position,
      points: mcq.points,
      optionOrder: shuffled(
        Array.from({ length: mcq.optionCount }, (_, i) => i),
        xoshiro128ss(questionSeed(args.seed, mcq.position)),
      ),
    }));
  /**
   * Written only when there is something to write, so a paper laid out by
   * a caller that does not know about accepted languages is stored exactly
   * as it was before this field existed.
   */
  const languages =
    args.languages === undefined || args.languages.length === 0 ? {} : { languages: [...args.languages] };
  if (mcqs.length > 0) {
    return {
      v: 2,
      questions: codingQuestions(sequence, args.seed),
      mcqs,
      ...(args.language === undefined ? {} : { language: args.language }),
      ...languages,
    };
  }
  return {
    v: 1,
    questions: codingQuestions(sequence, args.seed),
    ...(args.language === undefined ? {} : { language: args.language }),
    ...languages,
  };
}

/**
 * One mapping for both layout versions, so a v1 and a v2 paper can never
 * describe the same coding question differently.
 */
function codingQuestions(sequence: readonly AssessmentQuestionInput[], seed: number): LayoutQuestion[] {
  return sequence.map((question) => ({
    questionId: question.id,
    problemVersionId: question.problemVersionId,
    sourcePosition: question.position,
    points: question.points,
    // Written only when the question narrows the paper (Phase 13c), so a
    // layout is byte-identical to one from before this field for every
    // question that does not.
    ...(question.languages === undefined || question.languages.length === 0
      ? {}
      : { languages: [...question.languages] }),
    // Phase 16f, written only when it is not CODE, so a layout is
    // byte-identical to one from before this field for every ordinary
    // question.
    ...(question.kind === undefined || question.kind === "CODE" ? {} : { kind: question.kind }),
    // Keyed on the question's own source position, not its shuffled index,
    // so a candidate's test order for a given problem is stable even if the
    // order resolution ever changes.
    seed: questionSeed(seed, question.position),
  }));
}

/** Narrow a stored `layout` jsonb back to a paper. Throws on anything else. */
export function parseAttemptLayout(value: unknown): AttemptLayout {
  const layout = value as Partial<AttemptLayout> | null;
  if (!layout || (layout.v !== 1 && layout.v !== 2) || !Array.isArray(layout.questions)) {
    throw new Error("stored attempt layout is not a v1 or v2 layout");
  }
  /**
   * The version and the MCQs agree, in both directions. A v1 carrying MCQs
   * was written by something that did not know what it was doing and
   * serving it would quietly drop them; a v2 carrying none is a version
   * bump for nothing, which makes the version stop meaning anything. Both
   * are refused so the one fact the version asserts stays true.
   */
  if (layout.v === 1 && layout.mcqs !== undefined) {
    throw new Error("stored attempt layout is v1 but carries mcqs");
  }
  if (layout.v === 2 && (!Array.isArray(layout.mcqs) || layout.mcqs.length === 0)) {
    throw new Error("stored attempt layout is v2 but carries no mcqs");
  }
  if (layout.language !== undefined && (typeof layout.language !== "string" || layout.language.length === 0)) {
    throw new Error("stored attempt layout has a malformed language");
  }
  /**
   * The accepted set is refused rather than repaired if it is wrong
   * (Phase 13a). A layout is the record of what a candidate was asked;
   * silently dropping a malformed field here would hand them a paper
   * whose accepted languages are not the ones their sitting was laid out
   * with, which is the thing freezing it exists to prevent. An EMPTY array
   * is malformed too: a sitting that accepts nothing cannot be answered,
   * and "no restriction" is written by omitting the field.
   */
  if (layout.languages !== undefined) {
    if (
      !Array.isArray(layout.languages) ||
      layout.languages.length === 0 ||
      layout.languages.some((key: unknown) => typeof key !== "string" || key.length === 0)
    ) {
      throw new Error("stored attempt layout has malformed languages");
    }
  }
  if (layout.mcqs !== undefined) {
    if (!Array.isArray(layout.mcqs)) throw new Error("stored attempt layout has malformed mcqs");
    for (const mcq of layout.mcqs) {
      if (
        typeof mcq?.mcqId !== "string" ||
        typeof mcq?.sourcePosition !== "number" ||
        typeof mcq?.points !== "number" ||
        !Array.isArray(mcq?.optionOrder) ||
        mcq.optionOrder.length === 0 ||
        mcq.optionOrder.some((i: unknown) => typeof i !== "number")
      ) {
        throw new Error("stored attempt layout has a malformed mcq");
      }
    }
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
    // Refused rather than repaired, for the reason the paper's own set is
    // (Phase 13c): this is the record of what a candidate was asked.
    if (question.languages !== undefined) {
      if (
        !Array.isArray(question.languages) ||
        question.languages.length === 0 ||
        question.languages.some((key: unknown) => typeof key !== "string" || key.length === 0)
      ) {
        throw new Error("stored attempt layout has a malformed question language list");
      }
    }
    /**
     * Phase 16f, refused rather than repaired for the same reason. A kind
     * nobody recognises would quietly become CODE, and a candidate asked
     * for an answer would be handed a code editor over a question that
     * wants a number — which is exactly what the refusal this replaces
     * existed to prevent.
     */
    if (question.kind !== undefined && !EXAM_QUESTION_KINDS.includes(question.kind as ExamQuestionKind)) {
      throw new Error("stored attempt layout has a malformed question kind");
    }
  }
  return layout as AttemptLayout;
}
