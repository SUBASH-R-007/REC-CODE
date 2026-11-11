import { z } from "zod";
import { APTITUDE_AREAS, APTITUDE_TOPICS, APTITUDE_TOPIC_AREA, type AptitudeTopic } from "./aptitude-taxonomy";

/**
 * One aptitude question: its kinds, its bounds and its shape (Phase 7).
 *
 * SPEC §5: "Kinds: single-choice, multi-choice, numeric-entry,
 * passage-grouped (one shared passage, N questions)." Four kinds, exactly as
 * listed — `PASSAGE_GROUPED` is a kind here rather than a grouping flag
 * because that is how the spec names it, and because stating it as a kind
 * lets one CHECK hold "carries a passage" and "is a passage question" as the
 * same fact (`docs/OPEN-QUESTIONS.md`: a passage item answers as
 * single-choice, the narrower reading).
 *
 * This module is the ONE shape definition, used by the server boundary, the
 * CSV importer and the authoring form. Every refinement below mirrors a
 * database CHECK one for one, and `packages/db/test/aptitude-invariants.db.test.ts`
 * asserts the pairing in both directions — a refinement with no CHECK is a
 * rule a back-fill script walks around, and a CHECK with no refinement is an
 * error a faculty author meets as a 500.
 *
 * It stays free of `node:crypto` like `seb.ts` does: `normaliseQuestionForHash()`
 * returns the canonical string and the caller hashes it, so the normalisation
 * is testable against a known digest.
 */

export const APTITUDE_QUESTION_KINDS = [
  "SINGLE_CHOICE",
  "MULTI_CHOICE",
  "NUMERIC_ENTRY",
  "PASSAGE_GROUPED",
] as const;
export type AptitudeQuestionKind = (typeof APTITUDE_QUESTION_KINDS)[number];

/** The kinds answered by choosing options. */
export const CHOICE_KINDS = ["SINGLE_CHOICE", "MULTI_CHOICE", "PASSAGE_GROUPED"] as const;

/** The kinds that take exactly one correct option. */
export const SINGLE_ANSWER_KINDS = ["SINGLE_CHOICE", "PASSAGE_GROUPED"] as const;

export function isChoiceKind(kind: AptitudeQuestionKind): boolean {
  return (CHOICE_KINDS as readonly string[]).includes(kind);
}

/**
 * The floor on a worked explanation.
 *
 * SPEC §5: "Worked explanations are mandatory, enforced at publish." 40
 * characters is the floor that stops "use the formula" shipping as a worked
 * explanation. The explanation is the product here: a student who got a
 * percentage question wrong needs the working, not a tick.
 */
export const EXPLANATION_MIN_CHARS = 40;

/**
 * Bounds, as the CHECKs enforce them.
 *
 * `explanation` is generous on purpose — a worked solution to a time-and-work
 * problem runs to several hundred words, and a bound that forced it shorter
 * would quietly turn a worked explanation back into an answer key.
 */
export const APTITUDE_LIMITS = Object.freeze({
  stem: { min: 5, max: 4_000 },
  option: { min: 1, max: 500 },
  options: { min: 2, max: 8 },
  explanation: { min: EXPLANATION_MIN_CHARS, max: 8_000 },
  /** The authoring aid that tells a section author whether 25 questions fit in 25 minutes. */
  expectedSeconds: { min: 5, max: 1_800 },
  /** Decimal(20, 6) in the database, so six places and under 10^14. */
  numericScale: 6,
  numericMagnitude: 1e14,
  passageBody: { min: 80, max: 20_000 },
  /** A passage with one question is a stem with extra steps (SPEC §5: "N questions"). */
  passageQuestions: { min: 2, max: 20 },
  displayCode: /^APT-\d{5,}$/,
});

/** Comparing a numeric answer at a fixed scale, never with float equality. */
export const NUMERIC_COMPARE_SCALE = APTITUDE_LIMITS.numericScale;

const fitsDecimal = (value: number) => Math.abs(value) < APTITUDE_LIMITS.numericMagnitude;
const DECIMAL_MESSAGE = "The value does not fit Decimal(20, 6).";

const numeric = z.number().finite().refine(fitsDecimal, { message: DECIMAL_MESSAGE });
/** A tolerance is a distance, so it is never negative. */
const tolerance = z.number().finite().min(0).refine(fitsDecimal, { message: DECIMAL_MESSAGE });

