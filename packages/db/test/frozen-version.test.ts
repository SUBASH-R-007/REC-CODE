import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPARE_MODES, IO_MODES, JUDGE_LANES, JUDGE_NODE_STATUSES, SCORING_MODES, VERDICTS } from "@recx/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Structural decision (a): a published ProblemVersion and its children are
 * immutable. Two fences, both exercised here against a real database:
 *   1. the repository guard in src/frozen.ts (every createPrismaClient()),
 *   2. the database triggers in the init migration, which also refuse raw SQL.
 * The one permitted write is the publish transition itself (frozenAt null →
 * set). AuditLog rows are append-only by trigger as well.
 *
 * DB-backed: runs only with RECX_DB_TESTS=1, against recx_test (never recx).
 * Migrations are applied first with `prisma migrate deploy`
 * (RECX_DB_TESTS_MIGRATE=0 skips that step).
 */

const RUN = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
const DB_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

const TITLE = RUN
  ? "frozen ProblemVersion fences (recx_test)"
  : "frozen ProblemVersion fences [skipped: set RECX_DB_TESTS=1 to run against recx_test on localhost:5433]";

if (!RUN) {
  // The default reporter collapses skipped suites; say why once.
  console.info(
    "frozen-version.test.ts skipped: set RECX_DB_TESTS=1 (PostgreSQL recx_test on localhost:5433, or RECX_TEST_DATABASE_URL) to run.",
  );
}

type DbModule = typeof import("../src/index");
type Db = ReturnType<DbModule["createPrismaClient"]>;

/** Tables whose frozen-version trigger is lifted (inside one transaction) only for teardown. */
const GUARDED = [
  ["TestCase", "TestCase_frozen_guard"],
  ["StarterCode", "StarterCode_frozen_guard"],
  ["ReferenceSolution", "ReferenceSolution_frozen_guard"],
  ["ProblemVersion", "ProblemVersion_frozen_guard"],
] as const;

