import { describe, expect, it } from "vitest";
import {
  APTITUDE_LIMITS,
  APTITUDE_QUESTION_KINDS,
  EXPLANATION_MIN_CHARS,
  aptitudeDisplayCode,
  aptitudePassageSchema,
  aptitudePublishSchema,
  aptitudeQuestionSchema,
  isChoiceKind,
  normaliseQuestionForHash,
  wordCountOf,
} from "../src/aptitude-question";

const single = {
  kind: "SINGLE_CHOICE" as const,
  area: "QUANTITATIVE" as const,
  topic: "PERCENTAGES" as const,
  difficulty: "EASY" as const,
  stem: "What is 10% of 250?",
  options: ["25", "20", "30", "35"],
  correctOptionIndexes: [0],
  explanation: "Ten percent is one tenth of the number, so 250 divided by 10 gives 25.",
  expectedSeconds: 45,
  origin: "FACULTY" as const,
};

const numeric = {
  kind: "NUMERIC_ENTRY" as const,
  area: "QUANTITATIVE" as const,
  topic: "AVERAGES_MIXTURES" as const,
  difficulty: "MEDIUM" as const,
  stem: "The mean of 4, 8 and 12 is?",
  numericAnswer: 8,
  numericTolerance: 0,
  explanation: "Adding the three values gives 24, and dividing by three gives a mean of 8.",
  expectedSeconds: 60,
  origin: "FACULTY" as const,
};

const passage = {
  kind: "PASSAGE_GROUPED" as const,
  area: "VERBAL" as const,
  topic: "READING_COMPREHENSION" as const,
  difficulty: "MEDIUM" as const,
  stem: "What does the author mean by “a quiet revolution”?",
  options: ["A gradual change", "A violent change", "No change at all", "A reversal"],
  correctOptionIndexes: [1],
  explanation: "The author contrasts it with upheaval two sentences earlier, so a gradual change is meant.",
  expectedSeconds: 90,
  origin: "FACULTY" as const,
  passageId: "psg1",
};

describe("the four kinds", () => {
  it("are the four the spec lists", () => {
    // SPEC §5: "single-choice, multi-choice, numeric-entry, passage-grouped".
    expect(APTITUDE_QUESTION_KINDS).toEqual(["SINGLE_CHOICE", "MULTI_CHOICE", "NUMERIC_ENTRY", "PASSAGE_GROUPED"]);
  });

  it("knows which are answered by choosing", () => {
    expect(isChoiceKind("SINGLE_CHOICE")).toBe(true);
    expect(isChoiceKind("MULTI_CHOICE")).toBe(true);
    expect(isChoiceKind("PASSAGE_GROUPED")).toBe(true);
    expect(isChoiceKind("NUMERIC_ENTRY")).toBe(false);
  });
});

