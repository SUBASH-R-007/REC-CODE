/**
 * Marking the multiple-choice half of a paper (Phase 12r).
 *
 * An MCQ needs no judge: the answer is an index, the mark is a comparison,
 * and the whole thing is decided here where it can be unit-tested against
 * every shape a candidate can leave behind. That is the point of putting it
 * in `@recx/shared` rather than in a server action — the arithmetic a
 * student's result is built from should be readable without a database.
 *
 * Three rules, and each one is a decision rather than an obvious default:
 *
 *   - **Unanswered is zero, not wrong.** They are the same number here,
 *     and they are not the same thing on a report: a blank is a question
 *     the candidate ran out of time for, and staff reviewing a paper need
 *     to tell those apart from one they got wrong. So the breakdown counts
 *     them separately even though both score nothing.
 *   - **No negative marking.** It would have to be configurable per paper
 *     to be fair, and a wrong guess costing marks changes how a candidate
 *     uses the clock. Not a default to slip in; if a department wants it,
 *     it is a field on the assessment and a decision someone signs off.
 *   - **An option the candidate never saw cannot be their answer.** The
 *     stored answer is an index into the paper's OWN option order, which is
 *     shuffled per candidate, so marking compares what they picked after
 *     mapping it back. An index outside the order they were shown is not a
 *     wrong answer, it is a corrupt one, and it is reported as such rather
 *     than silently marked zero.
 */

import { moderatedMark, type QuestionModeration } from "./exam-moderation";

export interface McqMarkingInput {
  readonly mcqId: string;
  readonly points: number;
  /** The order of options this candidate was shown, as stored indexes. */
  readonly optionOrder: readonly number[];
  /** The stored index of the correct option. */
  readonly correctIndex: number;
  /** What the candidate picked, as a position in the order they were shown. */
  readonly chosenShownIndex: number | null;
  /**
   * Phase 13i: awarded to everyone, or dropped from the paper. Absent
   * means NONE, which is what every question is until somebody decides
   * otherwise after the paper has been sat.
   */
  readonly moderation?: QuestionModeration;
}

export type McqOutcome = "correct" | "wrong" | "blank" | "corrupt" | "awarded" | "dropped";

export interface McqMark {
  readonly mcqId: string;
  readonly outcome: McqOutcome;
  readonly points: number;
  readonly maxPoints: number;
}

export interface McqTotals {
  readonly marks: readonly McqMark[];
  readonly points: number;
  readonly maxPoints: number;
  readonly correct: number;
  readonly wrong: number;
  readonly blank: number;
  readonly corrupt: number;
  /** Phase 13i: awarded to everyone, and withdrawn from the paper. */
  readonly awarded: number;
  readonly dropped: number;
}

/** Which stored option a candidate picked, or null when they picked none. */
export function storedIndexOf(input: Pick<McqMarkingInput, "optionOrder" | "chosenShownIndex">): number | null {
  const { optionOrder, chosenShownIndex } = input;
  if (chosenShownIndex === null) return null;
  if (!Number.isInteger(chosenShownIndex) || chosenShownIndex < 0 || chosenShownIndex >= optionOrder.length) {
    return null;
  }
  return optionOrder[chosenShownIndex] ?? null;
}

export function markMcq(input: McqMarkingInput): McqMark {
  const max = input.points;
  /**
   * Moderation first (Phase 13i). A question awarded to everyone or
   * dropped from the paper is not marked at all, so what the candidate
   * left behind -- blank, wrong, even a corrupt index -- cannot change
   * what it is worth. Deciding it afterwards would mean a dropped
   * question still reported somebody as having got it wrong.
   */
  const moderated = moderatedMark(input.moderation, max);
  if (moderated) return { mcqId: input.mcqId, ...moderated };
  if (input.chosenShownIndex === null) {
    return { mcqId: input.mcqId, outcome: "blank", points: 0, maxPoints: max };
  }
  const stored = storedIndexOf(input);
  if (stored === null) {
    // Out of range for the order this candidate was shown: not a wrong
    // answer, a broken one. Reported so it is looked at rather than losing
    // somebody marks quietly.
    return { mcqId: input.mcqId, outcome: "corrupt", points: 0, maxPoints: max };
  }
  const right = stored === input.correctIndex;
  return {
    mcqId: input.mcqId,
    outcome: right ? "correct" : "wrong",
    // No negative marking: a wrong answer scores nothing, it does not cost.
    points: right ? max : 0,
    maxPoints: max,
  };
}

export function markMcqs(inputs: readonly McqMarkingInput[]): McqTotals {
  const marks = inputs.map(markMcq);
  const count = (outcome: McqOutcome) => marks.filter((m) => m.outcome === outcome).length;
  return {
    marks,
    points: marks.reduce((sum, m) => sum + m.points, 0),
    maxPoints: marks.reduce((sum, m) => sum + m.maxPoints, 0),
    correct: count("correct"),
    wrong: count("wrong"),
    blank: count("blank"),
    corrupt: count("corrupt"),
    awarded: count("awarded"),
    dropped: count("dropped"),
  };
}

/**
 * How many questions a paper actually asks (Phase 12r).
 *
 * Stated once, because getting it wrong is invisible and was got wrong
 * three times in one slice. A paper may be all code, all multiple-choice,
 * or a mix, and only none of each is an empty paper — but three separate
 * places counted the coding questions alone:
 *
 *   - publishing refused an all-multiple-choice paper as "an empty paper
 *     is not a test";
 *   - `startAttempt` refused it as `not_open`, which is the refusal whose
 *     message gives a candidate the least to go on;
 *   - and `submitAttempt` took its "nothing to submit" path, so the one
 *     kind of paper where the questions ARE the paper was the one where
 *     nothing recorded what they came to.
 *
 * Each read naturally and none of them was found by a type. So the rule
 * lives here, and the three call sites ask it.
 */
export function paperQuestionCount(paper: {
  readonly problems?: { readonly length: number } | null;
  readonly mcqs?: { readonly length: number } | null;
}): number {
  return (paper.problems?.length ?? 0) + (paper.mcqs?.length ?? 0);
}
