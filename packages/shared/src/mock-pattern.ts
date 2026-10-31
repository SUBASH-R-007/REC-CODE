import { z } from "zod";
import {
  APTITUDE_AREAS,
  APTITUDE_TOPICS,
  APTITUDE_TOPIC_AREA,
  type AptitudeArea,
  type AptitudeTopic,
} from "./aptitude-taxonomy";
import type { SectionRule } from "./aptitude-grading";

/**
 * Mock patterns: a recruiter funnel encoded declaratively (Phase 7).
 *
 * SPEC §5:
 *
 *   MockPattern encodes a recruiter funnel declaratively: ordered sections,
 *   per-section time limit, question count, per-section cutoff,
 *   negative-marking fraction, allowBackNavigation. Seed patterns modelled on
 *   the publicly described TCS NQT, Infosys, Wipro, Cognizant and Accenture
 *   funnels plus a generic campus pattern, each labelled in the UI "modelled
 *   on the publicly described pattern — not an official test."
 *
 * The seed patterns live HERE, in `@recx/shared`, and not under
 * `apps/web/scripts/content/`. The spec's gate test is "negative marking and
 * per-section cutoffs compute correctly across ALL SEEDED PATTERNS", and a
 * test in `packages/shared` cannot import `apps/web` — this package declares
 * one dependency (zod) and its vitest config is "pure unit tests: no I/O".
 * Putting the patterns beside the arithmetic that grades them is what makes
 * the gate test possible at all. The seed script reads them from here.
 *
 * Every number below comes from what these companies have published or
 * described about their own screening rounds. None of it is inside
 * information, none of it is scraped from a paper, and none of it is claimed
 * to be current: a funnel changes between hiring seasons, and a pattern here
 * going stale is expected rather than a bug. What is encoded is a SHAPE —
 * section order, counts, minutes, cutoffs — and every question drawn into it
 * is authored at REC from faculty banks that already exist on paper.
 */

/**
 * The notice SPEC §5 requires, in the spec's own words.
 *
 * One shared constant, not a per-row column: an editable per-row disclaimer
 * is a per-row opportunity to delete the disclaimer. It is rendered by ONE
 * component wherever a pattern's name appears — the card, the cover page and
 * the result page — and `tests/repo/aptitude-notice.test.ts` fails if any
 * surface renders a pattern name without it, because a label a future
 * redesign can quietly drop is a label that implies an endorsement these
 * companies have not given.
 */
export const MODELLED_ON_NOTICE = "Modelled on the publicly described pattern — not an official test.";

/**
 * The same assurance for the pattern that models nobody.
 *
 * `campus-generic` claims no company, so telling a student it is "modelled on
 * the publicly described pattern" would be the one false sentence on the
 * page. It still needs the half that matters.
 */
export const GENERIC_PATTERN_NOTICE = "A balanced practice pattern — not an official test.";

/** The notice for one pattern. Both paths are notices; neither is silence. */
export function patternNotice(pattern: { readonly modelledOnCompany: boolean }): string {
  return pattern.modelledOnCompany ? MODELLED_ON_NOTICE : GENERIC_PATTERN_NOTICE;
}

// ── Shapes ──────────────────────────────────────────────────────────────

export const MOCK_PATTERN_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type MockPatternStatus = (typeof MOCK_PATTERN_STATUSES)[number];

/**
 * No TERMINATED, no VOIDED.
 *
 * A practice mock has no invigilator, and an enum with no voiding value is an
 * enum no future code path and no future UI can void from — the same
 * technique Phase 6a used to keep a `void` option out of `FocusLimitAction`.
 */
export const MOCK_ATTEMPT_STATUSES = ["IN_PROGRESS", "SUBMITTED", "AUTO_SUBMITTED", "ABANDONED"] as const;
export type MockAttemptStatus = (typeof MOCK_ATTEMPT_STATUSES)[number];

/** One line of a section's blueprint: draw `count` questions of `topic`. */
export interface TopicMixEntry {
  readonly topic: AptitudeTopic;
  readonly count: number;
}

export const MOCK_SECTION_LIMITS = Object.freeze({
  questionCount: { min: 1, max: 100 },
  timeLimitSec: { min: 60, max: 7_200 },
  /** Below this a section is a stopwatch, not a test. */
  secondsPerQuestion: { min: 20 },
  marksPerCorrect: { min: 0.25, max: 10 },
  sections: { min: 1, max: 8 },
});

