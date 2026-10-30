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

const DATASET_A = "CREATE TABLE students (id int, name text);\nINSERT INTO students VALUES (1, 'Asha'), (2, 'Bala');\n";
const DATASET_B = "CREATE TABLE students (id int, name text);\nINSERT INTO students VALUES (7, 'Chitra');\n";
const EXPECTED_A = JSON.stringify({ columns: ["id", "name"], rows: [["1", "Asha"], ["2", "Bala"]] });
const EXPECTED_B = JSON.stringify({ columns: ["id", "name"], rows: [["7", "Chitra"]] });

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe.skipIf(!ENABLED)("SQL problems against recx_test", () => {
  const tag = `sqlp-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let claim: typeof import("@/lib/judge/claim");
  let nodeAuth: typeof import("@/lib/judge/node-auth");
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
      await db.submission.deleteMany({ where: { userId } });
      await db.problem.updateMany({ where: { id: problemId }, data: { liveVersionId: null } });
      await db.testCase.deleteMany({ where: { problemVersion: { problemId } } });
      await db.problemVersion.deleteMany({ where: { problemId } });
      await db.problem.deleteMany({ where: { id: problemId } });
      await db.testBlob.deleteMany({ where: { sha256: { in: blobShas } } });
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

  async function claimed(id: string, kind: "submission" | "run" = "submission") {
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
