/**
 * Written and system-design answers, graded against a rubric (Phase 12i).
 *
 * SPEC §11, the last line of the Phase 11+ list: "written/system-design
 * with rubric grading". Nothing here runs code — a system-design answer
 * has no test cases, and the thing being practised is the explanation
 * rather than the program.
 *
 * **The rubric is written before the answer and shown with the prompt.**
 * A student can read every criterion and its weight before they start.
 * That is the whole difference between a rubric and a mark: a mark says
 * how it went, a rubric says what is being looked for, and a student who
 * can see what is being looked for can practise against it. It also puts
 * a floor under the grading — a TA marking against four named criteria
 * writes something more useful than a TA marking against a feeling.
 *
 * **The score feeds nothing.** Not XP, not the leaderboard, not readiness,
 * not a band on anybody's profile. It is one person's reading of one
 * answer, which is exactly as good as one person's reading of one answer.
 * The product's rule everywhere else is that a human judgement stays a
 * human judgement (`mock-interview.ts` says the same of interview
 * feedback); a weighted percentage that fed a dashboard would be a number
 * students optimise and graders learn to inflate.
 *
 * **The time box is advice, not a clock.** A prompt says "about 45
 * minutes" because knowing the intended size is part of the exercise, and
 * nothing in here enforces it. An answer written over three evenings is
 * still worth grading; a timer on an unproctored text box would only
 * teach students to draft somewhere else and paste.
 */

export const WRITTEN_KINDS = ["SYSTEM_DESIGN", "WRITTEN"] as const;
export type WrittenKind = (typeof WRITTEN_KINDS)[number];

export const WRITTEN_KIND_LABEL: Readonly<Record<WrittenKind, string>> = Object.freeze({
  SYSTEM_DESIGN: "System design",
  WRITTEN: "Written answer",
});

export const WRITTEN_KIND_HINT: Readonly<Record<WrittenKind, string>> = Object.freeze({
  SYSTEM_DESIGN:
    "Design a system and say why. Interfaces, data, the failure you are most worried about — not code.",
  WRITTEN: "Explain something in prose. The marks are for the reasoning, not for the vocabulary.",
});

// ── The prompt's own lifecycle ──────────────────────────────────────────

export const WRITTEN_PROMPT_STATUSES = ["DRAFT", "PUBLISHED", "RETIRED"] as const;
export type WrittenPromptStatus = (typeof WRITTEN_PROMPT_STATUSES)[number];

export const WRITTEN_PROMPT_STATUS_LABEL: Readonly<Record<WrittenPromptStatus, string>> = Object.freeze({
  DRAFT: "Draft",
  PUBLISHED: "Open",
  RETIRED: "Retired",
});

/**
 * What a prompt may become next.
 *
 * RETIRED is terminal and does not delete anything: a retired prompt
 * disappears from the list and every answer already written against it
 * stays readable by its author. A question withdrawn after fifty students
 * answered it must not take their work with it.
 */
export const WRITTEN_PROMPT_NEXT: Readonly<Record<WrittenPromptStatus, readonly WrittenPromptStatus[]>> =
  Object.freeze({
    DRAFT: ["PUBLISHED", "RETIRED"],
    PUBLISHED: ["RETIRED"],
    RETIRED: [],
  });

export function canTransitionPrompt(from: WrittenPromptStatus, to: WrittenPromptStatus): boolean {
  return WRITTEN_PROMPT_NEXT[from].includes(to);
}

/**
 * A published prompt's rubric is fixed.
 *
 * Changing a criterion or its weight after answers exist would re-mark
 * work nobody looked at again: a student graded 12/16 against four
 * criteria did not get that score against five. The editing surface
 * refuses it, and so does the database.
 */
export function rubricEditable(status: WrittenPromptStatus): boolean {
  return status === "DRAFT";
}

// ── The answer's lifecycle ──────────────────────────────────────────────

export const WRITTEN_ANSWER_STATUSES = ["DRAFT", "SUBMITTED", "GRADED"] as const;
export type WrittenAnswerStatus = (typeof WRITTEN_ANSWER_STATUSES)[number];

export const WRITTEN_ANSWER_STATUS_LABEL: Readonly<Record<WrittenAnswerStatus, string>> = Object.freeze({
  DRAFT: "Draft",
  SUBMITTED: "Waiting to be read",
  GRADED: "Marked",
});

export const WRITTEN_ANSWER_NEXT: Readonly<Record<WrittenAnswerStatus, readonly WrittenAnswerStatus[]>> =
  Object.freeze({
    DRAFT: ["SUBMITTED"],
    SUBMITTED: ["GRADED", "DRAFT"],
    GRADED: [],
  });

export function canTransitionAnswer(from: WrittenAnswerStatus, to: WrittenAnswerStatus): boolean {
  return WRITTEN_ANSWER_NEXT[from].includes(to);
}

/**
 * SUBMITTED may go back to DRAFT, and that is a grader's doing rather than
 * a student's: handing an answer back unmarked ("you have described the
 * API and not the storage") is a better outcome than marking it 4/16, and
 * a student who could withdraw their own submission at will would make
 * the queue meaningless.
 */
