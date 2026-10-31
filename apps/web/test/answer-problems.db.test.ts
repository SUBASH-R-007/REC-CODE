import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Output-only problems in the data model (Phase 12n, slice 1), against a
 * real PostgreSQL.
 *
 * One CHECK, and it is a list of what an output-only version is NOT: no
 * function signature and no edit budget (there is no program), no dialect
 * and no result-set comparison (it is not a query), no interactor (it is
 * not a conversation). Each of those fields would otherwise be read by
 * rules that do not apply to a text answer.
 *
 * The two rules no CHECK could hold — exactly one case, and the case is
 * visible — are the publish gate's, and are tested with it.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

describe.skipIf(!ENABLED)("output-only problems against recx_test", () => {
  const tag = `answer-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let problemId = "";

  async function version(over: Record<string, unknown> = {}) {
    return db.problemVersion.create({
      data: {
        problemId,
        revision: Math.floor(Math.random() * 1_000_000),
        status: "DRAFT",
        title: "The hard instance",
        difficulty: "HARD",
        statementMd: "Here is the data. Submit the answer.",
        ioMode: "OUTPUT_ONLY",
        compareMode: "TOKEN",
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
        ...over,
      } as never,
      select: { id: true, ioMode: true },
    });
  }

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({
      url: process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test",
      log: [],
    });
    const problem = await db.problem.create({
      data: {
        slug: `${tag}-hard`,
        displayCode: `REC-${Math.floor(1000 + Math.random() * 8999)}`,
        title: "The hard instance",
        difficulty: "HARD",
        status: "DRAFT",
      },
      select: { id: true },
    });
    problemId = problem.id;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await db.$executeRawUnsafe(
        `DELETE FROM "ProblemVersion" WHERE "problemId" = $1 AND "frozenAt" IS NULL`,
        problemId,
      );
      const left = await db.problemVersion.count({ where: { problemId } });
      if (left === 0) await db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE id = $1`, problemId);
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  describe("the io mode exists and is storable", () => {
    it("accepts an output-only version", async () => {
      const v = await version();
      expect(v.ioMode).toBe("OUTPUT_ONLY");
    });

    it("accepts every text comparison an answer may be judged by", async () => {
      for (const compareMode of ["EXACT", "TOKEN", "FLOAT"] as const) {
        const v = await version({ compareMode, floatEpsilon: compareMode === "FLOAT" ? 1e-6 : null });
        expect(v.id).toBeTruthy();
      }
    });
  });

  describe("what the database refuses", () => {
    it("a function signature: there is no function", async () => {
      await expect(
        version({ functionSignature: { methodName: "x", params: [], returns: { kind: "int" }, comparator: "EXACT" } }),
      ).rejects.toThrow(/output_only_fields/);
    });

    it("a SQL dialect or an ordering rule: it is not a query", async () => {
      await expect(version({ sqlDialect: "postgres17" })).rejects.toThrow(/output_only_fields|sql_/);
      await expect(version({ sqlOrdered: true })).rejects.toThrow(/output_only_fields|sql_/);
    });

    it("an edit budget: there is no program to repair", async () => {
      await expect(version({ maxEditedLines: 2 })).rejects.toThrow(/output_only_fields/);
    });

    it("a result-set comparison or a conversation", async () => {
      await expect(version({ compareMode: "ROWS" })).rejects.toThrow(/output_only_fields|sql_mode_mirror/);
      await expect(version({ compareMode: "INTERACTIVE" })).rejects.toThrow(
        /output_only_fields|interactive_stdin_only|interactive_mode_mirror/,
      );
    });

    it("an interactor, even with a text comparison", async () => {
      const digest = "a".repeat(64);
      await db.testBlob.upsert({
        where: { sha256: digest },
        create: { sha256: digest, sizeBytes: 1, inline: "x" },
        update: {},
      });
      await expect(version({ interactorSha256: digest, testlibId: "testlib-0.9.41" })).rejects.toThrow(
        /output_only_fields|interactive_mode_mirror/,
      );
    });

    it("and refuses one arriving by UPDATE as firmly as by INSERT", async () => {
      const v = await version();
      await expect(
        db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "maxEditedLines" = 2 WHERE id = $1`, v.id),
      ).rejects.toThrow(/output_only_fields/);
    });

    it("but leaves every other kind of problem alone", async () => {
      const stdin = await version({ ioMode: "STDIN", maxEditedLines: 2 });
      expect(stdin.ioMode).toBe("STDIN");
    });
  });
});
