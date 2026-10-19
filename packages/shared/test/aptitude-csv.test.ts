import { describe, expect, it } from "vitest";
import {
  APTITUDE_CSV_COLUMNS,
  APTITUDE_CSV_SHAPE,
  APTITUDE_IMPORT_LIMITS,
  LMS_CSV_COLUMNS,
  aptitudeCsvHeader,
  parseAnswerKey,
  questionToRow,
  rowToQuestion,
  splitList,
  topicFromCells,
  type RowDefaults,
} from "../src/aptitude-csv";
import { parseCsvRecords } from "../src/csv";

/**
 * SPEC §5: *Reuse the LMS question-bank CSV import/export pipeline with
 * per-row results, so one bad row cannot discard a 300-question file.*
 *
 * Two halves, both tested here: a file exported from the LMS question bank
 * imports, and a file exported from THIS product re-imports unchanged.
 */

const DEFAULTS: RowDefaults = {
  area: "QUANTITATIVE",
  topic: "PERCENTAGES",
  origin: "FACULTY",
  sourceBatch: "batch-2026",
};

const WORKED = "Ten percent is one tenth of the number, so dividing 250 by ten gives 25 without the formula.";
const PASSAGE =
  "A quiet revolution has reshaped the way small towns buy and sell, and it arrived without a single announcement anywhere.";

/** A row as the LMS question bank writes one: its columns, its spellings. */
const lmsRow = (over: Partial<Record<string, string>> = {}): Record<string, string> => ({
  type: "mcq",
  text: "What is 10% of 250?",
  marks: "1",
  difficulty: "easy",
  options: "25|20|30|35",
  correct: "1",
  tolerance: "",
  unit: "",
  hint: "",
  explanation: WORKED,
  tags: "percentages|arithmetic",
  ...over,
});

describe("the column list is the LMS question bank's", () => {
  it("starts with the LMS header, in the LMS order", () => {
    // Not a column list of our own invention: a file exported from the LMS
    // question bank has to import, which is the point of the spec's clause.
    expect(APTITUDE_CSV_COLUMNS.slice(0, LMS_CSV_COLUMNS.length)).toEqual([...LMS_CSV_COLUMNS]);
    expect(LMS_CSV_COLUMNS).toEqual([
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
    ]);
  });

  it("makes everything this product added optional", () => {
    // An LMS export has none of them.
    for (const column of ["area", "topic", "code", "expectedSeconds", "origin"]) {
      expect(APTITUDE_CSV_SHAPE.optionalColumns, column).toContain(column);
    }
  });

  it("requires only the three a question cannot exist without", () => {
    const required = APTITUDE_CSV_COLUMNS.filter((c) => !APTITUDE_CSV_SHAPE.optionalColumns!.includes(c));
    expect([...required].sort()).toEqual(["explanation", "text", "type"]);
  });

  it("separates options with a pipe, so a comma inside one needs no quoting", () => {
    expect(APTITUDE_IMPORT_LIMITS.optionSeparator).toBe("|");
    expect(splitList("a, b|c|  d  ")).toEqual(["a, b", "c", "d"]);
    expect(splitList("")).toEqual([]);
  });
});

describe("a file exported from the LMS question bank", () => {
  const header = `${LMS_CSV_COLUMNS.join(",")}\r\n`;
  const file = `${header}mcq,"What is 10% of 250?",1,easy,25|20|30|35,1,,,,"${WORKED}",percentages\r\n`;

  it("parses against the shape, with no area or topic column", () => {
    const parsed = parseCsvRecords(file, APTITUDE_CSV_SHAPE);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
  });

  it("imports, taking its topic from the tags", () => {
    const parsed = parseCsvRecords(file, APTITUDE_CSV_SHAPE);
    const result = rowToQuestion(parsed.rows[0]!.cells, { ...DEFAULTS, topic: null });
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    if (result.ok) {
      expect(result.question.topic).toBe("PERCENTAGES");
      // The area comes from the topic, which is the one mapping that cannot
      // be wrong.
      expect(result.question.area).toBe("QUANTITATIVE");
      expect(result.question.correctOptionIndexes).toEqual([0]);
    }
  });

  it("warns about the two LMS columns with no home here, rather than dropping them in silence", () => {
    const result = rowToQuestion(lmsRow({ hint: "Move the decimal point." }), DEFAULTS);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("`marks` column is not stored");
    expect(result.warnings.join(" ")).toContain("`hint` column is not stored");
  });

  it("refuses a header with a column nothing reads, by name", () => {
    const parsed = parseCsvRecords(`type,text,explanation,nonsense\r\nsingle,a,b,c\r\n`, APTITUDE_CSV_SHAPE);
    expect(parsed.errors.some((e) => e.message.includes("nonsense"))).toBe(true);
  });

  it("refuses a header missing a column a question cannot exist without, by name", () => {
    const parsed = parseCsvRecords(`type,options,correct\r\nsingle,a|b,1\r\n`, APTITUDE_CSV_SHAPE);
    const message = parsed.errors.map((e) => e.message).join(" ");
    expect(message).toContain("text");
    expect(message).toContain("explanation");
  });
});

