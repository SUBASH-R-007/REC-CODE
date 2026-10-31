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

describe.skipIf(!ENABLED)("output-only problems against recx_test", () => {
  const tag = `answer-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let edits: typeof import("@/lib/authoring/edits");
  let content: typeof import("@/lib/authoring/content-input");
  let problemId = "";
  let actorId = "";

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
    edits = await import("@/lib/authoring/edits");
    content = await import("@/lib/authoring/content-input");
    const user = await db.user.create({
      data: {
        collegeId: `${tag}-a`,
        email: `${tag}@rec-code.example`,
        firstName: "Answer",
        lastName: "Author",
        handle: `${tag}-a`,
        role: "ADMIN",
      },
      select: { id: true },
    });
    actorId = user.id;

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
      // The gate test leaves a case and a reference behind; both point at
      // the version, so they go first.
      const ids = (await db.problemVersion.findMany({ where: { problemId }, select: { id: true } })).map((v) => v.id);
      await db.testCase.deleteMany({ where: { problemVersionId: { in: ids } } });
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

  describe("the authoring edit", () => {
    it("clears the edit budget when a version becomes output-only", async () => {
      const v = await db.problemVersion.create({
        data: {
          problemId,
          revision: Math.floor(Math.random() * 1_000_000),
          status: "DRAFT",
          title: "Was a debugging problem",
          difficulty: "EASY",
          statementMd: "Fix it.",
          ioMode: "STDIN",
          compareMode: "TOKEN",
          scoringMode: "ICPC",
          stopOnFirstFailure: true,
          timeLimitMs: 2000,
          maxEditedLines: 2,
        } as never,
        select: { id: true, editSeq: true },
      });
      const head = await edits.updateDraftJudging({
        versionId: v.id,
        expectedEditSeq: v.editSeq,
        actorId,
        ioMode: "OUTPUT_ONLY",
        functionSignature: null,
        compareMode: "TOKEN",
        floatEpsilon: null,
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
        memoryLimitKb: 262_144,
        maxEditedLines: 2,
      });
      expect(head.judgeSeq).toBeGreaterThan(0);
      const row = await db.problemVersion.findUniqueOrThrow({
        where: { id: v.id },
        select: { ioMode: true, maxEditedLines: true, sqlDialect: true, interactorSha256: true },
      });
      expect(row.ioMode).toBe("OUTPUT_ONLY");
      expect(row.maxEditedLines).toBeNull();
      expect(row.sqlDialect).toBeNull();
      expect(row.interactorSha256).toBeNull();
    });
  });

  describe("not sat in an assessment yet", () => {
    it("refuses the pin, by trigger", async () => {
      const v = await version({ status: "PUBLISHED" });
      await db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "frozenAt" = now() WHERE id = $1`, v.id);
      const user = await db.user.create({
        data: {
          collegeId: `${tag}-b`,
          email: `${tag}-b@rec-code.example`,
          firstName: "Paper",
          lastName: "Maker",
          handle: `${tag}-b`,
          role: "ADMIN",
        },
        select: { id: true },
      });
      const assessment = await db.assessment.create({
        data: {
          slug: `${tag}-paper`,
          title: "A paper",
          instructions: "Be honest.",
          status: "DRAFT",
          proctorMode: "ADVISORY",
          opensAt: new Date(Date.now() + 86_400_000),
          closesAt: new Date(Date.now() + 90_000_000),
          durationSec: 3_600,
          createdById: user.id,
        } as never,
        select: { id: true },
      });
      try {
        await expect(
          db.assessmentProblem.create({
            data: { assessmentId: assessment.id, problemVersionId: v.id, position: 1, points: 100 },
          }),
        ).rejects.toThrow(/not sat in an assessment yet/);
      } finally {
        await db.$executeRawUnsafe(`DELETE FROM "Assessment" WHERE id = $1`, assessment.id);
        await db.user.deleteMany({ where: { id: user.id } });
      }
    });
  });

  describe("the publish gate", () => {
    it("asks for one visible case with an expected answer, and the model answer", async () => {
      const v = await version();
      const empty = (await content.versionIssues(db, v.id)).map((i) => i.code);
      expect(empty).toContain("ANSWER_ONE_CASE");
      expect(empty).toContain("ANSWER_NO_REFERENCE");
      // The hidden-test rule is lifted for this kind.
      expect(empty).not.toContain("NO_HIDDEN_TEST");

      const data = "10\n3 1 4 1 5 9 2 6 5 3\n";
      const answer = "39\n";
      const blobs = await Promise.all(
        [data, answer].map(async (text) => {
          const { createHash } = await import("node:crypto");
          const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
          await db.testBlob.upsert({
            where: { sha256 },
            create: { sha256, sizeBytes: Buffer.byteLength(text, "utf8"), inline: text },
            update: {},
          });
          return sha256;
        }),
      );
      await db.testCase.create({
        data: {
          problemVersionId: v.id,
          index: 0,
          isSample: true,
          inputSha256: blobs[0]!,
          outputSha256: blobs[1]!,
        } as never,
      });
      await db.referenceSolution.create({
        data: { problemVersionId: v.id, language: "answer1", label: "the answer", expectedVerdict: "AC", source: answer },
      });
      const ready = (await content.versionIssues(db, v.id)).filter((i) => i.severity === "error").map((i) => i.code);
      expect(ready).toEqual([]);

      // A hidden case is a question nobody can read.
      await db.testCase.updateMany({ where: { problemVersionId: v.id }, data: { isSample: false } });
      expect((await content.versionIssues(db, v.id)).map((i) => i.code)).toContain("ANSWER_HIDDEN_CASE");
    });
  });
});
