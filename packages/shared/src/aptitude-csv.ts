import { z } from "zod";
import {
  APTITUDE_LIMITS,
  APTITUDE_QUESTION_KINDS,
  aptitudeQuestionSchema,
  type AptitudeQuestionInput,
  type AptitudeQuestionKind,
} from "./aptitude-question";
import {
  APTITUDE_TOPICS,
  APTITUDE_TOPIC_AREA,
  APTITUDE_TOPIC_LABEL,
  isAptitudeArea,
  isAptitudeTopic,
  type AptitudeArea,
  type AptitudeTopic,
} from "./aptitude-taxonomy";
import { csvRow, type CsvShape } from "./csv";

/**
 * The aptitude question-bank CSV (Phase 7d).
 *
 * SPEC §5: *Reuse the LMS question-bank CSV import/export pipeline with
 * per-row results, so one bad row cannot discard a 300-question file.*
 *
 * So the columns ARE the LMS question bank's, in its order —
 * `type,text,marks,difficulty,options,correct,tolerance,unit,hint,explanation,tags`
 * (REC-LMS `src/lib/quiz/question-csv.ts`) — with pipe-separated options so a
 * comma inside an option does not fight the CSV, and a 1-based index or a
 * letter for the key. A file exported from the LMS question bank imports
 * here, which is the point of the clause and would not be true of a column
 * list of our own invention.
 *
 * Five columns are added after them for what this product has and the LMS
 * does not: `area`, `topic`, `code`, `expectedSeconds` and `origin`. All five
 * are OPTIONAL, because an LMS export has none of them — the importer takes
 * an area and a topic chosen at upload, and a row may override them.
 *
 * Two LMS columns have no home here and are accepted with a per-row WARNING
 * rather than silently dropped or treated as an error: `marks` (a section
 * declares `marksPerCorrect`, so a per-question mark would be a second,
 * conflicting answer) and `hint` (an aptitude question has a worked
 * explanation instead, which the spec makes mandatory). A warning is the
 * honest answer: the data is real, we do not store it, and the person who
 * exported it should be told.
 */

/** The LMS question bank's own header, in its own order. */
export const LMS_CSV_COLUMNS = [
  "type",
  "text",
  "marks",
  "difficulty",
  "options",
  "correct",
  "tolerance",
  "unit",
  "hint",
  "explanation",
  "tags",
] as const;

/**
 * What this product adds. All optional: an LMS export has none of them.
 *
 * `passage` is where a passage-grouped question's SHARED TEXT lives, and it
 * has to exist: the LMS columns have nowhere to put it, and the Phase 7
 * design never said where it would come from. Every row of one group repeats
 * the same body — which is how a human writes them in a spreadsheet anyway —
 * and the importer creates ONE passage per distinct body. Grouping by the
 * text itself is also the only rule an operator can predict by looking at
 * the file.
 */
export const APTITUDE_EXTRA_COLUMNS = [
  "area",
  "topic",
  "code",
  "expectedSeconds",
  "origin",
  "passage",
  "passageTitle",
] as const;

export const APTITUDE_CSV_COLUMNS = [...LMS_CSV_COLUMNS, ...APTITUDE_EXTRA_COLUMNS] as const;

/**
 * Columns a file may omit.
 *
 * `text`, `type` and `explanation` are the three it may not: without them
 * there is no question, no way to grade it and nothing to teach with.
 */
export const APTITUDE_CSV_OPTIONAL = [
  "marks",
  "difficulty",
  "options",
  "correct",
  "tolerance",
  "unit",
  "hint",
  "tags",
  ...APTITUDE_EXTRA_COLUMNS,
] as const;

