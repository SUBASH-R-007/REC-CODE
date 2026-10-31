import { describe, expect, it } from "vitest";
import {
  parseAttemptLayout,
  questionSeed,
  resolveLayout,
  shuffled,
  xoshiro128ss,
  type AssessmentMcqInput,
  type AssessmentQuestionInput,
} from "../src/exam-randomise";

const questions = (n: number): AssessmentQuestionInput[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `q${i + 1}`,
    problemVersionId: `pv${i + 1}`,
    position: i + 1,
    points: 10,
  }));

describe("xoshiro128ss", () => {
  it("is deterministic for a seed — a disputed paper must be reproducible", () => {
    const a = xoshiro128ss(12_345);
    const b = xoshiro128ss(12_345);
    const first = Array.from({ length: 50 }, () => a());
    const second = Array.from({ length: 50 }, () => b());
    expect(first).toEqual(second);
  });

  it("gives different streams for different seeds", () => {
    const a = Array.from({ length: 20 }, xoshiro128ss(1));
    const b = Array.from({ length: 20 }, xoshiro128ss(2));
    expect(a).not.toEqual(b);
  });

  it("stays inside [0, 1)", () => {
    const random = xoshiro128ss(99);
    for (let i = 0; i < 5_000; i++) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("survives a zero seed without collapsing to a fixed point", () => {
    const random = xoshiro128ss(0);
    const values = new Set(Array.from({ length: 100 }, random));
    expect(values.size).toBeGreaterThan(50);
  });

  it("is roughly uniform across ten buckets", () => {
    const random = xoshiro128ss(2_026);
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) buckets[Math.floor(random() * 10)]!++;
    for (const count of buckets) {
      // Within 15% of n/10 — loose enough never to flake, tight enough to
      // catch a generator stuck in a corner of its range.
      expect(count).toBeGreaterThan((n / 10) * 0.85);
      expect(count).toBeLessThan((n / 10) * 1.15);
    }
  });
});

describe("shuffled", () => {
  it("keeps every element exactly once", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffled(items, xoshiro128ss(7));
    expect([...out].sort((a, b) => a - b)).toEqual(items);
  });

  it("does not mutate the input, which is the assessment's own order", () => {
    const items = [1, 2, 3, 4, 5];
    shuffled(items, xoshiro128ss(7));
    expect(items).toEqual([1, 2, 3, 4, 5]);
  });

  it("is deterministic for a seed", () => {
    expect(shuffled([1, 2, 3, 4, 5, 6], xoshiro128ss(42))).toEqual(shuffled([1, 2, 3, 4, 5, 6], xoshiro128ss(42)));
  });

  it("actually reorders across seeds", () => {
    const orders = new Set(
      Array.from({ length: 30 }, (_, seed) => shuffled([1, 2, 3, 4, 5], xoshiro128ss(seed)).join(",")),
    );
    expect(orders.size).toBeGreaterThan(10);
  });

  it("handles the empty and single-element cases", () => {
    expect(shuffled([], xoshiro128ss(1))).toEqual([]);
    expect(shuffled([9], xoshiro128ss(1))).toEqual([9]);
  });

  it("reaches every position for a given element, over many seeds", () => {
    // A shuffle that never moves element 0 out of slot 0 would pass the
    // tests above and still be badly broken.
    const seen = new Set<number>();
    for (let seed = 0; seed < 400; seed++) {
      seen.add(shuffled([0, 1, 2, 3, 4], xoshiro128ss(seed)).indexOf(0));
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("questionSeed", () => {
  it("is deterministic", () => {
    expect(questionSeed(1_000, 3)).toBe(questionSeed(1_000, 3));
  });

  it("differs per question and per attempt", () => {
    expect(questionSeed(1_000, 3)).not.toBe(questionSeed(1_000, 4));
    expect(questionSeed(1_000, 3)).not.toBe(questionSeed(1_001, 3));
  });

  it("is a non-negative 32-bit integer, so it fits an Int column", () => {
    for (const position of [1, 2, 50, 200]) {
      const seed = questionSeed(0xdead_beef, position);
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffff_ffff);
    }
  });
});

describe("resolveLayout", () => {
  it("returns every question exactly once", () => {
    const layout = resolveLayout({ questions: questions(5), seed: 11 });
    expect(layout.questions.map((q) => q.questionId).sort()).toEqual(["q1", "q2", "q3", "q4", "q5"]);
  });

  it("is identical for the same seed — a reload returns the same paper", () => {
    const a = resolveLayout({ questions: questions(6), seed: 2_026 });
    const b = resolveLayout({ questions: questions(6), seed: 2_026 });
    expect(a).toEqual(b);
  });

  it("gives two candidates different papers", () => {
    const orders = new Set(
      Array.from({ length: 30 }, (_, seed) =>
        resolveLayout({ questions: questions(5), seed })
          .questions.map((q) => q.questionId)
          .join(","),
      ),
    );
    expect(orders.size).toBeGreaterThan(10);
  });

  it("keeps the assessment's own order when randomisation is off", () => {
    const layout = resolveLayout({ questions: questions(4), seed: 5, randomiseOrder: false });
    expect(layout.questions.map((q) => q.sourcePosition)).toEqual([1, 2, 3, 4]);
  });

  it("carries the frozen version, the source position and the points through", () => {
    const layout = resolveLayout({ questions: questions(3), seed: 1, randomiseOrder: false });
    expect(layout.questions[0]).toEqual({
      questionId: "q1",
      problemVersionId: "pv1",
      sourcePosition: 1,
      points: 10,
      seed: questionSeed(1, 1),
    });
  });

  it("keys a question's seed on its source position, not its shuffled slot", () => {
    // So a candidate's hidden-test order for a given problem is stable even
    // if the order resolution itself ever changes.
    const shuffledLayout = resolveLayout({ questions: questions(8), seed: 77 });
    const orderedLayout = resolveLayout({ questions: questions(8), seed: 77, randomiseOrder: false });
    for (const question of shuffledLayout.questions) {
      const same = orderedLayout.questions.find((q) => q.questionId === question.questionId)!;
      expect(question.seed).toBe(same.seed);
    }
  });

  it("sorts by the assessment's position before resolving, so input order cannot change the paper", () => {
    const forward = resolveLayout({ questions: questions(5), seed: 3 });
    const reversed = resolveLayout({ questions: [...questions(5)].reverse(), seed: 3 });
    expect(reversed).toEqual(forward);
  });

  it("handles a one-question paper", () => {
    expect(resolveLayout({ questions: questions(1), seed: 1 }).questions).toHaveLength(1);
  });

  it("is versioned, so a later phase can add fields", () => {
    expect(resolveLayout({ questions: questions(2), seed: 1 }).v).toBe(1);
  });
});

describe("parseAttemptLayout", () => {
  it("accepts what resolveLayout produces", () => {
    const layout = resolveLayout({ questions: questions(3), seed: 9 });
    expect(parseAttemptLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });

  it("refuses anything that is not a v1 or v2 layout", () => {
    // `{ v: 2, questions: [] }` is still refused, and now for a reason the
    // version carries: a v2 layout with no MCQs is a bump for nothing.
    for (const bad of [null, undefined, {}, { v: 2, questions: [] }, { v: 3, questions: [] }, { v: 1 }, { v: 1, questions: {} }]) {
      expect(() => parseAttemptLayout(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("refuses a malformed question rather than rendering a broken paper", () => {
    expect(() => parseAttemptLayout({ v: 1, questions: [{ questionId: "q1" }] })).toThrow(/malformed/);
  });
});

/**
 * The MCQ half of a paper (Phase 12r), and the version boundary that keeps
 * it from going missing.
 *
 * A v1 reader ignores keys it does not know, so a layout carrying MCQs
 * under `v: 1` would be served as a paper short of those questions — a
 * candidate sitting an exam missing half its marks with nothing saying so.
 * Hence a version, and hence these tests.
 */
const mcqs = (n: number, optionCount = 4): AssessmentMcqInput[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, position: i + 1, points: 2, optionCount }));

describe("a paper with multiple-choice questions", () => {
  it("stays v1 when there are none, so nothing already stored changes", () => {
    expect(resolveLayout({ questions: questions(3), seed: 7 }).v).toBe(1);
    expect(resolveLayout({ questions: questions(3), seed: 7, mcqs: [] }).v).toBe(1);
    expect(resolveLayout({ questions: questions(3), seed: 7, mcqs: [] }).mcqs).toBeUndefined();
  });

  it("becomes v2 the moment it holds one", () => {
    const layout = resolveLayout({ questions: questions(3), seed: 7, mcqs: mcqs(2) });
    expect(layout.v).toBe(2);
    expect(layout.mcqs?.map((m) => m.mcqId)).toEqual(["m1", "m2"]);
  });

  it("shows every option exactly once, in some order", () => {
    const layout = resolveLayout({ questions: questions(1), seed: 99, mcqs: mcqs(1, 5) });
    const order = layout.mcqs?.[0]?.optionOrder ?? [];
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("is reproducible from the seed, which is what an appeal depends on", () => {
    const a = resolveLayout({ questions: questions(3), seed: 4_242, mcqs: mcqs(3) });
    const b = resolveLayout({ questions: questions(3), seed: 4_242, mcqs: mcqs(3) });
    expect(a).toEqual(b);
  });

  it("does not let an MCQ disturb the coding questions' order", () => {
    /**
     * The one that would have been a silent bug: drawing the option
     * shuffles from the same generator as the question order makes a
     * coding question's position depend on how many MCQs the paper
     * happens to hold, so adding one MCQ would re-order every candidate's
     * coding questions — and a seed that no longer reproduces a paper is
     * a seed that cannot settle an appeal.
     */
    const without = resolveLayout({ questions: questions(6), seed: 31 });
    const with1 = resolveLayout({ questions: questions(6), seed: 31, mcqs: mcqs(1) });
    const with4 = resolveLayout({ questions: questions(6), seed: 31, mcqs: mcqs(4) });
    expect(with1.questions).toEqual(without.questions);
    expect(with4.questions).toEqual(without.questions);
  });

  it("keeps the MCQs in the paper's own order, whatever the coding order does", () => {
    // The palette is one numbered list; an MCQ's place in it is the
    // assessment's, not the shuffle's.
    const layout = resolveLayout({ questions: questions(4), seed: 8, mcqs: mcqs(3) });
    expect(layout.mcqs?.map((m) => m.sourcePosition)).toEqual([1, 2, 3]);
  });

  it("round-trips through the parser", () => {
    const layout = resolveLayout({ questions: questions(2), seed: 5, mcqs: mcqs(2) });
    expect(parseAttemptLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });
});

describe("parseAttemptLayout, on the version boundary", () => {
  const good = resolveLayout({ questions: questions(2), seed: 5, mcqs: mcqs(1) });

  it("refuses a v1 layout that carries mcqs, rather than dropping them", () => {
    expect(() => parseAttemptLayout({ ...good, v: 1 })).toThrow(/v1 but carries mcqs/);
  });

  it("refuses a version it does not know", () => {
    expect(() => parseAttemptLayout({ ...good, v: 3 })).toThrow(/not a v1 or v2 layout/);
  });

  it("refuses a malformed mcq", () => {
    for (const bad of [
      { mcqId: 1, sourcePosition: 1, points: 2, optionOrder: [0, 1] },
      { mcqId: "m", sourcePosition: "1", points: 2, optionOrder: [0, 1] },
      { mcqId: "m", sourcePosition: 1, points: 2, optionOrder: [] },
      { mcqId: "m", sourcePosition: 1, points: 2, optionOrder: ["0"] },
      { mcqId: "m", sourcePosition: 1, points: 2 },
    ]) {
      expect(() => parseAttemptLayout({ v: 2, questions: good.questions, mcqs: [bad] }), JSON.stringify(bad)).toThrow(
        /malformed mcq/,
      );
    }
  });

  it("still reads a stored v1 paper", () => {
    const v1 = resolveLayout({ questions: questions(3), seed: 2 });
    expect(parseAttemptLayout(JSON.parse(JSON.stringify(v1)))).toEqual(v1);
  });
});