export function mayEditAnswer(status: WrittenAnswerStatus): boolean {
  return status === "DRAFT";
}

export function mayGrade(status: WrittenAnswerStatus): boolean {
  return status === "SUBMITTED";
}

// ── The rubric ──────────────────────────────────────────────────────────

/** A criterion is marked out of four. */
export const WRITTEN_MARK_MIN = 0;
export const WRITTEN_MARK_MAX = 4;

/**
 * What each mark means, written once so two TAs mean the same thing by a
 * 3 and a student can see the ladder before they write.
 */
export const WRITTEN_MARK_LABEL: Readonly<Record<number, string>> = Object.freeze({
  0: "Not addressed",
  1: "Mentioned, not reasoned",
  2: "Reasoned, with a gap",
  3: "Solid",
  4: "Solid, and says what it costs",
});

export interface RubricCriterion {
  /** 1 (nice to have) to 5 (the point of the question). */
  weight: number;
}

export interface CriterionMark {
  points: number;
}

export const WRITTEN_LIMITS = Object.freeze({
  criteriaPerPrompt: Object.freeze({ min: 2, max: 8 }),
  weight: Object.freeze({ min: 1, max: 5 }),
  title: Object.freeze({ min: 8, max: 160 }),
  prompt: Object.freeze({ min: 50, max: 8_000 }),
  criterionLabel: Object.freeze({ min: 3, max: 120 }),
  criterionGuidance: Object.freeze({ max: 400 }),
  answer: Object.freeze({ min: 120, max: 20_000 }),
  markNote: Object.freeze({ max: 500 }),
  overallNote: Object.freeze({ min: 30, max: 4_000 }),
  timeBoxMinutes: Object.freeze({ min: 10, max: 180 }),
});

export interface RubricScore {
  /** Weighted marks earned. */
  points: number;
  /** Weighted marks available. */
  outOf: number;
  /** 0–100, rounded to the nearest whole number. */
  percent: number;
}

/**
 * The weighted total.
 *
 * Weights multiply rather than scale the question: a criterion worth 5
 * contributes five times what a criterion worth 1 does, and the
 * denominator says so, so a student can check the arithmetic themselves.
 * An unmarked criterion is not "zero" — `unmarked()` refuses the grade
 * before this is ever called with a hole in it.
 */
export function rubricScore(criteria: readonly RubricCriterion[], marks: readonly CriterionMark[]): RubricScore {
  const outOf = criteria.reduce((sum, c) => sum + c.weight * WRITTEN_MARK_MAX, 0);
  const points = criteria.reduce((sum, c, i) => sum + c.weight * (marks[i]?.points ?? 0), 0);
  return { points, outOf, percent: outOf === 0 ? 0 : Math.round((points / outOf) * 100) };
}

/**
 * The criteria a grader has not marked yet, by index.
 *
 * A rubric with a hole in it is not a rubric; the grade action refuses
 * until every criterion carries a mark, which is also what stops a grader
 * from quietly skipping the one they are least sure about.
 */
export function unmarkedCriteria(
  criteria: readonly RubricCriterion[],
  marks: ReadonlyArray<CriterionMark | undefined>,
): number[] {
  return criteria
    .map((_, index) => index)
    .filter((index) => {
      const mark = marks[index];
      return (
        mark === undefined ||
        !Number.isInteger(mark.points) ||
        mark.points < WRITTEN_MARK_MIN ||
        mark.points > WRITTEN_MARK_MAX
      );
    });
}

/** "11 of 16 — about 45 minutes' work." Never a band, never a grade letter. */
export function scoreLine(score: RubricScore): string {
  return `${score.points} of ${score.outOf} weighted marks (${score.percent}%)`;
}

// ── What people are told ────────────────────────────────────────────────

export const WRITTEN_NOTICES = Object.freeze({
  rubricVisible:
    "The rubric below is what your answer is marked against. It is the same list the person reading it works through.",
  timeBox:
    "That is how long the question is meant to take, not a limit. Nothing here is timed, and nothing closes.",
  gradingCountsForNothing:
    "A mark here is one TA's reading of one answer. It is not XP, it is not on the leaderboard, it does not change your readiness, and no recruiter sees it.",
  graderSeesName: "The person marking your answer sees your name. This is coursework, not the discussion board.",
  handBack:
    "Handing it back puts the answer in their drafts with your note, unmarked. Use it when a mark would say less than a sentence would.",
});

export const WRITTEN_REFUSALS = Object.freeze({
  notPublished: "That question is not open for answers.",
  alreadySubmitted: "You have already handed that in. Ask the TA to hand it back if you need to change it.",
  notYours: "That answer is not yours.",
  notSubmitted: "That answer has not been handed in yet.",
  alreadyGraded: "That answer has already been marked.",
  ownAnswer: "You cannot mark your own answer.",
  rubricFixed: "That question is open, so its rubric cannot change. Retire it and write a new one.",
  rubricIncomplete: "Mark every criterion before you save — a rubric with a gap in it is not a rubric.",
  tooShort: "There is not enough here to mark. Say what you would build and why.",
  needsCriteria: "A question needs at least two criteria, so the mark says more than good or bad.",
});
