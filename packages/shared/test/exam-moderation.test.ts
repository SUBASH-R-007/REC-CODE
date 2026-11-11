import { describe, expect, it } from "vitest";
import { markMcq, markMcqs, type McqMarkingInput } from "../src/exam-mcq";
import { moderatedMark, QUESTION_MODERATIONS } from "../src/exam-moderation";
import { markCoding, markCodingQuestions, scoreAttempt, type CodingMarkingInput } from "../src/exam-result";

/**
 * Moderating a question after the paper has been sat (Phase 13i).
 *
 * Each rule is tested as the decision it is. The one that matters most and
 * is easiest to get wrong is what DROPPED does to the denominator: a
 * withdrawn question has to leave the total as well as every score, or
 * every percentage on the paper is quietly wrong in the candidates'
 * favour and nobody notices until somebody adds the marks up by hand.
 */

const judged = (over: Partial<NonNullable<CodingMarkingInput["submission"]>> = {}) => ({
  verdict: "WA" as const,
  score: null,
  maxScore: null,
  terminal: true,
  ...over,
});

const code = (over: Partial<CodingMarkingInput> = {}): CodingMarkingInput => ({
  questionId: "q1",
  points: 10,
  submission: judged(),
  ...over,
});

const mcq = (over: Partial<McqMarkingInput> = {}): McqMarkingInput => ({
  mcqId: "m1",
  points: 4,
  optionOrder: [2, 0, 1],
  correctIndex: 0,
  // Shown position 1 is stored option 0, the right one — so unmoderated
  // this is "correct" and every moderated case below has to override it.
  chosenShownIndex: 1,
  ...over,
});

describe("the two remedies, in the abstract", () => {
  it("awards the question's marks, keeping it in the total", () => {
    expect(moderatedMark("FULL_MARKS", 7)).toEqual({ outcome: "awarded", points: 7, maxPoints: 7 });
  });

  it("takes a withdrawn question out of the total as well as the score", () => {
    expect(moderatedMark("DROPPED", 7)).toEqual({ outcome: "dropped", points: 0, maxPoints: 0 });
  });

  it("says nothing at all about an unmoderated question", () => {
    expect(moderatedMark("NONE", 7)).toBeNull();
    expect(moderatedMark(undefined, 7)).toBeNull();
  });

  it("knows exactly three states", () => {
    expect([...QUESTION_MODERATIONS]).toEqual(["NONE", "FULL_MARKS", "DROPPED"]);
  });
});

describe("a moderated coding question", () => {
  it("awards full marks over a wrong answer", () => {
    expect(markCoding(code({ moderation: "FULL_MARKS" }))).toMatchObject({
      outcome: "awarded",
      points: 10,
      maxPoints: 10,
    });
  });

  it("awards full marks to a candidate who handed in nothing", () => {
    // The point of awarding it: nobody is disadvantaged by a question
    // that should not have been asked the way it was.
    expect(markCoding(code({ submission: null, moderation: "FULL_MARKS" }))).toMatchObject({
      outcome: "awarded",
      points: 10,
      maxPoints: 10,
    });
  });

  it("awards full marks over an accepted answer too, without doubling them", () => {
    expect(markCoding(code({ submission: judged({ verdict: "AC" }), moderation: "FULL_MARKS" }))).toMatchObject({
      outcome: "awarded",
      points: 10,
      maxPoints: 10,
    });
  });

  it("withdraws it from the total", () => {
    expect(markCoding(code({ submission: judged({ verdict: "AC" }), moderation: "DROPPED" }))).toMatchObject({
      outcome: "dropped",
      points: 0,
      maxPoints: 0,
    });
  });

  it("decides before the judge, so a question still queued is not reported as pending", () => {
    /**
     * A dropped question is worth nothing to anybody whatever the judge
     * eventually says, and a result that still called it pending would
     * keep the whole paper PROVISIONAL forever.
     */
    const mark = markCoding(code({ submission: judged({ verdict: null, terminal: false }), moderation: "DROPPED" }));
    expect(mark.outcome).toBe("dropped");
    const totals = markCodingQuestions([code({ submission: judged({ verdict: null, terminal: false }), moderation: "DROPPED" })]);
    expect(totals.pending).toBe(0);
    expect(totals.dropped).toBe(1);
  });

  it("keeps the verdict visible, because staff still need to see it", () => {
    expect(markCoding(code({ submission: judged({ verdict: "TLE" }), moderation: "DROPPED" })).verdict).toBe("TLE");
  });
});