describe("single choice", () => {
  it("accepts a well-formed question and defaults the numeric fields to null", () => {
    const parsed = aptitudeQuestionSchema.parse(single);
    expect(parsed.correctOptionIndexes).toEqual([0]);
    expect(parsed.numericAnswer).toBeNull();
    expect(parsed.numericTolerance).toBeNull();
    expect(parsed.passageId).toBeNull();
    expect(parsed.sourceBatch).toBeNull();
  });

  it("requires exactly one correct option", () => {
    expect(aptitudeQuestionSchema.safeParse({ ...single, correctOptionIndexes: [] }).success).toBe(false);
    expect(aptitudeQuestionSchema.safeParse({ ...single, correctOptionIndexes: [0, 1] }).success).toBe(false);
  });

  it("refuses a correct index past the end of the options", () => {
    const result = aptitudeQuestionSchema.safeParse({ ...single, correctOptionIndexes: [7] });
    expect(result.success).toBe(false);
    if (!result.success) {
      // An out-of-range key is a question nobody can answer correctly, so the
      // message names the option rather than the array index.
      expect(result.error.issues.some((i) => i.message.includes("Option 8 does not exist"))).toBe(true);
    }
  });

  it("refuses fewer than two options and more than eight", () => {
    expect(aptitudeQuestionSchema.safeParse({ ...single, options: ["25"] }).success).toBe(false);
    expect(
      aptitudeQuestionSchema.safeParse({ ...single, options: Array.from({ length: 9 }, (_, i) => `o${i}`) }).success,
    ).toBe(false);
  });

  it("refuses a numeric answer on a choice question", () => {
    expect(aptitudeQuestionSchema.safeParse({ ...single, numericAnswer: 25 }).success).toBe(false);
    expect(aptitudeQuestionSchema.safeParse({ ...single, numericTolerance: 0 }).success).toBe(false);
  });

  it("refuses a passage link on anything but a passage question", () => {
    const result = aptitudeQuestionSchema.safeParse({ ...single, passageId: "psg1" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("passage-grouped");
  });
});

describe("multi choice", () => {
  const multi = { ...single, kind: "MULTI_CHOICE" as const, correctOptionIndexes: [0, 2] };

  it("accepts two or more correct options", () => {
    expect(aptitudeQuestionSchema.safeParse(multi).success).toBe(true);
    expect(aptitudeQuestionSchema.safeParse({ ...multi, correctOptionIndexes: [0, 1, 2] }).success).toBe(true);
  });

  it("refuses exactly one correct option", () => {
    // A multi-choice with one correct option is a mis-authored single-choice:
    // it makes the all-or-nothing rule indistinguishable from single-choice
    // scoring, which is the worst of both for a candidate.
    expect(aptitudeQuestionSchema.safeParse({ ...multi, correctOptionIndexes: [1] }).success).toBe(false);
  });

  it("refuses the same option marked correct twice", () => {
    const result = aptitudeQuestionSchema.safeParse({ ...multi, correctOptionIndexes: [1, 1] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((i) => i.message.includes("twice"))).toBe(true);
  });

  it("refuses more correct options than there are options", () => {
    const result = aptitudeQuestionSchema.safeParse({ ...multi, options: ["a", "b"], correctOptionIndexes: [0, 1, 2] });
    expect(result.success).toBe(false);
  });
});

describe("numeric entry", () => {
  it("accepts an answer with a tolerance and no options", () => {
    const parsed = aptitudeQuestionSchema.parse(numeric);
    expect(parsed.options).toEqual([]);
    expect(parsed.correctOptionIndexes).toEqual([]);
    expect(parsed.numericUnit).toBeNull();
  });

  it("requires both the answer and the tolerance", () => {
    expect(aptitudeQuestionSchema.safeParse({ ...numeric, numericAnswer: null }).success).toBe(false);
    expect(aptitudeQuestionSchema.safeParse({ ...numeric, numericTolerance: null }).success).toBe(false);
  });

  it("refuses a negative tolerance", () => {
    expect(aptitudeQuestionSchema.safeParse({ ...numeric, numericTolerance: -0.5 }).success).toBe(false);
  });

  it("refuses options on a numeric question", () => {
    expect(aptitudeQuestionSchema.safeParse({ ...numeric, options: ["8", "9"] }).success).toBe(false);
  });

  it("refuses a value that does not fit Decimal(20, 6)", () => {
    // The column would silently round or overflow, and a graded field must
    // never do either.
    expect(aptitudeQuestionSchema.safeParse({ ...numeric, numericAnswer: 1e15 }).success).toBe(false);
    expect(aptitudeQuestionSchema.safeParse({ ...numeric, numericAnswer: Number.POSITIVE_INFINITY }).success).toBe(
      false,
    );
  });

  it("accepts a unit, which the field must name for a screen reader", () => {
    expect(aptitudeQuestionSchema.parse({ ...numeric, numericUnit: "km/h" }).numericUnit).toBe("km/h");
  });
});

describe("passage grouped", () => {
  it("requires a passage", () => {
    expect(aptitudeQuestionSchema.safeParse(passage).success).toBe(true);
    expect(aptitudeQuestionSchema.safeParse({ ...passage, passageId: null }).success).toBe(false);
  });

  it("answers as single-choice, which is the narrower reading", () => {
    // docs/OPEN-QUESTIONS.md: a multi-choice reading-comprehension item would
    // need the partial-credit convention this phase deliberately lacks.
    expect(aptitudeQuestionSchema.safeParse({ ...passage, correctOptionIndexes: [0, 1] }).success).toBe(false);
  });
});

describe("the area ↔ topic rule", () => {
  it("refuses a topic that belongs to another area", () => {
    // The one mistake a bulk import makes most, and the one that silently
    // corrupts every section blueprint and every weakness heatmap.
    const result = aptitudeQuestionSchema.safeParse({ ...single, area: "VERBAL", topic: "MENSURATION" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("QUANTITATIVE topic, not VERBAL");
  });

  it("refuses an unknown topic outright", () => {
    expect(aptitudeQuestionSchema.safeParse({ ...single, topic: "VIBES" }).success).toBe(false);
  });
});

describe("the explanation", () => {
  it("is not required to save a draft", () => {
    // A DRAFT with no explanation yet is a legitimate work in progress, and
    // refusing to SAVE it would push authors to paste a placeholder.
    expect(aptitudeQuestionSchema.safeParse({ ...single, explanation: "" }).success).toBe(true);
  });

  it("is required to publish, at the 40-character floor", () => {
    expect(aptitudePublishSchema.safeParse(single).success).toBe(true);
    expect(aptitudePublishSchema.safeParse({ ...single, explanation: "Use the formula." }).success).toBe(false);
    expect(aptitudePublishSchema.safeParse({ ...single, explanation: "x".repeat(EXPLANATION_MIN_CHARS) }).success).toBe(
      true,
    );
    expect(
      aptitudePublishSchema.safeParse({ ...single, explanation: "x".repeat(EXPLANATION_MIN_CHARS - 1) }).success,
    ).toBe(false);
  });

  it("says what is missing and why", () => {
    const result = aptitudePublishSchema.safeParse({ ...single, explanation: "" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("the working, not a tick");
  });

  it("allows a worked solution long enough to be one", () => {
    const long = "Step one: convert the rate. ".repeat(200); // 5,600 chars
    expect(long.length).toBeGreaterThan(APTITUDE_LIMITS.stem.max);
    expect(aptitudePublishSchema.safeParse({ ...single, explanation: long }).success).toBe(true);
  });

  it("refuses one past the bound", () => {
    const tooLong = "x".repeat(APTITUDE_LIMITS.explanation.max + 1);
    expect(aptitudeQuestionSchema.safeParse({ ...single, explanation: tooLong }).success).toBe(false);
  });
});

describe("bounds", () => {
  it("refuses an empty stem and one past the bound", () => {
    expect(aptitudeQuestionSchema.safeParse({ ...single, stem: "  " }).success).toBe(false);
    expect(
      aptitudeQuestionSchema.safeParse({ ...single, stem: "x".repeat(APTITUDE_LIMITS.stem.max + 1) }).success,
    ).toBe(false);
  });

  it("holds expectedSeconds between 5 and 1800", () => {
    expect(aptitudeQuestionSchema.safeParse({ ...single, expectedSeconds: 4 }).success).toBe(false);
    expect(aptitudeQuestionSchema.safeParse({ ...single, expectedSeconds: 1_801 }).success).toBe(false);
    expect(aptitudeQuestionSchema.safeParse({ ...single, expectedSeconds: 1_800 }).success).toBe(true);
  });

  it("refuses an unknown field, so an import typo is an error and not a silent drop", () => {
    expect(aptitudeQuestionSchema.safeParse({ ...single, marks: 2 }).success).toBe(false);
  });

  it("trims the stem and the options", () => {
    const parsed = aptitudeQuestionSchema.parse({ ...single, stem: "  What is 10% of 250?  ", options: [" 25 ", "20", "30", "35"] });
    expect(parsed.stem).toBe("What is 10% of 250?");
    expect(parsed.options[0]).toBe("25");
  });
});

describe("the passage itself", () => {
  const body = "A quiet revolution has reshaped the way small towns buy and sell. ".repeat(4);

  const valid = {
    area: "VERBAL" as const,
    topic: "READING_COMPREHENSION" as const,
    title: "A quiet revolution",
    body,
    sourceNote: "Written at REC for the verbal bank, 2026.",
    origin: "FACULTY" as const,
  };

  it("accepts a passage of real length", () => {
    expect(body.length).toBeGreaterThan(APTITUDE_LIMITS.passageBody.min);
    expect(aptitudePassageSchema.safeParse(valid).success).toBe(true);
  });

  it("refuses something shorter than a passage", () => {
    // Under 80 characters it is a stem, not a passage.
    expect(aptitudePassageSchema.safeParse({ ...valid, body: "Too short." }).success).toBe(false);
  });

  it("requires a stated provenance", () => {
    expect(aptitudePassageSchema.safeParse({ ...valid, sourceNote: "mine" }).success).toBe(false);
  });

  it("counts words, and counts an empty body as none", () => {
    expect(wordCountOf("  one two   three ")).toBe(3);
    expect(wordCountOf("   ")).toBe(0);
  });

  it("requires at least two questions per passage", () => {
    // SPEC §5 says "one shared passage, N questions"; a passage with one
    // question is a stem with extra steps.
    expect(APTITUDE_LIMITS.passageQuestions.min).toBe(2);
  });
});

describe("the content hash", () => {
  const key = {
    kind: "SINGLE_CHOICE" as const,
    topic: "PERCENTAGES" as const,
    stem: "What is 10% of 250?",
    options: ["25", "20"],
    correctOptionIndexes: [0],
    numericAnswer: null,
    numericTolerance: null,
  };

  it("sees through whitespace and case in the stem", () => {
    expect(normaliseQuestionForHash({ ...key, stem: "  what   is 10% OF 250? " })).toBe(normaliseQuestionForHash(key));
  });

  it("sees through the order of the correct indexes", () => {
    const multi = { ...key, kind: "MULTI_CHOICE" as const, options: ["a", "b", "c"], correctOptionIndexes: [2, 0] };
    expect(normaliseQuestionForHash(multi)).toBe(normaliseQuestionForHash({ ...multi, correctOptionIndexes: [0, 2] }));
  });

  it("does NOT see through the option order", () => {
    // A reordered question is the same question to a reader, but its stored
    // key has moved; treating the two as one row would silently rescore
    // everyone who has already answered it.
    expect(normaliseQuestionForHash({ ...key, options: ["20", "25"] })).not.toBe(normaliseQuestionForHash(key));
  });

  it("does not see through the numeric answer or the tolerance", () => {
    const base = { ...key, kind: "NUMERIC_ENTRY" as const, options: [], correctOptionIndexes: [], numericAnswer: 8, numericTolerance: 0 };
    expect(normaliseQuestionForHash({ ...base, numericAnswer: 9 })).not.toBe(normaliseQuestionForHash(base));
    expect(normaliseQuestionForHash({ ...base, numericTolerance: 0.5 })).not.toBe(normaliseQuestionForHash(base));
  });

  it("treats 8, 8.0 and \"8.000000\" as the same answer", () => {
    const base = { ...key, kind: "NUMERIC_ENTRY" as const, options: [], correctOptionIndexes: [], numericAnswer: 8, numericTolerance: 0 };
    expect(normaliseQuestionForHash({ ...base, numericAnswer: 8.0 })).toBe(normaliseQuestionForHash(base));
    expect(normaliseQuestionForHash({ ...base, numericAnswer: "8.000000" })).toBe(normaliseQuestionForHash(base));
  });

  it("does not let one field's text run into the next", () => {
    // A separator a stem could contain would make two different questions
    // hash the same, which is a silent duplicate-detection failure.
    expect(normaliseQuestionForHash({ ...key, stem: "a", options: ["b", "c"] })).not.toBe(
      normaliseQuestionForHash({ ...key, stem: "a b", options: ["c", ""] }),
    );
  });

  it("ignores the explanation, so improving the working is not a new question", () => {
    // Decision 17: a published question's key is frozen; its explanation is
    // not. A re-import that only improves the working reports UNCHANGED.
    const withExplanation = { ...key } as Record<string, unknown>;
    withExplanation.explanation = "A completely different explanation.";
    expect(normaliseQuestionForHash(withExplanation as typeof key)).toBe(normaliseQuestionForHash(key));
  });
});

describe("display codes", () => {
  it("pads to the Problem.displayCode convention", () => {
    expect(aptitudeDisplayCode(42)).toBe("APT-00042");
    expect(aptitudeDisplayCode(1)).toBe("APT-00001");
    expect(aptitudeDisplayCode(123_456)).toBe("APT-123456");
  });

  it("matches the pattern the CHECK uses", () => {
    for (const n of [1, 42, 99_999, 100_000]) {
      expect(APTITUDE_LIMITS.displayCode.test(aptitudeDisplayCode(n)), String(n)).toBe(true);
    }
    expect(APTITUDE_LIMITS.displayCode.test("APT-1")).toBe(false);
    expect(APTITUDE_LIMITS.displayCode.test("PRB-00001")).toBe(false);
  });
});
