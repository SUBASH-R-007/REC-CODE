import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAuditEntriesInTx } from "../src/audit";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type TestDb,
} from "./support/test-db";

/**
 * Drives, the human eligibility decision, and the signed export
 * (migration 20261020270200).
 *
 * The suite exists for one assertion above all others. SPEC §5 says
 * eligibility for a drive is "a human decision recorded in the audit log",
 * and the design's own review caught an earlier draft overclaiming what the
 * database could enforce about that: a NOT NULL actor with a foreign key does
 * NOT make an automatic decision impossible, because any job holding a staff
 * user id satisfies both.
 *
 * What IS enforceable is that a decision is attributable, reasoned,
 * immutable, and cannot exist without an `AuditLog` row written in the same
 * transaction. The last of those is a DEFERRED constraint trigger, and the
 * two tests that matter are: a decision inserted alone does not commit, and
 * a decision inserted with its audit row does.
 */

const run = (randomBytes(3).readUIntBE(0, 3) % 90_000) + 10_000;
const TITLE = RUN_DB_TESTS
  ? "drive and export invariants (live database)"
  : "drive and export invariants (set RECX_DB_TESTS=1 to run)";

const code = (suffix: string) => `${"c".repeat(24 - suffix.length)}${suffix}`;
const SIGNATURE = "s".repeat(64);

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let studentId = "";
  let otherStudentId = "";
  let officerId = "";
  let driveId = "";
  const userIds: string[] = [];
  const driveIds: string[] = [];
  const decisionIds: string[] = [];
  const codes: string[] = [];

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  /** A decision AND its audit row, in one transaction — the only legal way. */
  async function decide(over: Record<string, unknown> = {}): Promise<string> {
    const id = `dec_${run}_${decisionIds.length}_${randomBytes(3).toString("hex")}`;
    await db.$transaction(async (tx) => {
      await tx.driveEligibilityDecision.create({
        data: {
          id,
          driveId,
          userId: studentId,
          decision: "ELIGIBLE",
          reason: "Clears the bar and has the breadth for this company's rounds.",
          decidedById: officerId,
          ...over,
        } as never,
      });
      await appendAuditEntriesInTx(tx, [
        {
          actorId: officerId,
          action: "placement.eligibility_decided",
          entityType: "DriveEligibilityDecision",
          entityId: id,
          targetUserId: (over.userId as string) ?? studentId,
          sensitivity: "SENSITIVE",
        },
      ]);
    });
    decisionIds.push(id);
    return id;
  }

  /**
   * A drive nothing has been decided on yet.
   *
   * Needed because `@@unique([driveId, userId])` fires on the same insert as
   * the constraint under test: the no-decider test first failed with a unique
   * violation rather than the foreign-key one, which would have left the
   * foreign key untested while the suite went green.
   */
  async function freshDrive(label: string): Promise<string> {
    const row = await db.placementDrive.create({
      data: {
        companyName: `${label} ${run}`,
        tier: "PRODUCT",
        driveOn: new Date("2095-04-01T00:00:00.000Z"),
        createdById: officerId,
      },
      select: { id: true },
    });
    driveIds.push(row.id);
    return row.id;
  }

  const exportRow = (over: Record<string, unknown> = {}) =>
    db.profileExport
      .create({
        data: {
          code: code(`x${codes.length}${run}`),
          userId: studentId,
          kind: "PROFILE",
          payload: { v: 1, name: "A B" },
          rulesVersion: 1,
          signature: SIGNATURE,
          ...over,
        } as never,
        select: { code: true, revokedAt: true, algorithm: true },
      })
      .then((row) => {
        codes.push(row.code);
        return row;
      });

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const mk = async (suffix: string, role: "STUDENT" | "PLACEMENT_OFFICER") => {
      const row = await db.user.create({
        data: {
          collegeId: `DRV${run}${suffix}`,
          email: `drv-${run}-${suffix}@example.test`,
          firstName: "A",
          lastName: suffix,
          handle: `drv-${run}-${suffix}`,
          role,
        },
        select: { id: true },
      });
      userIds.push(row.id);
      return row.id;
    };
    studentId = await mk("s", "STUDENT");
    otherStudentId = await mk("t", "STUDENT");
    officerId = await mk("o", "PLACEMENT_OFFICER");

    const drive = await db.placementDrive.create({
      data: {
        companyName: `Verify Corp ${run}`,
        tier: "PRODUCT",
        driveOn: new Date("2095-02-01T00:00:00.000Z"),
        thresholdScore: 70,
        eligibleDepartmentCodes: ["CSE"],
        createdById: officerId,
      },
      select: { id: true },
    });
    driveId = drive.id;
    driveIds.push(drive.id);
  });

  afterAll(async () => {
    if (!db) return;
    try {
      for (const [table, trigger] of [
        ["DriveEligibilityDecision", "DriveEligibilityDecision_append_only"],
        ["ProfileExport", "ProfileExport_payload_frozen"],
      ] as const) {
        await db.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
      }
      await db.profileExport.deleteMany({ where: { code: { in: codes } } });
      await db.driveEligibilityDecision.deleteMany({ where: { driveId: { in: driveIds } } });
      for (const [table, trigger] of [
        ["DriveEligibilityDecision", "DriveEligibilityDecision_append_only"],
        ["ProfileExport", "ProfileExport_payload_frozen"],
      ] as const) {
        await db.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
      }
      // The audit chain is append-only by design; its rows for these
      // decisions stay, which is correct — the log outlives the fixture.
      await db.placementDrive.deleteMany({ where: { id: { in: driveIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("a drive", () => {
    it("refuses a company name nobody could recognise", async () => {
      expect(
        await refused(() =>
          db.placementDrive.create({
            data: {
              companyName: " X ",
              tier: "TOP",
              driveOn: new Date("2095-03-01T00:00:00.000Z"),
              createdById: officerId,
            },
          }),
        ),
      ).toMatch(/PlacementDrive_company_check/);
    });

    it("bounds the threshold to 0..100, and allows none at all", async () => {
      expect(
        await refused(() =>
          db.placementDrive.create({
            data: {
              companyName: `Over Corp ${run}`,
              tier: "TOP",
              driveOn: new Date("2095-03-02T00:00:00.000Z"),
              thresholdScore: 101,
              createdById: officerId,
            },
          }),
        ),
      ).toMatch(/PlacementDrive_threshold_check/);

      // Null is a real answer: a drive with no readiness bar at all.
      const open = await db.placementDrive.create({
        data: {
          companyName: `Open Corp ${run}`,
          tier: "SERVICE",
          driveOn: new Date("2095-03-03T00:00:00.000Z"),
          createdById: officerId,
        },
        select: { id: true, thresholdScore: true },
      });
      driveIds.push(open.id);
      expect(open.thresholdScore).toBeNull();
    });
  });

  describe("an eligibility decision cannot exist without its audit row", () => {
    it("REFUSES a decision inserted alone — at COMMIT, not at insert", async () => {
      /**
       * The assertion the whole table is for. The INSERT itself succeeds —
       * the trigger is `DEFERRABLE INITIALLY DEFERRED` — and the transaction
       * then fails to commit. That is the shape that makes the guarantee
       * reachable: the audit chain takes a per-day advisory lock and appends
       * with its own hash link, so the decision and its audit row cannot be
       * written in a fixed order without one waiting on the other.
       */
      const message = await refused(() =>
        db.$transaction(async (tx) => {
          await tx.driveEligibilityDecision.create({
            data: {
              driveId,
              userId: otherStudentId,
              decision: "NOT_ELIGIBLE",
              reason: "Short of the bar on breadth, and the drive is in three days.",
              decidedById: officerId,
            },
          });
          // No audit row. Nothing else is wrong with this write.
        }),
      );
      expect(message).toMatch(/DriveEligibilityDecision_requires_audit/);
      expect(message).toMatch(/human decision recorded in the audit log/);

      // And nothing was left behind: the whole transaction rolled back.
      expect(await db.driveEligibilityDecision.count({ where: { userId: otherStudentId } })).toBe(0);
    });

    it("accepts a decision written with its audit row", async () => {
      const id = await decide();
      const row = await db.driveEligibilityDecision.findUniqueOrThrow({
        where: { id },
        select: { decision: true, decidedById: true },
      });
      expect(row).toEqual({ decision: "ELIGIBLE", decidedById: officerId });
      const audited = await db.auditLog.count({
        where: { entityType: "DriveEligibilityDecision", entityId: id },
      });
      expect(audited).toBe(1);
    });

    it("refuses an audit row for a DIFFERENT decision", async () => {
      // The trigger matches on the decision's own id, so auditing something
      // else in the same transaction does not satisfy it.
      const message = await refused(() =>
        db.$transaction(async (tx) => {
          await tx.driveEligibilityDecision.create({
            data: {
              driveId,
              userId: otherStudentId,
              decision: "ELIGIBLE",
              reason: "A reason long enough to pass the check on its own.",
              decidedById: officerId,
            },
          });
          await appendAuditEntriesInTx(tx, [
            {
              actorId: officerId,
              action: "placement.eligibility_decided",
              entityType: "DriveEligibilityDecision",
              entityId: `dec_not_this_one_${run}`,
              sensitivity: "SENSITIVE",
            },
          ]);
        }),
      );
      expect(message).toMatch(/DriveEligibilityDecision_requires_audit/);
    });
  });

  describe("a decision names a person, a reason, and is said once", () => {
    it("refuses a reason too short for anybody to act on", async () => {
      const drive = await freshDrive("Short Reason Corp");
      expect(await refused(() => decide({ driveId: drive, reason: "no" }))).toMatch(
        /DriveEligibilityDecision_reason_present/,
      );
    });

    it("refuses a decision with no decider", async () => {
      const drive = await freshDrive("No Decider Corp");
      expect(await refused(() => decide({ driveId: drive, decidedById: `drv-nobody-${run}` }))).toMatch(
        /foreign key|decidedById_fkey/i,
      );
    });

    it("holds ONE decision per student per drive", async () => {
      await decide({ userId: otherStudentId });
      expect(await refused(() => decide({ userId: otherStudentId }))).toMatch(/Unique|driveId_userId/i);
    });

    it("refuses an edit and a delete", async () => {
      const id = await decide({ driveId: await freshDrive("Immutable Corp") });
      for (const data of [{ decision: "NOT_ELIGIBLE" as const }, { reason: "A different reason entirely." }]) {
        const message = await refused(() => db.driveEligibilityDecision.update({ where: { id }, data }));
        expect(message).toMatch(/DriveEligibilityDecision_append_only/);
        expect(message).toMatch(/never edited/);
      }
      expect(await refused(() => db.driveEligibilityDecision.delete({ where: { id } }))).toMatch(
        /never deleted/,
      );
    });

    it("refuses deleting a drive that has decisions", async () => {
      // The decisions ARE the record of what the drive was used for.
      expect(await refused(() => db.placementDrive.delete({ where: { id: driveId } }))).toMatch(
        /foreign key|RESTRICT|constraint/i,
      );
    });

    it("refuses TRUNCATE", async () => {
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE "DriveEligibilityDecision"`))).toMatch(
        /truncate/i,
      );
    });
  });

  describe("a signed export is frozen", () => {
    it("accepts what the action writes, with the algorithm defaulted", async () => {
      const row = await exportRow();
      expect(row.algorithm).toBe("HMAC-SHA256");
      expect(row.revokedAt).toBeNull();
    });

    it("refuses a code that is not 24 url-safe characters", async () => {
      for (const bad of ["short", `${"c".repeat(25)}`, `${"c".repeat(23)}/`]) {
        expect(await refused(() => exportRow({ code: bad })), bad.slice(0, 8)).toMatch(
          /ProfileExport_code_check/,
        );
      }
    });

    it("refuses a signature too short to be one, and a zero rules version", async () => {
      expect(await refused(() => exportRow({ signature: "nope" }))).toMatch(/ProfileExport_code_check/);
      expect(await refused(() => exportRow({ rulesVersion: 0 }))).toMatch(/ProfileExport_code_check/);
    });

    it("refuses a payload that is not an object", async () => {
      expect(await refused(() => exportRow({ payload: [] }))).toMatch(/ProfileExport_payload_object/);
    });

    it("refuses an expiry at or before the issue time", async () => {
      const issuedAt = new Date("2095-01-01T00:00:00.000Z");
      expect(await refused(() => exportRow({ issuedAt, expiresAt: issuedAt }))).toMatch(
        /ProfileExport_expiry_after_issue/,
      );
    });

    it("pairs the revocation with who revoked it", async () => {
      const row = await exportRow();
      expect(
        await refused(() => db.profileExport.update({ where: { code: row.code }, data: { revokedAt: new Date() } })),
      ).toMatch(/ProfileExport_revoke_pair/);
    });

    it("REFUSES a change to the payload, the signature or the owner", async () => {
      /**
       * A signature over a mutable payload verifies nothing. This is the
       * whole reason the table has a trigger rather than only CHECKs.
       */
      const row = await exportRow();
      const cases: Array<[string, Record<string, unknown>]> = [
        ["the payload", { payload: { v: 1, name: "Somebody Else" } }],
        ["the signature", { signature: "z".repeat(64) }],
        ["the algorithm", { algorithm: "none" }],
        ["the rules version", { rulesVersion: 2 }],
        ["the owner", { userId: otherStudentId }],
        ["the issue time", { issuedAt: new Date("2000-01-01T00:00:00.000Z") }],
        ["the expiry", { expiresAt: new Date("2099-01-01T00:00:00.000Z") }],
      ];
      for (const [what, data] of cases) {
        const message = await refused(() => db.profileExport.update({ where: { code: row.code }, data }));
        expect(message, what).toMatch(/ProfileExport_payload_frozen/);
        expect(message, what).toMatch(/verifies nothing/);
      }
    });

    it("lets the student withdraw it, once", async () => {
      const row = await exportRow();
      const revoked = await db.profileExport.update({
        where: { code: row.code },
        data: { revokedAt: new Date(), revokedById: studentId },
        select: { revokedAt: true },
      });
      expect(revoked.revokedAt).not.toBeNull();

      // Un-revoking would let somebody re-publish a record the student had
      // pulled back.
      const message = await refused(() =>
        db.profileExport.update({ where: { code: row.code }, data: { revokedAt: new Date(0) } }),
      );
      expect(message).toMatch(/stays withdrawn/);
    });

    it("is revoked, never deleted", async () => {
      const row = await exportRow();
      expect(await refused(() => db.profileExport.delete({ where: { code: row.code } }))).toMatch(
        /revoked, never deleted/,
      );
    });

    it("refuses TRUNCATE", async () => {
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE "ProfileExport"`))).toMatch(/truncate/i);
    });
  });
});
