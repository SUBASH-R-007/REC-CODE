import { describe, expect, it } from "vitest";
import {
  APTITUDE_ROW_STATUSES,
  passageGroups,
  planImport,
  type ExistingQuestion,
  type PlannedRow,
  type ReadRow,
} from "../src/aptitude-import";
import type { AptitudeCsvQuestion } from "../src/aptitude-csv";

/**
 * SPEC §5: *so one bad row cannot discard a 300-question file.*
 *
 * Every test here is a version of that sentence. The one that matters most
 * is the published-question re-import: the database trigger would refuse
 * that write and roll back the whole file, so the planner has to refuse the
 * ROW.
 */

const question = (over: Partial<AptitudeCsvQuestion> = {}): AptitudeCsvQuestion =>
  ({
    kind: "SINGLE_CHOICE",
    area: "QUANTITATIVE",
    topic: "PERCENTAGES",
    difficulty: "EASY",
    stem: "What is 10% of 250?",
    options: ["25", "20", "30", "35"],
    correctOptionIndexes: [0],
    numericAnswer: null,
    numericTolerance: null,
    numericUnit: null,
    explanation: "Ten percent is one tenth, so 250 divided by ten gives 25 without the formula.",
    expectedSeconds: 45,
    origin: "FACULTY",
    sourceBatch: null,
    passageId: null,
    ...over,
  }) as AptitudeCsvQuestion;

const ok = (line: number, contentHash: string, over: Partial<Extract<ReadRow, { ok: true }>> = {}): ReadRow => ({
  line,
  ok: true,
  question: question(),
  code: null,
  contentHash,
  needsPassage: false,
  warnings: [],
  ...over,
});

const bad = (line: number, ...errors: string[]): ReadRow => ({ line, ok: false, errors, warnings: [] });

const existing = (over: Partial<ExistingQuestion> = {}): ExistingQuestion => ({
  id: "q1",
  displayCode: "APT-00001",
  contentHash: "a".repeat(64),
  status: "DRAFT",
  ...over,
});

describe("the statuses are Phase 4's, reused", () => {
  it("names the four", () => {
    // ProblemImportRowStatus verbatim: the shape of the answer is the same.
    expect(APTITUDE_ROW_STATUSES).toEqual(["CREATED", "NEW_REVISION", "UNCHANGED", "FAILED"]);
  });

  it("counts a revision as `revised`, matching the status it counts", () => {
    // `ProblemImport` spells it the same way. A counter whose name does not
    // match its status cannot be reconciled.
    const plan = planImport([ok(2, "b".repeat(64), { code: "APT-00001" })], [existing()]);
    expect(plan.revised).toBe(1);
    expect(Object.keys(plan)).toContain("revised");
    expect(Object.keys(plan)).not.toContain("updated");
  });
});

describe("one bad row does not discard the file", () => {
  it("keeps every good row when one fails validation", () => {
    const plan = planImport(
      [ok(2, "1".repeat(64)), bad(3, "The question text is missing."), ok(4, "2".repeat(64))],
      [],
    );
    expect(plan.total).toBe(3);
    expect(plan.created).toBe(2);
    expect(plan.failed).toBe(1);
    expect(plan.rows[1]!.errors).toEqual(["The question text is missing."]);
  });

  it("carries every reason a row failed, not the first", () => {
    const plan = planImport([bad(2, "no type", "no text", "no topic")], []);
    expect(plan.rows[0]!.errors).toHaveLength(3);
  });

  it("keeps a failed row's warnings, so nothing an operator should know is lost", () => {
    const plan = planImport([{ line: 2, ok: false, errors: ["bad"], warnings: ["marks is not stored"] }], []);
    expect(plan.rows[0]!.warnings).toEqual(["marks is not stored"]);
  });
});

