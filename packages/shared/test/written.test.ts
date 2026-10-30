import { describe, expect, it } from "vitest";
import {
  WRITTEN_ANSWER_NEXT,
  WRITTEN_ANSWER_STATUSES,
  WRITTEN_ANSWER_STATUS_LABEL,
  WRITTEN_KINDS,
  WRITTEN_KIND_HINT,
  WRITTEN_KIND_LABEL,
  WRITTEN_LIMITS,
  WRITTEN_MARK_LABEL,
  WRITTEN_MARK_MAX,
  WRITTEN_MARK_MIN,
  WRITTEN_NOTICES,
  WRITTEN_PROMPT_NEXT,
  WRITTEN_PROMPT_STATUSES,
  WRITTEN_REFUSALS,
  canTransitionAnswer,
  canTransitionPrompt,
  mayEditAnswer,
  mayGrade,
  rubricEditable,
  rubricScore,
  scoreLine,
  unmarkedCriteria,
  type WrittenAnswerStatus,
} from "../src/index";

describe("the question's lifecycle", () => {
  it("opens a draft and retires it, and never reopens a retired one", () => {
    expect(canTransitionPrompt("DRAFT", "PUBLISHED")).toBe(true);
    expect(canTransitionPrompt("PUBLISHED", "RETIRED")).toBe(true);
    expect(canTransitionPrompt("DRAFT", "RETIRED")).toBe(true);
    expect(canTransitionPrompt("RETIRED", "PUBLISHED")).toBe(false);
    expect(canTransitionPrompt("PUBLISHED", "DRAFT")).toBe(false);
    expect(WRITTEN_PROMPT_NEXT.RETIRED).toEqual([]);
  });

  it("freezes the rubric the moment the question is open", () => {
    // A student marked 12 of 16 against four criteria did not get that
    // score against five.
    expect(rubricEditable("DRAFT")).toBe(true);
    expect(rubricEditable("PUBLISHED")).toBe(false);
    expect(rubricEditable("RETIRED")).toBe(false);
  });

  it("labels every status", () => {
    for (const status of WRITTEN_PROMPT_STATUSES) expect(status.length).toBeGreaterThan(0);
    for (const kind of WRITTEN_KINDS) {
      expect(WRITTEN_KIND_LABEL[kind].length).toBeGreaterThan(3);
      expect(WRITTEN_KIND_HINT[kind].length).toBeGreaterThan(20);
    }
  });
});

describe("the answer's lifecycle", () => {
  it("drafts, hands in and marks", () => {
    expect(canTransitionAnswer("DRAFT", "SUBMITTED")).toBe(true);
    expect(canTransitionAnswer("SUBMITTED", "GRADED")).toBe(true);
  });

  it("lets a grader hand it back, and a student not withdraw it", () => {
    // Handing back is the grader's doing: a student who could withdraw a
    // submission at will would make the queue meaningless.
    expect(canTransitionAnswer("SUBMITTED", "DRAFT")).toBe(true);
    expect(mayEditAnswer("SUBMITTED")).toBe(false);
    expect(mayEditAnswer("DRAFT")).toBe(true);
  });

  it("makes a mark final", () => {
    expect(WRITTEN_ANSWER_NEXT.GRADED).toEqual([]);
    for (const to of WRITTEN_ANSWER_STATUSES) expect(canTransitionAnswer("GRADED", to)).toBe(false);
    expect(mayEditAnswer("GRADED")).toBe(false);
    expect(mayGrade("GRADED")).toBe(false);
  });

  it("refuses every jump", () => {
    expect(canTransitionAnswer("DRAFT", "GRADED")).toBe(false);
    expect(mayGrade("DRAFT")).toBe(false);
    expect(mayGrade("SUBMITTED")).toBe(true);
  });

  it("labels every status", () => {
    for (const status of WRITTEN_ANSWER_STATUSES) {
      expect(WRITTEN_ANSWER_STATUS_LABEL[status as WrittenAnswerStatus].length).toBeGreaterThan(3);
    }
  });
});

