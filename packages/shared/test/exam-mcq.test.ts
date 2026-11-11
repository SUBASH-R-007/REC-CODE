import { describe, expect, it } from "vitest";
import { markMcq, markMcqs, paperQuestionCount, storedIndexOf, type McqMarkingInput } from "../src/exam-mcq";

/**
 * Marking the multiple-choice half of a paper (Phase 12r).
 *
 * The arithmetic a candidate's result is built from, which is why it is
 * here and not in a server action. The cases that matter are the ones that
 * are not "they got it right": a blank, a shuffled paper, and an answer
 * that cannot be mapped back to an option they were shown.
 */

const base: McqMarkingInput = {
  mcqId: "m1",
  points: 4,
  // The candidate saw the stored options in this order: C, A, D, B.
  optionOrder: [2, 0, 3, 1],
  correctIndex: 3,
  chosenShownIndex: null,
};

describe("storedIndexOf", () => {
  it("maps what the candidate clicked back to the option the paper stores", () => {
    // They clicked the third thing on their screen, which is stored D (3).
    expect(storedIndexOf({ optionOrder: base.optionOrder, chosenShownIndex: 2 })).toBe(3);
    expect(storedIndexOf({ optionOrder: base.optionOrder, chosenShownIndex: 0 })).toBe(2);
  });

  it("is null for no answer, and for an index they were never shown", () => {
    expect(storedIndexOf({ optionOrder: base.optionOrder, chosenShownIndex: null })).toBeNull();
    expect(storedIndexOf({ optionOrder: base.optionOrder, chosenShownIndex: 4 })).toBeNull();
    expect(storedIndexOf({ optionOrder: base.optionOrder, chosenShownIndex: -1 })).toBeNull();
    expect(storedIndexOf({ optionOrder: base.optionOrder, chosenShownIndex: 1.5 })).toBeNull();
  });
});

describe("markMcq", () => {
  it("marks the right option right, through the shuffle", () => {
    // Correct is stored 3, which this candidate saw third (shown index 2).
    expect(markMcq({ ...base, chosenShownIndex: 2 })).toEqual({
      mcqId: "m1",
      outcome: "correct",
      points: 4,
      maxPoints: 4,
    });
  });

  it("does not mark the SHOWN index against the stored one", () => {
    // The trap: shown index 3 is stored 1, not the correct 3. A marker that
    // compared the click position with correctIndex would score this
    // right, and every candidate's paper would be marked differently
    // depending on their shuffle.
    expect(markMcq({ ...base, chosenShownIndex: 3 }).outcome).toBe("wrong");
  });

  it("scores a wrong answer zero and never less", () => {
    // No negative marking: it would have to be per-paper to be fair, and it
    // changes how a candidate spends the clock.
    const mark = markMcq({ ...base, chosenShownIndex: 0 });
    expect(mark.outcome).toBe("wrong");
    expect(mark.points).toBe(0);
  });

  it("tells a blank apart from a wrong answer, though both score nothing", () => {
    const blank = markMcq({ ...base, chosenShownIndex: null });
    expect(blank).toMatchObject({ outcome: "blank", points: 0 });
    expect(markMcq({ ...base, chosenShownIndex: 0 }).outcome).toBe("wrong");
  });

  it("calls an unmappable answer corrupt rather than wrong", () => {
    // Somebody's marks are at stake: an index outside the order they were
    // shown is a bug somewhere, not a candidate's mistake, and it should be
    // looked at rather than quietly scored zero.
    expect(markMcq({ ...base, chosenShownIndex: 9 }).outcome).toBe("corrupt");
  });

  it("works on an unshuffled paper too", () => {
    const plain = { ...base, optionOrder: [0, 1, 2, 3] };
    expect(markMcq({ ...plain, chosenShownIndex: 3 }).outcome).toBe("correct");
    expect(markMcq({ ...plain, chosenShownIndex: 1 }).outcome).toBe("wrong");
  });
});

describe("markMcqs", () => {
  it("totals the points and counts each outcome separately", () => {
    const totals = markMcqs([
      { ...base, mcqId: "a", chosenShownIndex: 2 },
      { ...base, mcqId: "b", chosenShownIndex: 0 },
      { ...base, mcqId: "c", chosenShownIndex: null },
      { ...base, mcqId: "d", chosenShownIndex: 99 },
    ]);
    expect(totals.points).toBe(4);
    expect(totals.maxPoints).toBe(16);
    expect({ c: totals.correct, w: totals.wrong, b: totals.blank, x: totals.corrupt }).toEqual({
      c: 1,
      w: 1,
      b: 1,
      x: 1,
    });
  });

  it("is zero of everything for a paper with no MCQs", () => {
    expect(markMcqs([])).toMatchObject({ points: 0, maxPoints: 0, correct: 0, wrong: 0, blank: 0, corrupt: 0 });
  });

  it("keeps one mark per question, in the order given", () => {
    const totals = markMcqs([
      { ...base, mcqId: "first", chosenShownIndex: 2 },
      { ...base, mcqId: "second", chosenShownIndex: null },
    ]);
    expect(totals.marks.map((m) => m.mcqId)).toEqual(["first", "second"]);
  });

  it("carries a per-question weight rather than assuming one mark each", () => {
    const totals = markMcqs([
      { ...base, mcqId: "cheap", points: 1, chosenShownIndex: 2 },
      { ...base, mcqId: "dear", points: 10, chosenShownIndex: 2 },
    ]);
    expect(totals.points).toBe(11);
    expect(totals.maxPoints).toBe(11);
  });
});

/**
 * How many questions a paper asks (Phase 12r).
 *
 * Trivial arithmetic, and it has its own test because the same mistake was
 * made three times in one slice — publishing, starting and submitting each
 * counted the coding questions alone, so an all-multiple-choice paper
 * could not be published, could not be opened, and when it was finally
 * sat, nothing recorded what its questions came to. Every one of them read
 * naturally and none was caught by a type.
 */
describe("paperQuestionCount", () => {
  it("counts both kinds", () => {
    expect(paperQuestionCount({ problems: { length: 3 }, mcqs: { length: 2 } })).toBe(5);
  });

  it("is zero only when there is neither", () => {
    expect(paperQuestionCount({ problems: { length: 0 }, mcqs: { length: 0 } })).toBe(0);
    expect(paperQuestionCount({})).toBe(0);
  });

  it("counts an all-multiple-choice paper, which is the case that was broken", () => {
    expect(paperQuestionCount({ problems: { length: 0 }, mcqs: { length: 4 } })).toBe(4);
    expect(paperQuestionCount({ mcqs: { length: 1 } })).toBe(1);
  });

  it("counts an all-code paper, which never was", () => {
    expect(paperQuestionCount({ problems: { length: 2 } })).toBe(2);
    expect(paperQuestionCount({ problems: { length: 2 }, mcqs: null })).toBe(2);
  });
});
