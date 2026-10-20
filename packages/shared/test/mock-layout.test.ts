import { describe, expect, it } from "vitest";
import {
  BlueprintUnfillable,
  MOCK_LAYOUT_VERSION,
  buildMockLayout,
  layoutQuestionIds,
  layoutSection,
  mapOptionsToShown,
  mapOriginalToShown,
  mapSelectionToOriginal,
  parseMockLayout,
  type PoolQuestion,
  type SectionBlueprint,
} from "../src/mock-layout";
import type { AptitudeTopic } from "../src/aptitude-taxonomy";

/** `count` pool questions of one topic, named `<topic>-<n>`. */
function pool(topic: AptitudeTopic, count: number, over: Partial<PoolQuestion> = {}): PoolQuestion[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${topic.toLowerCase()}-${i}`,
    topic,
    optionCount: 4,
    passageId: null,
    ...over,
  }));
}

const quantSection: SectionBlueprint = {
  sectionId: "sec1",
  key: "quantitative",
  position: 1,
  topicMix: [
    { topic: "PERCENTAGES", count: 3 },
    { topic: "PROFIT_LOSS", count: 2 },
  ],
  questionCount: 5,
  shuffleQuestions: true,
  shuffleOptions: true,
};

const basePool = [...pool("PERCENTAGES", 10), ...pool("PROFIT_LOSS", 10)];

describe("building a paper", () => {
  it("draws exactly what the blueprint asks for", () => {
    const layout = buildMockLayout({ seed: 1, sections: [quantSection], pool: basePool });
    expect(layout.v).toBe(MOCK_LAYOUT_VERSION);
    expect(layout.sections).toHaveLength(1);
    const questions = layout.sections[0]!.questions;
    expect(questions).toHaveLength(5);
    expect(questions.filter((q) => q.topic === "PERCENTAGES")).toHaveLength(3);
    expect(questions.filter((q) => q.topic === "PROFIT_LOSS")).toHaveLength(2);
  });

  it("numbers the questions 0…n-1 in served order", () => {
    const layout = buildMockLayout({ seed: 1, sections: [quantSection], pool: basePool });
    expect(layout.sections[0]!.questions.map((q) => q.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it("is deterministic in the seed", () => {
    // A disputed paper has to be reproducible from MockAttempt.seed alone.
    const a = buildMockLayout({ seed: 12_345, sections: [quantSection], pool: basePool });
    const b = buildMockLayout({ seed: 12_345, sections: [quantSection], pool: basePool });
    expect(b).toEqual(a);
  });

  it("gives different candidates different papers", () => {
    const a = buildMockLayout({ seed: 1, sections: [quantSection], pool: basePool });
    const b = buildMockLayout({ seed: 2, sections: [quantSection], pool: basePool });
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
  });

  it("never serves the same question twice in one paper", () => {
    // Two sections drawing on the same topic consume one pool.
    const second: SectionBlueprint = {
      ...quantSection,
      sectionId: "sec2",
      key: "quantitative-2",
      position: 2,
      topicMix: [{ topic: "PERCENTAGES", count: 5 }],
      questionCount: 5,
    };
    const layout = buildMockLayout({ seed: 7, sections: [quantSection, second], pool: basePool });
    const ids = layoutQuestionIds(layout);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("keeps the question order fixed when the section says not to shuffle", () => {
    const layout = buildMockLayout({
      seed: 3,
      sections: [{ ...quantSection, shuffleQuestions: false }],
      pool: basePool,
    });
    const ids = layout.sections[0]!.questions.map((q) => q.questionId);
    // The pool is drawn in blueprint order, so percentages come first.
    expect(ids.slice(0, 3).every((id) => id.startsWith("percentages"))).toBe(true);
    expect(ids.slice(3).every((id) => id.startsWith("profit_loss"))).toBe(true);
  });

  it("actually shuffles when the section says to", () => {
    // Over several seeds the first question must not always be the same one,
    // or "question 1 is always the easy one" is a pattern candidates find
    // within a semester.
    const firsts = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map(
        (seed) => buildMockLayout({ seed, sections: [quantSection], pool: basePool }).sections[0]!.questions[0]!.questionId,
      ),
    );
    expect(firsts.size).toBeGreaterThan(1);
  });
});

describe("passage groups", () => {
  const passageQuestions: PoolQuestion[] = [
    ...pool("READING_COMPREHENSION", 3, { passageId: "psgA" }).map((q, i) => ({ ...q, id: `A${i}` })),
    ...pool("READING_COMPREHENSION", 3, { passageId: "psgB" }).map((q, i) => ({ ...q, id: `B${i}` })),
  ];
  const verbal: SectionBlueprint = {
    sectionId: "v",
    key: "verbal",
    position: 1,
    topicMix: [{ topic: "READING_COMPREHENSION", count: 6 }],
    questionCount: 6,
    shuffleQuestions: true,
    shuffleOptions: true,
  };

  it("keeps a passage's questions contiguous, for every seed", () => {
    // Splitting them would show a candidate question 3 of a passage they have
    // not been given.
    for (let seed = 1; seed <= 40; seed++) {
      const layout = buildMockLayout({ seed, sections: [verbal], pool: passageQuestions });
      const served = layout.sections[0]!.questions.map((q) => q.passageId);
      const runs = served.filter((id, i) => i === 0 || served[i - 1] !== id);
      expect(new Set(runs).size, `seed ${seed}: ${served.join(",")}`).toBe(runs.length);
    }
  });

  it("never splits a passage across a section boundary", () => {
    // Two sections, one passage of three questions in the pool: either the
    // whole group lands in one section or the blueprint is unfillable.
    const sections: SectionBlueprint[] = [
      { ...verbal, sectionId: "v1", key: "verbal-1", position: 1, topicMix: [{ topic: "READING_COMPREHENSION", count: 3 }], questionCount: 3 },
      { ...verbal, sectionId: "v2", key: "verbal-2", position: 2, topicMix: [{ topic: "READING_COMPREHENSION", count: 3 }], questionCount: 3 },
    ];
    for (let seed = 1; seed <= 20; seed++) {
      const layout = buildMockLayout({ seed, sections, pool: passageQuestions });
      for (const section of layout.sections) {
        const passages = new Set(section.questions.map((q) => q.passageId));
        // Each section ends up with exactly one whole passage group.
        expect(passages.size, `seed ${seed}`).toBe(1);
        expect(section.questions).toHaveLength(3);
      }
    }
  });

  it("shuffles the questions inside a group as well as the groups", () => {
    const orders = new Set(
      Array.from({ length: 12 }, (_, i) =>
        buildMockLayout({ seed: i + 1, sections: [verbal], pool: passageQuestions })
          .sections[0]!.questions.map((q) => q.questionId)
          .join(","),
      ),
    );
    expect(orders.size).toBeGreaterThan(2);
  });

  it("records the passage on each question, so the sitting page can group them", () => {
    const layout = buildMockLayout({ seed: 5, sections: [verbal], pool: passageQuestions });
    for (const question of layout.sections[0]!.questions) {
      expect(question.passageId).toMatch(/^psg[AB]$/);
    }
  });
});

describe("a blueprint the pool cannot fill", () => {
  it("raises rather than building a short paper", () => {
    // The consequence of retiring a question surfaces on the pattern page,
    // where somebody can act on it, not on a candidate's screen mid-sitting.
    expect(() =>
      buildMockLayout({ seed: 1, sections: [quantSection], pool: pool("PERCENTAGES", 2) }),
    ).toThrow(BlueprintUnfillable);
  });

  it("names EVERY shortfall, not the first", () => {
    try {
      buildMockLayout({ seed: 1, sections: [quantSection], pool: pool("PERCENTAGES", 1) });
      throw new Error("expected BlueprintUnfillable");
    } catch (error) {
      expect(error).toBeInstanceOf(BlueprintUnfillable);
      const { shortfalls, message } = error as BlueprintUnfillable;
      expect(shortfalls).toHaveLength(2);
      expect(shortfalls.map((s) => s.topic).sort()).toEqual(["PERCENTAGES", "PROFIT_LOSS"]);
      expect(message).toContain("needs 3 PERCENTAGES and has 1");
      expect(message).toContain("needs 2 PROFIT_LOSS and has 0");
    }
  });

  it("counts the pool ACROSS sections, so the second section's shortfall is seen", () => {
    // Ten percentages questions fill one section of five twice and no more.
    const sections: SectionBlueprint[] = [1, 2, 3].map((position) => ({
      ...quantSection,
      sectionId: `s${position}`,
      key: `s${position}`,
      position,
      topicMix: [{ topic: "PERCENTAGES", count: 4 }],
      questionCount: 4,
    }));
    try {
      buildMockLayout({ seed: 1, sections, pool: pool("PERCENTAGES", 10) });
      throw new Error("expected BlueprintUnfillable");
    } catch (error) {
      expect(error).toBeInstanceOf(BlueprintUnfillable);
      const { shortfalls } = error as BlueprintUnfillable;
      expect(shortfalls).toHaveLength(1);
      expect(shortfalls[0]).toEqual({
        sectionKey: "s3",
        topic: "PERCENTAGES",
        wanted: 4,
        available: 2,
        cause: "pool",
      });
    }
  });

  it("distinguishes a pool that is too small from one that cannot add up", () => {
    // Six reading-comprehension questions in two passages of three. A section
    // asking for four cannot be filled without splitting a passage, and an
    // author told "needs 4 and has 6" would have no idea what to do.
    const passages: PoolQuestion[] = [
      ...pool("READING_COMPREHENSION", 3, { passageId: "psgA" }).map((q, i) => ({ ...q, id: `A${i}` })),
      ...pool("READING_COMPREHENSION", 3, { passageId: "psgB" }).map((q, i) => ({ ...q, id: `B${i}` })),
    ];
    const section: SectionBlueprint = {
      ...quantSection,
      topicMix: [{ topic: "READING_COMPREHENSION", count: 4 }],
      questionCount: 4,
    };
    try {
      buildMockLayout({ seed: 1, sections: [section], pool: passages });
      throw new Error("expected BlueprintUnfillable");
    } catch (error) {
      expect(error).toBeInstanceOf(BlueprintUnfillable);
      const { shortfalls, message } = error as BlueprintUnfillable;
      expect(shortfalls[0]!.cause).toBe("grouping");
      expect(shortfalls[0]!.available).toBe(6);
      expect(message).toContain("passage groups that cannot total 4 without splitting one");
    }
  });

  it("fills a blueprint that groups add up to exactly, even where greedy would fail", () => {
    // Needing four from groups of three, three, two and two: a greedy draw
    // takes a three and then cannot place one, while two plus two fits.
    const passages: PoolQuestion[] = [
      ...pool("READING_COMPREHENSION", 3, { passageId: "p3a" }).map((q, i) => ({ ...q, id: `a${i}` })),
      ...pool("READING_COMPREHENSION", 3, { passageId: "p3b" }).map((q, i) => ({ ...q, id: `b${i}` })),
      ...pool("READING_COMPREHENSION", 2, { passageId: "p2a" }).map((q, i) => ({ ...q, id: `c${i}` })),
      ...pool("READING_COMPREHENSION", 2, { passageId: "p2b" }).map((q, i) => ({ ...q, id: `d${i}` })),
    ];
    const section: SectionBlueprint = {
      ...quantSection,
      topicMix: [{ topic: "READING_COMPREHENSION", count: 4 }],
      questionCount: 4,
    };
    for (let seed = 1; seed <= 20; seed++) {
      const layout = buildMockLayout({ seed, sections: [section], pool: passages });
      const served = layout.sections[0]!.questions;
      expect(served, `seed ${seed}`).toHaveLength(4);
      // Two whole groups of two, never half of a three.
      const counts = new Map<string, number>();
      for (const q of served) counts.set(q.passageId!, (counts.get(q.passageId!) ?? 0) + 1);
      for (const [passageId, count] of counts) {
        const whole = passages.filter((q) => q.passageId === passageId).length;
        expect(count, `seed ${seed}: ${passageId}`).toBe(whole);
      }
    }
  });

  it("fills a blueprint that exactly exhausts the pool", () => {
    const layout = buildMockLayout({
      seed: 1,
      sections: [quantSection],
      pool: [...pool("PERCENTAGES", 3), ...pool("PROFIT_LOSS", 2)],
    });
    expect(layout.sections[0]!.questions).toHaveLength(5);
  });
});

describe("option order", () => {
  it("is a permutation of the question's own indexes", () => {
    const layout = buildMockLayout({ seed: 9, sections: [quantSection], pool: basePool });
    for (const question of layout.sections[0]!.questions) {
      expect([...question.optionOrder].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    }
  });

  it("is the identity when the section says not to shuffle options", () => {
    const layout = buildMockLayout({
      seed: 9,
      sections: [{ ...quantSection, shuffleOptions: false }],
      pool: basePool,
    });
    for (const question of layout.sections[0]!.questions) {
      expect(question.optionOrder).toEqual([0, 1, 2, 3]);
    }
  });

  it("leaves a pinned option where the author put it", () => {
    // SPEC §5: excluding fixedPosition options like "None of the above".
    // Moving that one to the middle makes the question nonsense.
    const pinned = pool("PERCENTAGES", 5, { fixedOptionIndexes: [3] });
    for (let seed = 1; seed <= 25; seed++) {
      const layout = buildMockLayout({
        seed,
        sections: [{ ...quantSection, topicMix: [{ topic: "PERCENTAGES", count: 5 }], questionCount: 5 }],
        pool: pinned,
      });
      for (const question of layout.sections[0]!.questions) {
        expect(question.optionOrder[3], `seed ${seed}`).toBe(3);
        expect([...question.optionOrder].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
      }
    }
  });

  it("gives a numeric-entry question an empty order", () => {
    const layout = buildMockLayout({
      seed: 1,
      sections: [{ ...quantSection, topicMix: [{ topic: "PERCENTAGES", count: 2 }], questionCount: 2 }],
      pool: pool("PERCENTAGES", 2, { optionCount: 0 }),
    });
    for (const question of layout.sections[0]!.questions) expect(question.optionOrder).toEqual([]);
  });

  it("keeps one question's option order fixed whatever happens to the others", () => {
    // Derived from the question id, not its position, so re-deriving one
    // question does not require replaying the whole paper.
    const a = buildMockLayout({ seed: 4, sections: [quantSection], pool: basePool });
    const wider = buildMockLayout({
      seed: 4,
      sections: [{ ...quantSection, topicMix: [{ topic: "PERCENTAGES", count: 8 }, { topic: "PROFIT_LOSS", count: 2 }], questionCount: 10 }],
      pool: basePool,
    });
    const first = a.sections[0]!.questions[0]!;
    const same = wider.sections[0]!.questions.find((q) => q.questionId === first.questionId);
    expect(same?.optionOrder).toEqual(first.optionOrder);
  });
});

describe("mapping a selection back to the question's own order", () => {
  // Shown position 0 holds the question's option 2, and so on.
  const optionOrder = [2, 0, 3, 1];

  it("translates what the candidate clicked", () => {
    expect(mapSelectionToOriginal([0], optionOrder)).toEqual([2]);
    expect(mapSelectionToOriginal([1, 3], optionOrder)).toEqual([0, 1]);
  });

  it("returns the stored indexes sorted, so two equal answers compare equal", () => {
    expect(mapSelectionToOriginal([2, 0], optionOrder)).toEqual([2, 3]);
  });

  it("drops an index outside the permutation rather than storing it", () => {
    // A stale client or a crafted request; storing it would corrupt the
    // answer row, and the row is what a dispute reads.
    expect(mapSelectionToOriginal([9], optionOrder)).toEqual([]);
    expect(mapSelectionToOriginal([-1, 0], optionOrder)).toEqual([2]);
  });

  it("drops a duplicate click", () => {
    expect(mapSelectionToOriginal([0, 0], optionOrder)).toEqual([2]);
  });

  it("round-trips through the inverse", () => {
    const stored = mapSelectionToOriginal([1, 2], optionOrder);
    expect(mapOriginalToShown(stored, optionOrder).sort()).toEqual([1, 2]);
  });

  it("shows the options in the candidate's own order", () => {
    expect(mapOptionsToShown(["a", "b", "c", "d"], optionOrder)).toEqual(["c", "a", "d", "b"]);
  });
});

describe("reading a stored layout", () => {
  it("accepts one it built", () => {
    const layout = buildMockLayout({ seed: 1, sections: [quantSection], pool: basePool });
    expect(parseMockLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });

  it("refuses an unversioned or wrongly versioned layout", () => {
    expect(() => parseMockLayout({ sections: [] })).toThrow();
    expect(() => parseMockLayout({ v: 2, sections: [] })).toThrow();
  });

  it("refuses an unknown field, so a shape change is loud", () => {
    const layout = buildMockLayout({ seed: 1, sections: [quantSection], pool: basePool });
    const tampered = JSON.parse(JSON.stringify(layout));
    tampered.sections[0].questions[0].answer = 2;
    expect(() => parseMockLayout(tampered)).toThrow();
  });

  it("finds a section by key and nothing by a wrong one", () => {
    const layout = buildMockLayout({ seed: 1, sections: [quantSection], pool: basePool });
    expect(layoutSection(layout, "quantitative")?.position).toBe(1);
    expect(layoutSection(layout, "verbal")).toBeNull();
  });
});