export const topicMixEntrySchema = z
  .object({ topic: z.enum(APTITUDE_TOPICS), count: z.number().int().min(1).max(MOCK_SECTION_LIMITS.questionCount.max) })
  .strict();

export const mockSectionSchema = z
  .object({
    position: z.number().int().min(1).max(MOCK_SECTION_LIMITS.sections.max),
    /**
     * A stable, readable identity for the section, unique within its pattern
     * — `verbal`, `numerical`.
     *
     * Not cosmetic: it is what a seed script upserts on (a position can be
     * renumbered while a section stays the same section), and what
     * `scoreMock()` indexes a candidate's answers by, so a mock's result is
     * readable without resolving cuids.
     */
    key: z
      .string()
      .trim()
      .min(2)
      .max(40)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase words joined by hyphens."),
    label: z.string().trim().min(2).max(80),
    /** Null = a deliberately mixed section. */
    area: z.enum(APTITUDE_AREAS).nullable().default(null),
    topicMix: z.array(topicMixEntrySchema).min(1),
    questionCount: z.number().int().min(MOCK_SECTION_LIMITS.questionCount.min).max(MOCK_SECTION_LIMITS.questionCount.max),
    timeLimitSec: z.number().int().min(MOCK_SECTION_LIMITS.timeLimitSec.min).max(MOCK_SECTION_LIMITS.timeLimitSec.max),
    cutoffPercent: z.number().min(0).max(100),
    marksPerCorrect: z.number().min(MOCK_SECTION_LIMITS.marksPerCorrect.min).max(MOCK_SECTION_LIMITS.marksPerCorrect.max),
    /** A FRACTION of `marksPerCorrect`, held in [0, 1] by a CHECK too. */
    negativeMarkFraction: z.number().min(0).max(1),
    allowBackNavigation: z.boolean(),
    shuffleQuestions: z.boolean().default(true),
    shuffleOptions: z.boolean().default(true),
  })
  .strict()
  .superRefine((section, ctx) => {
    const summed = section.topicMix.reduce((sum, entry) => sum + entry.count, 0);
    if (summed !== section.questionCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["topicMix"],
        message: `The blueprint draws ${summed} questions but the section is ${section.questionCount} long.`,
      });
    }
    const seen = new Set<AptitudeTopic>();
    for (const entry of section.topicMix) {
      if (seen.has(entry.topic)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["topicMix"],
          message: `${entry.topic} appears twice; give it one line with the total count.`,
        });
      }
      seen.add(entry.topic);
      if (section.area !== null && APTITUDE_TOPIC_AREA[entry.topic] !== section.area) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["topicMix"],
          message: `${entry.topic} is a ${APTITUDE_TOPIC_AREA[entry.topic]} topic in a ${section.area} section.`,
        });
      }
    }
  });
export type MockSectionInput = z.infer<typeof mockSectionSchema>;

export const mockPatternSchema = z
  .object({
    slug: z
      .string()
      .trim()
      .min(3)
      .max(60)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase words joined by hyphens."),
    name: z.string().trim().min(2).max(120),
    funnelLabel: z.string().trim().min(2).max(120),
    /** A pattern with no stated provenance is a pattern nobody can check. */
    sourceNote: z.string().trim().min(10).max(500),
    modelledOnCompany: z.boolean(),
    description: z.string().trim().min(20).max(600),
    sections: z.array(mockSectionSchema).min(MOCK_SECTION_LIMITS.sections.min).max(MOCK_SECTION_LIMITS.sections.max),
  })
  .strict()
  .superRefine((pattern, ctx) => {
    for (const issue of patternBlueprintIssues(pattern)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sections"], message: issue });
    }
  });
export type MockPatternInput = z.infer<typeof mockPatternSchema>;

/**
 * Everything wrong with a pattern's sections, as sentences an author can act
 * on — ALL of them, not the first.
 *
 * Used by `mockPatternSchema` and rendered on the pattern page, so an author
 * fixing a blueprint sees the whole list rather than discovering the next
 * problem on each save.
 */