describe("the answer key, 1-based or lettered as the question bank writes it", () => {
  it("reads a number and a letter as the same option", () => {
    expect(parseAnswerKey("2", 4).indexes).toEqual([1]);
    expect(parseAnswerKey("B", 4).indexes).toEqual([1]);
    expect(parseAnswerKey("b", 4).indexes).toEqual([1]);
  });

  it("reads a list separated by a pipe, a comma or a semicolon", () => {
    expect(parseAnswerKey("1|3", 4).indexes).toEqual([0, 2]);
    expect(parseAnswerKey("A,C", 4).indexes).toEqual([0, 2]);
    expect(parseAnswerKey("A; C", 4).indexes).toEqual([0, 2]);
  });

  it("returns them sorted, so two spellings of one key compare equal", () => {
    expect(parseAnswerKey("3|1", 4).indexes).toEqual([0, 2]);
  });

  it("refuses an option that does not exist, and says how the numbering works", () => {
    const result = parseAnswerKey("5", 4);
    expect(result.indexes).toEqual([]);
    expect(result.errors[0]).toContain("Numbers start at 1 and letters at A");
  });

  it("refuses zero, which is the off-by-one a 1-based key invites", () => {
    // An off-by-one in an answer key is a question every candidate gets
    // wrong, which is why the conversion lives in one place.
    expect(parseAnswerKey("0", 4).errors).toHaveLength(1);
  });

  it("refuses a duplicate and says which", () => {
    expect(parseAnswerKey("1|1", 4).errors[0]).toContain("marked correct twice");
  });

  it("refuses nonsense and an empty key", () => {
    expect(parseAnswerKey("first", 4).errors[0]).toContain("not an option number or letter");
    expect(parseAnswerKey("", 4).errors[0]).toContain("missing");
  });

  it("reports EVERY problem in a key, not the first", () => {
    const result = parseAnswerKey("0|9|x", 4);
    expect(result.errors).toHaveLength(3);
  });
});

describe("finding a topic", () => {
  it("reads the topic column by its enum name", () => {
    expect(topicFromCells({ topic: "TIME_SPEED_DISTANCE" })).toBe("TIME_SPEED_DISTANCE");
    expect(topicFromCells({ topic: "time speed distance" })).toBe("TIME_SPEED_DISTANCE");
  });

  it("reads it by the label the export writes", () => {
    expect(topicFromCells({ topic: "Time, Speed & Distance" })).toBe("TIME_SPEED_DISTANCE");
    expect(topicFromCells({ topic: "Simple & Compound Interest" })).toBe("INTEREST");
  });

  it("falls back to the tags, which is where an LMS question's topic lives", () => {
    expect(topicFromCells({ tags: "arithmetic|syllogisms|campus" })).toBe("SYLLOGISMS");
  });

  it("prefers an explicit topic column over the tags, and does not fall back from a wrong one", () => {
    // A row that names a topic has made a claim; silently using a tag instead
    // would hide a typo in the column somebody meant to be read.
    expect(topicFromCells({ topic: "CLOZE", tags: "percentages" })).toBe("CLOZE");
    expect(topicFromCells({ topic: "vibes", tags: "percentages" })).toBeNull();
  });

  it("finds nothing in a file with neither", () => {
    expect(topicFromCells({})).toBeNull();
    expect(topicFromCells({ tags: "arithmetic|campus" })).toBeNull();
  });
});

