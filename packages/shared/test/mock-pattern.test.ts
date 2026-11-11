import { describe, expect, it } from "vitest";
import { APTITUDE_TOPIC_AREA } from "../src/aptitude-taxonomy";
import {
  GENERIC_PATTERN_NOTICE,
  MOCK_ATTEMPT_STATUSES,
  MOCK_PATTERN_SEEDS,
  MOCK_PATTERN_STATUSES,
  MOCK_SECTION_LIMITS,
  MODELLED_ON_NOTICE,
  SEED_PATTERN_SLUGS,
  findPatternSeed,
  mockPatternSchema,
  mockSectionSchema,
  patternBlueprintIssues,
  patternNotice,
  patternTopics,
  patternTotals,
} from "../src/mock-pattern";

describe("the required label", () => {
  it("carries the spec's notice in the spec's own words", () => {
    expect(MODELLED_ON_NOTICE).toBe("Modelled on the publicly described pattern — not an official test.");
  });

  it("gives the pattern that models nobody a truthful notice instead", () => {
    // Telling a student that `campus-generic` is "modelled on the publicly
    // described pattern" would be the one false sentence on the page. It
    // still needs the half that matters.
    expect(GENERIC_PATTERN_NOTICE).toContain("not an official test");
    expect(GENERIC_PATTERN_NOTICE).not.toContain("publicly described");
  });

  it("never returns silence", () => {
    expect(patternNotice({ modelledOnCompany: true })).toBe(MODELLED_ON_NOTICE);
    expect(patternNotice({ modelledOnCompany: false })).toBe(GENERIC_PATTERN_NOTICE);
    for (const pattern of MOCK_PATTERN_SEEDS) expect(patternNotice(pattern).length).toBeGreaterThan(20);
  });

  it("marks exactly the five company patterns as modelled on a company", () => {
    expect(MOCK_PATTERN_SEEDS.filter((p) => p.modelledOnCompany).map((p) => p.slug)).toEqual([
      "tcs-nqt",
      "infosys",
      "wipro",
      "cognizant",
      "accenture",
    ]);
    expect(findPatternSeed("campus-generic")?.modelledOnCompany).toBe(false);
  });
});

describe("the statuses", () => {
  it("has no voiding value for an attempt", () => {
    // A practice mock has no invigilator, and an enum with no voiding value
    // is an enum no future code path and no future UI can void from.
    expect(MOCK_ATTEMPT_STATUSES).toEqual(["IN_PROGRESS", "SUBMITTED", "AUTO_SUBMITTED", "ABANDONED"]);
    expect(MOCK_ATTEMPT_STATUSES).not.toContain("VOIDED");
    expect(MOCK_ATTEMPT_STATUSES).not.toContain("TERMINATED");
  });

  it("has the three pattern statuses", () => {
    expect(MOCK_PATTERN_STATUSES).toEqual(["DRAFT", "PUBLISHED", "ARCHIVED"]);
  });
});

