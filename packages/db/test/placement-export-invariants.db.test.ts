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
 * `PlacementExport` (migration 20261020270100).
 *
 * The table exists so that a leaked CSV of five thousand students' readiness
 * is attributable to a PERSON rather than to "the dashboard". Everything
 * below follows from that one sentence: the row names a requester through a
 * RESTRICT foreign key, it carries a usable digest rather than a placeholder,
 * and it can never be edited or deleted — because a record the exporter can
 * remove is not a record of anything.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS
  ? "placement export invariants (live database)"
  : "placement export invariants (set RECX_DB_TESTS=1 to run)";

const DIGEST = "a".repeat(64);

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let officerId = "";
  const userIds: string[] = [];
  const exportIds: string[] = [];

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  const record = (over: Record<string, unknown> = {}) =>
    db.placementExport
      .create({
        data: {
          requestedById: officerId,
          columns: ["collegeId", "serviceScore", "serviceAvailableWeight"],
          rowCount: 4312,
          sha256: DIGEST,
          ...over,
        } as never,
        select: { id: true, rowCount: true, columns: true, sha256: true },
      })
      .then((row) => {
        exportIds.push(row.id);
        return row;
      });

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const row = await db.user.create({
      data: {
        collegeId: `PEX${run}o`,
        email: `pex-${run}-o@example.test`,
        firstName: "A",
        lastName: "Officer",
        handle: `pex-${run}-o`,
        role: "PLACEMENT_OFFICER",
      },
      select: { id: true },
    });
    officerId = row.id;
    userIds.push(row.id);
  });

  afterAll(async () => {
    if (!db) return;
    try {
      // The row refuses DELETE by trigger — that is the point of the table —
      // so the teardown disables the guard, exactly as a Phase 8 teardown
      // does for an append-only event log.
      await db.$executeRawUnsafe(`ALTER TABLE "PlacementExport" DISABLE TRIGGER "PlacementExport_append_only"`);
      await db.placementExport.deleteMany({ where: { id: { in: exportIds } } });
      await db.$executeRawUnsafe(`ALTER TABLE "PlacementExport" ENABLE TRIGGER "PlacementExport_append_only"`);
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("a record names a person, a column set and a digest", () => {
    it("accepts what the export route writes", async () => {
      const row = await record();
      expect(row.rowCount).toBe(4312);
      expect(row.columns).toEqual(["collegeId", "serviceScore", "serviceAvailableWeight"]);
      expect(row.sha256).toBe(DIGEST);
    });

    it("accepts an export of zero rows, which is a real answer", async () => {
      // A filter that matched nobody is worth recording: it says somebody
      // looked, and it is how an officer finds out their filter was wrong.
      const row = await record({ rowCount: 0 });
      expect(row.rowCount).toBe(0);
    });

    it("refuses a file with no columns", async () => {
      expect(await refused(() => record({ columns: [] }))).toMatch(/PlacementExport_columns_check/);
    });

    it("refuses a negative row count", async () => {
      expect(await refused(() => record({ rowCount: -1 }))).toMatch(/PlacementExport_columns_check/);
    });

    it("refuses a digest that is not a sha256", async () => {
      /**
       * A truncated or placeholder digest identifies nothing, and a column
       * that sometimes holds a hash and sometimes holds "pending" is worse
       * than no column — a reader cannot tell which rows are usable.
       */
      for (const bad of ["", "pending", DIGEST.slice(0, 63), `${DIGEST}a`, DIGEST.toUpperCase()]) {
        expect(await refused(() => record({ sha256: bad })), bad.slice(0, 12)).toMatch(
          /PlacementExport_sha256_check/,
        );
      }
    });

    it("refuses filters that are not an object", async () => {
      expect(await refused(() => record({ filters: [] }))).toMatch(/PlacementExport_filters_object/);
    });

    it("refuses a requester who does not exist", async () => {
      expect(await refused(() => record({ requestedById: `pex-nobody-${run}` }))).toMatch(
        /foreign key|requestedById_fkey/i,
      );
    });

    it("refuses deleting the requester while the record stands", async () => {
      /**
       * RESTRICT, not CASCADE: the record of who exported a cohort outlives
       * the convenience of deleting a staff account. A staff member who
       * leaves is deactivated, not removed, exactly as everywhere else here.
       */
      await record();
      expect(await refused(() => db.user.delete({ where: { id: officerId } }))).toMatch(
        /foreign key|RESTRICT|constraint/i,
      );
    });
  });

  describe("a record is append-only", () => {
    it("refuses an edit, to any column", async () => {
      const row = await record();
      for (const data of [{ rowCount: 1 }, { sha256: "b".repeat(64) }, { columns: ["collegeId"] }]) {
        const message = await refused(() => db.placementExport.update({ where: { id: row.id }, data }));
        expect(message).toMatch(/PlacementExport_append_only/);
        expect(message).toMatch(/never edited/);
      }
    });

    it("refuses a DELETE, which is what stops the exporter removing the evidence", async () => {
      const row = await record();
      const message = await refused(() => db.placementExport.delete({ where: { id: row.id } }));
      expect(message).toMatch(/PlacementExport_append_only/);
      expect(message).toMatch(/never deleted/);
    });

    it("refuses an edit through raw SQL too", async () => {
      await record();
      expect(
        await refused(() => db.$executeRawUnsafe(`UPDATE "PlacementExport" SET "rowCount" = 0`)),
      ).toMatch(/PlacementExport_append_only/);
    });

    it("refuses TRUNCATE", async () => {
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE "PlacementExport"`))).toMatch(/truncate/i);
    });
  });
});