describe("the arithmetic", () => {
  const criteria = [{ weight: 5 }, { weight: 3 }, { weight: 1 }];

  it("weights each criterion and shows the denominator", () => {
    const score = rubricScore(criteria, [{ points: 4 }, { points: 2 }, { points: 0 }]);
    expect(score.outOf).toBe((5 + 3 + 1) * WRITTEN_MARK_MAX);
    expect(score.points).toBe(5 * 4 + 3 * 2 + 1 * 0);
    expect(score.percent).toBe(Math.round((26 / 36) * 100));
  });

  it("is 0 and full at the ends", () => {
    expect(rubricScore(criteria, criteria.map(() => ({ points: 0 }))).percent).toBe(0);
    expect(rubricScore(criteria, criteria.map(() => ({ points: WRITTEN_MARK_MAX }))).percent).toBe(100);
  });

  it("does not divide by zero when there is no rubric", () => {
    expect(rubricScore([], [])).toEqual({ points: 0, outOf: 0, percent: 0 });
  });

  it("says the marks and the total, and never a band", () => {
    const line = scoreLine(rubricScore(criteria, [{ points: 4 }, { points: 4 }, { points: 4 }]));
    expect(line).toContain("36 of 36");
    expect(line).toContain("100%");
    expect(line).not.toMatch(/\b(band|grade|A\+|distinction)\b/i);
  });
});

describe("a rubric with a hole in it", () => {
  const criteria = [{ weight: 2 }, { weight: 2 }];

  it("names the criteria nobody marked", () => {
    expect(unmarkedCriteria(criteria, [{ points: 3 }, undefined])).toEqual([1]);
    expect(unmarkedCriteria(criteria, [undefined, undefined])).toEqual([0, 1]);
    expect(unmarkedCriteria(criteria, [{ points: 0 }, { points: 4 }])).toEqual([]);
  });

  it("counts an out-of-range or fractional mark as no mark at all", () => {
    expect(unmarkedCriteria(criteria, [{ points: WRITTEN_MARK_MAX + 1 }, { points: 1 }])).toEqual([0]);
    expect(unmarkedCriteria(criteria, [{ points: WRITTEN_MARK_MIN - 1 }, { points: 1 }])).toEqual([0]);
    expect(unmarkedCriteria(criteria, [{ points: 2.5 }, { points: 1 }])).toEqual([0]);
  });

  it("labels every mark on the ladder, so two TAs mean the same by a 3", () => {
    for (let points = WRITTEN_MARK_MIN; points <= WRITTEN_MARK_MAX; points += 1) {
      expect(WRITTEN_MARK_LABEL[points]?.length ?? 0).toBeGreaterThan(4);
    }
  });
});

describe("what people are told", () => {
  it("says the rubric is visible before the answer is written", () => {
    expect(WRITTEN_NOTICES.rubricVisible).toContain("marked against");
  });

  it("says the time box is not a timer", () => {
    expect(WRITTEN_NOTICES.timeBox).toContain("not a limit");
  });

  it("says the mark feeds nothing", () => {
    const notice = WRITTEN_NOTICES.gradingCountsForNothing;
    for (const thing of ["XP", "leaderboard", "readiness", "recruiter"]) expect(notice).toContain(thing);
  });

  it("warns the student that the grader sees their name", () => {
    expect(WRITTEN_NOTICES.graderSeesName).toContain("sees your name");
  });

  it("every refusal is a sentence somebody can act on", () => {
    for (const [key, text] of Object.entries(WRITTEN_REFUSALS)) {
      expect(text.length, key).toBeGreaterThan(15);
      expect(text.trim(), key).toMatch(/[.!]$/);
    }
  });
});

describe("the limits", () => {
  it("are ordered, and a rubric has at least two lines", () => {
    expect(WRITTEN_LIMITS.criteriaPerPrompt.min).toBe(2);
    expect(WRITTEN_LIMITS.criteriaPerPrompt.max).toBeGreaterThan(WRITTEN_LIMITS.criteriaPerPrompt.min);
    expect(WRITTEN_LIMITS.answer.max).toBeGreaterThan(WRITTEN_LIMITS.answer.min);
    expect(WRITTEN_LIMITS.overallNote.max).toBeGreaterThan(WRITTEN_LIMITS.overallNote.min);
    expect(WRITTEN_LIMITS.weight.min).toBe(1);
    expect(WRITTEN_LIMITS.weight.max).toBe(5);
  });

  it("asks for enough to mark, and not a dissertation", () => {
    expect(WRITTEN_LIMITS.answer.min).toBeGreaterThanOrEqual(100);
    expect(WRITTEN_LIMITS.answer.max).toBeLessThanOrEqual(50_000);
  });
});