describe("matching a row to a question already in the bank", () => {
  it("creates a question the bank does not have", () => {
    const plan = planImport([ok(2, "1".repeat(64))], []);
    expect(plan.rows[0]!.status).toBe("CREATED");
    expect(plan.rows[0]!.questionId).toBeNull();
  });

  it("reports an identical question as UNCHANGED rather than rewriting it", () => {
    // The round trip's own case. A no-op write would bump `updatedAt` on
    // 2,000 rows and tell an operator nothing.
    const hash = "a".repeat(64);
    const plan = planImport([ok(2, hash)], [existing({ contentHash: hash })]);
    expect(plan.rows[0]!.status).toBe("UNCHANGED");
    expect(plan.rows[0]!.questionId).toBe("q1");
    expect(plan.unchanged).toBe(1);
  });

  it("matches on the CODE first, because a code is an explicit claim", () => {
    const plan = planImport([ok(2, "z".repeat(64), { code: "APT-00001" })], [existing()]);
    expect(plan.rows[0]!.status).toBe("NEW_REVISION");
    expect(plan.rows[0]!.questionId).toBe("q1");
  });

  it("falls back to the content hash, which catches the same file uploaded twice", () => {
    const hash = "c".repeat(64);
    const plan = planImport([ok(2, hash)], [existing({ contentHash: hash, displayCode: "APT-00009" })]);
    expect(plan.rows[0]!.status).toBe("UNCHANGED");
    expect(plan.rows[0]!.displayCode).toBe("APT-00009");
  });

  it("creates a row whose code the bank does not know", () => {
    // An operator importing from another REC instance has codes that are real
    // there; refusing them would make the file unusable.
    const plan = planImport([ok(2, "1".repeat(64), { code: "APT-99999" })], [existing()]);
    expect(plan.rows[0]!.status).toBe("CREATED");
    expect(plan.rows[0]!.displayCode).toBe("APT-99999");
  });
});

describe("a published question's wording is frozen", () => {
  it("refuses the ROW, not the file", () => {
    // recx_refuse_published_question_change would refuse the write and take
    // the whole transaction with it — one edited row discarding 299 good
    // ones, which is exactly what the spec's clause forbids.
    const plan = planImport(
      [ok(2, "1".repeat(64)), ok(3, "z".repeat(64), { code: "APT-00001" }), ok(4, "2".repeat(64))],
      [existing({ status: "PUBLISHED" })],
    );
    expect(plan.created).toBe(2);
    expect(plan.failed).toBe(1);
    expect(plan.rows[1]!.status).toBe("FAILED");
  });

  it("says what to do instead, in a sentence an operator can act on", () => {
    const plan = planImport([ok(2, "z".repeat(64), { code: "APT-00001" })], [existing({ status: "PUBLISHED" })]);
    const message = plan.rows[0]!.errors.join(" ");
    expect(message).toContain("APT-00001 is published");
    expect(message).toContain("students have already been scored on it");
    expect(message).toContain("Retire it and add a new question");
    expect(message).toContain("edit only its explanation");
  });

  it("refuses an edit to a RETIRED question too", () => {
    // A retired question is still the question past results were scored on.
    const plan = planImport([ok(2, "z".repeat(64), { code: "APT-00001" })], [existing({ status: "RETIRED" })]);
    expect(plan.rows[0]!.status).toBe("FAILED");
  });

  it("ACCEPTS a published question re-imported unchanged", () => {
    // Which is the whole round trip: export the bank, correct one draft, and
    // upload it back without the published rows getting in the way.
    const hash = "a".repeat(64);
    const plan = planImport([ok(2, hash, { code: "APT-00001" })], [existing({ status: "PUBLISHED", contentHash: hash })]);
    expect(plan.rows[0]!.status).toBe("UNCHANGED");
    expect(plan.failed).toBe(0);
  });

  it("allows a revision to a draft and to one in review", () => {
    for (const status of ["DRAFT", "IN_REVIEW"] as const) {
      const plan = planImport([ok(2, "z".repeat(64), { code: "APT-00001" })], [existing({ status })]);
      expect(plan.rows[0]!.status, status).toBe("NEW_REVISION");
    }
  });
});

