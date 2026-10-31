import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  JUDGE_PROTOCOL_VERSION,
  SQL_LANGUAGE_KEY,
  SQL_LIMITS,
  SQL_RUNTIME,
  SQL_TOOLCHAIN_ID,
  engineForIoMode,
  queueNameFor,
} from "@recx/shared";

/**
 * SQL problems in the data model, and the claim that routes them to the
 * sandbox engine (Phase 12k, slice 3) — against a real PostgreSQL.
 *
 * Two things need a database. The four CHECKs: a version cannot be half a
 * SQL problem, and the application is not the only thing that says so. And
 * the claim: the same `claimJob` that hands an isolate node a program must
 * hand a SQL node a statement, its datasets and its expected result sets,
 * with the dialect and the timeout the SERVER chose rather than any the
 * node could ask for.
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

/**
 * An in-memory object store, as every database suite uses: the real one
 * reads an environment this test has no business having, and what is being
 * tested is what reaches Postgres.
 */
const objects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("@/lib/testdata/store", () => ({
  getTestDataStore: () => ({
    driver: "local" as const,
    async put(key: string, bytes: Buffer) {
      objects.set(key, bytes);
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error(`missing ${key}`);
      return bytes;
    },
    async exists(key: string) {
      return objects.has(key);
    },
    async stream(key: string): Promise<ReadableStream<Uint8Array>> {
      return new Blob([new Uint8Array(objects.get(key) ?? Buffer.alloc(0))]).stream();
    },
  }),
}));