const stem = z.string().trim().min(APTITUDE_LIMITS.stem.min).max(APTITUDE_LIMITS.stem.max);
const option = z.string().trim().min(APTITUDE_LIMITS.option.min).max(APTITUDE_LIMITS.option.max);
const explanation = z.string().trim().max(APTITUDE_LIMITS.explanation.max);
const expectedSeconds = z
  .number()
  .int()
  .min(APTITUDE_LIMITS.expectedSeconds.min)
  .max(APTITUDE_LIMITS.expectedSeconds.max);

const base = {
  area: z.enum(APTITUDE_AREAS),
  topic: z.enum(APTITUDE_TOPICS),
  difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
  stem,
  explanation,
  expectedSeconds,
  origin: z.enum(["FACULTY", "SENIOR_STUDENT", "AI_ASSISTED"]),
  sourceBatch: z.string().trim().max(120).nullable().default(null),
  passageId: z.string().min(1).nullable().default(null),
};

const options = z.array(option).min(APTITUDE_LIMITS.options.min).max(APTITUDE_LIMITS.options.max);
const optionIndexes = z.array(z.number().int().min(0).max(APTITUDE_LIMITS.options.max - 1));

const singleChoice = z
  .object({
    ...base,
    kind: z.literal("SINGLE_CHOICE"),
    options,
    // Mirrors `CHECK AptitudeQuestion_single_answer`.
    correctOptionIndexes: optionIndexes.length(1),
    numericAnswer: z.null().default(null),
    numericTolerance: z.null().default(null),
    numericUnit: z.null().default(null),
  })
  .strict();

const passageGrouped = z
  .object({
    ...base,
    kind: z.literal("PASSAGE_GROUPED"),
    options,
    // Answers exactly as single-choice — the narrower reading of a kind the
    // spec lists without stating its answer shape.
    correctOptionIndexes: optionIndexes.length(1),
    numericAnswer: z.null().default(null),
    numericTolerance: z.null().default(null),
    numericUnit: z.null().default(null),
    // Mirrors `CHECK AptitudeQuestion_passage_kind`: this kind, and only this
    // kind, carries a passage.
    passageId: z.string().min(1),
  })
  .strict();

const multiChoice = z
  .object({
    ...base,
    kind: z.literal("MULTI_CHOICE"),
    options,
    /**
     * Mirrors `CHECK AptitudeQuestion_multi_answer`. A multi-choice question
     * with ONE correct option is a mis-authored single-choice: it makes the
     * all-or-nothing rule indistinguishable from single-choice scoring, which
     * is the worst of both for a candidate.
     */
    correctOptionIndexes: optionIndexes.min(2),
    numericAnswer: z.null().default(null),
    numericTolerance: z.null().default(null),
    numericUnit: z.null().default(null),
  })
  .strict();

const numericEntry = z
  .object({
    ...base,
    kind: z.literal("NUMERIC_ENTRY"),
    // Mirrors `CHECK AptitudeQuestion_numeric_shape`.
    options: z.array(option).length(0).default([]),
    correctOptionIndexes: z.array(z.number()).length(0).default([]),
    numericAnswer: numeric,
    numericTolerance: tolerance,
    numericUnit: z.string().trim().min(1).max(32).nullable().default(null),
  })
  .strict();

/**
 * The question shape at the server boundary.
 *
 * A discriminated union on `kind`, so a numeric-entry question carrying
 * options is not merely refined away — it does not typecheck, and the error a
 * faculty author sees names the field. An import of 300 questions that
 * reports "invalid input" has told them nothing.
 *
 * Every cross-field rule lives in the ONE refinement below rather than on the
 * individual variants: zod's `discriminatedUnion` takes plain objects, and a
 * variant wrapped in `.superRefine()` is no longer one. Having them in one
 * place also makes the CHECK-for-refinement pairing readable at a glance.
 */