describe("the six seeded patterns", () => {
  it("are the ones the spec names, in order", () => {
    expect(SEED_PATTERN_SLUGS).toEqual(["tcs-nqt", "infosys", "wipro", "cognizant", "accenture", "campus-generic"]);
  });

  it("each validate against the pattern schema", () => {
    // The seeds go through the same gate an admin-authored pattern does: a
    // seed the schema would refuse is a seed the seeder cannot insert.
    for (const pattern of MOCK_PATTERN_SEEDS) {
      const result = mockPatternSchema.safeParse(pattern);
      expect(result.success, `${pattern.slug}: ${result.success ? "" : JSON.stringify(result.error.issues)}`).toBe(true);
    }
  });

  it("each state a provenance long enough to check", () => {
    for (const pattern of MOCK_PATTERN_SEEDS) {
      expect(pattern.sourceNote.trim().length, pattern.slug).toBeGreaterThanOrEqual(10);
      expect(pattern.funnelLabel.trim().length, pattern.slug).toBeGreaterThan(2);
    }
  });

  it("each have sections numbered 1…n with distinct labels", () => {
    for (const pattern of MOCK_PATTERN_SEEDS) {
      expect(
        pattern.sections.map((s) => s.position),
        pattern.slug,
      ).toEqual(pattern.sections.map((_, i) => i + 1));
      expect(patternBlueprintIssues(pattern), pattern.slug).toEqual([]);
    }
  });

  it("each have a blueprint that sums to its section length", () => {
    for (const pattern of MOCK_PATTERN_SEEDS) {
      for (const section of pattern.sections) {
        const summed = section.topicMix.reduce((sum, entry) => sum + entry.count, 0);
        expect(summed, `${pattern.slug}/${section.key}`).toBe(section.questionCount);
      }
    }
  });

  it("never draws a topic from outside a section's own area", () => {
    // A VERBAL question in a quantitative section would corrupt the weakness
    // heatmap as well as the paper.
    for (const pattern of MOCK_PATTERN_SEEDS) {
      for (const section of pattern.sections) {
        if (section.area === null) continue;
        for (const entry of section.topicMix) {
          expect(APTITUDE_TOPIC_AREA[entry.topic], `${pattern.slug}/${section.key}/${entry.topic}`).toBe(section.area);
        }
      }
    }
  });

  it("never lists a topic twice in one section", () => {
    for (const pattern of MOCK_PATTERN_SEEDS) {
      for (const section of pattern.sections) {
        const topics = section.topicMix.map((e) => e.topic);
        expect(new Set(topics).size, `${pattern.slug}/${section.key}`).toBe(topics.length);
      }
    }
  });

  it("gives every pattern totals a student would recognise", () => {
    for (const pattern of MOCK_PATTERN_SEEDS) {
      const totals = patternTotals(pattern);
      expect(totals.totalQuestions, pattern.slug).toBeGreaterThan(20);
      expect(totals.totalTimeSec, pattern.slug).toBeGreaterThan(20 * 60);
      // Nobody sits a three-hour aptitude mock in one go.
      expect(totals.totalTimeSec, pattern.slug).toBeLessThanOrEqual(3 * 3_600);
    }
  });

  it("sums the totals the trigger will mirror", () => {
    // `recx_sync_pattern_totals` recomputes these in the database; the live
    // test asserts the two agree on all six.
    expect(patternTotals(findPatternSeed("tcs-nqt")!)).toEqual({ totalQuestions: 80, totalTimeSec: 90 * 60 });
  });

  it("lists every topic a pattern draws on, in taxonomy order", () => {
    const topics = patternTopics(findPatternSeed("accenture")!);
    expect(topics).toContain("READING_COMPREHENSION");
    expect(topics).toContain("SERIES");
    expect(new Set(topics).size).toBe(topics.length);
    // Accenture's three sections are verbal and logical only.
    expect(topics.some((t) => APTITUDE_TOPIC_AREA[t] === "QUANTITATIVE")).toBe(false);
  });

  it("finds a pattern by slug and nothing by a wrong one", () => {
    expect(findPatternSeed("tcs-nqt")?.name).toBe("TCS NQT");
    expect(findPatternSeed("TCS-NQT")).toBeNull();
    expect(findPatternSeed("nope")).toBeNull();
  });

  it("is frozen, so no caller can edit the shared copy", () => {
    expect(Object.isFrozen(MOCK_PATTERN_SEEDS)).toBe(true);
    expect(Object.isFrozen(MOCK_PATTERN_SEEDS[0]!.sections)).toBe(true);
  });
});

// ── The section schema ──────────────────────────────────────────────────

const section = {
  position: 1,
  key: "quantitative",
  label: "Quantitative aptitude",
  area: "QUANTITATIVE" as const,
  topicMix: [
    { topic: "PERCENTAGES" as const, count: 6 },
    { topic: "PROFIT_LOSS" as const, count: 4 },
  ],
  questionCount: 10,
  timeLimitSec: 600,
  cutoffPercent: 50,
  marksPerCorrect: 1,
  negativeMarkFraction: 0,
  allowBackNavigation: true,
};