const DATASET_A = "CREATE TABLE students (id int, name text);\nINSERT INTO students VALUES (1, 'Asha'), (2, 'Bala');\n";
const DATASET_B = "CREATE TABLE students (id int, name text);\nINSERT INTO students VALUES (7, 'Chitra');\n";
const EXPECTED_A = JSON.stringify({ columns: ["id", "name"], rows: [["1", "Asha"], ["2", "Bala"]] });
const EXPECTED_B = JSON.stringify({ columns: ["id", "name"], rows: [["7", "Chitra"]] });
/** What a draft's cases carry until the capture run replaces them. */
const PLACEHOLDER = JSON.stringify({ columns: [], rows: [] });

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe.skipIf(!ENABLED)("SQL problems against recx_test", () => {
  const tag = `sqlp-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let claim: typeof import("@/lib/judge/claim");
  let nodeAuth: typeof import("@/lib/judge/node-auth");
  let capture: typeof import("@/lib/judge/sql-capture");
  let userId = "";
  let nodeId = "";
  let configId = "";
  let problemId = "";
  let versionId = "";
  const blobShas: string[] = [];

  /** A blob row, as the authoring pipeline would write one. */
  async function blob(text: string) {
    const digest = sha(text);
    await db.testBlob.upsert({
      where: { sha256: digest },
      create: { sha256: digest, sizeBytes: Buffer.byteLength(text, "utf8"), inline: text },
      update: {},
    });
    blobShas.push(digest);
    return { sha256: digest, sizeBytes: Buffer.byteLength(text, "utf8") };
  }

  /** A SQL version with two cases: the first a sample, the second hidden. */
  async function sqlVersion(over: Record<string, unknown> = {}) {
    const version = await db.problemVersion.create({
      data: {
        problemId,
        revision: Math.floor(Math.random() * 1_000_000),
        status: "PUBLISHED",
        title: "Every student",
        difficulty: "EASY",
        statementMd: "List every student, by id.",
        ioMode: "SQL",
        compareMode: "ROWS",
        sqlDialect: "postgres17",
        sqlOrdered: true,
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 1000,
        ...over,
      } as never,
      select: { id: true },
    });
    const [a, b, ea, eb] = await Promise.all([blob(DATASET_A), blob(DATASET_B), blob(EXPECTED_A), blob(EXPECTED_B)]);
    await db.testCase.createMany({
      data: [
        { problemVersionId: version.id, index: 0, isSample: true, inputSha256: a.sha256, outputSha256: ea.sha256 },
        { problemVersionId: version.id, index: 1, isSample: false, inputSha256: b.sha256, outputSha256: eb.sha256 },
      ],
    });
    return version.id;
  }

  async function submissionOn(version: string, lane: "PRACTICE" | "CONTEST" = "PRACTICE") {
    const row = await db.submission.create({
      data: {
        userId,
        problemId,
        problemVersionId: version,
        languageConfigId: configId,
        language: SQL_LANGUAGE_KEY,
        lane,
        status: "QUEUED",
        judgeState: "PENDING",
        sourceSha256: sha("SELECT id, name FROM students ORDER BY id"),
        sourceBytes: 34,
        source: { create: { source: "SELECT id, name FROM students ORDER BY id" } },
      },
      select: { id: true },
    });
    return row.id;
  }

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({
      url: process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test",
      log: [],
    });
    claim = await import("@/lib/judge/claim");
    nodeAuth = await import("@/lib/judge/node-auth");
    capture = await import("@/lib/judge/sql-capture");

    const user = await db.user.create({
      data: {
        collegeId: `${tag}-s`,
        email: `${tag}@rec-code.example`,
        firstName: "Sql",
        lastName: "Tester",
        handle: `${tag}-s`,
        role: "STUDENT",
      },
      select: { id: true },
    });
    userId = user.id;

    // The SQL LanguageConfig row: the thing that let a SQL submission be a
    // Submission, with no change to the table at all.
    const config = await db.languageConfig.upsert({
      where: { key_toolchainId: { key: SQL_LANGUAGE_KEY, toolchainId: SQL_TOOLCHAIN_ID } },
      create: {
        key: SQL_LANGUAGE_KEY,
        toolchainId: SQL_TOOLCHAIN_ID,
        version: "17",
        label: "PostgreSQL 17",
        runtime: SQL_RUNTIME as never,
        enabled: true,
        isCurrent: true,
      },
      update: {},
      select: { id: true },
    });
    configId = config.id;

    const problem = await db.problem.create({
      data: { slug: `${tag}-p`, displayCode: `${tag}-P`.toUpperCase(), title: "Students", difficulty: "EASY", status: "PUBLISHED" },
      select: { id: true },
    });
    problemId = problem.id;
    versionId = await sqlVersion();
    await db.problem.update({ where: { id: problemId }, data: { liveVersionId: versionId } });

    nodeId = `${tag}-node`;
    await db.judgeNode.create({
      data: {
        id: nodeId,
        hostname: "sql-judge-test",
        tokenHash: nodeAuth.hashNodeToken(randomBytes(32).toString("base64url")),
        driver: "postgres",
        status: "ONLINE",
        sensitiveLanesOk: true,
        languages: [],
      },
    });
  }, 90_000);

  afterAll(async () => {
    if (!db) return;
    try {
      /**
       * One of the cases below freezes a version on purpose (to prove a
       * capture cannot reach a published one), and the frozen guard then
       * refuses every Prisma write to it — including this cleanup, which is
       * the guard working as designed.
       *
       * So the suite's own rows go out through raw SQL, in dependency
       * order. A test may do that about rows it created; the application
       * may not, which is what `tests/repo/admin-scope.test.ts` and the
       * exposure fence are for.
       */
      await db.$executeRawUnsafe(`UPDATE "Problem" SET "liveVersionId" = NULL WHERE id = $1`, problemId);
      await db.$executeRawUnsafe(
        `DELETE FROM "SubmissionSource" WHERE "submissionId" IN (SELECT id FROM "Submission" WHERE "userId" = $1)`,
        userId,
      );
      await db.$executeRawUnsafe(`DELETE FROM "Submission" WHERE "userId" = $1`, userId);
      await db.$executeRawUnsafe(`DELETE FROM "RunRequest" WHERE "userId" = $1`, userId);
      const versions = `SELECT id FROM "ProblemVersion" WHERE "problemId" = $1`;
      await db.$executeRawUnsafe(`DELETE FROM "ValidationRun" WHERE "problemVersionId" IN (${versions})`, problemId);
      await db.$executeRawUnsafe(`DELETE FROM "ReferenceSolution" WHERE "problemVersionId" IN (${versions})`, problemId);
      await db.$executeRawUnsafe(`DELETE FROM "TestCase" WHERE "problemVersionId" IN (${versions})`, problemId);
      await db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = $1`, problemId);
      await db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE id = $1`, problemId);
      // Only the blobs nothing points at any more: the frozen version above
      // keeps its dataset and its placeholder, and a content-addressed blob
      // is shared by whoever has the same bytes.
      await db.testBlob.deleteMany({
        where: { sha256: { in: blobShas }, asInput: { none: {} }, asOutput: { none: {} } },
      });
      await db.judgeNode.deleteMany({ where: { id: nodeId } });
      await db.user.deleteMany({ where: { id: userId } });
    } finally {
      await db.$disconnect();
    }
  }, 90_000);

  // ── The CHECKs ────────────────────────────────────────────────────────

  it("refuses a SQL version that does not compare result sets", async () => {
    await expect(sqlVersion({ compareMode: "TOKEN" })).rejects.toThrow();
  });

  it("refuses a result-set comparison on a version that is not SQL", async () => {
    await expect(sqlVersion({ ioMode: "STDIN", sqlDialect: null, sqlOrdered: null })).rejects.toThrow();
  });

  it("refuses a SQL version with no dialect or no ordering rule", async () => {
    await expect(sqlVersion({ sqlDialect: null })).rejects.toThrow();
    await expect(sqlVersion({ sqlOrdered: null })).rejects.toThrow();
  });

  it("refuses the SQL columns on a version that is not SQL", async () => {
    await expect(sqlVersion({ ioMode: "STDIN", compareMode: "TOKEN", sqlOrdered: null })).rejects.toThrow();
  });

  it("refuses a SQL version carrying a function signature or a checker", async () => {
    await expect(sqlVersion({ functionSignature: { name: "x" } })).rejects.toThrow();
    await expect(sqlVersion({ checkerSha256: "a".repeat(64), testlibId: "testlib-0.9.41" })).rejects.toThrow();
  });

  // ── The engine mapping ────────────────────────────────────────────────

  it("maps the io mode to the engine, and the engine to its own queue", () => {
    expect(engineForIoMode("SQL")).toBe("postgres");
    expect(engineForIoMode("STDIN")).toBe("isolate");
    expect(engineForIoMode("FUNCTION")).toBe("isolate");
    expect(queueNameFor("postgres", "PRACTICE")).toBe("judge-sql-practice");
    expect(queueNameFor("isolate", "PRACTICE")).toBe("judge-practice");
  });

  // ── The claim ─────────────────────────────────────────────────────────

  async function claimed(id: string, kind: "submission" | "run" | "validation" = "submission") {
    const node = await db.judgeNode.findUniqueOrThrow({ where: { id: nodeId } });
    const outcome = await claim.claimJob(node, { protocolVersion: JUDGE_PROTOCOL_VERSION, kind, id });
    if (!outcome.claimed) throw new Error(`claim refused: ${outcome.refusal.reason}`);
    return outcome.spec;
  }

  it("hands a SQL submission the sandbox engine's spec", async () => {
    const id = await submissionOn(versionId);
    const spec = await claimed(id);
    expect(spec.engine).toBe("postgres");
    if (spec.engine !== "postgres") return;

    expect(spec.dialect).toBe("postgres17");
    expect(spec.source).toBe("SELECT id, name FROM students ORDER BY id");
    expect(spec.stopOnFirstFailure).toBe(true);
    // The server's numbers, not the node's.
    expect(spec.statementTimeoutMs).toBe(SQL_LIMITS.statementTimeoutMs);
    expect(spec.maxRows).toBe(SQL_LIMITS.rows);

    expect(spec.cases).toHaveLength(2);
    expect(spec.cases[0]).toEqual({
      index: 0,
      visible: true,
      setup: { sha256: sha(DATASET_A), sizeBytes: Buffer.byteLength(DATASET_A, "utf8") },
      expected: { sha256: sha(EXPECTED_A), sizeBytes: Buffer.byteLength(EXPECTED_A, "utf8") },
      ordered: true,
    });
    // The hidden case is in the spec and marked invisible: the judge needs
    // it, and what the STUDENT is told about it is decided per case.
    expect(spec.cases[1]!.visible).toBe(false);
    expect(spec.cases[1]!.setup.sha256).toBe(sha(DATASET_B));
  });

  it("carries the version's ordering rule to every case", async () => {
    const unordered = await sqlVersion({ sqlOrdered: false });
    const id = await submissionOn(unordered);
    const spec = await claimed(id);
    if (spec.engine !== "postgres") throw new Error("expected the sandbox engine");
    expect(spec.cases.map((c) => c.ordered)).toEqual([false, false]);
  });

  it("gives a Run only the cases the student can already see", async () => {
    const run = await db.runRequest.create({
      data: {
        // A RunRequest is keyed on the VERSION only: a run is against the
        // revision the student has open.
        userId,
        problemVersionId: versionId,
        languageConfigId: configId,
        language: SQL_LANGUAGE_KEY,
        status: "QUEUED",
        judgeState: "PENDING",
        source: "SELECT id, name FROM students",
        // Null is "run the sample tests", which is the only thing a Run
        // means for a SQL problem: its input is its dataset.
        customInput: null,
        // Runs expire; the column is required.
        expiresAt: new Date(Date.now() + 3_600_000),
      } as never,
      select: { id: true },
    });
    const spec = await claimed(run.id, "run");
    if (spec.engine !== "postgres") throw new Error("expected the sandbox engine");
    expect(spec.cases.map((c) => c.index)).toEqual([0]);
    await db.runRequest.deleteMany({ where: { id: run.id } });
  });

  // ── The capture run ───────────────────────────────────────────────────

  /** A draft SQL version with a reference query, as the author leaves it. */
  async function draftWithReference() {
    const version = await db.problemVersion.create({
      data: {
        problemId,
        revision: Math.floor(Math.random() * 1_000_000),
        status: "DRAFT",
        title: "Capture me",
        difficulty: "EASY",
        statementMd: "List every student, by id.",
        ioMode: "SQL",
        compareMode: "ROWS",
        sqlDialect: "postgres17",
        sqlOrdered: true,
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 5000,
      } as never,
      select: { id: true },
    });
    const [a, b, placeholder] = await Promise.all([blob(DATASET_A), blob(DATASET_B), blob(PLACEHOLDER)]);
    await db.testCase.createMany({
      data: [
        { problemVersionId: version.id, index: 0, isSample: true, inputSha256: a.sha256, outputSha256: placeholder.sha256 },
        { problemVersionId: version.id, index: 1, isSample: false, inputSha256: b.sha256, outputSha256: placeholder.sha256 },
      ],
    });
    const reference = await db.referenceSolution.create({
      data: {
        problemVersionId: version.id,
        language: SQL_LANGUAGE_KEY,
        label: "Reference query",
        source: "SELECT id, name FROM students ORDER BY id",
        expectedVerdict: "AC",
      },
      select: { id: true },
    });
    const run = await db.validationRun.create({
      data: {
        problemVersionId: version.id,
        referenceSolutionId: reference.id,
        language: SQL_LANGUAGE_KEY,
        languageConfigId: configId,
        judgeSeq: 0,
      },
      select: { id: true },
    });
    return { versionId: version.id, runId: run.id };
  }

  it("claims a validation run as a CAPTURE run, with nothing to compare against", async () => {
    const { runId } = await draftWithReference();
    const spec = await claimed(runId, "validation");
    if (spec.engine !== "postgres") throw new Error("expected the sandbox engine");
    expect(spec.capture).toBe(true);
    // The author's query, not a student's.
    expect(spec.source).toBe("SELECT id, name FROM students ORDER BY id");
    expect(spec.cases.map((c) => c.expected)).toEqual([null, null]);
    expect(spec.cases.map((c) => c.setup.sha256)).toEqual([sha(DATASET_A), sha(DATASET_B)]);
  });

  it("stores what the capture reported as the version's expected results", async () => {
    const { versionId: draftId, runId } = await draftWithReference();
    const stored = await capture.storeSqlCapture(runId, {
      kind: "validation",
      sqlCaptured: [
        { index: 0, resultSet: { columns: ["id", "name"], rows: [["1", "Asha"], ["2", "Bala"]] } },
        { index: 1, resultSet: { columns: ["id", "name"], rows: [["7", "Chitra"]] } },
      ],
    });
    expect(stored).toEqual({ stored: true, cases: 2 });

    const cases = await db.testCase.findMany({
      where: { problemVersionId: draftId },
      orderBy: { index: "asc" },
      select: { index: true, output: { select: { sha256: true, inline: true } } },
    });
    expect(cases[0]!.output.inline).toBe(EXPECTED_A);
    expect(cases[1]!.output.inline).toBe(EXPECTED_B);
    // The placeholder is gone from both, which is what "captured" means.
    expect(cases.every((c) => c.output.sha256 !== sha(PLACEHOLDER))).toBe(true);
  });

  it("refuses a capture that is not a validation run", async () => {
    const { runId } = await draftWithReference();
    const stored = await capture.storeSqlCapture(runId, {
      kind: "submission",
      sqlCaptured: [{ index: 0, resultSet: { columns: ["id"], rows: [["1"]] } }],
    });
    expect(stored).toEqual({ stored: false, reason: "only a validation run captures expected results" });
  });

  it("refuses a half capture, so a version cannot publish with one case left over", async () => {
    const { versionId: draftId, runId } = await draftWithReference();
    const stored = await capture.storeSqlCapture(runId, {
      kind: "validation",
      sqlCaptured: [{ index: 0, resultSet: { columns: ["id"], rows: [["1"]] } }],
    });
    expect(stored.stored).toBe(false);
    if (!stored.stored) expect(stored.reason).toContain("no result was captured for case 1");
    // And nothing was written for the case it did report.
    const first = await db.testCase.findFirstOrThrow({
      where: { problemVersionId: draftId, index: 0 },
      select: { outputSha256: true },
    });
    expect(first.outputSha256).toBe(sha(PLACEHOLDER));
  });

  it("refuses a case the version does not have", async () => {
    const { runId } = await draftWithReference();
    const stored = await capture.storeSqlCapture(runId, {
      kind: "validation",
      sqlCaptured: [
        { index: 0, resultSet: { columns: ["id"], rows: [] } },
        { index: 1, resultSet: { columns: ["id"], rows: [] } },
        { index: 9, resultSet: { columns: ["id"], rows: [] } },
      ],
    });
    expect(stored.stored).toBe(false);
    if (!stored.stored) expect(stored.reason).toContain("cases this version does not have: 9");
  });

  it("refuses to capture into a published version", async () => {
    /**
     * This case needs a FROZEN version, and a frozen version cannot be
     * deleted afterwards: the database refuses to touch it or any of its
     * children (`ReferenceSolution of frozen ProblemVersion … is
     * immutable`), which is the immutability the whole platform rests on.
     * So it gets its own problem, and that problem is left behind in
     * recx_test rather than the suite disabling a guard to tidy up. The
     * tag makes it obvious where it came from.
     */
    const own = await db.problem.create({
      data: {
        slug: `${tag}-frozen`,
        displayCode: `${tag}-FROZEN`.toUpperCase(),
        title: "Frozen",
        difficulty: "EASY",
        status: "PUBLISHED",
      },
      select: { id: true },
    });
    const version = await db.problemVersion.create({
      data: {
        problemId: own.id,
        revision: 1,
        status: "PUBLISHED",
        title: "Frozen",
        difficulty: "EASY",
        statementMd: "Frozen.",
        ioMode: "SQL",
        compareMode: "ROWS",
        sqlDialect: "postgres17",
        sqlOrdered: true,
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 5000,
      } as never,
      select: { id: true },
    });
    const dataset = await blob(DATASET_A);
    const placeholder = await blob(PLACEHOLDER);
    await db.testCase.create({
      data: {
        problemVersionId: version.id,
        index: 0,
        isSample: true,
        inputSha256: dataset.sha256,
        outputSha256: placeholder.sha256,
      },
    });
    const reference = await db.referenceSolution.create({
      data: {
        problemVersionId: version.id,
        language: SQL_LANGUAGE_KEY,
        label: "Reference query",
        source: "SELECT id, name FROM students ORDER BY id",
        expectedVerdict: "AC",
      },
      select: { id: true },
    });
    const run = await db.validationRun.create({
      data: {
        problemVersionId: version.id,
        referenceSolutionId: reference.id,
        language: SQL_LANGUAGE_KEY,
        languageConfigId: configId,
        judgeSeq: 0,
      },
      select: { id: true },
    });
    await db.problemVersion.update({ where: { id: version.id }, data: { frozenAt: new Date() } });

    const stored = await capture.storeSqlCapture(run.id, {
      kind: "validation",
      sqlCaptured: [{ index: 0, resultSet: { columns: ["id"], rows: [] } }],
    });
    expect(stored).toEqual({ stored: false, reason: "that version is published and frozen" });
  });

  it("still hands an isolate node a program's spec", async () => {
    // The mapping is per VERSION, so the second engine took nothing away
    // from the first.
    const stdin = await db.problemVersion.create({
      data: {
        problemId,
        revision: Math.floor(Math.random() * 1_000_000),
        status: "PUBLISHED",
        title: "A program",
        difficulty: "EASY",
        statementMd: "Print it.",
        ioMode: "STDIN",
        compareMode: "TOKEN",
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 1000,
      } as never,
      select: { id: true },
    });
    const input = await blob("1\n");
    const output = await blob("1\n");
    await db.testCase.create({
      data: { problemVersionId: stdin.id, index: 0, isSample: true, inputSha256: input.sha256, outputSha256: output.sha256 },
    });
    const cpp = await db.languageConfig.findFirst({ where: { key: "cpp20" }, select: { id: true } });
    if (!cpp) return; // a database without the seeded languages cannot show this
    const row = await db.submission.create({
      data: {
        userId,
        problemId,
        problemVersionId: stdin.id,
        languageConfigId: cpp.id,
        language: "cpp20",
        lane: "PRACTICE",
        status: "QUEUED",
        judgeState: "PENDING",
        sourceSha256: sha("int main(){}"),
        sourceBytes: 12,
        source: { create: { source: "int main(){}" } },
      },
      select: { id: true },
    });
    const spec = await claimed(row.id);
    expect(spec.engine).toBe("isolate");
  });
});
