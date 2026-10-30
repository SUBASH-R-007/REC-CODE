import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Debugging problems in the data model (Phase 12m, slice 1), against a real
 * PostgreSQL.
 *
 * Two CHECKs: the budget is a whole number of lines in a range an author
 * may set, and it belongs only to a problem that hands the student a
 * program to repair. And the authoring edit, which must clear the budget
 * when a version becomes a kind that has no program — otherwise a version
 * could be switched to SQL carrying a number nothing can measure, and the
 * database would refuse the edit instead of the form explaining it.
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
vi.mock("@/lib/redis", () => ({
  redis: () => ({ publish: async () => 1 }),
  newSubscriber: () => {
    throw new Error("no subscribers here");
  },
}));
vi.mock("@/lib/testdata/store", () => ({
  getTestDataStore: () => ({
    driver: "local" as const,
    async put() {},
    async get() {
      return Buffer.alloc(0);
    },
    async exists() {
      return false;
    },
    async stream(): Promise<ReadableStream<Uint8Array>> {
      return new Blob([new Uint8Array()]).stream();
    },
  }),
}));

const BROKEN = `#include <iostream>
int main() {
  int n;
  std::cin >> n;
  int sum = 0;
  for (int i = 0; i <= n; i++) sum += i;
  std::cout << sum << std::endl;
}
`;

