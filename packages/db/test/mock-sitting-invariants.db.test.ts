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
 * The sitting invariants (migration 20261019250200).
 *
 * SPEC §5's second gate for Phase 7, in its own words:
 *
 *   a test asserts `allowBackNavigation: false` is enforced server-side, not
 *   just in the UI.
 *
 * This file is the RAW SQL half of it — the writes go straight at the table,
 * past every server action, because the point of the rule living in the
 * database is that it survives a future edit to the action. The pure half is
 * `packages/shared/test/mock-navigation.test.ts` and the action half is
 * `apps/web/test/aptitude-navigation.test.ts`. None of the three renders
 * anything.
 *
 * Also proved here: the clock, the seed and the paper are written once; a
 * finished sitting never restarts; and a pattern that has been sat is frozen.
 */

const run = randomBytes(3).readUIntBE(0, 3) % 90_000 + 10_000;
const TITLE = RUN_DB_TESTS
  ? "mock sitting invariants (live database)"
  : "mock sitting invariants (set RECX_DB_TESTS=1 to run)";

const WORKED = "Ten percent is one tenth of the number, so dividing 250 by ten gives 25 without the formula.";
const LAYOUT = { v: 1, sections: [] as unknown[] };

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let userId = "";
  let questionId = "";
  let nextCode = 1;
  let nextSlug = 1;

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  /** A pattern with one section, which is all most of these tests need. */
  async function pattern(sectionOver: Record<string, unknown> = {}) {
    const row = await db.mockPattern.create({
      data: {
        slug: `sit-${run}-${nextSlug++}`,
        name: "Sitting fixture",
        funnelLabel: "A sitting-invariant funnel",
        sourceNote: "Written for the sitting invariant suite, 2026.",
        description: "A pattern the sitting invariant suite uses; it models nobody.",
      },
      select: { id: true },
    });
    const section = await db.aptitudeSection.create({
      data: {
        patternId: row.id,
        position: 1,
        key: "quantitative",
        label: "Quantitative aptitude",
        area: "QUANTITATIVE",
        topicMix: [{ topic: "PERCENTAGES", count: 10 }],
        questionCount: 10,
        timeLimitSec: 600,
        ...sectionOver,
      } as never,
      select: { id: true, allowBackNavigation: true },
    });
    return { patternId: row.id, sectionId: section.id, allowBackNavigation: section.allowBackNavigation };
  }

  async function attempt(patternId: string, over: Record<string, unknown> = {}) {
    const startedAt = new Date(Date.now() - 60_000);
    return db.mockAttempt.create({
      data: {
        patternId,
        userId,
        attemptNumber: 1,
        seed: 12_345,
        startedAt,
        expiresAt: new Date(startedAt.getTime() + 3_600_000),
        layout: LAYOUT,
        ...over,
      } as never,
      select: { id: true, status: true, version: true },
    });
  }

  async function sectionState(attemptId: string, sectionId: string, over: Record<string, unknown> = {}) {
    const startedAt = new Date(Date.now() - 30_000);
    return db.mockSectionState.create({
      data: {
        attemptId,
        sectionId,
        position: 1,
        startedAt,
        endsAt: new Date(startedAt.getTime() + 600_000),
        ...over,
      } as never,
      select: { id: true, highWaterIndex: true, submittedAt: true },
    });
  }

  /** Insert an answer by RAW SQL, past every server action. */
  function rawAnswer(args: {
    attemptId: string;
    sectionStateId: string;
    questionId: string;
    position: number;
    selected?: number[];
  }) {
    return db.$executeRawUnsafe(
      `INSERT INTO "MockAttemptAnswer"
         ("id", "attemptId", "sectionStateId", "questionId", "position", "selectedIndexes", "firstSeenAtMs", "answeredAtMs", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6::int[], 0, 100, now(), now())`,
      `ans-${run}-${Math.random().toString(36).slice(2, 10)}`,
      args.attemptId,
      args.sectionStateId,
      args.questionId,
      args.position,
      args.selected ?? [0],
    );
  }

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const user = await db.user.create({
      data: {
        collegeId: `SIT${run}`,
        email: `sit-${run}@example.test`,
        firstName: "A",
        lastName: "Candidate",
        handle: `sit-${run}`,
        role: "STUDENT",
      },
      select: { id: true },
    });
    userId = user.id;

    const question = await db.aptitudeQuestion.create({
      data: {
        displayCode: `APT-${run}${String(nextCode++).padStart(4, "0")}`,
        area: "QUANTITATIVE",
        topic: "PERCENTAGES",
        kind: "SINGLE_CHOICE",
        difficulty: "EASY",
        status: "PUBLISHED",
        publishedAt: new Date(),
        stem: "What is 10% of 250?",
        options: ["25", "20", "30", "35"],
        correctOptionIndexes: [0],
        explanation: WORKED,
        expectedSeconds: 45,
        origin: "FACULTY",
        contentHash: createHash("sha256").update(`sit-${run}`).digest("hex"),
      },
      select: { id: true },
    });
    questionId = question.id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
      const off = [
        ["MockAttempt", "MockAttempt_written_once"],
        ["MockAttemptAnswer", "MockAttemptAnswer_closed_section"],
        ["AptitudeSection", "AptitudeSection_pattern_frozen"],
        ["MockPattern", "MockPattern_scoring_frozen"],
        ["AptitudeQuestion", "AptitudeQuestion_published_immutable"],
      ] as const;
      await db.$transaction([
        ...off.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" DISABLE TRIGGER "${g}"`)),
        raw(`DELETE FROM "public"."MockAttemptAnswer" WHERE "attemptId" IN (SELECT "id" FROM "public"."MockAttempt" WHERE "userId" = $1)`, userId),
        raw(`DELETE FROM "public"."MockSectionState" WHERE "attemptId" IN (SELECT "id" FROM "public"."MockAttempt" WHERE "userId" = $1)`, userId),
        raw(`DELETE FROM "public"."MockAttempt" WHERE "userId" = $1`, userId),
        raw(`DELETE FROM "public"."AptitudeUserTopicStat" WHERE "userId" = $1`, userId),
        raw(`DELETE FROM "public"."AptitudeSection" WHERE "patternId" IN (SELECT "id" FROM "public"."MockPattern" WHERE "slug" LIKE $1)`, `sit-${run}-%`),
        raw(`DELETE FROM "public"."MockPattern" WHERE "slug" LIKE $1`, `sit-${run}-%`),
        raw(`DELETE FROM "public"."AptitudeQuestion" WHERE "id" = $1`, questionId),
        ...off.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" ENABLE TRIGGER "${g}"`)),
        raw(`DELETE FROM "public"."User" WHERE "id" = $1`, userId),
      ]);
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  // ── The gate: allowBackNavigation: false, by raw SQL ──────────────────

  describe("allowBackNavigation: false is enforced in the database", () => {
    it("refuses an answer below the high-water mark", async () => {
      const { patternId, sectionId } = await pattern({ allowBackNavigation: false });
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId, { highWaterIndex: 5 });

      const message = await refused(() =>
        rawAnswer({ attemptId: sitting.id, sectionStateId: state.id, questionId, position: 2 }),
      );
      expect(message).toMatch(/does not allow going back/);
      // And it says where the candidate was told.
      expect(message).toMatch(/cover page before the sitting starts/);
    });

    it("allows the question the candidate is on", async () => {
      const { patternId, sectionId } = await pattern({ allowBackNavigation: false });
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId, { highWaterIndex: 5 });
      await rawAnswer({ attemptId: sitting.id, sectionStateId: state.id, questionId, position: 5 });
      expect(await db.mockAttemptAnswer.count({ where: { attemptId: sitting.id } })).toBe(1);
    });

    it("allows an earlier question when back navigation IS allowed", async () => {
      const { patternId, sectionId } = await pattern({ allowBackNavigation: true });
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId, { highWaterIndex: 5 });
      await rawAnswer({ attemptId: sitting.id, sectionStateId: state.id, questionId, position: 1 });
      expect(await db.mockAttemptAnswer.count({ where: { attemptId: sitting.id } })).toBe(1);
    });

    it("refuses an UPDATE that moves an answer below the mark, not only an insert", async () => {
      // Otherwise the rule is bypassed by writing at the mark and editing.
      const { patternId, sectionId } = await pattern({ allowBackNavigation: false });
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId, { highWaterIndex: 3 });
      await rawAnswer({ attemptId: sitting.id, sectionStateId: state.id, questionId, position: 3 });
      await db.mockSectionState.update({ where: { id: state.id }, data: { highWaterIndex: 6 } });

      const message = await refused(() =>
        db.$executeRawUnsafe(
          `UPDATE "MockAttemptAnswer" SET "position" = 1 WHERE "attemptId" = $1`,
          sitting.id,
        ),
      );
      expect(message).toMatch(/does not allow going back/);
    });

    it("refuses any write to a submitted section, however back navigation is set", async () => {
      // docs/OPEN-QUESTIONS.md: back navigation is WITHIN the current section.
      // A section timer a candidate can re-enter is not a section timer.
      for (const allowBackNavigation of [true, false]) {
        const { patternId, sectionId } = await pattern({ allowBackNavigation });
        const sitting = await attempt(patternId);
        const state = await sectionState(sitting.id, sectionId, { submittedAt: new Date() });
        const message = await refused(() =>
          rawAnswer({ attemptId: sitting.id, sectionStateId: state.id, questionId, position: 0 }),
        );
        expect(message, String(allowBackNavigation)).toMatch(/section has closed/);
        expect(message).toMatch(/saved and scored/);
      }
    });

    it("refuses EDITING an answer in a submitted section", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId);
      await rawAnswer({ attemptId: sitting.id, sectionStateId: state.id, questionId, position: 0 });
      await db.mockSectionState.update({ where: { id: state.id }, data: { submittedAt: new Date() } });

      const message = await refused(() =>
        db.$executeRawUnsafe(
          `UPDATE "MockAttemptAnswer" SET "selectedIndexes" = ARRAY[2] WHERE "attemptId" = $1`,
          sitting.id,
        ),
      );
      expect(message).toMatch(/section has closed/);
    });

    it("lets finalise grade BEFORE the section closes, which is the order it must use", async () => {
      // The trigger gates on submittedAt, not on the section's own clock, and
      // that constrains finalise: grading writes isCorrect and awarded onto
      // these rows, so it has to grade first and close afterwards. A
      // now() > endsAt clause here would refuse the grading writes of every
      // section that closed on its own clock.
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const startedAt = new Date(Date.now() - 1_200_000);
      const state = await sectionState(sitting.id, sectionId, {
        startedAt,
        endsAt: new Date(startedAt.getTime() + 600_000), // already past
      });
      await rawAnswer({ attemptId: sitting.id, sectionStateId: state.id, questionId, position: 0 });

      // Grade: allowed, even though the section's clock has run out.
      await db.mockAttemptAnswer.updateMany({
        where: { attemptId: sitting.id },
        data: { isCorrect: true, awarded: 1 },
      });
      // Then close it.
      await db.mockSectionState.update({ where: { id: state.id }, data: { submittedAt: new Date() } });
      // And now nothing more may be written.
      expect(
        await refused(() =>
          db.mockAttemptAnswer.updateMany({ where: { attemptId: sitting.id }, data: { awarded: 0 } }),
        ),
      ).toMatch(/section has closed/);
    });

    it("refuses an answer pointing at a section state that does not exist", async () => {
      const { patternId } = await pattern();
      const sitting = await attempt(patternId);
      const message = await refused(() =>
        rawAnswer({ attemptId: sitting.id, sectionStateId: "nope", questionId, position: 0 }),
      );
      // The foreign key or the trigger; either is a refusal.
      expect(message).toMatch(/section state that does not exist|foreign key|violates/i);
    });
  });

  // ── The high-water mark only rises ───────────────────────────────────

  describe("the high-water mark", () => {
    it("rises", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId, { highWaterIndex: 2 });
      await db.mockSectionState.update({ where: { id: state.id }, data: { highWaterIndex: 7 } });
      const after = await db.mockSectionState.findUniqueOrThrow({
        where: { id: state.id },
        select: { highWaterIndex: true },
      });
      expect(after.highWaterIndex).toBe(7);
    });

    it("never falls, even by raw SQL", async () => {
      // This is the column the client must not be able to move backwards.
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId, { highWaterIndex: 7 });
      const message = await refused(() =>
        db.$executeRawUnsafe(`UPDATE "MockSectionState" SET "highWaterIndex" = 1 WHERE "id" = $1`, state.id),
      );
      expect(message).toMatch(/highWaterIndex only rises/);
    });
  });

  // ── The section clock ────────────────────────────────────────────────

  describe("a section's clock is written once", () => {
    it("can be set on entry", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await db.mockSectionState.create({
        data: { attemptId: sitting.id, sectionId, position: 1 },
        select: { id: true },
      });
      const startedAt = new Date();
      await db.mockSectionState.update({
        where: { id: state.id },
        data: { startedAt, endsAt: new Date(startedAt.getTime() + 600_000) },
      });
    });

    it("cannot be moved afterwards", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId);
      expect(
        await refused(() =>
          db.mockSectionState.update({ where: { id: state.id }, data: { endsAt: new Date(Date.now() + 9_000_000) } }),
        ),
      ).toMatch(/endsAt is written once/);
      expect(
        await refused(() =>
          db.mockSectionState.update({ where: { id: state.id }, data: { startedAt: new Date() } }),
        ),
      ).toMatch(/startedAt is written once/);
    });

    it("cannot be re-submitted or re-opened", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId, { submittedAt: new Date() });
      expect(
        await refused(() => db.mockSectionState.update({ where: { id: state.id }, data: { submittedAt: null } })),
      ).toMatch(/cannot be re-submitted or re-opened/);
    });

    it("refuses a section that closes before it opens", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      expect(
        await refused(() =>
          db.mockSectionState.create({
            data: { attemptId: sitting.id, sectionId, position: 1, submittedAt: new Date() },
          }),
        ),
      ).toMatch(/MockSectionState_started_check/);
    });

    it("refuses an endsAt before its startedAt", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const startedAt = new Date();
      expect(
        await refused(() =>
          db.mockSectionState.create({
            data: {
              attemptId: sitting.id,
              sectionId,
              position: 1,
              startedAt,
              endsAt: new Date(startedAt.getTime() - 1_000),
            },
          }),
        ),
      ).toMatch(/MockSectionState_window_check/);
    });
  });

  // ── The attempt's clock, seed and paper ──────────────────────────────

  describe("the sitting's clock, seed and paper are written once", () => {
    it("refuses moving the deadline", async () => {
      // Extra time is an accommodation applied before the sitting starts,
      // never a later edit.
      const { patternId } = await pattern();
      const sitting = await attempt(patternId);
      const message = await refused(() =>
        db.mockAttempt.update({ where: { id: sitting.id }, data: { expiresAt: new Date(Date.now() + 9_000_000) } }),
      );
      expect(message).toMatch(/written once/);
      expect(message).toMatch(/Extra time is an accommodation/);
    });

    it("refuses re-rolling the seed or the paper", async () => {
      const { patternId } = await pattern();
      for (const data of [{ seed: 999 }, { layout: { v: 1, sections: [{}] } }]) {
        const sitting = await attempt(patternId, { attemptNumber: data.seed ? 2 : 3 });
        expect(await refused(() => db.mockAttempt.update({ where: { id: sitting.id }, data })), JSON.stringify(data)).toMatch(
          /written once/,
        );
      }
    });

    it("refuses moving the sitting to another candidate or another pattern", async () => {
      const { patternId } = await pattern();
      const other = await pattern();
      const sitting = await attempt(patternId);
      expect(
        await refused(() => db.mockAttempt.update({ where: { id: sitting.id }, data: { patternId: other.patternId } })),
      ).toMatch(/written once/);
    });

    it("lets the result and the pointer be written", async () => {
      const { patternId } = await pattern();
      const sitting = await attempt(patternId);
      await db.mockAttempt.update({
        where: { id: sitting.id },
        data: {
          status: "SUBMITTED",
          finalizedAt: new Date(),
          passedOverall: false,
          totalRaw: 4,
          totalMax: 10,
          percent: 40,
          sectionsPassed: 0,
          version: 1,
        },
      });
      const after = await db.mockAttempt.findUniqueOrThrow({ where: { id: sitting.id }, select: { percent: true } });
      expect(after.percent).toBe(40);
    });

    it("refuses sending the section pointer backwards", async () => {
      const { patternId } = await pattern();
      const sitting = await attempt(patternId, { currentSectionPosition: 2 });
      expect(
        await refused(() =>
          db.mockAttempt.update({ where: { id: sitting.id }, data: { currentSectionPosition: 1 } }),
        ),
      ).toMatch(/only moves forward/);
    });
  });

  // ── The status machine ───────────────────────────────────────────────

  describe("a finished sitting never restarts", () => {
    it("refuses every transition out of a finished state", async () => {
      // Its answers have been scored and its XP written, and an XpEvent is
      // permanent.
      const { patternId } = await pattern();
      let n = 1;
      for (const finished of ["SUBMITTED", "AUTO_SUBMITTED"] as const) {
        const sitting = await attempt(patternId, {
          attemptNumber: n++,
          status: finished,
          finalizedAt: new Date(),
          passedOverall: true,
        });
        expect(
          await refused(() => db.mockAttempt.update({ where: { id: sitting.id }, data: { status: "IN_PROGRESS" } })),
          finished,
        ).toMatch(/never restarts/);
      }
      const abandoned = await attempt(patternId, { attemptNumber: n++, status: "ABANDONED" });
      expect(
        await refused(() => db.mockAttempt.update({ where: { id: abandoned.id }, data: { status: "IN_PROGRESS" } })),
      ).toMatch(/never restarts/);
    });

    it("refuses deleting a scored sitting", async () => {
      const { patternId } = await pattern();
      const sitting = await attempt(patternId, { status: "SUBMITTED", finalizedAt: new Date(), passedOverall: true });
      expect(await refused(() => db.mockAttempt.delete({ where: { id: sitting.id } }))).toMatch(
        /result and its XP are permanent/,
      );
    });

    it("lets an unfinished sitting be deleted", async () => {
      const { patternId } = await pattern();
      const sitting = await attempt(patternId);
      await db.mockAttempt.delete({ where: { id: sitting.id } });
      expect(await db.mockAttempt.findUnique({ where: { id: sitting.id } })).toBeNull();
    });

    it("refuses a scored sitting with no result, and a result with no score", async () => {
      // A status with no result behind it is how a total stops adding up on
      // the one page a candidate reads.
      const { patternId } = await pattern();
      expect(await refused(() => attempt(patternId, { status: "SUBMITTED" }))).toMatch(
        /MockAttempt_finalised_check/,
      );
      expect(
        await refused(() => attempt(patternId, { finalizedAt: new Date(), passedOverall: true })),
      ).toMatch(/MockAttempt_finalised_check/);
    });
  });

  // ── Answer shape ─────────────────────────────────────────────────────

  describe("an answer row", () => {
    it("carries one response shape, not two", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId);
      const message = await refused(() =>
        db.mockAttemptAnswer.create({
          data: {
            attemptId: sitting.id,
            sectionStateId: state.id,
            questionId,
            position: 0,
            selectedIndexes: [1],
            numericValue: "8",
            firstSeenAtMs: 0,
          },
        }),
      );
      expect(message).toMatch(/MockAttemptAnswer_shape_check/);
    });

    it("may be blank, which is a legitimate and never-penalised state", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId);
      const row = await db.mockAttemptAnswer.create({
        data: { attemptId: sitting.id, sectionStateId: state.id, questionId, position: 0, firstSeenAtMs: 0 },
        select: { id: true, selectedIndexes: true },
      });
      expect(row.selectedIndexes).toEqual([]);
    });

    it("refuses penalising a blank", async () => {
      // The line in the phase most likely to be written wrongly, stated in
      // the data as well as in gradeAnswer().
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId);
      const message = await refused(() =>
        db.mockAttemptAnswer.create({
          data: {
            attemptId: sitting.id,
            sectionStateId: state.id,
            questionId,
            position: 0,
            firstSeenAtMs: 0,
            isCorrect: false,
            awarded: -0.25,
          },
        }),
      );
      expect(message).toMatch(/MockAttemptAnswer_blank_not_penalised/);
    });

    it("accepts a zero award on a blank", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId);
      const row = await db.mockAttemptAnswer.create({
        data: {
          attemptId: sitting.id,
          sectionStateId: state.id,
          questionId,
          position: 0,
          firstSeenAtMs: 0,
          isCorrect: false,
          awarded: 0,
        },
        select: { awarded: true },
      });
      expect(row.awarded).toBe(0);
    });

    it("refuses a half-graded row", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId);
      const message = await refused(() =>
        db.mockAttemptAnswer.create({
          data: {
            attemptId: sitting.id,
            sectionStateId: state.id,
            questionId,
            position: 0,
            selectedIndexes: [0],
            firstSeenAtMs: 0,
            isCorrect: true,
          },
        }),
      );
      expect(message).toMatch(/MockAttemptAnswer_graded_check/);
    });

    it("refuses an answer timed before it was seen", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId);
      const message = await refused(() =>
        db.mockAttemptAnswer.create({
          data: {
            attemptId: sitting.id,
            sectionStateId: state.id,
            questionId,
            position: 0,
            selectedIndexes: [0],
            firstSeenAtMs: 1_000,
            answeredAtMs: 500,
          },
        }),
      );
      expect(message).toMatch(/MockAttemptAnswer_timing_check/);
    });

    it("refuses the same question twice in one sitting", async () => {
      const { patternId, sectionId } = await pattern();
      const sitting = await attempt(patternId);
      const state = await sectionState(sitting.id, sectionId);
      await rawAnswer({ attemptId: sitting.id, sectionStateId: state.id, questionId, position: 0 });
      expect(
        await refused(() => rawAnswer({ attemptId: sitting.id, sectionStateId: state.id, questionId, position: 1 })),
      ).toMatch(/questionId/);
    });
  });

  // ── A sat pattern is frozen ──────────────────────────────────────────

  describe("a pattern that has been sat is frozen", () => {
    async function satPattern() {
      const made = await pattern();
      await attempt(made.patternId, { status: "SUBMITTED", finalizedAt: new Date(), passedOverall: true });
      return made;
    }

    it("refuses editing one of its sections", async () => {
      const { sectionId } = await satPattern();
      const message = await refused(() =>
        db.aptitudeSection.update({ where: { id: sectionId }, data: { cutoffPercent: 80 } }),
      );
      expect(message).toMatch(/has been sat 1 times and is frozen/);
      expect(message).toMatch(/Copy it to a new pattern instead/);
    });

    it("refuses adding or deleting a section", async () => {
      const { patternId, sectionId } = await satPattern();
      expect(
        await refused(() =>
          db.aptitudeSection.create({
            data: {
              patternId,
              position: 2,
              key: "logical",
              label: "Logical reasoning",
              area: "LOGICAL",
              topicMix: [{ topic: "SERIES", count: 5 }],
              questionCount: 5,
              timeLimitSec: 300,
            } as never,
          }),
        ),
      ).toMatch(/frozen/);
      expect(await refused(() => db.aptitudeSection.delete({ where: { id: sectionId } }))).toMatch(/frozen/);
    });

    it("refuses changing its slug, its provenance or its company claim", async () => {
      for (const data of [
        { slug: `sit-${run}-moved` },
        { sourceNote: "Something else entirely, written later." },
        { modelledOnCompany: true },
      ]) {
        const { patternId } = await satPattern();
        expect(await refused(() => db.mockPattern.update({ where: { id: patternId }, data })), JSON.stringify(data)).toMatch(
          /frozen/,
        );
      }
    });

    it("still allows the maintained totals and statistics to be written", async () => {
      // Or the nightly pattern-stats job and the totals trigger could never
      // run again on a pattern anyone had sat.
      const { patternId } = await satPattern();
      await db.mockPattern.update({
        where: { id: patternId },
        data: { finalizedAttemptCount: 42, medianPercent: 51.5, status: "ARCHIVED" },
      });
      const after = await db.mockPattern.findUniqueOrThrow({
        where: { id: patternId },
        select: { medianPercent: true, status: true },
      });
      expect(after.medianPercent).toBe(51.5);
      expect(after.status).toBe("ARCHIVED");
    });

    it("leaves a pattern nobody has finished editable", async () => {
      // An in-progress sitting does not freeze a pattern: nothing has been
      // scored, so nothing can be rescored.
      const made = await pattern();
      await attempt(made.patternId);
      await db.aptitudeSection.update({ where: { id: made.sectionId }, data: { cutoffPercent: 70 } });
      const after = await db.aptitudeSection.findUniqueOrThrow({
        where: { id: made.sectionId },
        select: { cutoffPercent: true },
      });
      expect(after.cutoffPercent).toBe(70);
    });
  });

  // ── The topic roll-up ────────────────────────────────────────────────

  describe("the per-topic roll-up", () => {
    it("refuses more correct than attempted", async () => {
      const message = await refused(() =>
        db.aptitudeUserTopicStat.create({ data: { userId, topic: "PERCENTAGES", attempted: 1, correct: 2 } }),
      );
      expect(message).toMatch(/AptitudeUserTopicStat_counts_check/);
    });

    it("refuses a negative counter", async () => {
      const message = await refused(() =>
        db.aptitudeUserTopicStat.create({ data: { userId, topic: "PROBABILITY", totalSeconds: -1 } }),
      );
      expect(message).toMatch(/AptitudeUserTopicStat_counts_check/);
    });

    it("accepts a consistent row and upserts onto it", async () => {
      await db.aptitudeUserTopicStat.upsert({
        where: { userId_topic: { userId, topic: "SERIES" } },
        create: { userId, topic: "SERIES", attempted: 3, correct: 2, totalSeconds: 90 },
        update: { attempted: { increment: 2 }, correct: { increment: 1 } },
      });
      await db.aptitudeUserTopicStat.upsert({
        where: { userId_topic: { userId, topic: "SERIES" } },
        create: { userId, topic: "SERIES", attempted: 3, correct: 2, totalSeconds: 90 },
        update: { attempted: { increment: 2 }, correct: { increment: 1 } },
      });
      const row = await db.aptitudeUserTopicStat.findUniqueOrThrow({
        where: { userId_topic: { userId, topic: "SERIES" } },
      });
      expect(row.attempted).toBe(5);
      expect(row.correct).toBe(3);
    });
  });

  // ── TRUNCATE ─────────────────────────────────────────────────────────

  describe("TRUNCATE", () => {
    it("is refused on all three new tables", async () => {
      for (const table of ["MockAttempt", "MockSectionState", "MockAttemptAnswer"]) {
        const message = await refused(() => db.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`));
        expect(message, table).toMatch(/TRUNCATE/i);
      }
    });
  });
});
