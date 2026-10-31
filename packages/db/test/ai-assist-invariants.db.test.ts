import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, disabledTriggers, openTestDb, RUN_DB_TESTS, testDatabaseName, type TestDb } from "./support/test-db";

/**
 * The AI helper's record (migration 20261030094500).
 *
 * Three promises are kept in the data here rather than only in the code
 * path that writes it, and each is checked through the real database:
 *
 *   * the assistant is a PRACTICE tool — a row claiming otherwise is
 *     refused, so the promise made to every candidate survives a caller
 *     that forgets which surface it is on;
 *   * an answer exists exactly when the ask did not fail, so a broken ask
 *     can never later read as something a student was told;
 *   * the table is append-only, because a row here is what makes a later
 *     solve ASSISTED — and a deletable one would let the XP and the
 *     readiness number resting on it be rewritten after the fact.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS ? "AI assist invariants (live database)" : "AI assist invariants (set RECX_DB_TESTS=1 to run)";

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let userId = "";
  let problemId = "";

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  const assist = (over: Record<string, unknown> = {}) =>
    db.aiAssist.create({
      data: { userId, problemId, kind: "MISTAKE", modelId: "claude-sonnet-5-5", answer: "Look at line 4.", ...over } as never,
      select: { id: true, context: true, failed: true },
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
        collegeId: `AIA${run}`,
        email: `aia-${run}@example.test`,
        firstName: "A",
        lastName: "Student",
        handle: `aia-${run}`,
        role: "STUDENT",
      },
      select: { id: true },
    });
    userId = user.id;

    const problem = await db.problem.create({
      data: {
        slug: `ai-assist-${run}`,
        displayCode: `AIA-${run}`,
        title: "A problem to be stuck on",
        difficulty: "EASY",
      },
      select: { id: true },
    });
    problemId = problem.id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      if (userId) {
        // The trigger refuses every delete, by design. Teardown lifts it
        // inside one transaction (DDL is transactional; no other session
        // sees it off).
        await db.$transaction([
          db.$executeRawUnsafe(`ALTER TABLE "AiAssist" DISABLE TRIGGER "AiAssist_append_only"`),
          db.$executeRawUnsafe(`DELETE FROM "AiAssist" WHERE "userId" = $1`, userId),
          db.$executeRawUnsafe(`ALTER TABLE "AiAssist" ENABLE TRIGGER "AiAssist_append_only"`),
        ]);
        await db.problem.delete({ where: { id: problemId } });
        await db.user.delete({ where: { id: userId } });
      }
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("practice only", () => {
    it("accepts an answered ask in practice", async () => {
      const row = await assist();
      expect(row.context).toBe("PRACTICE");
      expect(row.failed).toBe(false);
    });

    it("refuses a contest and an assessment, at the database", async () => {
      for (const context of ["CONTEST", "ASSESSMENT"] as const) {
        expect(await refused(() => assist({ context }))).toMatch(/AiAssist_practice_only_check/);
      }
    });
  });

  describe("an answer exists exactly when the ask did not fail", () => {
    it("accepts a failure with no answer", async () => {
      const row = await assist({ failed: true, answer: null, latencyMs: 31_000 });
      expect(row.failed).toBe(true);
    });

    it("refuses an answered ask with no answer", async () => {
      expect(await refused(() => assist({ answer: null }))).toMatch(/AiAssist_answer_pair_check/);
    });

    it("refuses a failure that carries an answer", async () => {
      expect(await refused(() => assist({ failed: true, answer: "but here it is" }))).toMatch(
        /AiAssist_answer_pair_check/,
      );
    });

    it("refuses an empty answer", async () => {
      expect(await refused(() => assist({ answer: "" }))).toMatch(/AiAssist_answer_size_check/);
    });

    it("refuses an answer past the cap", async () => {
      expect(await refused(() => assist({ answer: "x".repeat(20_001) }))).toMatch(/AiAssist_answer_size_check/);
    });

    it("refuses negative usage", async () => {
      expect(await refused(() => assist({ tokensOut: -1 }))).toMatch(/AiAssist_usage_check/);
      expect(await refused(() => assist({ latencyMs: -1 }))).toMatch(/AiAssist_usage_check/);
    });
  });

  describe("append-only", () => {
    it("refuses an edit and a delete, through Prisma and through raw SQL", async () => {
      const row = await assist({ kind: "APPROACH" });

      expect(await refused(() => db.aiAssist.update({ where: { id: row.id }, data: { answer: "something else" } }))).toMatch(
        /append-only/,
      );
      expect(await refused(() => db.aiAssist.delete({ where: { id: row.id } }))).toMatch(/append-only/);
      expect(
        await refused(() => db.$executeRawUnsafe(`UPDATE "AiAssist" SET "failed" = true WHERE id = $1`, row.id)),
      ).toMatch(/append-only/);
      expect(await refused(() => db.$executeRawUnsafe(`DELETE FROM "AiAssist" WHERE id = $1`, row.id))).toMatch(
        /append-only/,
      );
    });

    it("refuses TRUNCATE, which is the back door out of append-only", async () => {
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE TABLE "AiAssist"`))).toMatch(/TRUNCATE/i);
    });
  });
});