/**
 * Upload limits.
 *
 * `maxRows` is 2,000 because that is the content target the spec records
 * ("~2,000 aptitude questions, with named owners"), so a full bank has to
 * fit in one file or the clause about one bad row is moot.
 *
 * `maxBytes` is 4 MB, not the 900 KB the roster uses. A roster row is ~80
 * bytes; an aptitude row carries a stem of up to 4 KB and a WORKED
 * EXPLANATION of up to 8 KB, which the spec makes mandatory at publish. A
 * realistic 300-question file with real explanations runs to 1–2 MB, and a
 * 900 KB cap would refuse it WHOLE — which is exactly the failure "one bad
 * row cannot discard a 300-question file" forbids, arrived at from the other
 * direction. The upload is therefore a route handler and not a server
 * action: Next's default server-action body limit is 1 MB.
 */
export const APTITUDE_IMPORT_LIMITS = Object.freeze({
  maxRows: 2_000,
  maxBytes: 4 * 1024 * 1024,
  /** Options are pipe-separated, so a comma inside an option needs no quoting. */
  optionSeparator: "|",
});

export const APTITUDE_CSV_SHAPE: CsvShape = Object.freeze({
  columns: APTITUDE_CSV_COLUMNS,
  optionalColumns: APTITUDE_CSV_OPTIONAL,
  maxRows: APTITUDE_IMPORT_LIMITS.maxRows,
  maxBytes: APTITUDE_IMPORT_LIMITS.maxBytes,
});

// ── Reading one row ─────────────────────────────────────────────────────

/**
 * The `type` vocabulary.
 *
 * Generous on input and exact on output: a faculty member's export may say
 * "mcq" or "single choice", and refusing a 300-row file over a synonym is
 * not a standard worth holding.
 */
const KIND_ALIASES: Readonly<Record<string, AptitudeQuestionKind>> = Object.freeze({
  single: "SINGLE_CHOICE",
  single_choice: "SINGLE_CHOICE",
  singlechoice: "SINGLE_CHOICE",
  mcq: "SINGLE_CHOICE",
  radio: "SINGLE_CHOICE",
  multi: "MULTI_CHOICE",
  multiple: "MULTI_CHOICE",
  multi_choice: "MULTI_CHOICE",
  multichoice: "MULTI_CHOICE",
  checkbox: "MULTI_CHOICE",
  numeric: "NUMERIC_ENTRY",
  number: "NUMERIC_ENTRY",
  numeric_entry: "NUMERIC_ENTRY",
  numericentry: "NUMERIC_ENTRY",
  passage: "PASSAGE_GROUPED",
  passage_grouped: "PASSAGE_GROUPED",
  comprehension: "PASSAGE_GROUPED",
});

const DIFFICULTY_ALIASES: Readonly<Record<string, "EASY" | "MEDIUM" | "HARD">> = Object.freeze({
  easy: "EASY",
  e: "EASY",
  "1": "EASY",
  medium: "MEDIUM",
  moderate: "MEDIUM",
  m: "MEDIUM",
  "2": "MEDIUM",
  hard: "HARD",
  difficult: "HARD",
  h: "HARD",
  "3": "HARD",
});

const ORIGIN_ALIASES: Readonly<Record<string, "FACULTY" | "SENIOR_STUDENT" | "AI_ASSISTED">> = Object.freeze({
  faculty: "FACULTY",
  staff: "FACULTY",
  senior: "SENIOR_STUDENT",
  senior_student: "SENIOR_STUDENT",
  student: "SENIOR_STUDENT",
  ai: "AI_ASSISTED",
  ai_assisted: "AI_ASSISTED",
});