describe.skipIf(!ENABLED)("debugging problems against recx_test", () => {
  const tag = `debug-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let edits: typeof import("@/lib/authoring/edits");
  let content: typeof import("@/lib/authoring/content-input");
  let problemId = "";
  let actorId = "";

  /** A draft version, with whatever overrides a case needs. */
  async function version(over: Record<string, unknown> = {}) {
    return db.problemVersion.create({
      data: {
        problemId,
        revision: Math.floor(Math.random() * 1_000_000),
        status: "DRAFT",
        title: "Fix the sum",
        difficulty: "EASY",
        statementMd: "The program adds one number too many. Fix it.",
        ioMode: "STDIN",
        compareMode: "TOKEN",
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
        ...over,
      } as never,
      select: { id: true, editSeq: true, judgeSeq: true },
    });
  }

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({
      url: process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test",
      log: [],
    });
    edits = await import("@/lib/authoring/edits");
    content = await import("@/lib/authoring/content-input");

    const user = await db.user.create({
      data: {
        collegeId: `${tag}-a`,
        email: `${tag}@rec-code.example`,
        firstName: "Debug",
        lastName: "Author",
        handle: `${tag}-a`,
        role: "ADMIN",
      },
      select: { id: true },
    });
    actorId = user.id;

    const problem = await db.problem.create({
      data: {
        slug: `${tag}-fix-the-sum`,
        displayCode: `REC-${Math.floor(1000 + Math.random() * 8999)}`,
        title: "Fix the sum",
        difficulty: "EASY",
        status: "DRAFT",
      },
      select: { id: true },
    });
    problemId = problem.id;
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      const ids = (await db.problemVersion.findMany({ where: { problemId }, select: { id: true } })).map((v) => v.id);
      await db.starterCode.deleteMany({ where: { problemVersionId: { in: ids } } });
      await db.referenceSolution.deleteMany({ where: { problemVersionId: { in: ids } } });
      await db.$executeRawUnsafe(
        `DELETE FROM "ProblemVersion" WHERE "problemId" = $1 AND "frozenAt" IS NULL`,
        problemId,
      );
      const left = await db.problemVersion.count({ where: { problemId } });
      if (left === 0) await db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE id = $1`, problemId);
      await db.user.deleteMany({ where: { id: actorId } });
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  describe("what the database says an edit budget is", () => {
    it("accepts a whole number of lines in range", async () => {
      const v = await version({ maxEditedLines: 1 });
      const row = await db.problemVersion.findUniqueOrThrow({ where: { id: v.id }, select: { maxEditedLines: true } });
      expect(row.maxEditedLines).toBe(1);
      const top = await version({ maxEditedLines: 50 });
      expect(top.id).toBeTruthy();
    });

    it("refuses a budget of zero and one past the top", async () => {
      await expect(version({ maxEditedLines: 0 })).rejects.toThrow(/debug_budget_range/);
      await expect(version({ maxEditedLines: 51 })).rejects.toThrow(/debug_budget_range/);
      await expect(version({ maxEditedLines: -2 })).rejects.toThrow(/debug_budget_range/);
    });

    it("refuses one on a kind of problem with no program to repair", async () => {
      await expect(
        version({ ioMode: "SQL", compareMode: "ROWS", sqlDialect: "postgres17", sqlOrdered: true, maxEditedLines: 2 }),
      ).rejects.toThrow(/debug_budget_kind/);
      await expect(version({ compareMode: "INTERACTIVE", maxEditedLines: 2 })).rejects.toThrow(
        /debug_budget_kind|interactive_mode_mirror/,
      );
    });

    it("refuses one arriving by UPDATE as firmly as by INSERT", async () => {
      const v = await version();
      await expect(
        db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "maxEditedLines" = 0 WHERE id = $1`, v.id),
      ).rejects.toThrow(/debug_budget_range/);
    });
  });

  describe("the authoring edit", () => {
    it("stores the budget and moves judgeSeq, because it changes what is judged", async () => {
      const v = await version();
      const head = await edits.updateDraftJudging({
        versionId: v.id,
        expectedEditSeq: v.editSeq,
        actorId,
        ioMode: "STDIN",
        functionSignature: null,
        compareMode: "TOKEN",
        floatEpsilon: null,
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
        memoryLimitKb: 262_144,
        maxEditedLines: 2,
      });
      expect(head.judgeSeq).toBe(v.judgeSeq + 1);
      const row = await db.problemVersion.findUniqueOrThrow({ where: { id: v.id }, select: { maxEditedLines: true } });
      expect(row.maxEditedLines).toBe(2);
    });

    it("clears it when the version becomes a kind that has no program to repair", async () => {
      const v = await version({ maxEditedLines: 3 });
      let seq = v.editSeq;
      for (const over of [
        { ioMode: "SQL" as const, compareMode: "TOKEN" as const, sqlOrdered: false },
        { ioMode: "STDIN" as const, compareMode: "INTERACTIVE" as const },
      ]) {
        const head = await edits.updateDraftJudging({
          versionId: v.id,
          expectedEditSeq: seq,
          actorId,
          functionSignature: null,
          floatEpsilon: null,
          scoringMode: "ICPC",
          stopOnFirstFailure: true,
          timeLimitMs: 2000,
          memoryLimitKb: 262_144,
          maxEditedLines: 3,
          ...over,
        });
        seq = head.editSeq;
        const row = await db.problemVersion.findUniqueOrThrow({
          where: { id: v.id },
          select: { maxEditedLines: true, sqlOrdered: true },
        });
        expect(row.maxEditedLines).toBeNull();
        // And Phase 12k's own question keeps the author's answer.
        if (over.ioMode === "SQL") expect(row.sqlOrdered).toBe(false);
      }
    });
  });

  describe("the publish gate reads the program, not just the row", () => {
    it("refuses a budget with no starter, and accepts one the model solution fits", async () => {
      const v = await version({ maxEditedLines: 1 });
      const noStarter = await content.versionIssues(db, v.id);
      expect(noStarter.map((i) => i.code)).toContain("DEBUG_NO_STARTER");

      await db.starterCode.create({ data: { problemVersionId: v.id, language: "cpp20", code: BROKEN } });
      await db.referenceSolution.create({
        data: {
          problemVersionId: v.id,
          language: "cpp20",
          label: "model",
          expectedVerdict: "AC",
          source: BROKEN.replace("i <= n", "i < n"),
        },
      });
      const fits = await content.versionIssues(db, v.id);
      expect(fits.filter((i) => i.code.startsWith("DEBUG_"))).toEqual([]);

      // A model solution that was rewritten rather than repaired is a
      // question nobody can answer within the budget.
      await db.referenceSolution.updateMany({
        where: { problemVersionId: v.id },
        data: { source: `#include <cstdio>\nint main(){int n;scanf("%d",&n);printf("%d",n*(n-1)/2);}\n` },
      });
      const unsolvable = await content.versionIssues(db, v.id);
      expect(unsolvable.map((i) => i.code)).toContain("DEBUG_UNSOLVABLE");
    });

    it("reads no starter and no model source for an ordinary problem", async () => {
      const v = await version();
      const issues = await content.versionIssues(db, v.id);
      expect(issues.filter((i) => i.code.startsWith("DEBUG_"))).toEqual([]);
    });
  });
});