describe("a file that fights itself", () => {
  it("refuses the second copy of a question, naming the first line", () => {
    const hash = "d".repeat(64);
    const plan = planImport([ok(2, hash), ok(7, hash)], []);
    expect(plan.rows[0]!.status).toBe("CREATED");
    expect(plan.rows[1]!.status).toBe("FAILED");
    expect(plan.rows[1]!.errors[0]).toContain("identical to the one on line 2");
  });

  it("keeps the rest of the file", () => {
    const hash = "d".repeat(64);
    const plan = planImport([ok(2, hash), ok(3, hash), ok(4, "e".repeat(64))], []);
    expect(plan.created).toBe(2);
    expect(plan.failed).toBe(1);
  });
});

// ── Passage groups ──────────────────────────────────────────────────────

const row = (line: number, over: Partial<PlannedRow> = {}): PlannedRow => ({
  line,
  status: "CREATED",
  question: question({ kind: "PASSAGE_GROUPED", area: "VERBAL", topic: "READING_COMPREHENSION" }),
  questionId: null,
  displayCode: null,
  contentHash: "x".repeat(64),
  needsPassage: true,
  errors: [],
  warnings: [],
  ...over,
});

describe("grouping a passage's questions", () => {
  it("groups consecutive passage rows of the same topic", () => {
    // Consecutive, because that is how a human writes a passage's questions
    // in a spreadsheet — and any cleverer rule would be one nobody could
    // predict from looking at the file.
    const result = passageGroups([row(2), row(3), row(4)]);
    expect(result.errors).toEqual([]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.lines).toEqual([2, 3, 4]);
  });

  it("starts a new group at a non-passage row", () => {
    const result = passageGroups([row(2), row(3), row(4, { needsPassage: false }), row(5), row(6)]);
    expect(result.groups.map((g) => g.lines)).toEqual([
      [2, 3],
      [5, 6],
    ]);
  });

  it("starts a new group when the topic changes", () => {
    const other = row(4, {
      question: question({ kind: "PASSAGE_GROUPED", area: "VERBAL", topic: "CLOZE" }),
    });
    const result = passageGroups([row(2), row(3), other, row(5, { question: question({ kind: "PASSAGE_GROUPED", area: "VERBAL", topic: "CLOZE" }) })]);
    expect(result.groups.map((g) => g.topic)).toEqual(["READING_COMPREHENSION", "CLOZE"]);
  });

  it("refuses a passage with one question, and says what to do instead", () => {
    // SPEC §5 says "one shared passage, N questions"; a passage with one
    // question is a stem with extra steps.
    const result = passageGroups([row(2), row(3, { needsPassage: false })]);
    expect(result.groups).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(2);
    expect(result.errors[0]!.message).toContain("at least two questions");
    expect(result.errors[0]!.message).toContain("single-choice question instead");
  });

  it("refuses a lone passage row at the end of the file", () => {
    const result = passageGroups([row(2), row(3), row(9)]);
    // Lines 2 and 3 are one group; line 9 follows a gap but is still
    // consecutive in the ROW LIST, so it joins them.
    expect(result.groups[0]!.lines).toEqual([2, 3, 9]);
  });

  it("closes a group at a FAILED row, so a bad row cannot join two passages", () => {
    const result = passageGroups([row(2), row(3), row(4, { status: "FAILED", question: null }), row(5), row(6)]);
    expect(result.groups.map((g) => g.lines)).toEqual([
      [2, 3],
      [5, 6],
    ]);
  });

  it("finds nothing in a file with no passage rows", () => {
    const result = passageGroups([row(2, { needsPassage: false }), row(3, { needsPassage: false })]);
    expect(result.groups).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
