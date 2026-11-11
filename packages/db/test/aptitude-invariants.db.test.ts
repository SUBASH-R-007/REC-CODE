import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type TestDb,
} from "./support/test-db";

/**
 * The aptitude question-bank invariants (migration 20261019250000).
 *
 * Phase 6d and 6e between them taught the reason this file exists. Three
 * CHECKs in 6d were created happily by Postgres and raised on every insert
 * (a regex with a repetition count over 255, compiled lazily); one in 6e was
 * created happily and accepted exactly the row it was written to refuse,
 * because a CHECK that evaluates to NULL is SATISFIED. Both catalog fences
 * reported all four present and correct.
 *
 * A catalog fence proves a guard EXISTS; only this kind of test proves it
 * WORKS. So every CHECK and trigger in the migration gets a row here, and
 * each one is attempted through Prisma — the path the application takes.
 */

/**
 * A per-run numeric prefix. The display code CHECK is `^APT-[0-9]+$`, so the
 * usual hex tag cannot go in it; the prefix keeps codes unique across runs and
 * gives the cleanup a LIKE pattern to delete by.
 */
const prefix = String(randomBytes(3).readUIntBE(0, 3) % 90_000 + 10_000);
const TITLE = RUN_DB_TESTS
  ? "aptitude question-bank invariants (live database)"
  : "aptitude question-bank invariants (set RECX_DB_TESTS=1 to run)";

const WORKED =
  "Ten percent is one tenth of the number, so dividing 250 by ten gives 25 without needing the formula.";
const PASSAGE_BODY =
  "A quiet revolution has reshaped the way small towns buy and sell, and the change arrived without a single announcement. ".repeat(
    2,
  );

const SOURCE_NOTE = "Written at REC for the verbal bank, 2026.";