export function patternBlueprintIssues(pattern: {
  readonly sections: readonly {
    readonly position: number;
    readonly key: string;
    readonly label: string;
    readonly questionCount: number;
    readonly timeLimitSec: number;
  }[];
}): string[] {
  const issues: string[] = [];
  const positions = pattern.sections.map((section) => section.position);
  const sorted = [...positions].sort((a, b) => a - b);
  if (new Set(positions).size !== positions.length) issues.push("Two sections share a position.");
  else if (sorted.some((position, index) => position !== index + 1)) {
    issues.push(`Positions must run 1…${pattern.sections.length} with no gaps.`);
  }

  const labels = pattern.sections.map((section) => section.label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) issues.push("Two sections share a label.");

  const keys = pattern.sections.map((section) => section.key);
  if (new Set(keys).size !== keys.length) issues.push("Two sections share a key.");

  for (const section of pattern.sections) {
    const perQuestion = section.timeLimitSec / section.questionCount;
    if (perQuestion < MOCK_SECTION_LIMITS.secondsPerQuestion.min) {
      issues.push(
        `"${section.label}" gives ${perQuestion.toFixed(0)}s a question. Below ${MOCK_SECTION_LIMITS.secondsPerQuestion.min}s the timer is the test, not the questions.`,
      );
    }
  }
  return issues;
}

/**
 * A pattern's totals.
 *
 * This is the arithmetic the `recx_sync_pattern_totals` trigger mirrors, and
 * a test asserts the two agree on all six seed patterns: one definition, two
 * enforcements, so the denormalised totals on the listing page cannot drift.
 */
export function patternTotals(pattern: {
  readonly sections: readonly { readonly questionCount: number; readonly timeLimitSec: number }[];
}): { totalQuestions: number; totalTimeSec: number } {
  return {
    totalQuestions: pattern.sections.reduce((sum, section) => sum + section.questionCount, 0),
    totalTimeSec: pattern.sections.reduce((sum, section) => sum + section.timeLimitSec, 0),
  };
}

/** A seeded section carries its blueprint as well as its scoring rule. */
export interface SeedSection extends SectionRule {
  readonly position: number;
  readonly area: AptitudeArea | null;
  readonly topicMix: readonly TopicMixEntry[];
  readonly shuffleQuestions: boolean;
  readonly shuffleOptions: boolean;
}

export interface MockPatternSeed {
  readonly slug: string;
  readonly name: string;
  readonly funnelLabel: string;
  readonly sourceNote: string;
  /** False for the generic pattern, which claims to model nobody. */
  readonly modelledOnCompany: boolean;
  readonly description: string;
  readonly sections: readonly SeedSection[];
}

// ── The six seeded patterns ─────────────────────────────────────────────

/** Minutes, for readability. The rules themselves are in seconds. */
const min = (m: number) => m * 60;

/** Build a section, deriving `questionCount` from the blueprint so the two cannot disagree. */
function section(spec: {
  position: number;
  key: string;
  label: string;
  area: AptitudeArea | null;
  minutes: number;
  cutoffPercent: number;
  negativeMarkFraction?: number;
  allowBackNavigation: boolean;
  mix: ReadonlyArray<readonly [AptitudeTopic, number]>;
}): SeedSection {
  const topicMix = spec.mix.map(([topic, count]) => ({ topic, count }));
  return {
    position: spec.position,
    key: spec.key,
    label: spec.label,
    area: spec.area,
    topicMix,
    questionCount: topicMix.reduce((sum, entry) => sum + entry.count, 0),
    timeLimitSec: min(spec.minutes),
    cutoffPercent: spec.cutoffPercent,
    marksPerCorrect: 1,
    negativeMarkFraction: spec.negativeMarkFraction ?? 0,
    allowBackNavigation: spec.allowBackNavigation,
    shuffleQuestions: true,
    shuffleOptions: true,
  };
}

