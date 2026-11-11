import { randomBytes } from "node:crypto";
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
 * The aptitude import invariants (migration 20261019250400).
 *
 * SPEC §5: *so one bad row cannot discard a 300-question file.* The CHECKs
 * here are what make the REPORT of that trustworthy — an import whose
 * counters disagree with its rows, or a failure with no reason, sends an
 * operator back to the file to guess.
 *
 * Also proved: the display-code sequence hands out a different code every
 * time, which is why the importer uses one instead of `max + 1`.
 */

const run = randomBytes(3).readUIntBE(0, 3) % 90_000 + 10_000;
const TITLE = RUN_DB_TESTS
  ? "aptitude import invariants (live database)"
  : "aptitude import invariants (set RECX_DB_TESTS=1 to run)";

const SHA = "a".repeat(64);

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let userId = "";
  let nextName = 1;

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  /**
   * `startedAt` is written explicitly, from the SAME clock as `finishedAt`.
   *
   * Leaving the database default in place compares the database's clock
   * against the app's, and the WSL database runs ~200ms ahead of the Windows
   * host — which is how `AptitudeImport_finished_check` refused a row whose
   * finish was two milliseconds "before" its start. The importer writes both
   * for the same reason; in production the app and the database are different
   * machines.
   */
  const upload = (over: Record<string, unknown> = {}) => {
    const startedAt = new Date(Date.now() - 1_000);
    return db.aptitudeImport.create({
      data: {
        uploadedById: userId,
        fileName: `bank-${run}-${nextName++}.csv`,
        sizeBytes: BigInt(2_048),
        fileSha256: SHA,
        via: "upload",
        startedAt,
        ...over,
      } as never,
      select: { id: true, status: true, total: true },
    });
  };

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const user = await db.user.create({
      data: {
        collegeId: `IMP${run}`,
        email: `imp-${run}@example.test`,
        firstName: "An",
        lastName: "Operator",
        handle: `imp-${run}`,
        role: "ADMIN",
      },
      select: { id: true },
    });
    userId = user.id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.aptitudeImport.deleteMany({ where: { uploadedById: userId } });
      await db.user.delete({ where: { id: userId } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("the counters agree with the rows", () => {
    it("accepts counts that add up to the total", async () => {
      const row = await upload({ status: "DONE", total: 10, created: 7, revised: 1, unchanged: 1, failed: 1, finishedAt: new Date() });
      expect(row.total).toBe(10);
    });

    it("refuses counts that add up to more than the total", async () => {
      // An import whose counters exceed its rows is an import nobody can
      // reconcile against the file they uploaded.
      const message = await refused(() =>
        upload({ status: "DONE", total: 5, created: 5, failed: 1, finishedAt: new Date() }),
      );
      expect(message).toMatch(/AptitudeImport_counts_check/);
    });

    it("refuses a negative counter", async () => {
      expect(await refused(() => upload({ created: -1 }))).toMatch(/AptitudeImport_counts_check/);
    });

    it("allows counts BELOW the total, which is a crash mid-import", async () => {
      // Honest rather than refused: the parent says 300 rows and the rows say
      // 112, which is exactly what an operator needs to see.
      const row = await upload({ status: "DONE", total: 300, created: 112, finishedAt: new Date() });
      expect(row.total).toBe(300);
    });
  });

  describe("the file is a real file", () => {
    it("refuses a digest that is not a sha256", async () => {
      expect(await refused(() => upload({ fileSha256: "nope" }))).toMatch(/AptitudeImport_file_check/);
      expect(await refused(() => upload({ fileSha256: "A".repeat(64) }))).toMatch(/AptitudeImport_file_check/);
    });

    it("refuses a size past the upload cap", async () => {
      // The same 4 MB the route refuses before reading a body, stated again
      // where a back-fill script cannot step around it.
      expect(await refused(() => upload({ sizeBytes: BigInt(4 * 1024 * 1024 + 1) }))).toMatch(
        /AptitudeImport_file_check/,
      );
    });

    it("refuses an empty file name", async () => {
      expect(await refused(() => upload({ fileName: "   " }))).toMatch(/AptitudeImport_file_check/);
    });

    it("refuses a `via` that is neither an upload nor a named operator", async () => {
      expect(await refused(() => upload({ via: "somehow" }))).toMatch(/AptitudeImport_via_check/);
      const cli = await upload({ via: "cli:subash" });
      expect(cli.id).toBeTruthy();
    });
  });

  describe("a finished import carries the moment it finished", () => {
    it("accepts PROCESSING with no finish time", async () => {
      const row = await upload();
      expect(row.status).toBe("PROCESSING");
    });

    it("refuses PROCESSING with one", async () => {
      expect(await refused(() => upload({ finishedAt: new Date() }))).toMatch(/AptitudeImport_finished_check/);
    });

    it("refuses DONE without one", async () => {
      // An import that says DONE with no finish time is an import nobody can
      // put in order.
      expect(await refused(() => upload({ status: "DONE" }))).toMatch(/AptitudeImport_finished_check/);
    });

    it("refuses a finish before the start", async () => {
      const startedAt = new Date();
      expect(
        await refused(() => upload({ status: "DONE", startedAt, finishedAt: new Date(startedAt.getTime() - 1_000) })),
      ).toMatch(/AptitudeImport_finished_check/);
    });
  });

  describe("a whole-file failure says why", () => {
    it("refuses FAILED with no reason", async () => {
      // The reason is what an operator reads instead of re-uploading to find
      // out.
      expect(await refused(() => upload({ status: "FAILED", finishedAt: new Date() }))).toMatch(
        /AptitudeImport_error_check/,
      );
    });

    it("refuses a reason too short to be one", async () => {
      expect(await refused(() => upload({ status: "FAILED", error: "no", finishedAt: new Date() }))).toMatch(
        /AptitudeImport_error_check/,
      );
    });

    it("refuses a reason on an import that did NOT fail", async () => {
      expect(
        await refused(() => upload({ status: "DONE", error: "Something went wrong.", finishedAt: new Date() })),
      ).toMatch(/AptitudeImport_error_check/);
    });

    it("accepts FAILED with a real reason", async () => {
      const row = await upload({
        status: "FAILED",
        error: "The header is missing: text, explanation.",
        finishedAt: new Date(),
      });
      expect(row.status).toBe("FAILED");
    });
  });

  describe("every row says what happened to it", () => {
    async function parent() {
      return (await upload({ status: "DONE", total: 3, finishedAt: new Date() })).id;
    }

    it("refuses a FAILED row with no reasons", async () => {
      const importId = await parent();
      expect(
        await refused(() => db.aptitudeImportRow.create({ data: { importId, line: 2, status: "FAILED" } })),
      ).toMatch(/AptitudeImportRow_errors_check/);
    });

    it("refuses reasons on a row that did NOT fail", async () => {
      // A CREATED row carrying errors is a row whose status and its reasons
      // disagree, and a reader has to pick one to believe.
      const importId = await parent();
      expect(
        await refused(() =>
          db.aptitudeImportRow.create({
            data: {
              importId,
              line: 2,
              status: "CREATED",
              questionId: "q1",
              contentHash: SHA,
              errors: [{ path: "row", message: "something" }],
            },
          }),
        ),
      ).toMatch(/AptitudeImportRow_errors_check/);
    });

    it("refuses errors or warnings that are not lists", async () => {
      const importId = await parent();
      expect(
        await refused(() =>
          db.aptitudeImportRow.create({
            data: { importId, line: 2, status: "FAILED", errors: { message: "not a list" } },
          }),
        ),
      ).toMatch(/AptitudeImportRow_errors_check/);
    });

    it("requires an applied row to name the question it applied to", async () => {
      const importId = await parent();
      expect(
        await refused(() => db.aptitudeImportRow.create({ data: { importId, line: 2, status: "UNCHANGED" } })),
      ).toMatch(/AptitudeImportRow_applied_check/);
    });

    it("lets a FAILED row name the published question it was refused for", async () => {
      // Which is the commonest real failure: an operator edited a published
      // question in the export and uploaded it back.
      const importId = await parent();
      const row = await db.aptitudeImportRow.create({
        data: {
          importId,
          line: 7,
          status: "FAILED",
          questionId: "q-published",
          displayCode: "APT-00042",
          errors: [{ path: "row", message: "APT-00042 is published and its wording is frozen." }],
        },
        select: { line: true },
      });
      expect(row.line).toBe(7);
    });

    it("accepts warnings on an applied row", async () => {
      const importId = await parent();
      const row = await db.aptitudeImportRow.create({
        data: {
          importId,
          line: 3,
          status: "CREATED",
          questionId: "q2",
          contentHash: SHA,
          warnings: [{ path: "row", message: "The `marks` column is not stored." }],
        },
        select: { line: true },
      });
      expect(row.line).toBe(3);
    });

    it("refuses a line number below one", async () => {
      const importId = await parent();
      expect(
        await refused(() =>
          db.aptitudeImportRow.create({ data: { importId, line: 0, status: "UNCHANGED", questionId: "q", contentHash: SHA } }),
        ),
      ).toMatch(/AptitudeImportRow_line_check/);
    });

    it("refuses the same line twice in one import", async () => {
      const importId = await parent();
      const data = { importId, line: 4, status: "UNCHANGED" as const, questionId: "q3", contentHash: SHA };
      await db.aptitudeImportRow.create({ data });
      expect(await refused(() => db.aptitudeImportRow.create({ data }))).toMatch(/importId|line/);
    });

    it("takes its rows with it when the import is deleted", async () => {
      const importId = await parent();
      await db.aptitudeImportRow.create({
        data: { importId, line: 2, status: "UNCHANGED", questionId: "q4", contentHash: SHA },
      });
      await db.aptitudeImport.delete({ where: { id: importId } });
      expect(await db.aptitudeImportRow.count({ where: { importId } })).toBe(0);
    });
  });

  describe("the display-code sequence", () => {
    it("hands out a different number every time", async () => {
      // Why the importer uses a sequence rather than `max(displayCode) + 1`:
      // two concurrent imports reading the same max would be handed the same
      // code, and the unique index would fail a whole file for a reason that
      // has nothing to do with its contents.
      const take = async () => {
        const [row] = await db.$queryRawUnsafe<Array<{ next: bigint }>>(
          `SELECT nextval('public.aptitude_display_code_seq') AS next`,
        );
        return Number(row!.next);
      };
      const first = await take();
      const second = await take();
      const third = await take();
      expect(second).toBe(first + 1);
      expect(third).toBe(second + 1);
      // Five digits from the start, so every allocated code sorts in a list.
      expect(first).toBeGreaterThanOrEqual(1_000);
    });
  });

  describe("TRUNCATE", () => {
    it("is refused on both new tables", async () => {
      for (const table of ["AptitudeImport", "AptitudeImportRow"]) {
        const message = await refused(() => db.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`));
        expect(message, table).toMatch(/TRUNCATE/i);
      }
    });
  });
});
