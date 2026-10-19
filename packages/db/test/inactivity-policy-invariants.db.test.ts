import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_INACTIVITY_POLICY, inactivityPolicySchema, resolveInactivityPolicy } from "@recx/shared";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type TestDb,
} from "./support/test-db";

/**
 * The inactivity policy invariants (migration 20261019260100).
 *
 * SPEC §5 Phase 8: "Every threshold is a Super-admin-configurable,
 * audit-logged setting rather than a constant, so the policy can be tightened
 * without a deploy." Two consequences this suite is about.
 *
 * First, the numbers live in rows — so the rows must be IMMUTABLE, because a
 * Phase 8c event cites the version it was decided under and an editable row
 * would turn old evidence into a lie.
 *
 * Second, and this is the one worth stating: there is NO numeric floor on
 * `disableAfterDays` in the database. A five-day auto-disable threshold is
 * accepted here, deliberately, and a test below proves it — because the spec
 * says the policy must be tightenable without a deploy and a constant in a
 * CHECK is a constant that needs a migration. The argument against short
 * thresholds is shown to the human who types one.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS
  ? "inactivity policy invariants (live database)"
  : "inactivity policy invariants (set RECX_DB_TESTS=1 to run)";

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let staffId = "";
  const written: number[] = [];

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  /**
   * Every policy this suite writes is INACTIVE unless a test says otherwise.
   *
   * `InactivityPolicy_active_scope_key` allows one active row per scope
   * across the whole table, so a fixture that defaulted to active would
   * collide with the seeded global policy and with every other test in the
   * file — the constraint doing its job, failing the suite for its own reason
   * rather than the code's.
   */
  const write = (over: Record<string, unknown> = {}) =>
    db.inactivityPolicy
      .create({
        data: {
          ...DEFAULT_INACTIVITY_POLICY,
          isActive: false,
          createdById: staffId,
          ...over,
        } as never,
        select: { version: true, isActive: true, autoDisableEnabled: true, disableAfterDays: true },
      })
      .then((row) => {
        written.push(row.version);
        return row;
      });

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    staffId = (
      await db.user.create({
        data: {
          collegeId: `POL${run}`,
          email: `pol-${run}@example.test`,
          firstName: "A",
          lastName: "Super",
          handle: `pol-${run}`,
          role: "SUPER_ADMIN",
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      // The policy row refuses DELETE by trigger — on purpose: a version is
      // cited by the decisions taken under it. Only the teardown lifts it.
      await db.$executeRawUnsafe(
        `ALTER TABLE "InactivityPolicy" DISABLE TRIGGER "InactivityPolicy_version_immutable"`,
      );
      await db.inactivityPolicy.deleteMany({ where: { version: { in: written } } });
      await db.$executeRawUnsafe(
        `ALTER TABLE "InactivityPolicy" ENABLE TRIGGER "InactivityPolicy_version_immutable"`,
      );
      await db.user.delete({ where: { id: staffId } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("the shipped default is writable, and cannot disable anybody", () => {
    it("accepts the default policy", async () => {
      const row = await write();
      expect(row.autoDisableEnabled).toBe(false);
      expect(row.version).toBeGreaterThan(0);
    });

    it("gives each row its own version, ascending", async () => {
      const first = await write();
      const second = await write();
      expect(second.version).toBeGreaterThan(first.version);
    });

    it("defaults autoDisableEnabled to false when the column is not named", async () => {
      const row = await db.$queryRawUnsafe<Array<{ autoDisableEnabled: boolean; graceDays: number }>>(
        `INSERT INTO "InactivityPolicy" ("isActive", "createdById") VALUES (false, $1)
         RETURNING "autoDisableEnabled", "graceDays", "version"`,
        staffId,
      );
      expect(row[0]?.autoDisableEnabled).toBe(false);
      expect(row[0]?.graceDays).toBe(2);
      written.push((row[0] as unknown as { version: number }).version);
    });
  });

  describe("the thresholds are in order, and a null rung is skipped", () => {
    it("accepts non-decreasing thresholds", async () => {
      const row = await write({ nudgeAfterDays: 3, warnAfterDays: 5, softRestrictAfterDays: 10, disableAfterDays: 30 });
      expect(row.version).toBeGreaterThan(0);
    });

    it("accepts two rungs on the same day", async () => {
      const row = await write({ nudgeAfterDays: 5, warnAfterDays: 5, softRestrictAfterDays: 10, disableAfterDays: 30 });
      expect(row.version).toBeGreaterThan(0);
    });

    it("refuses a warning that fires before its nudge", async () => {
      expect(await refused(() => write({ nudgeAfterDays: 10, warnAfterDays: 5 }))).toMatch(
        /InactivityPolicy_threshold_order_check/,
      );
    });

    it("refuses a restriction that fires before its warning", async () => {
      expect(await refused(() => write({ warnAfterDays: 12, softRestrictAfterDays: 10 }))).toMatch(
        /InactivityPolicy_threshold_order_check/,
      );
    });

    it("refuses a disable that fires before its restriction", async () => {
      expect(await refused(() => write({ softRestrictAfterDays: 40, disableAfterDays: 30 }))).toMatch(
        /InactivityPolicy_threshold_order_check/,
      );
    });

    it("accepts a null rung and still checks the rungs either side of it", async () => {
      const ok = await write({ nudgeAfterDays: 3, warnAfterDays: null, softRestrictAfterDays: 10 });
      expect(ok.version).toBeGreaterThan(0);
      // The case a CHECK on adjacent pairs ALONE would let through: with
      // `warn` null, nudge and softRestrict are no longer neighbours, and 20
      // > 10 has to be caught by the nudge ≤ softRestrict pair.
      expect(
        await refused(() => write({ nudgeAfterDays: 20, warnAfterDays: null, softRestrictAfterDays: 10 })),
      ).toMatch(/InactivityPolicy_threshold_order_check/);
    });

    it("accepts every rung null, which is a policy that never fires", async () => {
      const row = await write({
        nudgeAfterDays: null,
        warnAfterDays: null,
        softRestrictAfterDays: null,
        disableAfterDays: null,
        autoDisableEnabled: false,
      });
      expect(row.version).toBeGreaterThan(0);
    });

    it("refuses a threshold of zero, a negative one, or one over a year", async () => {
      for (const days of [0, -1, 366]) {
        expect(await refused(() => write({ nudgeAfterDays: days })), String(days)).toMatch(
          /InactivityPolicy_threshold_order_check/,
        );
      }
    });
  });

  describe("auto-disable", () => {
    it("needs a threshold, because a switch with none cannot be evaluated", async () => {
      expect(await refused(() => write({ autoDisableEnabled: true, disableAfterDays: null }))).toMatch(
        /InactivityPolicy_auto_disable_check/,
      );
    });

    it("ACCEPTS a five-day threshold — there is deliberately no floor in the database", async () => {
      /**
       * This test exists to stop the floor being re-added. An earlier draft
       * had `disableAfterDays >= 14` in the CHECK, which contradicted the
       * spec clause requiring every threshold to be configurable without a
       * deploy: the college's own stated wish would have needed a migration.
       *
       * The fortnight argument is real and it is shipped — as
       * AUTO_DISABLE_FLOOR_REASON above the field, with a typed confirmation
       * and a SECURITY audit. It is just not a constraint.
       */
      const row = await write({
        autoDisableEnabled: true,
        nudgeAfterDays: 2,
        warnAfterDays: 3,
        softRestrictAfterDays: 4,
        disableAfterDays: 5,
      });
      expect(row).toMatchObject({ autoDisableEnabled: true, disableAfterDays: 5 });
    });
  });

  describe("the bounds on the rest", () => {
    it("bounds graceDays to 0..30", async () => {
      expect((await write({ graceDays: 0 })).version).toBeGreaterThan(0);
      expect((await write({ graceDays: 30 })).version).toBeGreaterThan(0);
      expect(await refused(() => write({ graceDays: 31 }))).toMatch(/InactivityPolicy_grace_check/);
      expect(await refused(() => write({ graceDays: -1 }))).toMatch(/InactivityPolicy_grace_check/);
    });

    it("bounds minActivityPerDay to 1..20", async () => {
      expect((await write({ minActivityPerDay: 1 })).version).toBeGreaterThan(0);
      expect(await refused(() => write({ minActivityPerDay: 0 }))).toMatch(/InactivityPolicy_min_activity_check/);
      expect(await refused(() => write({ minActivityPerDay: 21 }))).toMatch(/InactivityPolicy_min_activity_check/);
    });

    it("bounds a department code, and allows null for every department", async () => {
      expect((await write({ departmentCode: null })).version).toBeGreaterThan(0);
      expect((await write({ departmentCode: "CSE" })).version).toBeGreaterThan(0);
      expect(await refused(() => write({ departmentCode: "C" }))).toMatch(/InactivityPolicy_scope_check/);
      expect(await refused(() => write({ departmentCode: "X".repeat(17) }))).toMatch(
        /InactivityPolicy_scope_check/,
      );
    });

    it("refuses turning the parent email on at all", async () => {
      // A parent address is third-party personal data and the consent record
      // it needs is not built in any phase of this plan. Dropped by the
      // migration of whatever phase builds consent, never by a flag flip.
      expect(await refused(() => write({ notifyParentEmail: true }))).toMatch(
        /InactivityPolicy_parent_email_check/,
      );
    });
  });

  describe("the activity map is a complete map of booleans", () => {
    it("accepts the four keys", async () => {
      const row = await write({ countsAsActivity: { submission: true, solve: true, login: false, lesson: true } });
      expect(row.version).toBeGreaterThan(0);
    });

    it("refuses a map missing a key", async () => {
      // Otherwise the counter reads `undefined` as "does not count", which is
      // the harshest reading arrived at by accident.
      expect(
        await refused(() => write({ countsAsActivity: { submission: true, solve: true, login: false } })),
      ).toMatch(/InactivityPolicy_counts_as_activity_check/);
    });

    it("refuses a key that is not a boolean", async () => {
      expect(
        await refused(() =>
          write({ countsAsActivity: { submission: "yes", solve: true, login: false, lesson: true } }),
        ),
      ).toMatch(/InactivityPolicy_counts_as_activity_check/);
    });

    it("refuses an array or a scalar in place of the map", async () => {
      expect(await refused(() => write({ countsAsActivity: [] }))).toMatch(
        /InactivityPolicy_counts_as_activity_check/,
      );
      expect(await refused(() => write({ countsAsActivity: 7 }))).toMatch(
        /InactivityPolicy_counts_as_activity_check/,
      );
    });
  });

  describe("at most one active policy per scope", () => {
    /**
     * What these assert on, and why it is not the constraint's name.
     *
     * Postgres says `duplicate key value violates unique constraint
     * "InactivityPolicy_active_scope_key"`, but Prisma maps every unique
     * violation — raw queries included — to P2002 and rewrites the message
     * as the FIELDS it parsed out of the index. The name does not survive.
     *
     * So the assertion is on the COALESCE expressions, which Prisma does
     * render and which no other index in this schema has. That is the part
     * worth pinning anyway: it proves the EXPRESSION index fired rather than
     * some plain column index, and an expression index that lost its COALESCE
     * would stop treating two global policies as one. `guard-state.db.test.ts`
     * checks the name against `pg_get_indexdef`, where it does survive.
     */
    const ACTIVE_SCOPE_VIOLATION = /COALESCE\(batchYear[\s\S]*COALESCE\(departmentCode/;
    /** Prisma renders the key list with ESCAPED quotes; compare without them. */
    const plain = (message: string) => message.replace(/[\\"]/g, "");

    const insertRaw = (batchYear: number | null, departmentCode: string | null) =>
      db.$executeRawUnsafe(
        `INSERT INTO "InactivityPolicy" ("isActive", "batchYear", "departmentCode", "createdById")
         VALUES (true, $1, $2, $3)`,
        batchYear,
        departmentCode,
        staffId,
      );

    /** Retire whatever this test activated, even when its assertion throws. */
    const activated: number[] = [];
    const activate = async (batchYear: number | null, departmentCode: string | null) => {
      const row = await write({ isActive: true, batchYear, departmentCode });
      activated.push(row.version);
      return row;
    };
    afterEach(async () => {
      for (const version of activated.splice(0)) {
        await db.inactivityPolicy.update({ where: { version }, data: { isActive: false } });
      }
    });

    it("refuses a second active GLOBAL policy — nulls are treated as equal", async () => {
      /**
       * The reason the index is on COALESCE expressions rather than on the
       * columns: a plain unique index treats two NULL batch years as
       * distinct, both rows stay active, and `resolveInactivityPolicy()`
       * stops being single-valued — two policies, same scope, and whichever
       * the planner returned first would decide a student's account.
       */
      const first = await activate(null, null);
      expect(first.isActive).toBe(true);
      expect(plain(await refused(() => insertRaw(null, null)))).toMatch(ACTIVE_SCOPE_VIOLATION);
    });

    it("refuses a second active policy for the same batch and department", async () => {
      await activate(2027, "CSE");
      expect(plain(await refused(() => insertRaw(2027, "CSE")))).toMatch(ACTIVE_SCOPE_VIOLATION);
    });

    it("refuses a second active policy for the same batch with no department", async () => {
      await activate(2027, null);
      expect(plain(await refused(() => insertRaw(2027, null)))).toMatch(ACTIVE_SCOPE_VIOLATION);
    });

    it("allows active policies at DIFFERENT scopes at once", async () => {
      const a = await write({ isActive: true, batchYear: 2028, departmentCode: null });
      const b = await write({ isActive: true, batchYear: null, departmentCode: "ECE" });
      const c = await write({ isActive: true, batchYear: 2028, departmentCode: "ECE" });
      expect([a, b, c].every((row) => row.isActive)).toBe(true);
      for (const row of [a, b, c]) {
        await db.inactivityPolicy.update({ where: { version: row.version }, data: { isActive: false } });
      }
    });

    it("allows any number of INACTIVE policies at one scope — that is the version history", async () => {
      const rows = [await write({ batchYear: 2029 }), await write({ batchYear: 2029 }), await write({ batchYear: 2029 })];
      expect(rows.every((row) => row.isActive === false)).toBe(true);
    });

    it("lets a scope be re-activated once the previous row is retired", async () => {
      const first = await write({ isActive: true, batchYear: 2030 });
      await db.inactivityPolicy.update({ where: { version: first.version }, data: { isActive: false } });
      const second = await write({ isActive: true, batchYear: 2030 });
      expect(second.isActive).toBe(true);
      await db.inactivityPolicy.update({ where: { version: second.version }, data: { isActive: false } });
    });
  });

  describe("a version is immutable, and never deleted", () => {
    it("allows isActive to move, because that is how a policy is retired", async () => {
      const row = await write({ isActive: true, batchYear: 2031 });
      const retired = await db.inactivityPolicy.update({
        where: { version: row.version },
        data: { isActive: false },
        select: { isActive: true },
      });
      expect(retired.isActive).toBe(false);
    });

    it.each([
      ["nudgeAfterDays", { nudgeAfterDays: 1 }],
      ["disableAfterDays", { disableAfterDays: 90 }],
      ["autoDisableEnabled", { autoDisableEnabled: true }],
      ["graceDays", { graceDays: 7 }],
      ["minActivityPerDay", { minActivityPerDay: 3 }],
      ["excludeNonWorkingDays", { excludeNonWorkingDays: false }],
      ["excludeApprovedLeave", { excludeApprovedLeave: false }],
      ["notifyMentor", { notifyMentor: false }],
      ["batchYear", { batchYear: 2032 }],
      ["departmentCode", { departmentCode: "MECH" }],
      ["countsAsActivity", { countsAsActivity: { submission: false, solve: true, login: false, lesson: true } }],
    ])("refuses an edit to %s — a threshold change is a NEW version", async (_field, data) => {
      const row = await write();
      const message = await refused(() =>
        db.inactivityPolicy.update({ where: { version: row.version }, data: data as never }),
      );
      expect(message).toMatch(/InactivityPolicy_version_immutable/);
      expect(message).toMatch(/NEW version/);
    });

    it("refuses an edit through raw SQL too", async () => {
      const row = await write();
      const message = await refused(() =>
        db.$executeRawUnsafe(
          `UPDATE "InactivityPolicy" SET "disableAfterDays" = 7 WHERE "version" = ${row.version}`,
        ),
      );
      expect(message).toMatch(/InactivityPolicy_version_immutable/);
    });

    it("refuses DELETE: a version is cited by the decisions taken under it", async () => {
      const row = await write();
      const message = await refused(() => db.inactivityPolicy.delete({ where: { version: row.version } }));
      expect(message).toMatch(/InactivityPolicy_version_immutable/);
      expect(message).toMatch(/deactivate it instead/);
    });

    it("refuses TRUNCATE", async () => {
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE "InactivityPolicy"`))).toMatch(/TRUNCATE/i);
    });
  });

  describe("the zod schema and the CHECKs agree", () => {
    /**
     * Not a style point. `inactivityPolicySchema` is what a settings form is
     * validated against and the CHECKs are what the database enforces; where
     * they disagree, a super-admin either gets an unexplained database error
     * or saves something the form should have refused.
     */
    const cases: Array<[string, Record<string, unknown>]> = [
      ["the default", {}],
      ["backwards thresholds", { nudgeAfterDays: 10, warnAfterDays: 5 }],
      ["a null middle rung with crossed neighbours", { nudgeAfterDays: 20, warnAfterDays: null, softRestrictAfterDays: 10 }],
      ["auto-disable with no threshold", { autoDisableEnabled: true, disableAfterDays: null }],
      ["a five-day auto-disable", { autoDisableEnabled: true, nudgeAfterDays: 2, warnAfterDays: 3, softRestrictAfterDays: 4, disableAfterDays: 5 }],
      ["grace over the cap", { graceDays: 31 }],
      ["no activity floor", { minActivityPerDay: 0 }],
      ["a one-letter department", { departmentCode: "C" }],
      ["the parent email on", { notifyParentEmail: true }],
    ];

    it.each(cases)("agree on %s", async (_name, over) => {
      const candidate = { ...DEFAULT_INACTIVITY_POLICY, isActive: false, ...over };
      const schemaOk = inactivityPolicySchema.safeParse(candidate).success;
      let dbOk = true;
      try {
        await write(over);
      } catch {
        dbOk = false;
      }
      expect(dbOk, `zod says ${schemaOk}, the database says ${dbOk}`).toBe(schemaOk);
    });
  });

  describe("resolution over rows the database actually holds", () => {
    it("picks the most specific ACTIVE policy, matching the pure resolver", async () => {
      const global = await write({ isActive: true, batchYear: null, departmentCode: null });
      const batch = await write({ isActive: true, batchYear: 2033, departmentCode: null });
      const both = await write({ isActive: true, batchYear: 2033, departmentCode: "CSE" });

      const rows = await db.inactivityPolicy.findMany({
        where: { version: { in: [global.version, batch.version, both.version] } },
      });
      const shaped = rows.map((row) => ({
        ...row,
        countsAsActivity: row.countsAsActivity as never,
      }));

      expect(resolveInactivityPolicy(shaped as never, { batchYear: 2033, departmentCode: "CSE" })?.version).toBe(
        both.version,
      );
      expect(resolveInactivityPolicy(shaped as never, { batchYear: 2033, departmentCode: "ECE" })?.version).toBe(
        batch.version,
      );
      expect(resolveInactivityPolicy(shaped as never, { batchYear: 2099, departmentCode: "ECE" })?.version).toBe(
        global.version,
      );

      for (const row of [global, batch, both]) {
        await db.inactivityPolicy.update({ where: { version: row.version }, data: { isActive: false } });
      }
    });
  });
});
