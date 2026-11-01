import { describe, expect, it } from "vitest";
import {
  formatMarks,
  markCoding,
  markCodingQuestions,
  scoreAttempt,
  type CodingMarkingInput,
} from "../src/exam-result";

/**
 * The result of a sitting (Phase 12y).
 *
 * Every number here decides what a department believes about a student, so
 * each rule is tested as the decision it is rather than as arithmetic.
 */

const judged = (over: Partial<NonNullable<CodingMarkingInput["submission"]>> = {}) => ({
  verdict: "AC" as const,
  score: null,
  maxScore: null,
  terminal: true,
  ...over,
});

const q = (over: Partial<CodingMarkingInput> = {}): CodingMarkingInput => ({
  questionId: "q1",
  points: 10,
  submission: judged(),
  ...over,
});

describe("one coding question", () => {
  it("gives full marks for Accepted", () => {
    expect(markCoding(q())).toMatchObject({ outcome: "accepted", points: 10 });
  });

  it("gives nothing for a wrong answer, and does not take anything away", () => {
    for (const verdict of ["WA", "TLE", "MLE", "RE", "CE", "OLE"] as const) {
      const mark = markCoding(q({ submission: judged({ verdict }) }));
      expect(mark, verdict).toMatchObject({ outcome: "rejected", points: 0 });
    }
  });

  it("scores a partial as the judge's fraction of the PAPER's points", () => {
    // The problem's own scale is 60; this paper says the question is worth
    // 10. Half the problem is half the question.
    const mark = markCoding(q({ submission: judged({ verdict: "PARTIAL", score: 30, maxScore: 60 }) }));
    expect(mark).toMatchObject({ outcome: "partial", points: 5 });
  });

  it("clamps a judge that reports more than its own maximum", () => {
    const mark = markCoding(q({ submission: judged({ verdict: "PARTIAL", score: 90, maxScore: 60 }) }));
    expect(mark.points).toBe(10);
  });

  it("treats a question still being judged as pending, NOT as a zero", () => {
    const mark = markCoding(q({ submission: judged({ verdict: null, terminal: false }) }));
    expect(mark).toMatchObject({ outcome: "pending", points: 0 });
  });

  it("treats an internal error as unjudged, because the judge broke and the candidate did not", () => {
    const mark = markCoding(q({ submission: judged({ verdict: "IE" }) }));
    expect(mark).toMatchObject({ outcome: "unjudged", verdict: "IE", points: 0 });
  });

  it("treats a PARTIAL with no usable fraction as unjudged rather than guessing", () => {
    // Zero would punish the candidate for a checker that answered badly;
    // full would hand marks to everybody the moment one misbehaves.
    for (const submission of [
      judged({ verdict: "PARTIAL", score: null, maxScore: 60 }),
      judged({ verdict: "PARTIAL", score: 30, maxScore: 0 }),
      judged({ verdict: "PARTIAL", score: Number.NaN, maxScore: 60 }),
    ]) {
      expect(markCoding(q({ submission }))).toMatchObject({ outcome: "unjudged", points: 0 });
    }
  });

  it("counts a question with nothing handed in as blank", () => {
    expect(markCoding(q({ submission: null }))).toMatchObject({ outcome: "blank", points: 0 });
  });
});

describe("the coding half", () => {
  it("adds the marks up and counts each kind separately", () => {
    const totals = markCodingQuestions([
      q({ questionId: "a", points: 10 }),
      q({ questionId: "b", points: 10, submission: judged({ verdict: "WA" }) }),
      q({ questionId: "c", points: 10, submission: judged({ verdict: "PARTIAL", score: 1, maxScore: 4 }) }),
      q({ questionId: "d", points: 10, submission: null }),
      q({ questionId: "e", points: 10, submission: judged({ verdict: null, terminal: false }) }),
      q({ questionId: "f", points: 10, submission: judged({ verdict: "IE" }) }),
    ]);
    expect(totals.points).toBe(12.5);
    expect(totals.maxPoints).toBe(60);
    expect(totals).toMatchObject({ accepted: 1, rejected: 1, partial: 1, blank: 1, pending: 1, unjudged: 1 });
  });
});

describe("a whole sitting", () => {
  const mcq = (correct: boolean) => ({
    mcqId: correct ? "right" : "wrong",
    points: 2,
    optionOrder: [2, 0, 1],
    correctIndex: 2,
    chosenShownIndex: correct ? 0 : 1,
  });

  it("adds both halves and reports a percentage", () => {
    const result = scoreAttempt({
      mcqs: [mcq(true), mcq(false)],
      coding: [q({ points: 6 })],
    });
    expect(result.mcq.points).toBe(2);
    expect(result.coding.points).toBe(6);
    expect(result.points).toBe(8);
    expect(result.maxPoints).toBe(10);
    expect(result.percent).toBe(80);
    expect(result.provisional).toBe(false);
  });

  it("is PROVISIONAL while anything is still being judged", () => {
    // An exam whose last submission is still in the queue must not show a
    // score as if it were final: that is how somebody is told they failed
    // by a progress bar.
    const result = scoreAttempt({
      mcqs: [mcq(true)],
      coding: [q({ submission: judged({ verdict: null, terminal: false }) })],
    });
    expect(result.provisional).toBe(true);
    expect(result.points).toBe(2);
  });

  it("is provisional, and asks for a person, when the judge failed", () => {
    const result = scoreAttempt({ mcqs: [], coding: [q({ submission: judged({ verdict: "IE" }) })] });
    expect(result.provisional).toBe(true);
    expect(result.needsAttention).toBe(1);
  });

  it("counts a corrupt multiple-choice answer as needing a person too", () => {
    const result = scoreAttempt({
      mcqs: [{ mcqId: "x", points: 2, optionOrder: [0, 1], correctIndex: 0, chosenShownIndex: 7 }],
      coding: [],
    });
    expect(result.mcq.corrupt).toBe(1);
    expect(result.needsAttention).toBe(1);
  });

  it("reports no percentage at all for a paper worth nothing, rather than 0 %", () => {
    const result = scoreAttempt({ mcqs: [], coding: [] });
    expect(result.maxPoints).toBe(0);
    expect(result.percent).toBeNull();
  });

  it("does not let an empty paper read as a failure", () => {
    // The same point from the other side: 0 / 0 is not zero per cent, and
    // a report that printed "0%" would be making something up.
    expect(scoreAttempt({ mcqs: [], coding: [] }).points).toBe(0);
    expect(scoreAttempt({ mcqs: [], coding: [] }).percent).not.toBe(0);
  });
});

describe("marks as a department writes them", () => {
  it("drops a trailing zero and keeps two decimals", () => {
    expect(formatMarks(7)).toBe("7");
    expect(formatMarks(7.5)).toBe("7.5");
    expect(formatMarks(7.456)).toBe("7.46");
    expect(formatMarks(0)).toBe("0");
  });
});
