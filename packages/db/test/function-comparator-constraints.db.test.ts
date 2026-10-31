import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, openTestDb, RUN_DB_TESTS, testDatabaseName, type TestDb } from "./support/test-db";

/**
 * Migration 20261010100100_function_comparator_checks: "a problem cannot
 * publish without a declared comparator", in the database. Freezing (the
 * publish UPDATE that sets "frozenAt") a version that breaks any of the three
 * CHECKs fails with SQLSTATE 23514; a draft may be incomplete; the legacy
 * FUNCTION EXACT + TOKEN combination (the published seeds) freezes.
 *
 * Every case runs inside ONE transaction that is always rolled back (each
 * attempt behind its own savepoint), so the suite leaves no rows behind and
 * needs no trigger-lifting teardown. RECX_DB_TESTS=1, recx_test only.
 */

const SIGNATURE = {
  className: "Solution",
  methodName: "twoSum",
  params: [
    { name: "nums", type: "list<int>" },
    { name: "target", type: "long" },
  ],
  returns: "list<int>",
  comparator: "EXACT",
  mutatedParam: null,
};
const CHECKER = { sha: "c".repeat(64), testlib: "testlib-0.9.41" };

interface VersionCase {
  ioMode: "STDIN" | "FUNCTION";
  compareMode: "TOKEN" | "EXACT" | "CHECKER" | "FLOAT";
  signature: unknown;
  checker: boolean;
}

class Rollback extends Error {}

describe.skipIf(!RUN_DB_TESTS)("FUNCTION comparator CHECK constraints (recx_test)", () => {
  let db: TestDb;
  let restore: () => void = () => {};
  const tag = `fcc-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

  beforeAll(async () => {
    testDatabaseName();
    applyMigrations();
    ({ db, restore } = await openTestDb());
  }, 180_000);

  afterAll(async () => {
    await db?.$disconnect();
    restore();
  });

  /**
   * Insert a draft version for each case and try to freeze it, each behind a
   * savepoint. Returns the SQLSTATE and message of every refused freeze (null =
   * frozen fine). Everything is rolled back.
   */
  async function freezeAll(cases: VersionCase[]): Promise<({ code: string; message: string } | null)[]> {
    const outcomes: ({ code: string; message: string } | null)[] = [];
    await db
      .$transaction(
        async (tx) => {
          const problem = await tx.problem.create({
            data: { slug: tag, displayCode: tag.toUpperCase(), title: "Comparator CHECK fixture", difficulty: "EASY" },
            select: { id: true },
          });
          for (const [i, c] of cases.entries()) {
            const id = `${tag}-v${i}`;
            await tx.$executeRawUnsafe(
              `INSERT INTO "ProblemVersion" ("id", "problemId", "revision", "title", "difficulty", "statementMd", "ioMode",
                 "functionSignature", "compareMode", "timeLimitMs", "checkerSha256", "testlibId")
               VALUES ($1, $2, $3, 'x', 'EASY', 'x', $4::"IoMode", $5::jsonb, $6::"CompareMode", 1000, $7, $8)`,
              id,
              problem.id,
              i + 1,
              c.ioMode,
              c.signature === null ? null : JSON.stringify(c.signature),
              c.compareMode,
              c.checker ? CHECKER.sha : null,
              c.checker ? CHECKER.testlib : null,
            );
            await tx.$executeRawUnsafe(`SAVEPOINT freeze_${i}`);
            try {
              await tx.$executeRawUnsafe(
                `UPDATE "ProblemVersion" SET "frozenAt" = now(), "publishedAt" = now(), "status" = 'PUBLISHED' WHERE "id" = $1`,
                id,
              );
              outcomes.push(null);
            } catch (error) {
              await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT freeze_${i}`);
              const text = String((error as Error).message);
              outcomes.push({ code: /\b23514\b/.test(text) ? "23514" : "other", message: text });
            }
          }
          throw new Rollback();
        },
        { timeout: 60_000 },
      )
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
    return outcomes;
  }

  const fn = (signature: unknown, compareMode: VersionCase["compareMode"] = "TOKEN", checker = false): VersionCase => ({
    ioMode: "FUNCTION",
    compareMode,
    signature,
    checker,
  });

  it("freezes the legacy FUNCTION EXACT + TOKEN combination and a complete CUSTOM_CHECKER version", async () => {
    const outcomes = await freezeAll([
      fn(SIGNATURE),
      fn({ ...SIGNATURE, comparator: "IN_PLACE_MUTATION", returns: "void", mutatedParam: "nums" }),
      fn({ ...SIGNATURE, comparator: "CUSTOM_CHECKER" }, "CHECKER", true),
      { ioMode: "STDIN", compareMode: "TOKEN", signature: null, checker: false },
      { ioMode: "STDIN", compareMode: "CHECKER", signature: null, checker: true },
    ]);
    expect(outcomes).toEqual([null, null, null, null, null]);
  });

  it.each([
    ["no signature", fn(null), "ProblemVersion_function_comparator_declared"],
    ["a signature without a comparator", fn({ ...SIGNATURE, comparator: undefined }), "ProblemVersion_function_comparator_declared"],
    ["an unknown comparator", fn({ ...SIGNATURE, comparator: "FUZZY" }), "ProblemVersion_function_comparator_declared"],
    ["CUSTOM_CHECKER without compare mode CHECKER", fn({ ...SIGNATURE, comparator: "CUSTOM_CHECKER" }, "TOKEN", true), "ProblemVersion_function_checker_mirror"],
    ["compare mode CHECKER with another comparator", fn(SIGNATURE, "CHECKER", true), "ProblemVersion_function_checker_mirror"],
    ["CUSTOM_CHECKER without a checker", fn({ ...SIGNATURE, comparator: "CUSTOM_CHECKER" }, "CHECKER", false), "ProblemVersion_checker_present_when_frozen"],
    ["a STDIN CHECKER version without a checker", { ioMode: "STDIN", compareMode: "CHECKER", signature: null, checker: false } as VersionCase, "ProblemVersion_checker_present_when_frozen"],
  ])("refuses to freeze a version with %s (23514, %s)", async (_name, c, constraint) => {
    const [outcome] = await freezeAll([c]);
    expect(outcome).not.toBeNull();
    expect(outcome!.code, outcome!.message).toBe("23514");
    expect(outcome!.message).toContain(constraint);
  });

  it("lets a draft be incomplete (only the freeze is checked)", async () => {
    let inserted = false;
    await db
      .$transaction(async (tx) => {
        const problem = await tx.problem.create({
          data: { slug: `${tag}-draft`, displayCode: `${tag}-DRAFT`.toUpperCase(), title: "Draft fixture", difficulty: "EASY" },
          select: { id: true },
        });
        await tx.$executeRawUnsafe(
          `INSERT INTO "ProblemVersion" ("id", "problemId", "revision", "title", "difficulty", "statementMd", "ioMode", "compareMode", "timeLimitMs")
           VALUES ($1, $2, 1, 'x', 'EASY', 'x', 'FUNCTION', 'CHECKER', 1000)`,
          `${tag}-draft-v1`,
          problem.id,
        );
        inserted = true;
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
    expect(inserted).toBe(true);
  });

  it("leaves nothing behind", async () => {
    expect(await db.problem.count({ where: { slug: { startsWith: tag } } })).toBe(0);
  });
});
