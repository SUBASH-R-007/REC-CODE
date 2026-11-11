import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, disabledTriggers, openTestDb, RUN_DB_TESTS, testDatabaseName, type TestDb } from "./support/test-db";

/**
 * The spaced-revision card's invariants (migration 20261030150000).
 *
 * A card's columns are the only explanation a student ever gets for why a
 * problem is in front of them today — "due 3 days ago, on the 7-day step,
 * and you have had to relearn it twice". Every CHECK here exists because
 * the corresponding bad row would turn that sentence into a lie that no
 * code path would notice: a rung off the end of the ladder, a negative
 * count, a card marked learned without ever having been reviewed.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS ? "revision card invariants (live database)" : "revision card invariants (set RECX_DB_TESTS=1 to run)";

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let userId = "";
  let problemId = "";
  let nextProblem = 0;

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  /** A fresh problem per card: the primary key is (userId, problemId). */
  async function freshProblem(): Promise<string> {
    nextProblem += 1;
    const problem = await db.problem.create({
      data: {
        slug: `revision-${run}-${nextProblem}`,
        displayCode: `REV-${run}-${nextProblem}`,
        title: "A problem to come back to",
        difficulty: "EASY",
      },
      select: { id: true },
    });
    return problem.id;
  }

  const card = (over: Record<string, unknown> = {}) =>
    db.revisionCard.create({
      data: { userId, problemId, dueOn: new Date("2097-01-02T00:00:00.000Z"), ...over } as never,
      select: { userId: true, problemId: true, stage: true, reviews: true },
    });

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const user = await db.user.create({
      data: {
        collegeId: `REV${run}`,
        email: `rev-${run}@example.test`,
        firstName: "A",
        lastName: "Reviser",
        handle: `rev-${run}`,
        role: "STUDENT",
      },
      select: { id: true },
    });
    userId = user.id;
    problemId = await freshProblem();
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.revisionCard.deleteMany({ where: { userId } });
      await db.problem.deleteMany({ where: { slug: { startsWith: `revision-${run}-` } } });
      await db.user.delete({ where: { id: userId } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("the rung is on the ladder", () => {
    it("accepts every rung the ladder has", async () => {
      for (let stage = 0; stage <= 4; stage++) {
        const row = await card({ problemId: await freshProblem(), stage });
        expect(row.stage).toBe(stage);
      }
    });

    it("refuses a rung off either end", async () => {
      const [above, below] = [await freshProblem(), await freshProblem()];
      expect(await refused(() => card({ problemId: above, stage: 5 }))).toMatch(/RevisionCard_stage_check/);
      expect(await refused(() => card({ problemId: below, stage: -1 }))).toMatch(/RevisionCard_stage_check/);
    });
  });

  describe("counts are counts", () => {
    it("refuses a negative review or lapse count", async () => {
      const [reviewed, lapsed] = [await freshProblem(), await freshProblem()];
      expect(await refused(() => card({ problemId: reviewed, reviews: -1, lastReviewAt: new Date() }))).toMatch(
        /RevisionCard_(counts|review_pair)_check/,
      );
      expect(await refused(() => card({ problemId: lapsed, lapses: -1 }))).toMatch(/RevisionCard_counts_check/);
    });
  });

  describe("a reviewed card has been reviewed", () => {
    it("accepts a new card with no reviews and no review time", async () => {
      const row = await card({ problemId: await freshProblem() });
      expect(row.reviews).toBe(0);
    });

    it("refuses a review count with no review time, and a review time with no count", async () => {
      const [counted, timed] = [await freshProblem(), await freshProblem()];
      expect(await refused(() => card({ problemId: counted, reviews: 2 }))).toMatch(/RevisionCard_review_pair_check/);
      expect(await refused(() => card({ problemId: timed, lastReviewAt: new Date() }))).toMatch(
        /RevisionCard_review_pair_check/,
      );
    });
  });

  describe("learned means finished", () => {
    it("accepts a card learned at the top of the ladder", async () => {
      const row = await card({
        problemId: await freshProblem(),
        stage: 4,
        reviews: 5,
        lastReviewAt: new Date(),
        learnedAt: new Date(),
      });
      expect(row.stage).toBe(4);
    });

    it("refuses a card learned part-way up, or learned without ever being reviewed", async () => {
      const [partway, unreviewed] = [await freshProblem(), await freshProblem()];
      expect(
        await refused(() =>
          card({ problemId: partway, stage: 2, reviews: 2, lastReviewAt: new Date(), learnedAt: new Date() }),
        ),
      ).toMatch(/RevisionCard_learned_check/);
      expect(await refused(() => card({ problemId: unreviewed, stage: 4, learnedAt: new Date() }))).toMatch(
        /RevisionCard_learned_check/,
      );
    });
  });

  describe("one card per student per problem", () => {
    it("refuses a second card for the same pair", async () => {
      const only = await freshProblem();
      await card({ problemId: only });
      expect(await refused(() => card({ problemId: only }))).toMatch(/Unique constraint|RevisionCard_pkey/);
    });
  });
});