const normalise = (value: string): string => value.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Split a pipe-separated list, dropping empties and trimming. */
export function splitList(value: string, separator = APTITUDE_IMPORT_LIMITS.optionSeparator): string[] {
  return value
    .split(separator)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * The answer key, as the LMS writes it: 1-based indexes or letters.
 *
 * `2` and `B` both mean the second option, and `1|3` and `A,C` both mean the
 * first and third. Returns 0-based indexes, which is what the question model
 * stores — and the conversion is HERE, once, because an off-by-one in an
 * answer key is a question every candidate gets wrong.
 */
export function parseAnswerKey(value: string, optionCount: number): { indexes: number[]; errors: string[] } {
  const errors: string[] = [];
  const indexes: number[] = [];
  const parts = value
    .split(/[|,;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  for (const part of parts) {
    let index: number | null = null;
    if (/^\d+$/.test(part)) {
      // 1-based, as the LMS writes it.
      index = Number(part) - 1;
    } else if (/^[A-Za-z]$/.test(part)) {
      index = part.toUpperCase().charCodeAt(0) - 65;
    }
    if (index === null) {
      errors.push(`"${part}" is not an option number or letter.`);
      continue;
    }
    if (index < 0 || index >= optionCount) {
      errors.push(
        `"${part}" is not one of the ${optionCount} options. Numbers start at 1 and letters at A, as the question bank writes them.`,
      );
      continue;
    }
    if (indexes.includes(index)) {
      errors.push(`"${part}" is marked correct twice.`);
      continue;
    }
    indexes.push(index);
  }
  if (parts.length === 0) errors.push("The correct answer is missing.");
  return { indexes: indexes.sort((a, b) => a - b), errors };
}

/** A topic named in the `topic` column, or found among the `tags`. */
export function topicFromCells(cells: Readonly<Record<string, string>>): AptitudeTopic | null {
  const named = (cells.topic ?? "").trim();
  if (named.length > 0) {
    const upper = named.toUpperCase().replace(/[\s-]+/g, "_");
    if (isAptitudeTopic(upper)) return upper;
    // A label, as the export writes it ("Time, Speed & Distance").
    const byLabel = APTITUDE_TOPICS.find(
      (topic) => APTITUDE_TOPIC_LABEL[topic].toLowerCase() === named.toLowerCase(),
    );
    if (byLabel) return byLabel;
    return null;
  }
  // SPEC asks us to reuse the LMS pipeline, and an LMS question's topic lives
  // in its tags. Trying them is the difference between a file that imports
  // and a file that needs hand-editing first.
  for (const tag of splitList(cells.tags ?? "")) {
    const upper = tag.toUpperCase().replace(/[\s-]+/g, "_");
    if (isAptitudeTopic(upper)) return upper;
  }
  return null;
}

export interface RowDefaults {
  /** Chosen at upload, for a file (an LMS export) with no area or topic column. */
  readonly area: AptitudeArea | null;
  readonly topic: AptitudeTopic | null;
  readonly origin: "FACULTY" | "SENIOR_STUDENT" | "AI_ASSISTED";
  readonly sourceBatch: string | null;
}

/**
 * A question read from a row.
 *
 * `passageId` is null even for a PASSAGE_GROUPED row: a CSV row cannot carry
 * a database id, so the IMPORTER creates the passage and assigns it. The row
 * carries the passage's TEXT instead (`RowResult.passage`), which is what its
 * siblings are keyed by — null, never a sentinel string somebody could
 * mistake for an id.
 */
export interface AptitudeCsvQuestion extends Omit<AptitudeQuestionInput, "passageId"> {
  readonly passageId: null;
}

/** The shared text a passage-grouped row carries, repeated by its siblings. */
export interface CsvPassage {
  readonly title: string;
  readonly body: string;
}

export type RowResult =
  | {
      readonly ok: true;
      readonly question: AptitudeCsvQuestion;
      readonly code: string | null;
      /** Set for a PASSAGE_GROUPED row: the shared text its group is keyed by. */
      readonly passage: CsvPassage | null;
      readonly warnings: string[];
    }
  | { readonly ok: false; readonly errors: string[]; readonly warnings: string[] };

/**
 * Turn one CSV row into a question, or into EVERY reason it is not one.
 *
 * Every reason, not the first: SPEC §5's whole point about per-row results is
 * that an operator fixing a 300-question file should see what is wrong with
 * each bad row in one pass. A row that reports its first problem makes them
 * upload the file once per mistake.
 */
export function rowToQuestion(cells: Readonly<Record<string, string>>, defaults: RowDefaults): RowResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const kind = KIND_ALIASES[normalise(cells.type ?? "")];
  if (!kind) {
    errors.push(
      `"${(cells.type ?? "").trim()}" is not a question type. Use one of: single, multi, numeric, passage.`,
    );
  }

  const stem = (cells.text ?? "").trim();
  if (stem.length < APTITUDE_LIMITS.stem.min) errors.push("The question text is missing.");

  const difficultyCell = (cells.difficulty ?? "").trim();
  const difficulty = difficultyCell.length === 0 ? "MEDIUM" : DIFFICULTY_ALIASES[normalise(difficultyCell)];
  if (!difficulty) errors.push(`"${difficultyCell}" is not a difficulty. Use easy, medium or hard.`);

  // Area and topic: the row first, then what was chosen at upload.
  const topic = topicFromCells(cells) ?? defaults.topic;
  if (!topic) {
    errors.push(
      (cells.topic ?? "").trim().length > 0
        ? `"${cells.topic!.trim()}" is not one of the 29 topics.`
        : "The row has no topic, and no topic was chosen for this upload.",
    );
  }
  const areaCell = (cells.area ?? "").trim();
  let area: AptitudeArea | null = null;
  if (areaCell.length > 0) {
    const upper = areaCell.toUpperCase();
    if (isAptitudeArea(upper)) area = upper;
    else errors.push(`"${areaCell}" is not an area. Use quantitative, logical or verbal.`);
  } else {
    // Derived from the topic, which is the one mapping that cannot be wrong.
    area = topic ? APTITUDE_TOPIC_AREA[topic] : defaults.area;
  }
  if (topic && area && APTITUDE_TOPIC_AREA[topic] !== area) {
    errors.push(`${topic} is a ${APTITUDE_TOPIC_AREA[topic]} topic, not ${area}.`);
  }

  const explanation = (cells.explanation ?? "").trim();

  const expectedCell = (cells.expectedSeconds ?? "").trim();
  let expectedSeconds = 60;
  if (expectedCell.length > 0) {
    const parsed = Number(expectedCell);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      errors.push(`"${expectedCell}" is not a whole number of seconds.`);
    } else if (parsed < APTITUDE_LIMITS.expectedSeconds.min || parsed > APTITUDE_LIMITS.expectedSeconds.max) {
      errors.push(
        `${parsed} seconds is outside ${APTITUDE_LIMITS.expectedSeconds.min}–${APTITUDE_LIMITS.expectedSeconds.max}.`,
      );
    } else {
      expectedSeconds = parsed;
    }
  }

  const originCell = (cells.origin ?? "").trim();
  let origin = defaults.origin;
  if (originCell.length > 0) {
    const resolved = ORIGIN_ALIASES[normalise(originCell)];
    if (!resolved) errors.push(`"${originCell}" is not an origin. Use faculty, senior or ai.`);
    else origin = resolved;
  }

  // The two LMS columns with no home here.
  if ((cells.marks ?? "").trim().length > 0) {
    warnings.push(
      "The `marks` column is not stored: a mock's section declares marksPerCorrect, so a per-question mark would be a second, conflicting answer.",
    );
  }
  if ((cells.hint ?? "").trim().length > 0) {
    warnings.push(
      "The `hint` column is not stored: an aptitude question carries a worked explanation instead, which is mandatory at publish.",
    );
  }

  const code = (cells.code ?? "").trim() || null;

  /**
   * The shared passage text. Required for a PASSAGE_GROUPED row and refused
   * on every other kind: a passage on a standalone question is a passage no
   * sibling shares, which is a stem with extra steps by another route.
   */
  const passageBody = (cells.passage ?? "").trim();
  let passage: CsvPassage | null = null;
  if (kind === "PASSAGE_GROUPED") {
    if (passageBody.length < APTITUDE_LIMITS.passageBody.min) {
      errors.push(
        passageBody.length === 0
          ? "A passage question needs its shared text in the `passage` column, repeated on every question of the group."
          : `The passage is ${passageBody.length} characters; a passage is at least ${APTITUDE_LIMITS.passageBody.min}. Shorter than that it is a stem, not a passage.`,
      );
    } else if (passageBody.length > APTITUDE_LIMITS.passageBody.max) {
      errors.push(`The passage is longer than ${APTITUDE_LIMITS.passageBody.max} characters.`);
    } else {
      const title = (cells.passageTitle ?? "").trim();
      passage = { title: title.length > 0 ? title : passageBody.slice(0, 60).trim(), body: passageBody };
    }
  } else if (passageBody.length > 0) {
    errors.push("Only a passage question carries a `passage`. Set the type to passage, or clear the column.");
  }

  if (kind === "NUMERIC_ENTRY") {
    const answerCell = (cells.correct ?? "").trim();
    const answer = Number(answerCell);
    if (answerCell.length === 0) errors.push("The numeric answer is missing.");
    else if (!Number.isFinite(answer)) errors.push(`"${answerCell}" is not a number.`);

    const toleranceCell = (cells.tolerance ?? "").trim();
    // Zero rather than refused: "exactly this number" is a complete answer,
    // and a bank exported from a product without the column should not have
    // to invent one.
    const tolerance = toleranceCell.length === 0 ? 0 : Number(toleranceCell);
    if (toleranceCell.length > 0 && (!Number.isFinite(tolerance) || tolerance < 0)) {
      errors.push(`"${toleranceCell}" is not a tolerance. Use a number of zero or more.`);
    }
    if (splitList(cells.options ?? "").length > 0) {
      errors.push("A numeric question has no options; remove the options column's value for this row.");
    }
    if (errors.length > 0) return { ok: false, errors, warnings };

    return finish(
      {
        kind: "NUMERIC_ENTRY",
        area: area!,
        topic: topic!,
        difficulty: difficulty!,
        stem,
        options: [],
        correctOptionIndexes: [],
        numericAnswer: answer,
        numericTolerance: tolerance,
        numericUnit: (cells.unit ?? "").trim() || null,
        explanation,
        expectedSeconds,
        origin,
        sourceBatch: defaults.sourceBatch,
        passageId: null,
      },
      code,
      passage,
      warnings,
    );
  }

  const options = splitList(cells.options ?? "");
  if (options.length < APTITUDE_LIMITS.options.min) {
    errors.push(
      `A choice question needs at least ${APTITUDE_LIMITS.options.min} options, separated by "${APTITUDE_IMPORT_LIMITS.optionSeparator}".`,
    );
  }
  if (options.length > APTITUDE_LIMITS.options.max) {
    errors.push(`A question may have at most ${APTITUDE_LIMITS.options.max} options; this row has ${options.length}.`);
  }
  const key = parseAnswerKey(cells.correct ?? "", options.length);
  errors.push(...key.errors);
  if ((cells.tolerance ?? "").trim().length > 0 || (cells.unit ?? "").trim().length > 0) {
    errors.push("A choice question has no tolerance or unit.");
  }
  if (kind === "MULTI_CHOICE" && key.indexes.length === 1) {
    errors.push(
      "A multi-choice question needs two or more correct options. Use single for one — otherwise the all-or-nothing rule scores like single-choice anyway.",
    );
  }
  if (kind === "SINGLE_CHOICE" && key.indexes.length > 1) {
    errors.push("A single-choice question has exactly one correct option. Use multi for more.");
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  return finish(
    {
      kind: kind!,
      area: area!,
      topic: topic!,
      difficulty: difficulty!,
      stem,
      options,
      correctOptionIndexes: key.indexes,
      numericAnswer: null,
      numericTolerance: null,
      numericUnit: null,
      explanation,
      expectedSeconds,
      origin,
      sourceBatch: defaults.sourceBatch,
      // Resolved by the importer, which knows which rows share a passage; a
      // CSV row cannot carry a database id.
      passageId: null,
    } as Record<string, unknown>,
    code,
    passage,
    warnings,
  );
}

/**
 * The last gate: the same schema the authoring form uses.
 *
 * Not a second opinion — THE opinion. Everything above exists to turn CSV
 * text into the shape this schema judges, and a row that got past the
 * column-level checks and fails here fails for a reason the schema states.
 */
function finish(
  draft: Record<string, unknown>,
  code: string | null,
  passage: CsvPassage | null,
  warnings: string[],
): RowResult {
  // A passage-grouped row has no passage ROW yet, and the schema requires one
  // for that kind — so it is asked about everything else with a stand-in, and
  // the stand-in never leaves this function.
  const forSchema = passage !== null ? { ...draft, passageId: "assigned-by-the-importer" } : draft;
  const parsed = aptitudeQuestionSchema.safeParse(forSchema);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      ),
      warnings,
    };
  }
  return {
    ok: true,
    question: { ...parsed.data, passageId: null } as AptitudeCsvQuestion,
    code,
    passage,
    warnings,
  };
}