const hash = (seed: string) => createHash("sha256").update(seed).digest("hex");

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let nextCode = 1;

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  /** A well-formed single-choice question, with any field overridden. */
  function questionData(over: Record<string, unknown> = {}): Record<string, unknown> {
    const code = `APT-${prefix}${String(nextCode++).padStart(4, "0")}`;
    return {
      displayCode: code,
      area: "QUANTITATIVE",
      topic: "PERCENTAGES",
      kind: "SINGLE_CHOICE",
      difficulty: "EASY",
      stem: "What is 10% of 250?",
      options: ["25", "20", "30", "35"],
      correctOptionIndexes: [0],
      explanation: WORKED,
      expectedSeconds: 45,
      origin: "FACULTY",
      contentHash: hash(code),
      ...over,
    };
  }

  const create = (over: Record<string, unknown> = {}) =>
    db.aptitudeQuestion.create({ data: questionData(over) as never, select: { id: true, displayCode: true } });

  const passage = (over: Record<string, unknown> = {}) =>
    db.aptitudePassage.create({
      data: {
        area: "VERBAL",
        topic: "READING_COMPREHENSION",
        title: "A quiet revolution",
        body: PASSAGE_BODY,
        wordCount: 40,
        sourceNote: SOURCE_NOTE,
        origin: "FACULTY",
        ...over,
      } as never,
      select: { id: true },
    });

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);
  });

  afterAll(async () => {
    if (!db) return;
    try {
      // A published question cannot be deleted — that is the invariant under
      // test — so the fixtures come out with the guard disabled inside one
      // transaction, the convention the other invariant suites use.
      const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
      const like = `APT-${prefix}%`;
      await db.$transaction([
        raw(`ALTER TABLE "public"."AptitudeQuestion" DISABLE TRIGGER "AptitudeQuestion_published_immutable"`),
        raw(
          `DELETE FROM "public"."AptitudeQuestionStat" WHERE "questionId" IN (SELECT "id" FROM "public"."AptitudeQuestion" WHERE "displayCode" LIKE $1)`,
          like,
        ),
        raw(`DELETE FROM "public"."AptitudeQuestion" WHERE "displayCode" LIKE $1`, like),
        raw(`ALTER TABLE "public"."AptitudeQuestion" ENABLE TRIGGER "AptitudeQuestion_published_immutable"`),
        raw(`DELETE FROM "public"."AptitudePassage" WHERE "sourceNote" = $1`, SOURCE_NOTE),
      ]);
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  // ── The worked explanation ────────────────────────────────────────────

  describe("a worked explanation is mandatory at publish", () => {
    it("accepts a draft with no explanation at all", async () => {
      // A DRAFT with no explanation yet is a legitimate work in progress.
      const row = await create({ explanation: "" });
      expect(row.id).toBeTruthy();
    });

    it("refuses publishing with a blank explanation", async () => {
      const message = await refused(() =>
        create({ explanation: "", status: "PUBLISHED", publishedAt: new Date() }),
      );
      expect(message).toMatch(/AptitudeQuestion_explanation_published/);
    });

    it("refuses publishing with a 20-character explanation", async () => {
      // "Use the formula." is not a worked explanation.
      const message = await refused(() =>
        create({ explanation: "Use the formula xy.", status: "PUBLISHED", publishedAt: new Date() }),
      );
      expect(message).toMatch(/AptitudeQuestion_explanation_published/);
    });

    it("refuses an explanation of whitespace, which would pass a naive length check", async () => {
      const message = await refused(() =>
        create({ explanation: " ".repeat(200), status: "PUBLISHED", publishedAt: new Date() }),
      );
      expect(message).toMatch(/AptitudeQuestion_explanation_published/);
    });

    it("accepts publishing with a real one", async () => {
      const row = await create({ status: "PUBLISHED", publishedAt: new Date() });
      expect(row.id).toBeTruthy();
    });

    it("refuses an explanation past the 8,000-character bound", async () => {
      const message = await refused(() => create({ explanation: "x".repeat(8_001) }));
      expect(message).toMatch(/AptitudeQuestion_explanation_length/);
    });
  });

  // ── The taxonomy ─────────────────────────────────────────────────────

  describe("a topic belongs to its area", () => {
    it("refuses a VERBAL question tagged MENSURATION", async () => {
      // It would silently corrupt every section blueprint and every weakness
      // heatmap, which is why this is a CHECK and not a trigger.
      const message = await refused(() => create({ area: "VERBAL", topic: "MENSURATION" }));
      expect(message).toMatch(/AptitudeQuestion_area_topic_check/);
    });

    it("refuses a QUANTITATIVE question tagged CLOZE", async () => {
      const message = await refused(() => create({ area: "QUANTITATIVE", topic: "CLOZE" }));
      expect(message).toMatch(/AptitudeQuestion_area_topic_check/);
    });

    it("accepts every area with one of its own topics", async () => {
      await create({ area: "QUANTITATIVE", topic: "DATA_INTERPRETATION" });
      await create({ area: "LOGICAL", topic: "SYLLOGISMS" });
      await create({ area: "VERBAL", topic: "CLOZE" });
    });

    it("holds the same rule on a passage", async () => {
      const message = await refused(() => passage({ area: "VERBAL", topic: "PROBABILITY" }));
      expect(message).toMatch(/AptitudePassage_area_topic_check/);
    });
  });

  // ── Answer shapes ────────────────────────────────────────────────────

  describe("each kind's answer shape", () => {
    it("refuses a single-choice question with two correct options", async () => {
      const message = await refused(() => create({ correctOptionIndexes: [0, 1] }));
      expect(message).toMatch(/AptitudeQuestion_single_answer/);
    });

    it("refuses a single-choice question with no correct option", async () => {
      const message = await refused(() => create({ correctOptionIndexes: [] }));
      expect(message).toMatch(/AptitudeQuestion_single_answer/);
    });

    it("refuses a multi-choice question with one correct option", async () => {
      // A mis-authored single-choice: it makes the all-or-nothing rule
      // indistinguishable from single-choice scoring.
      const message = await refused(() => create({ kind: "MULTI_CHOICE", correctOptionIndexes: [1] }));
      expect(message).toMatch(/AptitudeQuestion_multi_answer/);
    });

    it("accepts a multi-choice question with two", async () => {
      const row = await create({ kind: "MULTI_CHOICE", correctOptionIndexes: [0, 2] });
      expect(row.id).toBeTruthy();
    });

    it("refuses more correct options than there are options", async () => {
      const message = await refused(() =>
        create({ kind: "MULTI_CHOICE", options: ["a", "b"], correctOptionIndexes: [0, 1, 2] }),
      );
      // Either bound catches it; both are the same rule stated at two ends.
      expect(message).toMatch(/AptitudeQuestion_(multi_answer|option_index_check)/);
    });

    it("refuses a correct index past the end of the options", async () => {
      const message = await refused(() => create({ correctOptionIndexes: [7] }));
      expect(message).toMatch(/AptitudeQuestion_option_index_check/);
    });

    it("refuses a negative correct index", async () => {
      const message = await refused(() => create({ correctOptionIndexes: [-1] }));
      expect(message).toMatch(/AptitudeQuestion_option_index_check/);
    });

    it("refuses the same option marked correct twice", async () => {
      const message = await refused(() => create({ kind: "MULTI_CHOICE", correctOptionIndexes: [1, 1] }));
      expect(message).toMatch(/AptitudeQuestion_option_index_check/);
    });

    it("refuses a choice question with one option and with nine", async () => {
      expect(await refused(() => create({ options: ["only"] }))).toMatch(/AptitudeQuestion_choice_shape/);
      expect(
        await refused(() =>
          create({ options: Array.from({ length: 9 }, (_, i) => `o${i}`), correctOptionIndexes: [0] }),
        ),
      ).toMatch(/AptitudeQuestion_choice_shape/);
    });

    it("refuses a numeric answer on a choice question", async () => {
      const message = await refused(() => create({ numericAnswer: 25 }));
      expect(message).toMatch(/AptitudeQuestion_choice_shape/);
    });

    it("accepts a well-formed numeric-entry question", async () => {
      const row = await create({
        kind: "NUMERIC_ENTRY",
        options: [],
        correctOptionIndexes: [],
        numericAnswer: 8,
        numericTolerance: "0.01",
        numericUnit: "km/h",
        topic: "AVERAGES_MIXTURES",
      });
      expect(row.id).toBeTruthy();
    });

    it("refuses a numeric-entry question with no answer", async () => {
      const message = await refused(() =>
        create({ kind: "NUMERIC_ENTRY", options: [], correctOptionIndexes: [], numericTolerance: 0 }),
      );
      expect(message).toMatch(/AptitudeQuestion_numeric_shape/);
    });

    it("refuses a numeric-entry question with no tolerance", async () => {
      // Not defaulted to zero in the data: a question whose tolerance nobody
      // set is a question whose author has not decided how exact to be.
      const message = await refused(() =>
        create({ kind: "NUMERIC_ENTRY", options: [], correctOptionIndexes: [], numericAnswer: 8 }),
      );
      expect(message).toMatch(/AptitudeQuestion_numeric_shape/);
    });

    it("refuses a negative tolerance", async () => {
      const message = await refused(() =>
        create({
          kind: "NUMERIC_ENTRY",
          options: [],
          correctOptionIndexes: [],
          numericAnswer: 8,
          numericTolerance: "-0.5",
        }),
      );
      expect(message).toMatch(/AptitudeQuestion_numeric_shape/);
    });

    it("refuses a numeric-entry question carrying options", async () => {
      const message = await refused(() =>
        create({
          kind: "NUMERIC_ENTRY",
          options: ["8", "9"],
          correctOptionIndexes: [],
          numericAnswer: 8,
          numericTolerance: 0,
        }),
      );
      expect(message).toMatch(/AptitudeQuestion_numeric_shape/);
    });
  });

  // ── Passages ─────────────────────────────────────────────────────────

  describe("passages and the questions that belong to them", () => {
    it("accepts a passage of real length", async () => {
      const row = await passage();
      expect(row.id).toBeTruthy();
    });

    it("refuses something shorter than a passage", async () => {
      // Under 80 characters it is a stem, not a passage.
      const message = await refused(() => passage({ body: "Too short to be a passage." }));
      expect(message).toMatch(/AptitudePassage_body_check/);
    });

    it("refuses a passage that is only whitespace padding", async () => {
      const message = await refused(() => passage({ body: `  short  ${" ".repeat(200)}` }));
      expect(message).toMatch(/AptitudePassage_body_check/);
    });

    it("refuses a passage with no stated provenance", async () => {
      const message = await refused(() => passage({ sourceNote: "mine" }));
      expect(message).toMatch(/AptitudePassage_source_note_check/);
    });

    it("refuses a negative word count", async () => {
      const message = await refused(() => passage({ wordCount: -1 }));
      expect(message).toMatch(/AptitudePassage_word_count_check/);
    });

    it("refuses a PASSAGE_GROUPED question with no passage", async () => {
      const message = await refused(() =>
        create({ kind: "PASSAGE_GROUPED", area: "VERBAL", topic: "READING_COMPREHENSION" }),
      );
      expect(message).toMatch(/AptitudeQuestion_passage_kind/);
    });

    it("refuses a SINGLE_CHOICE question that carries one", async () => {
      // The kinds and the passage link are one fact stated twice.
      const psg = await passage();
      const message = await refused(() => create({ passageId: psg.id }));
      expect(message).toMatch(/AptitudeQuestion_passage_kind/);
    });

    it("accepts a PASSAGE_GROUPED question with a passage", async () => {
      const psg = await passage();
      const row = await create({
        kind: "PASSAGE_GROUPED",
        area: "VERBAL",
        topic: "READING_COMPREHENSION",
        passageId: psg.id,
      });
      expect(row.id).toBeTruthy();
    });

    it("refuses a PASSAGE_GROUPED question with two correct options", async () => {
      // It answers exactly as single-choice.
      const psg = await passage();
      const message = await refused(() =>
        create({
          kind: "PASSAGE_GROUPED",
          area: "VERBAL",
          topic: "READING_COMPREHENSION",
          passageId: psg.id,
          correctOptionIndexes: [0, 1],
        }),
      );
      expect(message).toMatch(/AptitudeQuestion_single_answer/);
    });
  });

  // ── Bounds ───────────────────────────────────────────────────────────

  describe("the remaining bounds", () => {
    it("refuses a stem of four characters and one past 4,000", async () => {
      expect(await refused(() => create({ stem: "10%?" }))).toMatch(/AptitudeQuestion_stem_check/);
      expect(await refused(() => create({ stem: "x".repeat(4_001) }))).toMatch(/AptitudeQuestion_stem_check/);
    });

    it("refuses expectedSeconds outside 5…1800", async () => {
      expect(await refused(() => create({ expectedSeconds: 4 }))).toMatch(
        /AptitudeQuestion_expected_seconds_check/,
      );
      expect(await refused(() => create({ expectedSeconds: 1_801 }))).toMatch(
        /AptitudeQuestion_expected_seconds_check/,
      );
    });

    it("refuses a display code that is not APT-#####", async () => {
      expect(await refused(() => create({ displayCode: `PRB-${prefix}0001` }))).toMatch(
        /AptitudeQuestion_display_code_check/,
      );
      expect(await refused(() => create({ displayCode: "APT-1" }))).toMatch(
        /AptitudeQuestion_display_code_check/,
      );
    });

    it("refuses a content hash that is not a sha256", async () => {
      expect(await refused(() => create({ contentHash: "not-a-hash" }))).toMatch(
        /AptitudeQuestion_content_hash_check/,
      );
      expect(await refused(() => create({ contentHash: "A".repeat(64) }))).toMatch(
        /AptitudeQuestion_content_hash_check/,
      );
    });

    it("refuses a PUBLISHED question with no publication date", async () => {
      const message = await refused(() => create({ status: "PUBLISHED" }));
      expect(message).toMatch(/AptitudeQuestion_status_dates_check/);
    });

    it("refuses a RETIRED question with no retirement date", async () => {
      const message = await refused(() => create({ status: "RETIRED" }));
      expect(message).toMatch(/AptitudeQuestion_status_dates_check/);
    });
  });

  // ── A published question's key is frozen ─────────────────────────────

  describe("a published question's key is frozen; its explanation is not", () => {
    async function published() {
      return create({ status: "PUBLISHED", publishedAt: new Date() });
    }

    it("lets a draft be edited freely", async () => {
      const row = await create();
      await db.aptitudeQuestion.update({ where: { id: row.id }, data: { stem: "What is 20% of 250?" } });
      const after = await db.aptitudeQuestion.findUnique({ where: { id: row.id }, select: { stem: true } });
      expect(after?.stem).toBe("What is 20% of 250?");
    });

    it("refuses changing a published question's stem", async () => {
      const row = await published();
      const message = await refused(() =>
        db.aptitudeQuestion.update({ where: { id: row.id }, data: { stem: "A different question entirely?" } }),
      );
      expect(message).toMatch(/is published/);
      expect(message).toMatch(/RETIRED rather than rewritten/);
    });

    it("refuses changing its options, its key, its kind, its area or its topic", async () => {
      for (const data of [
        { options: ["25", "20", "30", "40"] },
        { correctOptionIndexes: [1] },
        { kind: "MULTI_CHOICE" as const, correctOptionIndexes: [0, 1] },
        { area: "LOGICAL" as const, topic: "SERIES" as const },
        { contentHash: hash("different") },
      ]) {
        const row = await published();
        const message = await refused(() => db.aptitudeQuestion.update({ where: { id: row.id }, data }));
        expect(message, JSON.stringify(data)).toMatch(/is published/);
      }
    });

    it("ALLOWS improving the worked explanation", async () => {
      // Students have already been scored on that question, so rewriting its
      // key silently rescores the past — while improving the wording of the
      // worked solution harms nobody.
      const row = await published();
      const better = `${WORKED} A second way to see it: move the decimal point one place left.`;
      await db.aptitudeQuestion.update({ where: { id: row.id }, data: { explanation: better } });
      const after = await db.aptitudeQuestion.findUnique({
        where: { id: row.id },
        select: { explanation: true },
      });
      expect(after?.explanation).toBe(better);
    });

    it("ALLOWS retiring it", async () => {
      const row = await published();
      await db.aptitudeQuestion.update({
        where: { id: row.id },
        data: { status: "RETIRED", retiredAt: new Date() },
      });
      const after = await db.aptitudeQuestion.findUnique({ where: { id: row.id }, select: { status: true } });
      expect(after?.status).toBe("RETIRED");
    });

    it("refuses returning it to DRAFT", async () => {
      const row = await published();
      const message = await refused(() =>
        db.aptitudeQuestion.update({ where: { id: row.id }, data: { status: "DRAFT" } }),
      );
      expect(message).toMatch(/retired, never unpublished/);
    });

    it("refuses DELETING a published or retired question", async () => {
      // A RETIRED question is never deleted: answer rows reference it, and
      // past percentiles must stay honest.
      const row = await published();
      expect(await refused(() => db.aptitudeQuestion.delete({ where: { id: row.id } }))).toMatch(
        /retire it instead of deleting it/,
      );
      await db.aptitudeQuestion.update({
        where: { id: row.id },
        data: { status: "RETIRED", retiredAt: new Date() },
      });
      expect(await refused(() => db.aptitudeQuestion.delete({ where: { id: row.id } }))).toMatch(
        /retire it instead of deleting it/,
      );
    });

    it("lets a draft be deleted", async () => {
      const row = await create();
      await db.aptitudeQuestion.delete({ where: { id: row.id } });
      expect(await db.aptitudeQuestion.findUnique({ where: { id: row.id } })).toBeNull();
    });
  });

  // ── The counters ─────────────────────────────────────────────────────

  describe("the per-question counters", () => {
    it("refuses more answers than servings", async () => {
      // The CHECK is protective only because timesServed moves where the
      // question is SERVED; incrementing both at finalise would make it
      // vacuous and bias the dud-question denominator.
      const row = await create();
      const message = await refused(() =>
        db.aptitudeQuestionStat.create({ data: { questionId: row.id, timesServed: 1, timesAnswered: 2 } }),
      );
      expect(message).toMatch(/AptitudeQuestionStat_counts_check/);
    });

    it("refuses more correct than answered", async () => {
      const row = await create();
      const message = await refused(() =>
        db.aptitudeQuestionStat.create({
          data: { questionId: row.id, timesServed: 5, timesAnswered: 2, timesCorrect: 3 },
        }),
      );
      expect(message).toMatch(/AptitudeQuestionStat_counts_check/);
    });

    it("refuses a negative counter", async () => {
      const row = await create();
      const message = await refused(() =>
        db.aptitudeQuestionStat.create({ data: { questionId: row.id, totalSeconds: -1 } }),
      );
      expect(message).toMatch(/AptitudeQuestionStat_counts_check/);
    });

    it("accepts a consistent set", async () => {
      const row = await create();
      const stat = await db.aptitudeQuestionStat.create({
        data: { questionId: row.id, timesServed: 10, timesAnswered: 8, timesCorrect: 5, totalSeconds: 400 },
      });
      expect(stat.timesCorrect).toBe(5);
    });
  });

  // ── TRUNCATE ─────────────────────────────────────────────────────────

  describe("TRUNCATE", () => {
    it("is refused on both new tables", async () => {
      for (const table of ["AptitudeQuestion", "AptitudePassage"]) {
        const message = await refused(() => db.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`));
        expect(message, table).toMatch(/TRUNCATE/i);
      }
    });
  });
});