function applyMigrations() {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("prisma/package.json");
  const cli = path.join(path.dirname(pkgJson), "build", "index.js");
  execFileSync(process.execPath, [cli, "migrate", "deploy"], {
    cwd: DB_PACKAGE_DIR,
    env: { ...process.env, DATABASE_URL: TEST_URL, DATABASE_URL_DIRECT: TEST_URL },
    stdio: "pipe",
    timeout: 150_000,
  });
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!RUN)(TITLE, () => {
  let mod: DbModule;
  let db: Db;
  const savedEnv = { url: process.env.DATABASE_URL, direct: process.env.DATABASE_URL_DIRECT };
  const tag = `ft-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const blob = { in: `${tag} input\n`, out: `${tag} output\n`, in2: `${tag} input 2\n` };
  const ids = {
    problem: "",
    /** revision 1: published (frozen) in the first test */
    v1: "",
    /** revision 2: stays a draft until the last trigger test publishes it */
    v2: "",
    v1TestCase: "",
    v1Starter: "",
    v1Reference: "",
    v2TestCase: "",
  };

  beforeAll(async () => {
    const dbName = new URL(TEST_URL).pathname.replace(/^\//, "");
    if (!dbName.endsWith("_test")) {
      throw new Error(`Refusing to run destructive tests against "${dbName}": the database name must end in _test.`);
    }
    if (process.env.RECX_DB_TESTS_MIGRATE !== "0") applyMigrations();

    // Set before the client loads so packages/db/.env (the dev database) is never used.
    process.env.DATABASE_URL = TEST_URL;
    process.env.DATABASE_URL_DIRECT = TEST_URL;
    mod = await import("../src/index");
    // No error logging: most queries below are expected to be refused.
    db = mod.createPrismaClient({ url: TEST_URL, log: [] });

    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);

    await db.testBlob.createMany({
      data: Object.values(blob).map((text) => ({ sha256: sha256(text), sizeBytes: text.length, inline: text })),
    });
    const problem = await db.problem.create({
      data: { slug: tag, displayCode: `T-${tag}`, title: "Frozen fence test", difficulty: "EASY" },
    });
    ids.problem = problem.id;
    const version = (revision: number) => ({
      problemId: problem.id,
      revision,
      title: `Frozen fence test r${revision}`,
      difficulty: "EASY" as const,
      statementMd: "Echo the input.",
      ioMode: "STDIN" as const,
      timeLimitMs: 1000,
    });
    ids.v1 = (await db.problemVersion.create({ data: version(1) })).id;
    ids.v2 = (await db.problemVersion.create({ data: version(2) })).id;

    const testCase = (problemVersionId: string, index: number) => ({
      problemVersionId,
      index,
      isSample: index === 0,
      inputSha256: sha256(blob.in),
      outputSha256: sha256(blob.out),
    });
    ids.v1TestCase = (await db.testCase.create({ data: testCase(ids.v1, 0) })).id;
    ids.v2TestCase = (await db.testCase.create({ data: testCase(ids.v2, 0) })).id;
    ids.v1Starter = (
      await db.starterCode.create({ data: { problemVersionId: ids.v1, language: "cpp20", code: "int main() {}\n" } })
    ).id;
    ids.v1Reference = (
      await db.referenceSolution.create({
        data: { problemVersionId: ids.v1, language: "cpp20", source: "int main() {}\n", expectedVerdict: "AC" },
      })
    ).id;
  });

  afterAll(async () => {
    try {
      if (db && ids.problem) {
        // The triggers refuse every delete under a frozen version, by design.
        // Teardown lifts them inside one transaction (DDL is transactional in
        // Postgres, so no other session ever sees them disabled).
        const versionScope = `SELECT "id" FROM "ProblemVersion" WHERE "problemId" = $1`;
        await db.$transaction([
          ...GUARDED.map(([table, trigger]) => db.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`)),
          db.$executeRawUnsafe(`DELETE FROM "TestCase" WHERE "problemVersionId" IN (${versionScope})`, ids.problem),
          db.$executeRawUnsafe(`DELETE FROM "StarterCode" WHERE "problemVersionId" IN (${versionScope})`, ids.problem),
          db.$executeRawUnsafe(`DELETE FROM "ReferenceSolution" WHERE "problemVersionId" IN (${versionScope})`, ids.problem),
          db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = $1`, ids.problem),
          ...GUARDED.map(([table, trigger]) => db.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`)),
          db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE "id" = $1`, ids.problem),
          db.$executeRawUnsafe(
            `DELETE FROM "TestBlob" WHERE "sha256" = ANY($1::text[])`,
            Object.values(blob).map(sha256),
          ),
        ]);
        expect(await db.problem.count({ where: { id: ids.problem } })).toBe(0);
        const disabled = await db.$queryRawUnsafe<Array<{ tgname: string }>>(
          `SELECT "tgname" FROM pg_trigger WHERE "tgname" LIKE '%_frozen_guard' AND "tgenabled" = 'D'`,
        );
        expect(disabled).toEqual([]);
      }
    } finally {
      await db?.$disconnect();
      process.env.DATABASE_URL = savedEnv.url;
      process.env.DATABASE_URL_DIRECT = savedEnv.direct;
      if (savedEnv.url === undefined) delete process.env.DATABASE_URL;
      if (savedEnv.direct === undefined) delete process.env.DATABASE_URL_DIRECT;
    }
  });

  it("allows the publish transition (frozenAt null → set) on a draft version", async () => {
    const now = new Date();
    const published = await db.problemVersion.update({
      where: { id: ids.v1 },
      data: { frozenAt: now, publishedAt: now, status: "PUBLISHED" },
    });
    expect(published.frozenAt).not.toBeNull();
    expect(published.status).toBe("PUBLISHED");
  });

  it("allows ordinary writes to a draft version and its children", async () => {
    await expect(db.problemVersion.update({ where: { id: ids.v2 }, data: { statementMd: "Draft edit." } })).resolves.toBeTruthy();
    await expect(db.testCase.update({ where: { id: ids.v2TestCase }, data: { isSample: true } })).resolves.toBeTruthy();
    await expect(
      db.starterCode.create({ data: { problemVersionId: ids.v2, language: "py312", code: "print(input())\n" } }),
    ).resolves.toBeTruthy();
    await expect(
      db.testCase.create({
        data: {
          problemVersion: { connect: { id: ids.v2 } },
          index: 1,
          input: { connect: { sha256: sha256(blob.in2) } },
          output: { connect: { sha256: sha256(blob.out) } },
        },
      }),
    ).resolves.toBeTruthy();
  });

  it("allows draft writes addressed by a compound unique key", async () => {
    await expect(
      db.starterCode.upsert({
        where: { problemVersionId_language: { problemVersionId: ids.v2, language: "cpp20" } },
        create: { problemVersionId: ids.v2, language: "cpp20", code: "int main() {}\n" },
        update: { code: "int main() { return 0; }\n" },
      }),
    ).resolves.toBeTruthy();
    await expect(
      db.testCase.update({
        where: { problemVersionId_index: { problemVersionId: ids.v2, index: 1 } },
        data: { isSample: false },
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses every update or delete of a frozen version (FrozenVersionError)", async () => {
    const { FrozenVersionError } = mod;
    await expect(db.problemVersion.update({ where: { id: ids.v1 }, data: { title: "edited" } })).rejects.toBeInstanceOf(
      FrozenVersionError,
    );
    await expect(
      db.problemVersion.updateMany({ where: { problemId: ids.problem }, data: { statementMd: "edited" } }),
    ).rejects.toBeInstanceOf(FrozenVersionError);
    await expect(db.problemVersion.update({ where: { id: ids.v1 }, data: { frozenAt: null } })).rejects.toBeInstanceOf(
      FrozenVersionError,
    );
    await expect(
      db.problemVersion.upsert({
        where: { id: ids.v1 },
        create: { problemId: ids.problem, revision: 99, title: "x", difficulty: "EASY", statementMd: "x", ioMode: "STDIN", timeLimitMs: 1000 },
        update: { timeLimitMs: 2000 },
      }),
    ).rejects.toBeInstanceOf(FrozenVersionError);
    await expect(db.problemVersion.delete({ where: { id: ids.v1 } })).rejects.toBeInstanceOf(FrozenVersionError);
  });

  it("refuses creating a TestCase, StarterCode or ReferenceSolution under a frozen version", async () => {
    const { FrozenVersionError } = mod;
    const testCase = { index: 5, isSample: false, inputSha256: sha256(blob.in), outputSha256: sha256(blob.out) };
    await expect(db.testCase.create({ data: { problemVersionId: ids.v1, ...testCase } })).rejects.toBeInstanceOf(
      FrozenVersionError,
    );
    await expect(
      db.testCase.createMany({ data: [{ problemVersionId: ids.v1, ...testCase, index: 6 }] }),
    ).rejects.toBeInstanceOf(FrozenVersionError);
    await expect(
      db.testCase.create({
        data: {
          problemVersion: { connect: { id: ids.v1 } },
          index: 7,
          input: { connect: { sha256: sha256(blob.in) } },
          output: { connect: { sha256: sha256(blob.out) } },
        },
      }),
    ).rejects.toBeInstanceOf(FrozenVersionError);
    await expect(
      db.starterCode.create({ data: { problemVersionId: ids.v1, language: "py312", code: "print()\n" } }),
    ).rejects.toBeInstanceOf(FrozenVersionError);
    await expect(
      db.referenceSolution.create({
        data: { problemVersionId: ids.v1, language: "py312", source: "print()\n", expectedVerdict: "WA" },
      }),
    ).rejects.toBeInstanceOf(FrozenVersionError);
  });

  it("refuses updating or deleting a child of a frozen version", async () => {
    const { FrozenVersionError } = mod;
    await expect(db.testCase.update({ where: { id: ids.v1TestCase }, data: { isSample: false } })).rejects.toBeInstanceOf(
      FrozenVersionError,
    );
    await expect(db.testCase.delete({ where: { id: ids.v1TestCase } })).rejects.toBeInstanceOf(FrozenVersionError);
    await expect(db.starterCode.deleteMany({ where: { problemVersionId: ids.v1 } })).rejects.toBeInstanceOf(
      FrozenVersionError,
    );
    await expect(
      db.referenceSolution.update({ where: { id: ids.v1Reference }, data: { expectedVerdict: "WA" } }),
    ).rejects.toBeInstanceOf(FrozenVersionError);
    expect(await db.testCase.count({ where: { problemVersionId: ids.v1 } })).toBe(1);
  });

  it("refuses moving a draft's child into a frozen version", async () => {
    await expect(
      db.testCase.update({ where: { id: ids.v2TestCase }, data: { problemVersionId: ids.v1, index: 50 } }),
    ).rejects.toBeInstanceOf(mod.FrozenVersionError);
  });

  it("rejects raw SQL writes to a frozen version and its children (database trigger)", async () => {
    const before = await db.problemVersion.findUniqueOrThrow({ where: { id: ids.v1 } });
    const frozen = /frozen/i;
    await expect(
      db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "title" = $1 WHERE "id" = $2`, "raw edit", ids.v1),
    ).rejects.toThrow(frozen);
    await expect(db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "frozenAt" = NULL WHERE "id" = $1`, ids.v1)).rejects.toThrow(
      frozen,
    );
    await expect(db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "id" = $1`, ids.v1)).rejects.toThrow(frozen);
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "TestCase" ("id", "problemVersionId", "index", "isSample", "inputSha256", "outputSha256") VALUES ($1, $2, 9, false, $3, $4)`,
        `${tag}-raw`,
        ids.v1,
        sha256(blob.in),
        sha256(blob.out),
      ),
    ).rejects.toThrow(frozen);
    await expect(db.$executeRawUnsafe(`UPDATE "TestCase" SET "isSample" = false WHERE "id" = $1`, ids.v1TestCase)).rejects.toThrow(
      frozen,
    );
    await expect(db.$executeRawUnsafe(`UPDATE "StarterCode" SET "code" = 'x' WHERE "id" = $1`, ids.v1Starter)).rejects.toThrow(
      frozen,
    );
    await expect(db.$executeRawUnsafe(`DELETE FROM "ReferenceSolution" WHERE "id" = $1`, ids.v1Reference)).rejects.toThrow(
      frozen,
    );
    await expect(
      db.$executeRawUnsafe(`UPDATE "TestCase" SET "problemVersionId" = $1 WHERE "id" = $2`, ids.v1, ids.v2TestCase),
    ).rejects.toThrow(frozen);

    const after = await db.problemVersion.findUniqueOrThrow({ where: { id: ids.v1 } });
    expect(after).toEqual(before);
    expect(await db.testCase.count({ where: { problemVersionId: ids.v1 } })).toBe(1);
    expect(await db.referenceSolution.count({ where: { problemVersionId: ids.v1 } })).toBe(1);
  });

  it("lets the database accept the publish transition itself, then freezes", async () => {
    const published = await db.$executeRawUnsafe(
      `UPDATE "ProblemVersion" SET "frozenAt" = now(), "status" = 'PUBLISHED' WHERE "id" = $1 AND "frozenAt" IS NULL`,
      ids.v2,
    );
    expect(published).toBe(1);
    await expect(
      db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "statementMd" = 'late edit' WHERE "id" = $1`, ids.v2),
    ).rejects.toThrow(/frozen/i);
    await expect(db.problemVersion.update({ where: { id: ids.v2 }, data: { title: "late" } })).rejects.toBeInstanceOf(
      mod.FrozenVersionError,
    );
  });

  it("rejects any UPDATE of an AuditLog row (append-only trigger)", async () => {
    const row = await db.auditLog.create({
      data: {
        action: "test.audit_append_only",
        entityType: "Test",
        entityId: tag,
        // A synthetic chain day so no real day's hash chain is touched.
        chainDay: `test-${tag}`,
        prevHash: "0".repeat(64),
        hash: sha256(tag),
      },
    });
    try {
      await expect(db.auditLog.update({ where: { id: row.id }, data: { action: "edited" } })).rejects.toThrow(/append-only/i);
      await expect(
        db.$executeRawUnsafe(`UPDATE "AuditLog" SET "metadata" = '{"edited":true}' WHERE "id" = $1`, row.id),
      ).rejects.toThrow(/append-only/i);
      const unchanged = await db.auditLog.findUniqueOrThrow({ where: { id: row.id } });
      expect(unchanged.action).toBe("test.audit_append_only");
    } finally {
      // Retention deletes are allowed; this is also the cleanup.
      await db.auditLog.delete({ where: { id: row.id } });
    }
  });

  it.each([
    ["Verdict", VERDICTS],
    ["JudgeLane", JUDGE_LANES],
    ["CompareMode", COMPARE_MODES],
    ["ScoringMode", SCORING_MODES],
    ["IoMode", IO_MODES],
    ["JudgeNodeStatus", JUDGE_NODE_STATUSES],
  ] as Array<[string, readonly string[]]>)("the database enum %s matches @recx/shared", async (typeName, shared) => {
    const rows = await db.$queryRawUnsafe<Array<{ label: string }>>(
      `SELECT e."enumlabel" AS label FROM pg_enum e JOIN pg_type t ON t.oid = e."enumtypid" WHERE t."typname" = $1 ORDER BY e."enumsortorder"`,
      typeName,
    );
    expect(rows.map((r) => r.label)).toEqual([...shared]);
  });
});