describe("reading one row", () => {
  it("accepts a well-formed single-choice row", () => {
    const result = rowToQuestion(lmsRow(), DEFAULTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.question.kind).toBe("SINGLE_CHOICE");
      expect(result.question.options).toEqual(["25", "20", "30", "35"]);
      expect(result.question.sourceBatch).toBe("batch-2026");
      expect(result.passage).toBeNull();
    }
  });

  it("accepts every type spelling a faculty export might use", () => {
    // Refusing a 300-row file over a synonym is not a standard worth holding.
    for (const [spelling, kind] of [
      ["single", "SINGLE_CHOICE"],
      ["Single Choice", "SINGLE_CHOICE"],
      ["mcq", "SINGLE_CHOICE"],
      ["multi", "MULTI_CHOICE"],
      ["checkbox", "MULTI_CHOICE"],
    ] as const) {
      const result = rowToQuestion(
        lmsRow({ type: spelling, correct: kind === "MULTI_CHOICE" ? "1|3" : "1" }),
        DEFAULTS,
      );
      expect(result.ok, `${spelling}: ${result.ok ? "" : result.errors.join("; ")}`).toBe(true);
      if (result.ok) expect(result.question.kind).toBe(kind);
    }
  });

  it("refuses a type it does not know, and lists the ones it does", () => {
    const result = rowToQuestion(lmsRow({ type: "essay" }), DEFAULTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("single, multi, numeric, passage");
  });

  it("defaults the difficulty to medium rather than refusing the row", () => {
    const result = rowToQuestion(lmsRow({ difficulty: "" }), DEFAULTS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.question.difficulty).toBe("MEDIUM");
  });

  it("reads a numeric row, defaulting the tolerance to exact", () => {
    const result = rowToQuestion(
      lmsRow({ type: "numeric", options: "", correct: "8", tolerance: "", unit: "", tags: "averages_mixtures" }),
      { ...DEFAULTS, topic: null },
    );
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    if (result.ok) {
      expect(result.question.numericAnswer).toBe(8);
      // "Exactly this number" is a complete answer; a bank exported from a
      // product without the column should not have to invent one.
      expect(result.question.numericTolerance).toBe(0);
      expect(result.question.topic).toBe("AVERAGES_MIXTURES");
    }
  });

  it("reads a tolerance and a unit when the row has them", () => {
    const result = rowToQuestion(
      lmsRow({ type: "numeric", options: "", correct: "12.5", tolerance: "0.01", unit: "km/h" }),
      DEFAULTS,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.question.numericTolerance).toBe(0.01);
      expect(result.question.numericUnit).toBe("km/h");
    }
  });

  it("refuses options on a numeric row and a tolerance on a choice row", () => {
    expect(rowToQuestion(lmsRow({ type: "numeric", correct: "8" }), DEFAULTS).ok).toBe(false);
    expect(rowToQuestion(lmsRow({ tolerance: "0.5" }), DEFAULTS).ok).toBe(false);
  });

  it("refuses a multi-choice row with one correct option, and says why", () => {
    const result = rowToQuestion(lmsRow({ type: "multi", correct: "1" }), DEFAULTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("all-or-nothing rule scores like single-choice");
  });

  it("refuses a single-choice row with two", () => {
    expect(rowToQuestion(lmsRow({ correct: "1|2" }), DEFAULTS).ok).toBe(false);
  });

  it("reports EVERY problem in a row, not the first", () => {
    // The whole point of per-row results: an operator fixing a 300-question
    // file should see what is wrong with each bad row in one pass.
    const result = rowToQuestion(
      { type: "essay", text: "", difficulty: "trivial", options: "only-one", correct: "9", explanation: "" },
      { ...DEFAULTS, topic: null },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(5);
  });

  it("refuses a row with no topic and no default chosen", () => {
    const result = rowToQuestion(lmsRow({ tags: "arithmetic" }), { ...DEFAULTS, topic: null, area: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("no topic was chosen for this upload");
  });

  it("refuses a topic that contradicts the row's own area", () => {
    const result = rowToQuestion(lmsRow({ area: "VERBAL", topic: "MENSURATION" }), DEFAULTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("QUANTITATIVE topic, not VERBAL");
  });

  it("accepts a draft with no explanation, because publishing is where it becomes mandatory", () => {
    const result = rowToQuestion(lmsRow({ explanation: "" }), DEFAULTS);
    expect(result.ok).toBe(true);
  });

  it("holds expectedSeconds to the question's own bounds", () => {
    expect(rowToQuestion(lmsRow({ expectedSeconds: "4" }), DEFAULTS).ok).toBe(false);
    expect(rowToQuestion(lmsRow({ expectedSeconds: "2000" }), DEFAULTS).ok).toBe(false);
    expect(rowToQuestion(lmsRow({ expectedSeconds: "x" }), DEFAULTS).ok).toBe(false);
    const good = rowToQuestion(lmsRow({ expectedSeconds: "90" }), DEFAULTS);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.question.expectedSeconds).toBe(90);
  });

  it("reads a passage row's shared text and leaves the passage ROW to the importer", () => {
    const result = rowToQuestion(
      lmsRow({ type: "passage", tags: "reading_comprehension", area: "VERBAL", passage: PASSAGE }),
      { ...DEFAULTS, topic: null, area: null },
    );
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    if (result.ok) {
      expect(result.passage?.body).toBe(PASSAGE);
      // A title is optional; without one the opening words stand in, which is
      // what a reviewer scanning a list needs.
      expect(result.passage?.title.length).toBeGreaterThan(0);
      // Null, never a sentinel somebody could mistake for an id.
      expect(result.question.passageId).toBeNull();
    }
  });

  it("refuses a passage question with no shared text, and says where to put it", () => {
    // The LMS columns have nowhere to put a passage, and the Phase 7 design
    // never said where it would come from.
    const result = rowToQuestion(lmsRow({ type: "passage", tags: "reading_comprehension" }), DEFAULTS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("`passage` column");
      expect(result.errors.join(" ")).toContain("repeated on every question of the group");
    }
  });

  it("refuses a passage shorter than a passage", () => {
    const result = rowToQuestion(
      lmsRow({ type: "passage", tags: "reading_comprehension", passage: "Too short." }),
      DEFAULTS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("it is a stem, not a passage");
  });

  it("refuses a passage on a question that is not passage-grouped", () => {
    // A passage no sibling shares is a stem with extra steps by another route.
    const result = rowToQuestion(lmsRow({ passage: PASSAGE }), DEFAULTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("Only a passage question carries a `passage`");
  });

  it("leaves `passage` null on an ordinary question", () => {
    const result = rowToQuestion(lmsRow(), DEFAULTS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.passage).toBeNull();
  });

  it("carries a code through, for a re-import that updates", () => {
    const result = rowToQuestion(lmsRow({ code: "APT-00042" }), DEFAULTS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe("APT-00042");
  });
});

describe("the round trip", () => {
  const question = {
    kind: "SINGLE_CHOICE" as const,
    displayCode: "APT-00042",
    area: "QUANTITATIVE",
    topic: "PERCENTAGES",
    difficulty: "EASY",
    stem: 'What is 10% of 250, "about"?',
    options: ["25", "20, maybe", "30", "35"],
    correctOptionIndexes: [0],
    numericAnswer: null,
    numericTolerance: null,
    numericUnit: null,
    explanation: WORKED,
    expectedSeconds: 45,
    origin: "FACULTY",
  };

  it("writes a header in the declared column order", () => {
    expect(aptitudeCsvHeader().trim()).toBe(APTITUDE_CSV_COLUMNS.map((c) => `"${c}"`).join(","));
  });

  it("re-imports an exported question UNCHANGED", () => {
    // What makes the export usable for review: a faculty member opens it,
    // corrects a stem, and uploads it back.
    const file = aptitudeCsvHeader() + questionToRow(question);
    const parsed = parseCsvRecords(file, APTITUDE_CSV_SHAPE);
    expect(parsed.errors).toEqual([]);
    const result = rowToQuestion(parsed.rows[0]!.cells, DEFAULTS);
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    if (!result.ok) return;
    expect(result.question.kind).toBe(question.kind);
    expect(result.question.topic).toBe(question.topic);
    expect(result.question.area).toBe(question.area);
    expect(result.question.difficulty).toBe(question.difficulty);
    expect(result.question.stem).toBe(question.stem);
    expect(result.question.options).toEqual(question.options);
    expect(result.question.correctOptionIndexes).toEqual(question.correctOptionIndexes);
    expect(result.question.explanation).toBe(question.explanation);
    expect(result.question.expectedSeconds).toBe(question.expectedSeconds);
    expect(result.code).toBe("APT-00042");
  });

  it("survives a quote and a comma inside a stem and an option", () => {
    // The reason options are pipe-separated and every cell is quoted.
    const file = aptitudeCsvHeader() + questionToRow(question);
    const parsed = parseCsvRecords(file, APTITUDE_CSV_SHAPE);
    expect(parsed.rows[0]!.cells.text).toBe(question.stem);
    expect(parsed.rows[0]!.cells.options).toContain("20, maybe");
  });

  it("re-imports an exported numeric question unchanged", () => {
    const numeric = {
      ...question,
      kind: "NUMERIC_ENTRY" as const,
      topic: "AVERAGES_MIXTURES",
      options: [],
      correctOptionIndexes: [],
      numericAnswer: 12.5,
      numericTolerance: 0.01,
      numericUnit: "km/h",
    };
    const file = aptitudeCsvHeader() + questionToRow(numeric);
    const result = rowToQuestion(parseCsvRecords(file, APTITUDE_CSV_SHAPE).rows[0]!.cells, DEFAULTS);
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    if (result.ok) {
      expect(result.question.numericAnswer).toBe(12.5);
      expect(result.question.numericTolerance).toBe(0.01);
      expect(result.question.numericUnit).toBe("km/h");
      expect(result.question.options).toEqual([]);
    }
  });

  it("re-imports an exported PASSAGE question with its text intact", () => {
    // Lossless for a passage too, or the round trip would quietly orphan
    // every comprehension question in the bank.
    const passaged = {
      ...question,
      kind: "PASSAGE_GROUPED" as const,
      area: "VERBAL",
      topic: "READING_COMPREHENSION",
      passage: { title: "A quiet revolution", body: PASSAGE },
    };
    const file = aptitudeCsvHeader() + questionToRow(passaged);
    const result = rowToQuestion(parseCsvRecords(file, APTITUDE_CSV_SHAPE).rows[0]!.cells, DEFAULTS);
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    if (result.ok) {
      expect(result.passage).toEqual({ title: "A quiet revolution", body: PASSAGE });
      expect(result.question.kind).toBe("PASSAGE_GROUPED");
    }
  });

  it("writes the key 1-based, as a reviewer reading the file would expect", () => {
    const row = questionToRow({ ...question, kind: "MULTI_CHOICE", correctOptionIndexes: [0, 2] });
    // Option 1 and option 3, not 0 and 2.
    expect(row).toContain('"1|3"');
  });

  it("prefixes a cell a spreadsheet would run as a formula", () => {
    // The hardened writer, lifted from the PII export: an opened export can
    // never run a formula planted in a stem.
    const row = questionToRow({ ...question, stem: "=SUM(A1:A9)" });
    expect(row).toContain(`"'=SUM(A1:A9)"`);
  });
});

describe("the upload limits", () => {
  it("fits the content target the spec records in one file", () => {
    // "~2,000 aptitude questions, with named owners" — a full bank has to fit
    // in one upload or the clause about one bad row is moot.
    expect(APTITUDE_IMPORT_LIMITS.maxRows).toBe(2_000);
  });

  it("is big enough for 300 questions with real worked explanations", () => {
    // A roster row is ~80 bytes; an aptitude row carries a 4 KB stem and an
    // 8 KB explanation. The roster's 900 KB cap would refuse such a file
    // WHOLE, which is the failure "one bad row cannot discard a 300-question
    // file" forbids, from the other direction.
    const worstRow = 4_000 + 8_000 + 500;
    expect(APTITUDE_IMPORT_LIMITS.maxBytes).toBeGreaterThan(300 * worstRow);
  });

  it("refuses a file past the byte cap with a line nobody has to interpret", () => {
    const parsed = parseCsvRecords("x".repeat(APTITUDE_IMPORT_LIMITS.maxBytes + 1), APTITUDE_CSV_SHAPE);
    expect(parsed.errors[0]!.message).toContain("Split it and upload the parts");
  });

  it("refuses a file past the row cap, counting the rows it has", () => {
    const rows = Array.from({ length: APTITUDE_IMPORT_LIMITS.maxRows + 2 }, () => "single,a,,,x|y,1,,,,b,percentages");
    const file = `${APTITUDE_CSV_COLUMNS.slice(0, 11).join(",")}\r\n${rows.join("\r\n")}\r\n`;
    const parsed = parseCsvRecords(file, APTITUDE_CSV_SHAPE);
    expect(parsed.errors.some((e) => e.message.includes(`${APTITUDE_IMPORT_LIMITS.maxRows + 2} rows`))).toBe(true);
  });
});