// ── Writing one row ─────────────────────────────────────────────────────

/**
 * One question as a CSV row, in `APTITUDE_CSV_COLUMNS` order.
 *
 * The inverse of `rowToQuestion`, and a test asserts the round trip: a file
 * exported from `/admin/aptitude/export` re-imports as UNCHANGED. That is
 * what makes the export usable for review — a faculty member can open it,
 * correct a stem, and upload it back.
 *
 * The key is written 1-based, as the question bank writes it, so a reviewer
 * reading the file sees what they would read anywhere else.
 */
export function questionToRow(question: {
  readonly kind: AptitudeQuestionKind;
  readonly displayCode?: string | null;
  readonly area: string;
  readonly topic: string;
  readonly difficulty: string;
  readonly stem: string;
  readonly options: readonly string[];
  readonly correctOptionIndexes: readonly number[];
  readonly numericAnswer: number | string | null;
  readonly numericTolerance: number | string | null;
  readonly numericUnit: string | null;
  readonly explanation: string;
  readonly expectedSeconds: number;
  readonly origin: string;
  readonly passage?: { readonly title: string; readonly body: string } | null;
}): string {
  const numeric = question.kind === "NUMERIC_ENTRY";
  return csvRow([
    CSV_KIND[question.kind],
    question.stem,
    // `marks` is not stored, so it is written empty rather than invented.
    "",
    question.difficulty.toLowerCase(),
    numeric ? "" : question.options.join(APTITUDE_IMPORT_LIMITS.optionSeparator),
    numeric
      ? (question.numericAnswer ?? "")
      : question.correctOptionIndexes.map((index) => index + 1).join(APTITUDE_IMPORT_LIMITS.optionSeparator),
    numeric ? (question.numericTolerance ?? "") : "",
    numeric ? (question.numericUnit ?? "") : "",
    // `hint` is not stored either.
    "",
    question.explanation,
    question.topic,
    question.area,
    question.topic,
    question.displayCode ?? "",
    question.expectedSeconds,
    question.origin.toLowerCase(),
    // Repeated on every question of a group, which is how the importer keys
    // them — and what makes the round trip lossless for a passage.
    question.passage?.body ?? "",
    question.passage?.title ?? "",
  ]);
}

/** The `type` this product writes, which is also the first alias it reads. */
const CSV_KIND: Readonly<Record<AptitudeQuestionKind, string>> = Object.freeze({
  SINGLE_CHOICE: "single",
  MULTI_CHOICE: "multi",
  NUMERIC_ENTRY: "numeric",
  PASSAGE_GROUPED: "passage",
});

export function aptitudeCsvHeader(): string {
  return csvRow([...APTITUDE_CSV_COLUMNS]);
}

/** Every kind has a CSV spelling, and every spelling reads back. */
export const aptitudeCsvRowSchema = z.object(
  Object.fromEntries(APTITUDE_CSV_COLUMNS.map((column) => [column, z.string().default("")])) as Record<
    (typeof APTITUDE_CSV_COLUMNS)[number],
    z.ZodDefault<z.ZodString>
  >,
);

/** For the round-trip test and the authoring page's own sanity. */
export const APTITUDE_CSV_KINDS = APTITUDE_QUESTION_KINDS;