export const aptitudeQuestionSchema = z
  .discriminatedUnion("kind", [singleChoice, multiChoice, numericEntry, passageGrouped])
  .superRefine((value, ctx) => {
    // Mirrors `CHECK AptitudeQuestion_area_topic_check`.
    if (APTITUDE_TOPIC_AREA[value.topic] !== value.area) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["topic"],
        message: `${value.topic} is a ${APTITUDE_TOPIC_AREA[value.topic]} topic, not ${value.area}.`,
      });
    }

    // Mirrors `CHECK AptitudeQuestion_passage_kind` from the other side.
    if (value.kind !== "PASSAGE_GROUPED" && value.passageId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passageId"],
        message: "Only a passage-grouped question may belong to a passage.",
      });
    }

    if (value.kind === "NUMERIC_ENTRY") return;

    // Mirrors `CHECK AptitudeQuestion_option_index_check`: every index in
    // range, and no index twice. An out-of-range key is a question nobody can
    // answer correctly.
    const seen = new Set<number>();
    for (const index of value.correctOptionIndexes) {
      if (index >= value.options.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correctOptionIndexes"],
          message: `Option ${index + 1} does not exist; there are ${value.options.length}.`,
        });
      }
      if (seen.has(index)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["correctOptionIndexes"],
          message: `Option ${index + 1} is marked correct twice.`,
        });
      }
      seen.add(index);
    }

    // The upper half of `CHECK AptitudeQuestion_multi_answer`.
    if (value.kind === "MULTI_CHOICE" && value.correctOptionIndexes.length > value.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["correctOptionIndexes"],
        message: "More options are marked correct than exist.",
      });
    }
  });
export type AptitudeQuestionInput = z.infer<typeof aptitudeQuestionSchema>;

/**
 * Publishing is where the explanation becomes mandatory.
 *
 * Kept separate from `aptitudeQuestionSchema` on purpose: a DRAFT with no
 * explanation yet is a legitimate work in progress, and refusing to SAVE it
 * would push authors to paste a placeholder — which is how "use the formula"
 * ends up shipping as a worked solution. Mirrors
 * `CHECK AptitudeQuestion_explanation_published`.
 */
export const aptitudePublishSchema = aptitudeQuestionSchema.superRefine((value, ctx) => {
  if (value.explanation.trim().length < EXPLANATION_MIN_CHARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["explanation"],
      message: `A published question needs a worked explanation of at least ${EXPLANATION_MIN_CHARS} characters. A student who got this wrong needs the working, not a tick.`,
    });
  }
});

export const aptitudePassageSchema = z
  .object({
    area: z.enum(APTITUDE_AREAS),
    topic: z.enum(APTITUDE_TOPICS),
    title: z.string().trim().min(3).max(200),
    body: z.string().trim().min(APTITUDE_LIMITS.passageBody.min).max(APTITUDE_LIMITS.passageBody.max),
    sourceNote: z.string().trim().min(10).max(500),
    origin: z.enum(["FACULTY", "SENIOR_STUDENT", "AI_ASSISTED"]),
  })
  .strict();
export type AptitudePassageInput = z.infer<typeof aptitudePassageSchema>;

/** Words, for the reading-time estimate on the sitting page. */
export function wordCountOf(body: string): number {
  const trimmed = body.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * The canonical string a question's `contentHash` is taken over.
 *
 * It is the import's duplicate detector, so it must see through the
 * differences that do not change the question: surrounding whitespace, runs
 * of whitespace inside the stem, letter case, and the ORDER of the correct
 * indexes. It must NOT see through the things that do: the option order (a
 * question whose options were reordered is the same question, but its stored
 * key moved, and treating them as one row would silently rescore the past),
 * the numeric answer, or the tolerance.
 *
 * The explanation is deliberately excluded. Decision 17 holds a published
 * question's key frozen while leaving the explanation writable, so a
 * re-import that only improves the working must report UNCHANGED rather than
 * trying to create a second question.
 */
export function normaliseQuestionForHash(question: {
  readonly kind: AptitudeQuestionKind;
  readonly topic: AptitudeTopic;
  readonly stem: string;
  readonly options: readonly string[];
  readonly correctOptionIndexes: readonly number[];
  readonly numericAnswer: number | string | null;
  readonly numericTolerance: number | string | null;
}): string {
  const text = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const decimal = (value: number | string | null) =>
    value === null ? "" : Number(value).toFixed(NUMERIC_COMPARE_SCALE);
  return [
    question.kind,
    question.topic,
    text(question.stem),
    question.options.map(text).join("\u001f"),
    [...question.correctOptionIndexes].sort((a, b) => a - b).join(","),
    decimal(question.numericAnswer),
    decimal(question.numericTolerance),
  ].join("\u001e");
}

/** `APT-00042`, the `Problem.displayCode` convention. */
export function aptitudeDisplayCode(sequence: number): string {
  return `APT-${String(sequence).padStart(5, "0")}`;
}
