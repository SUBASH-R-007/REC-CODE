import { randomBytes } from "node:crypto";
import { MOCK_PATTERN_SEEDS, patternTotals } from "@recx/shared";
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
 * Mock patterns and their sections (migration 20261019250100).
 *
 * Two things are proved here that the pure arithmetic in `@recx/shared`
 * cannot prove on its own:
 *
 *   1. `patternTotals()` and `recx_sync_pattern_totals` agree — on all six
 *      seeded patterns, which is the gate item. One definition, two
 *      enforcements, so the denormalised totals the listing page renders
 *      cannot drift from the sections they summarise.
 *   2. A section's blueprint SUMS to its question count in the data. A
 *      blueprint that does not sum is a short paper for a candidate, and
 *      `buildMockLayout()` draws straight from it.
 */

const tag = `mp-${randomBytes(4).toString("hex")}`;
const TITLE = RUN_DB_TESTS
  ? "mock pattern invariants (live database)"
  : "mock pattern invariants (set RECX_DB_TESTS=1 to run)";

const DESCRIPTION = "A pattern used by the invariant suite; it models nobody and is deleted afterwards.";
const SOURCE_NOTE = "Written for the invariant suite, 2026.";

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let nextSlug = 1;

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  const pattern = (over: Record<string, unknown> = {}) =>
    db.mockPattern.create({
      data: {
        slug: `${tag}-${nextSlug++}`,
        name: "Invariant pattern",
        funnelLabel: "An invariant-suite funnel",
        sourceNote: SOURCE_NOTE,
        description: DESCRIPTION,
        ...over,
      } as never,
      select: { id: true, totalQuestions: true, totalTimeSec: true, status: true },
    });

  const section = (patternId: string, over: Record<string, unknown> = {}) =>
    db.aptitudeSection.create({
      data: {
        patternId,
        position: 1,
        key: "quantitative",
        label: "Quantitative aptitude",
        area: "QUANTITATIVE",
        topicMix: [
          { topic: "PERCENTAGES", count: 6 },
          { topic: "PROFIT_LOSS", count: 4 },
        ],
        questionCount: 10,
        timeLimitSec: 600,
        ...over,
      } as never,
      select: { id: true },
    });

  const totalsOf = (id: string) =>
    db.mockPattern.findUniqueOrThrow({
      where: { id },
      select: { totalQuestions: true, totalTimeSec: true },
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
      // A published pattern cannot lose its last section, so the status comes
      // down first and the cascade takes the sections with the pattern.
      await db.mockPattern.updateMany({ where: { slug: { startsWith: tag } }, data: { status: "DRAFT" } });
      await db.mockPattern.deleteMany({ where: { slug: { startsWith: tag } } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  // ── The gate item ────────────────────────────────────────────────────

  describe("patternTotals() and recx_sync_pattern_totals agree", () => {
    it.each(MOCK_PATTERN_SEEDS.map((p) => [p.slug, p] as const))(
      "%s: the trigger computes exactly what the pure function does",
      async (slug, seed) => {
        const row = await pattern({ name: seed.name, funnelLabel: seed.funnelLabel, description: seed.description });
        for (const s of seed.sections) {
          await section(row.id, {
            position: s.position,
            key: s.key,
            label: s.label,
            area: s.area,
            topicMix: s.topicMix,
            questionCount: s.questionCount,
            timeLimitSec: s.timeLimitSec,
            cutoffPercent: s.cutoffPercent,
            marksPerCorrect: s.marksPerCorrect,
            negativeMarkFraction: s.negativeMarkFraction,
            allowBackNavigation: s.allowBackNavigation,
          });
        }
        const expected = patternTotals(seed);
        expect(await totalsOf(row.id), slug).toEqual(expected);
      },
    );

    it("starts a pattern with no sections at zero", async () => {
      const row = await pattern();
      expect(row.totalQuestions).toBe(0);
      expect(row.totalTimeSec).toBe(0);
    });

    it("follows an added section, an edited one and a deleted one", async () => {
      const row = await pattern();
      const first = await section(row.id);
      expect(await totalsOf(row.id)).toEqual({ totalQuestions: 10, totalTimeSec: 600 });

      await section(row.id, {
        position: 2,
        key: "logical",
        label: "Logical reasoning",
        area: "LOGICAL",
        topicMix: [{ topic: "SERIES", count: 5 }],
        questionCount: 5,
        timeLimitSec: 300,
      });
      expect(await totalsOf(row.id)).toEqual({ totalQuestions: 15, totalTimeSec: 900 });

      await db.aptitudeSection.update({
        where: { id: first.id },
        data: { questionCount: 12, timeLimitSec: 900, topicMix: [{ topic: "PERCENTAGES", count: 12 }] },
      });
      expect(await totalsOf(row.id)).toEqual({ totalQuestions: 17, totalTimeSec: 1_200 });

      await db.aptitudeSection.delete({ where: { id: first.id } });
      expect(await totalsOf(row.id)).toEqual({ totalQuestions: 5, totalTimeSec: 300 });
    });

    it("updates BOTH patterns when a section moves between them", async () => {
      const from = await pattern();
      const to = await pattern();
      const moved = await section(from.id);
      expect(await totalsOf(from.id)).toEqual({ totalQuestions: 10, totalTimeSec: 600 });

      await db.aptitudeSection.update({ where: { id: moved.id }, data: { patternId: to.id } });
      // The source would otherwise keep a total for a section it no longer
      // has, which is exactly the drift the trigger exists to prevent.
      expect(await totalsOf(from.id)).toEqual({ totalQuestions: 0, totalTimeSec: 0 });
      expect(await totalsOf(to.id)).toEqual({ totalQuestions: 10, totalTimeSec: 600 });
    });

    it("returns to zero when the last section goes", async () => {
      const row = await pattern();
      const only = await section(row.id);
      await db.aptitudeSection.delete({ where: { id: only.id } });
      expect(await totalsOf(row.id)).toEqual({ totalQuestions: 0, totalTimeSec: 0 });
    });
  });

  // ── A published pattern has a paper behind it ────────────────────────

  describe("a published pattern has a paper behind it", () => {
    it("refuses publishing a pattern with no sections", async () => {
      const row = await pattern();
      const message = await refused(() =>
        db.mockPattern.update({ where: { id: row.id }, data: { status: "PUBLISHED" } }),
      );
      expect(message).toMatch(/MockPattern_published_has_paper/);
    });

    it("accepts publishing once it has one", async () => {
      const row = await pattern();
      await section(row.id);
      const after = await db.mockPattern.update({
        where: { id: row.id },
        data: { status: "PUBLISHED" },
        select: { status: true, totalQuestions: true },
      });
      expect(after.status).toBe("PUBLISHED");
      expect(after.totalQuestions).toBe(10);
    });

    it("refuses deleting the last section of a published pattern", async () => {
      // The write that would otherwise turn a live pattern a student can open
      // into an empty one.
      const row = await pattern();
      const only = await section(row.id);
      await db.mockPattern.update({ where: { id: row.id }, data: { status: "PUBLISHED" } });
      const message = await refused(() => db.aptitudeSection.delete({ where: { id: only.id } }));
      expect(message).toMatch(/MockPattern_published_has_paper/);
    });

    it("allows deleting a section a published pattern can spare", async () => {
      const row = await pattern();
      await section(row.id);
      const second = await section(row.id, {
        position: 2,
        key: "logical",
        label: "Logical reasoning",
        area: "LOGICAL",
        topicMix: [{ topic: "SERIES", count: 5 }],
        questionCount: 5,
        timeLimitSec: 300,
      });
      await db.mockPattern.update({ where: { id: row.id }, data: { status: "PUBLISHED" } });
      await db.aptitudeSection.delete({ where: { id: second.id } });
      expect(await totalsOf(row.id)).toEqual({ totalQuestions: 10, totalTimeSec: 600 });
    });
  });

  // ── The blueprint ────────────────────────────────────────────────────

  describe("a section's blueprint", () => {
    it("refuses a blueprint that draws fewer questions than the section is long", async () => {
      const row = await pattern();
      const message = await refused(() => section(row.id, { questionCount: 12 }));
      expect(message).toMatch(/AptitudeSection_topic_mix_check/);
    });

    it("refuses a blueprint that draws more", async () => {
      const row = await pattern();
      const message = await refused(() => section(row.id, { questionCount: 8 }));
      expect(message).toMatch(/AptitudeSection_topic_mix_check/);
    });

    it("refuses the same topic on two lines", async () => {
      const row = await pattern();
      const message = await refused(() =>
        section(row.id, {
          topicMix: [
            { topic: "PERCENTAGES", count: 5 },
            { topic: "PERCENTAGES", count: 5 },
          ],
        }),
      );
      expect(message).toMatch(/AptitudeSection_topic_mix_check/);
    });

    it("refuses an empty blueprint", async () => {
      const row = await pattern();
      expect(await refused(() => section(row.id, { topicMix: [] }))).toMatch(/AptitudeSection_topic_mix_check/);
    });

    it("refuses a blueprint that is not a list of {topic, count}", async () => {
      // The function is total rather than raising, because an error from
      // inside a CHECK is an error an author cannot read.
      const row = await pattern();
      for (const topicMix of [
        { topic: "PERCENTAGES", count: 10 },
        ["PERCENTAGES"],
        [{ topic: "PERCENTAGES" }],
        [{ topic: "PERCENTAGES", count: "ten" }],
        [{ topic: 7, count: 10 }],
        [{ topic: "PERCENTAGES", count: 2.5 }],
        [{ topic: "PERCENTAGES", count: 0 }],
        [{ topic: "PERCENTAGES", count: -10 }],
        "PERCENTAGES",
        42,
      ]) {
        let message = "";
        try {
          await section(row.id, { topicMix });
          throw new Error(`accepted a malformed blueprint: ${JSON.stringify(topicMix)}`);
        } catch (error) {
          message = String((error as Error).message);
        }
        expect(message, JSON.stringify(topicMix)).toMatch(/AptitudeSection_topic_mix_check/);
      }
    });

    it("accepts a blueprint of one line and of many", async () => {
      const row = await pattern();
      await section(row.id, { topicMix: [{ topic: "PERCENTAGES", count: 10 }] });
      await section(row.id, {
        position: 2,
        key: "mixed",
        label: "Mixed",
        area: null,
        questionCount: 6,
        timeLimitSec: 300,
        topicMix: [
          { topic: "PERCENTAGES", count: 2 },
          { topic: "SERIES", count: 2 },
          { topic: "CLOZE", count: 2 },
        ],
      });
      expect(await totalsOf(row.id)).toEqual({ totalQuestions: 16, totalTimeSec: 900 });
    });
  });

  // ── Scoring bounds ───────────────────────────────────────────────────

  describe("a section's scoring bounds", () => {
    it("refuses a negative-mark fraction above one", async () => {
      // The penalty is a FRACTION of the question's marks: a 2-mark penalty on
      // a 1-mark question makes a mock harsher than the funnel it models.
      const row = await pattern();
      expect(await refused(() => section(row.id, { negativeMarkFraction: 1.25 }))).toMatch(
        /AptitudeSection_negative_check/,
      );
      expect(await refused(() => section(row.id, { negativeMarkFraction: -0.25 }))).toMatch(
        /AptitudeSection_negative_check/,
      );
    });

    it("accepts a fraction of exactly one", async () => {
      const row = await pattern();
      const made = await section(row.id, { negativeMarkFraction: 1 });
      expect(made.id).toBeTruthy();
    });

    it("refuses a cutoff outside 0…100 and accepts both ends", async () => {
      const row = await pattern();
      expect(await refused(() => section(row.id, { cutoffPercent: 100.5 }))).toMatch(
        /AptitudeSection_cutoff_check/,
      );
      expect(await refused(() => section(row.id, { cutoffPercent: -1 }))).toMatch(/AptitudeSection_cutoff_check/);
      // Zero is how "no cutoff" is said.
      await section(row.id, { cutoffPercent: 0 });
      await section(row.id, { position: 2, key: "second", label: "Second", cutoffPercent: 100 });
    });

    it("refuses zero or negative marks per correct answer", async () => {
      const row = await pattern();
      expect(await refused(() => section(row.id, { marksPerCorrect: 0 }))).toMatch(/AptitudeSection_marks_check/);
    });

    it("refuses a section where the timer is the test", async () => {
      // Fewer than twenty seconds a question.
      const row = await pattern();
      const message = await refused(() =>
        section(row.id, { questionCount: 40, timeLimitSec: 600, topicMix: [{ topic: "PERCENTAGES", count: 40 }] }),
      );
      expect(message).toMatch(/AptitudeSection_pace_check/);
    });

    it("refuses a section shorter than a minute or longer than two hours", async () => {
      const row = await pattern();
      expect(
        await refused(() =>
          section(row.id, { timeLimitSec: 59, questionCount: 1, topicMix: [{ topic: "PERCENTAGES", count: 1 }] }),
        ),
      ).toMatch(/AptitudeSection_time_check/);
      expect(await refused(() => section(row.id, { timeLimitSec: 7_201 }))).toMatch(/AptitudeSection_time_check/);
    });

    it("refuses a position outside 1…8", async () => {
      const row = await pattern();
      expect(await refused(() => section(row.id, { position: 0 }))).toMatch(/AptitudeSection_position_check/);
      expect(await refused(() => section(row.id, { position: 9 }))).toMatch(/AptitudeSection_position_check/);
    });

    it("refuses a key that is not a slug", async () => {
      const row = await pattern();
      expect(await refused(() => section(row.id, { key: "Quantitative Aptitude" }))).toMatch(
        /AptitudeSection_key_check/,
      );
    });
  });

  // ── Uniqueness ───────────────────────────────────────────────────────

  describe("within one pattern", () => {
    it("refuses two sections at the same position, with the same key or the same label", async () => {
      const row = await pattern();
      await section(row.id);
      expect(await refused(() => section(row.id, { key: "other", label: "Other" }))).toMatch(/position/);
      expect(await refused(() => section(row.id, { position: 2, label: "Other" }))).toMatch(/key/);
      expect(await refused(() => section(row.id, { position: 2, key: "other" }))).toMatch(/label/);
    });

    it("allows the same key in a different pattern", async () => {
      const a = await pattern();
      const b = await pattern();
      await section(a.id);
      const made = await section(b.id);
      expect(made.id).toBeTruthy();
    });
  });

  // ── The pattern's own fields ─────────────────────────────────────────

  describe("the pattern's own fields", () => {
    it("refuses a slug that is not lowercase-hyphenated", async () => {
      expect(await refused(() => pattern({ slug: "TCS NQT" }))).toMatch(/MockPattern_slug_check/);
      expect(await refused(() => pattern({ slug: "ab" }))).toMatch(/MockPattern_slug_check/);
    });

    it("refuses a pattern with no stated provenance", async () => {
      expect(await refused(() => pattern({ sourceNote: "mine" }))).toMatch(/MockPattern_source_note_check/);
    });

    it("refuses a description too short to tell a student anything", async () => {
      expect(await refused(() => pattern({ description: "A mock." }))).toMatch(/MockPattern_description_check/);
    });

    it("refuses a median percent outside 0…100", async () => {
      expect(await refused(() => pattern({ medianPercent: 101 }))).toMatch(/MockPattern_totals_check/);
    });

    it("refuses a negative finalised count", async () => {
      expect(await refused(() => pattern({ finalizedAttemptCount: -1 }))).toMatch(/MockPattern_totals_check/);
    });

    it("defaults modelledOnCompany to false, so a claim has to be made explicitly", async () => {
      const row = await db.mockPattern.findUniqueOrThrow({
        where: { id: (await pattern()).id },
        select: { modelledOnCompany: true },
      });
      expect(row.modelledOnCompany).toBe(false);
    });
  });

  // ── TRUNCATE ─────────────────────────────────────────────────────────

  describe("TRUNCATE", () => {
    it("is refused on both new tables", async () => {
      for (const table of ["MockPattern", "AptitudeSection"]) {
        const message = await refused(() => db.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`));
        expect(message, table).toMatch(/TRUNCATE/i);
      }
    });
  });
});