describe("a moderated multiple-choice question", () => {
  it("awards full marks over a wrong answer", () => {
    expect(markMcq(mcq({ chosenShownIndex: 0, moderation: "FULL_MARKS" }))).toEqual({
      mcqId: "m1",
      outcome: "awarded",
      points: 4,
      maxPoints: 4,
    });
  });

  it("withdraws it from the total even when they got it right", () => {
    expect(markMcq(mcq({ moderation: "DROPPED" }))).toEqual({
      mcqId: "m1",
      outcome: "dropped",
      points: 0,
      maxPoints: 0,
    });
  });

  it("decides before the answer is read, so a corrupt one stops needing a person", () => {
    // An index outside the order they were shown is reported as corrupt
    // and sent to a human — but not once the question has gone.
    const totals = markMcqs([mcq({ chosenShownIndex: 99, moderation: "DROPPED" })]);
    expect(totals.corrupt).toBe(0);
    expect(totals.dropped).toBe(1);
  });
});

describe("what it does to the paper", () => {
  it("a withdrawn question makes the paper worth less, and the percentage honest", () => {
    const before = scoreAttempt({
      mcqs: [mcq({ mcqId: "m1", points: 4 }), mcq({ mcqId: "m2", points: 6, chosenShownIndex: 0 })],
      coding: [],
    });
    // 4 of 10: one right, one wrong.
    expect(before).toMatchObject({ points: 4, maxPoints: 10, percent: 40 });

    const after = scoreAttempt({
      mcqs: [mcq({ mcqId: "m1", points: 4 }), mcq({ mcqId: "m2", points: 6, chosenShownIndex: 0, moderation: "DROPPED" })],
      coding: [],
    });
    // The question they got wrong is gone: 4 of 4, not 4 of 10.
    expect(after).toMatchObject({ points: 4, maxPoints: 4, percent: 100 });
  });

  it("an awarded question keeps the total and lifts the score", () => {
    const after = scoreAttempt({
      mcqs: [mcq({ mcqId: "m1", points: 4 }), mcq({ mcqId: "m2", points: 6, chosenShownIndex: 0, moderation: "FULL_MARKS" })],
      coding: [],
    });
    expect(after).toMatchObject({ points: 10, maxPoints: 10, percent: 100 });
  });

  it("a paper whose every question is withdrawn has no percentage rather than zero", () => {
    const after = scoreAttempt({
      mcqs: [mcq({ moderation: "DROPPED" })],
      coding: [code({ moderation: "DROPPED" })],
    });
    expect(after).toMatchObject({ points: 0, maxPoints: 0, percent: null });
  });

  it("a withdrawn coding question cannot keep a result provisional", () => {
    const after = scoreAttempt({
      mcqs: [],
      coding: [code({ submission: judged({ verdict: null, terminal: false }), moderation: "DROPPED" })],
    });
    expect(after.provisional).toBe(false);
    expect(after.needsAttention).toBe(0);
  });

  it("an awarded question that the judge broke on stops needing a person", () => {
    // IE is "the judge failed, not the candidate", and awarding the
    // question to everybody is one of the two ways out of it.
    const after = scoreAttempt({
      mcqs: [],
      coding: [code({ submission: judged({ verdict: "IE" }), moderation: "FULL_MARKS" })],
    });
    expect(after).toMatchObject({ points: 10, maxPoints: 10, needsAttention: 0, provisional: false });
  });
});