describe("mockSectionSchema", () => {
  it("accepts a well-formed section and defaults the shuffles on", () => {
    const parsed = mockSectionSchema.parse(section);
    expect(parsed.shuffleQuestions).toBe(true);
    expect(parsed.shuffleOptions).toBe(true);
  });

  it("refuses a blueprint that does not sum to the section length", () => {
    const result = mockSectionSchema.safeParse({ ...section, questionCount: 12 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("draws 10 questions but the section is 12");
  });

  it("refuses a topic from another area", () => {
    const result = mockSectionSchema.safeParse({
      ...section,
      topicMix: [{ topic: "CLOZE", count: 10 }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]!.message).toContain("VERBAL topic in a QUANTITATIVE section");
  });

  it("allows any topic in a deliberately mixed section", () => {
    expect(
      mockSectionSchema.safeParse({
        ...section,
        area: null,
        topicMix: [
          { topic: "PERCENTAGES", count: 5 },
          { topic: "CLOZE", count: 5 },
        ],
      }).success,
    ).toBe(true);
  });

  it("refuses the same topic on two lines", () => {
    const result = mockSectionSchema.safeParse({
      ...section,
      topicMix: [
        { topic: "PERCENTAGES", count: 5 },
        { topic: "PERCENTAGES", count: 5 },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((i) => i.message.includes("appears twice"))).toBe(true);
  });

  it("holds the negative mark in [0, 1]", () => {
    // A 2-mark penalty on a 1-mark question makes a mock strictly harsher
    // than the funnel it claims to model.
    expect(mockSectionSchema.safeParse({ ...section, negativeMarkFraction: -0.1 }).success).toBe(false);
    expect(mockSectionSchema.safeParse({ ...section, negativeMarkFraction: 1.01 }).success).toBe(false);
    expect(mockSectionSchema.safeParse({ ...section, negativeMarkFraction: 1 }).success).toBe(true);
  });

  it("holds the cutoff in [0, 100] and the marks above zero", () => {
    expect(mockSectionSchema.safeParse({ ...section, cutoffPercent: 101 }).success).toBe(false);
    expect(mockSectionSchema.safeParse({ ...section, marksPerCorrect: 0 }).success).toBe(false);
  });

  it("holds the time limit between a minute and two hours", () => {
    expect(mockSectionSchema.safeParse({ ...section, timeLimitSec: 59 }).success).toBe(false);
    expect(mockSectionSchema.safeParse({ ...section, timeLimitSec: 7_201 }).success).toBe(false);
  });

  it("refuses an unknown field", () => {
    expect(mockSectionSchema.safeParse({ ...section, overallCutoffPercent: 50 }).success).toBe(false);
  });
});

describe("patternBlueprintIssues", () => {
  const pattern = (
    sections: Array<{ position: number; key?: string; label: string; questionCount: number; timeLimitSec: number }>,
  ) => ({ sections: sections.map((s) => ({ key: s.label.toLowerCase(), ...s })) });

  it("reports nothing for a sound pattern", () => {
    expect(
      patternBlueprintIssues(
        pattern([
          { position: 1, label: "A", questionCount: 10, timeLimitSec: 600 },
          { position: 2, label: "B", questionCount: 10, timeLimitSec: 600 },
        ]),
      ),
    ).toEqual([]);
  });

  it("catches a duplicated position and a gap", () => {
    expect(
      patternBlueprintIssues(
        pattern([
          { position: 1, label: "A", questionCount: 1, timeLimitSec: 600 },
          { position: 1, label: "B", questionCount: 1, timeLimitSec: 600 },
        ]),
      ),
    ).toContain("Two sections share a position.");
    expect(
      patternBlueprintIssues(
        pattern([
          { position: 1, label: "A", questionCount: 1, timeLimitSec: 600 },
          { position: 3, label: "B", questionCount: 1, timeLimitSec: 600 },
        ]),
      ),
    ).toContain("Positions must run 1…2 with no gaps.");
  });

  it("catches a duplicated label, whatever its case", () => {
    expect(
      patternBlueprintIssues(
        pattern([
          { position: 1, label: "Verbal", questionCount: 1, timeLimitSec: 600 },
          { position: 2, label: " verbal ", questionCount: 1, timeLimitSec: 600 },
        ]),
      ),
    ).toContain("Two sections share a label.");
  });

  it("catches a section where the timer is the test", () => {
    const issues = patternBlueprintIssues(pattern([{ position: 1, label: "Rush", questionCount: 60, timeLimitSec: 600 }]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("10s a question");
    expect(MOCK_SECTION_LIMITS.secondsPerQuestion.min).toBe(20);
  });

  it("reports every problem, not the first", () => {
    // An author fixing a blueprint should see the whole list rather than
    // discovering the next problem on each save.
    const issues = patternBlueprintIssues(
      pattern([
        { position: 1, label: "A", questionCount: 60, timeLimitSec: 600 },
        { position: 1, label: "A", questionCount: 60, timeLimitSec: 600 },
      ]),
    );
    expect(issues.length).toBeGreaterThan(2);
  });
});