export const MOCK_PATTERN_SEEDS: readonly MockPatternSeed[] = Object.freeze([
  {
    slug: "tcs-nqt",
    name: "TCS NQT",
    funnelLabel: "TCS National Qualifier Test — foundation section",
    sourceNote: "The publicly described TCS NQT foundation pattern: three sections, section timers, no return.",
    modelledOnCompany: true,
    description:
      "Three sections, no going back, and a cutoff on each. The numerical section is the one most candidates lose on time rather than on ability.",
    sections: Object.freeze([
      section({
        position: 1,
        key: "verbal",
        label: "Verbal ability",
        area: "VERBAL",
        minutes: 25,
        cutoffPercent: 60,
        // The published descriptions agree on this: one question at a time,
        // no return. It is also why `allowBackNavigation` has to be enforced
        // server-side rather than by hiding a button.
        allowBackNavigation: false,
        mix: [
          ["READING_COMPREHENSION", 6],
          ["SENTENCE_CORRECTION", 5],
          ["PARA_JUMBLES", 4],
          ["SYNONYMS_ANTONYMS", 4],
          ["CLOZE", 3],
          ["ERROR_SPOTTING", 2],
        ],
      }),
      section({
        position: 2,
        key: "reasoning",
        label: "Reasoning ability",
        area: "LOGICAL",
        minutes: 25,
        cutoffPercent: 60,
        allowBackNavigation: false,
        mix: [
          ["SERIES", 5],
          ["SEATING_ARRANGEMENT", 4],
          ["PUZZLES", 4],
          ["CODING_DECODING", 4],
          ["BLOOD_RELATIONS", 3],
          ["SYLLOGISMS", 3],
          ["DATA_SUFFICIENCY", 3],
          ["DIRECTIONS", 2],
          ["STATEMENT_CONCLUSION", 2],
        ],
      }),
      section({
        position: 3,
        key: "numerical",
        label: "Numerical ability",
        area: "QUANTITATIVE",
        minutes: 40,
        cutoffPercent: 60,
        allowBackNavigation: false,
        mix: [
          ["PERCENTAGES", 3],
          ["PROFIT_LOSS", 3],
          ["TIME_SPEED_DISTANCE", 3],
          ["TIME_AND_WORK", 3],
          ["RATIO_PROPORTION", 2],
          ["AVERAGES_MIXTURES", 2],
          ["PERMUTATIONS_COMBINATIONS", 2],
          ["PROBABILITY", 2],
          ["NUMBER_SYSTEMS", 2],
          ["INTEREST", 2],
          ["MENSURATION", 1],
          ["DATA_INTERPRETATION", 1],
        ],
      }),
    ]),
  },
  {
    slug: "infosys",
    name: "Infosys",
    funnelLabel: "Infosys online assessment — aptitude rounds",
    sourceNote: "The publicly described Infosys aptitude rounds: section timers, no negative marking.",
    modelledOnCompany: true,
    description:
      "Section timers with no negative marking, and a quantitative section that gives far more time per question than candidates expect.",
    sections: Object.freeze([
      section({
        position: 1,
        key: "reasoning",
        label: "Logical reasoning",
        area: "LOGICAL",
        minutes: 25,
        cutoffPercent: 50,
        allowBackNavigation: true,
        mix: [
          ["SERIES", 3],
          ["PUZZLES", 3],
          ["SEATING_ARRANGEMENT", 3],
          ["DATA_SUFFICIENCY", 2],
          ["CODING_DECODING", 2],
          ["BLOOD_RELATIONS", 2],
        ],
      }),
      section({
        position: 2,
        key: "quantitative",
        label: "Quantitative aptitude",
        area: "QUANTITATIVE",
        minutes: 35,
        cutoffPercent: 50,
        allowBackNavigation: true,
        mix: [
          ["PERCENTAGES", 2],
          ["TIME_SPEED_DISTANCE", 2],
          ["TIME_AND_WORK", 2],
          ["PROBABILITY", 2],
          ["PERMUTATIONS_COMBINATIONS", 2],
        ],
      }),
      section({
        position: 3,
        key: "verbal",
        label: "Verbal ability",
        area: "VERBAL",
        minutes: 20,
        cutoffPercent: 50,
        allowBackNavigation: true,
        mix: [
          ["READING_COMPREHENSION", 8],
          ["SENTENCE_CORRECTION", 4],
          ["PARA_JUMBLES", 3],
          ["CLOZE", 3],
          ["ERROR_SPOTTING", 2],
        ],
      }),
    ]),
  },
  {
    slug: "wipro",
    name: "Wipro",
    funnelLabel: "Wipro elite national talent hunt — aptitude",
    sourceNote: "The publicly described Wipro aptitude round, including its quarter-mark penalty.",
    modelledOnCompany: true,
    description:
      "A quarter-mark penalty for a wrong answer, which changes how a candidate should treat a guess. Practise the arithmetic of when not to answer.",
    sections: Object.freeze([
      section({
        position: 1,
        key: "quantitative",
        label: "Quantitative aptitude",
        area: "QUANTITATIVE",
        minutes: 16,
        cutoffPercent: 55,
        // The reason negative marking exists in the product at all: a funnel
        // that penalises guessing needs a candidate to have practised under
        // that rule, not discovered it on the day.
        negativeMarkFraction: 0.25,
        allowBackNavigation: false,
        mix: [
          ["PERCENTAGES", 2],
          ["PROFIT_LOSS", 2],
          ["TIME_SPEED_DISTANCE", 2],
          ["TIME_AND_WORK", 2],
          ["RATIO_PROPORTION", 2],
          ["AVERAGES_MIXTURES", 2],
          ["NUMBER_SYSTEMS", 2],
          ["INTEREST", 2],
        ],
      }),
      section({
        position: 2,
        key: "logical",
        label: "Logical reasoning",
        area: "LOGICAL",
        minutes: 14,
        cutoffPercent: 55,
        negativeMarkFraction: 0.25,
        allowBackNavigation: false,
        mix: [
          ["SERIES", 3],
          ["CODING_DECODING", 2],
          ["BLOOD_RELATIONS", 2],
          ["SYLLOGISMS", 2],
          ["SEATING_ARRANGEMENT", 2],
          ["DIRECTIONS", 2],
          ["STATEMENT_CONCLUSION", 1],
        ],
      }),
      section({
        position: 3,
        key: "verbal",
        label: "Verbal ability",
        area: "VERBAL",
        minutes: 22,
        cutoffPercent: 55,
        negativeMarkFraction: 0.25,
        allowBackNavigation: false,
        mix: [
          ["READING_COMPREHENSION", 6],
          ["SENTENCE_CORRECTION", 4],
          ["PARA_JUMBLES", 4],
          ["SYNONYMS_ANTONYMS", 4],
          ["CLOZE", 2],
          ["ERROR_SPOTTING", 2],
        ],
      }),
    ]),
  },
  {
    slug: "cognizant",
    name: "Cognizant",
    funnelLabel: "Cognizant GenC — aptitude section",
    sourceNote: "The publicly described Cognizant GenC aptitude section, which allows review within a section.",
    modelledOnCompany: true,
    description:
      "Back navigation allowed inside a section, which rewards answering the easy questions first and returning to the rest.",
    sections: Object.freeze([
      section({
        position: 1,
        key: "quantitative",
        label: "Quantitative aptitude",
        area: "QUANTITATIVE",
        minutes: 25,
        cutoffPercent: 50,
        allowBackNavigation: true,
        mix: [
          ["PERCENTAGES", 2],
          ["PROFIT_LOSS", 2],
          ["TIME_SPEED_DISTANCE", 2],
          ["TIME_AND_WORK", 2],
          ["AVERAGES_MIXTURES", 2],
          ["PROBABILITY", 2],
          ["NUMBER_SYSTEMS", 2],
          ["DATA_INTERPRETATION", 2],
        ],
      }),
      section({
        position: 2,
        key: "logical",
        label: "Logical reasoning",
        area: "LOGICAL",
        minutes: 25,
        cutoffPercent: 50,
        allowBackNavigation: true,
        mix: [
          ["PUZZLES", 3],
          ["SEATING_ARRANGEMENT", 3],
          ["SERIES", 2],
          ["SYLLOGISMS", 2],
          ["CODING_DECODING", 2],
          ["DATA_SUFFICIENCY", 2],
        ],
      }),
      section({
        position: 3,
        key: "verbal",
        label: "Verbal ability",
        area: "VERBAL",
        minutes: 25,
        cutoffPercent: 50,
        allowBackNavigation: true,
        mix: [
          ["READING_COMPREHENSION", 8],
          ["SENTENCE_CORRECTION", 4],
          ["SYNONYMS_ANTONYMS", 4],
          ["PARA_JUMBLES", 3],
          ["ERROR_SPOTTING", 3],
        ],
      }),
    ]),
  },
  {
    slug: "accenture",
    name: "Accenture",
    funnelLabel: "Accenture cognitive assessment",
    sourceNote: "The publicly described Accenture cognitive assessment: English, critical and abstract reasoning.",
    modelledOnCompany: true,
    description:
      "No negative marking, and the English section contributes to the total without gating, so a candidate can afford to attempt everything.",
    sections: Object.freeze([
      section({
        position: 1,
        key: "english",
        label: "English ability",
        area: "VERBAL",
        minutes: 20,
        // Zero is how "no cutoff" is said: every candidate clears it, and the
        // section still counts toward the total. A nullable column would make
        // `passedCutoff` a three-valued answer on every surface that reads it.
        cutoffPercent: 0,
        allowBackNavigation: true,
        mix: [
          ["READING_COMPREHENSION", 6],
          ["SENTENCE_CORRECTION", 4],
          ["SYNONYMS_ANTONYMS", 4],
          ["CLOZE", 3],
          ["ERROR_SPOTTING", 3],
        ],
      }),
      section({
        position: 2,
        key: "critical",
        label: "Critical reasoning",
        area: "LOGICAL",
        minutes: 35,
        cutoffPercent: 50,
        allowBackNavigation: true,
        mix: [
          ["STATEMENT_CONCLUSION", 5],
          ["SYLLOGISMS", 5],
          ["DATA_SUFFICIENCY", 4],
          ["PUZZLES", 4],
          ["SEATING_ARRANGEMENT", 4],
          ["BLOOD_RELATIONS", 3],
        ],
      }),
      section({
        position: 3,
        key: "abstract",
        label: "Abstract reasoning",
        area: "LOGICAL",
        minutes: 15,
        cutoffPercent: 50,
        allowBackNavigation: true,
        mix: [
          ["SERIES", 8],
          ["CODING_DECODING", 4],
          ["DIRECTIONS", 3],
        ],
      }),
    ]),
  },
  {
    slug: "campus-generic",
    name: "Generic campus pattern",
    funnelLabel: "A balanced campus aptitude round",
    sourceNote: "Written at REC as a balanced starting point; it models no particular company's funnel.",
    // Models nobody, so it makes no claim and carries the generic notice.
    modelledOnCompany: false,
    description:
      "A balanced practice pattern that models no particular company. Start here if you do not yet know which funnel you are preparing for.",
    sections: Object.freeze([
      section({
        position: 1,
        key: "quantitative",
        label: "Quantitative aptitude",
        area: "QUANTITATIVE",
        minutes: 30,
        cutoffPercent: 50,
        allowBackNavigation: true,
        mix: [
          ["PERCENTAGES", 2],
          ["PROFIT_LOSS", 2],
          ["TIME_SPEED_DISTANCE", 2],
          ["TIME_AND_WORK", 2],
          ["RATIO_PROPORTION", 2],
          ["AVERAGES_MIXTURES", 2],
          ["PROBABILITY", 2],
          ["NUMBER_SYSTEMS", 2],
          ["INTEREST", 2],
          ["AGES", 1],
          ["CALENDARS_CLOCKS", 1],
        ],
      }),
      section({
        position: 2,
        key: "logical",
        label: "Logical reasoning",
        area: "LOGICAL",
        minutes: 30,
        cutoffPercent: 50,
        allowBackNavigation: true,
        mix: [
          ["SERIES", 3],
          ["PUZZLES", 3],
          ["BLOOD_RELATIONS", 2],
          ["SYLLOGISMS", 2],
          ["SEATING_ARRANGEMENT", 2],
          ["CODING_DECODING", 2],
          ["DATA_SUFFICIENCY", 2],
          ["DIRECTIONS", 2],
          ["STATEMENT_CONCLUSION", 2],
        ],
      }),
      section({
        position: 3,
        key: "verbal",
        label: "Verbal ability",
        area: "VERBAL",
        minutes: 25,
        cutoffPercent: 50,
        allowBackNavigation: true,
        mix: [
          ["READING_COMPREHENSION", 6],
          ["SENTENCE_CORRECTION", 4],
          ["PARA_JUMBLES", 3],
          ["SYNONYMS_ANTONYMS", 3],
          ["CLOZE", 2],
          ["ERROR_SPOTTING", 2],
        ],
      }),
    ]),
  },
]);

export const SEED_PATTERN_SLUGS: readonly string[] = Object.freeze(MOCK_PATTERN_SEEDS.map((p) => p.slug));

export function findPatternSeed(slug: string): MockPatternSeed | null {
  return MOCK_PATTERN_SEEDS.find((pattern) => pattern.slug === slug) ?? null;
}

/** Every topic a pattern's blueprints draw on, in taxonomy order. */
export function patternTopics(pattern: MockPatternSeed): readonly AptitudeTopic[] {
  const used = new Set<AptitudeTopic>();
  for (const section of pattern.sections) for (const entry of section.topicMix) used.add(entry.topic);
  return APTITUDE_TOPICS.filter((topic) => used.has(topic));
}
