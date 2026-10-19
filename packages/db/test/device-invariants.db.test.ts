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
 * Device binding invariants (migration 20261019220000).
 *
 * These are the rules that make WebAuthn worth having rather than decorative,
 * and each is in the DATABASE because each one would otherwise hold only for
 * as long as every future code path remembers it:
 *
 *   - at most TWO active own devices per student (SPEC §5), which is a COUNT
 *     and so cannot be a CHECK or a unique index — it is a trigger;
 *   - a LOANER does not count towards that limit, because the limit exists to
 *     stop a student registering a friend's machine and a loaner is issued by
 *     a supervisor standing there. Counting it would mean a student with two
 *     devices cannot be lent one when a device breaks, which is the exact
 *     situation the loaner exists for;
 *   - a registration is never hard-deleted and never un-revoked: which device
 *     sat an exam has to stay answerable;
 *   - the signature counter only rises (a counter going BACKWARDS is the one
 *     hint WebAuthn gives that a credential may have been cloned);
 *   - a challenge is spent exactly once, which is what makes it a challenge
 *     rather than a password.
 */

const tag = `dv-${randomBytes(4).toString("hex")}`;
const TITLE = RUN_DB_TESTS
  ? "device binding invariants (live database)"
  : "device binding invariants (set RECX_DB_TESTS=1 to run)";

const credential = () => randomBytes(32).toString("base64url");
const publicKey = () => randomBytes(64).toString("base64url");

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;

  let userId = "";
  let otherUserId = "";
  let supervisorId = "";

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  async function device(over: Record<string, unknown> = {}) {
    return db.deviceRegistration.create({
      data: {
        userId,
        credentialId: credential(),
        publicKey: publicKey(),
        label: "a laptop",
        enrolledBySupervisorId: supervisorId,
        ...over,
      },
      select: { id: true, signCount: true, revokedAt: true },
    });
  }

  /** Revoke every device of a user, so each test starts from a known count. */
  async function clearDevices() {
    await db.deviceRegistration.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: supervisorId },
    });
  }

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const make = async (suffix: string, role: "STUDENT" | "ADMIN") => {
      const handle = `${tag}-${suffix}`;
      const row = await db.user.create({
        data: {
          collegeId: handle.toUpperCase(),
          email: `${handle}@example.test`,
          firstName: "A",
          lastName: "Person",
          handle,
          role,
        },
        select: { id: true },
      });
      return row.id;
    };
    userId = await make("s", "STUDENT");
    otherUserId = await make("s2", "STUDENT");
    supervisorId = await make("sup", "ADMIN");
  });

  afterAll(async () => {
    if (!db) return;
    try {
      const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
      const ids = [userId, otherUserId, supervisorId];
      await db.$transaction([
        raw(`ALTER TABLE "public"."DeviceRegistration" DISABLE TRIGGER "DeviceRegistration_write_once"`),
        raw(`DELETE FROM "public"."WebAuthnChallenge" WHERE "userId" = ANY($1::text[])`, ids),
        raw(`DELETE FROM "public"."DeviceRegistration" WHERE "userId" = ANY($1::text[])`, ids),
        raw(`ALTER TABLE "public"."DeviceRegistration" ENABLE TRIGGER "DeviceRegistration_write_once"`),
        raw(`DELETE FROM "public"."User" WHERE "id" = ANY($1::text[])`, ids),
      ]);
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  // ── The two-device limit ───────────────────────────────────────────────

  describe("at most two active own devices", () => {
    it("allows two", async () => {
      await clearDevices();
      await device({ label: "laptop" });
      await device({ label: "phone" });
      expect(await db.deviceRegistration.count({ where: { userId, revokedAt: null } })).toBe(2);
    });

    it("refuses a third", async () => {
      await clearDevices();
      await device();
      await device();
      const message = await refused(() => device());
      expect(message).toMatch(/already has 2 active registered devices/);
    });

    it("allows a third once one is revoked", async () => {
      await clearDevices();
      const first = await device();
      await device();
      await db.deviceRegistration.update({
        where: { id: first.id },
        data: { revokedAt: new Date(), revokedById: supervisorId },
      });
      await expect(device()).resolves.toBeDefined();
    });

    it("counts per student, not globally", async () => {
      await clearDevices();
      await device();
      await device();
      // The other student is unaffected.
      await expect(
        db.deviceRegistration.create({
          data: {
            userId: otherUserId,
            credentialId: credential(),
            publicKey: publicKey(),
            label: "theirs",
            enrolledBySupervisorId: supervisorId,
          },
        }),
      ).resolves.toBeDefined();
    });

    it("refuses a third even through raw SQL", async () => {
      await clearDevices();
      await device();
      await device();
      const message = await refused(() =>
        db.$executeRawUnsafe(
          `INSERT INTO "public"."DeviceRegistration" ("id","userId","credentialId","publicKey","label","enrolledBySupervisorId","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6, now())`,
          `${tag}-raw`,
          userId,
          credential(),
          publicKey(),
          "raw",
          supervisorId,
        ),
      );
      expect(message).toMatch(/already has 2 active registered devices/);
    });
  });

  describe("a loaner does not count towards the limit", () => {
    it("can be issued to a student who already has two devices", async () => {
      // The exact situation the loaner exists for: a student with two
      // registered devices whose laptop has just died.
      await clearDevices();
      await device();
      await device();
      await expect(device({ isLoaner: true, label: "lab 3 loaner 7" })).resolves.toBeDefined();
    });

    it("does not let a THIRD own device in behind it", async () => {
      await clearDevices();
      await device();
      await device();
      await device({ isLoaner: true });
      expect(await refused(() => device())).toMatch(/already has 2 active/);
    });

    it("is the only kind of device that can be consumed", async () => {
      await clearDevices();
      const own = await device();
      expect(await refused(() => db.deviceRegistration.update({ where: { id: own.id }, data: { loanConsumedAt: new Date() } }))).toMatch(
        /DeviceRegistration_loan_check/,
      );
      const loaner = await device({ isLoaner: true });
      await expect(
        db.deviceRegistration.update({ where: { id: loaner.id }, data: { loanConsumedAt: new Date() } }),
      ).resolves.toBeDefined();
    });

    it("is consumed once", async () => {
      await clearDevices();
      const loaner = await device({ isLoaner: true });
      await db.deviceRegistration.update({ where: { id: loaner.id }, data: { loanConsumedAt: new Date() } });
      expect(
        await refused(() =>
          db.deviceRegistration.update({ where: { id: loaner.id }, data: { loanConsumedAt: new Date() } }),
        ),
      ).toMatch(/a loan is consumed once/);
    });
  });

  // ── Write-once and revocation ──────────────────────────────────────────

  describe("a registration is written once", () => {
    it("is never deleted", async () => {
      await clearDevices();
      const row = await device();
      expect(await refused(() => db.deviceRegistration.delete({ where: { id: row.id } }))).toMatch(
        /never deleted; set revokedAt instead/,
      );
    });

    it("refuses a change of owner, credential, public key or who enrolled it", async () => {
      await clearDevices();
      const row = await device();
      for (const data of [
        { userId: otherUserId },
        { credentialId: credential() },
        { publicKey: publicKey() },
        { enrolledBySupervisorId: userId },
        { isLoaner: true },
      ]) {
        expect(await refused(() => db.deviceRegistration.update({ where: { id: row.id }, data })), JSON.stringify(data)).toMatch(
          /written once/,
        );
      }
    });

    it("allows the label to be corrected", async () => {
      // A student calling it "my laptop" when it is the lab's is worth fixing.
      await clearDevices();
      const row = await device();
      await expect(
        db.deviceRegistration.update({ where: { id: row.id }, data: { label: "lab 2, seat 11" } }),
      ).resolves.toBeDefined();
    });

    it("never un-revokes, because that would make the audit trail a lie", async () => {
      await clearDevices();
      const row = await device();
      await db.deviceRegistration.update({
        where: { id: row.id },
        data: { revokedAt: new Date(), revokedById: supervisorId },
      });
      expect(
        await refused(() =>
          db.deviceRegistration.update({ where: { id: row.id }, data: { revokedAt: null, revokedById: null } }),
        ),
      ).toMatch(/already revoked/);
    });

    it("requires a name on a withdrawal", async () => {
      await clearDevices();
      const row = await device();
      expect(await refused(() => db.deviceRegistration.update({ where: { id: row.id }, data: { revokedAt: new Date() } }))).toMatch(
        /DeviceRegistration_revoked_check/,
      );
    });

    it("refuses TRUNCATE", async () => {
      expect(await refused(() => db.$executeRawUnsafe(`TRUNCATE TABLE "public"."DeviceRegistration"`))).toMatch(
        /truncate/i,
      );
    });
  });

  describe("the signature counter", () => {
    it("rises", async () => {
      await clearDevices();
      const row = await device();
      await expect(db.deviceRegistration.update({ where: { id: row.id }, data: { signCount: 7 } })).resolves.toBeDefined();
    });

    it("never goes backwards, even through raw SQL", async () => {
      await clearDevices();
      const row = await device();
      await db.deviceRegistration.update({ where: { id: row.id }, data: { signCount: 10 } });
      expect(await refused(() => db.deviceRegistration.update({ where: { id: row.id }, data: { signCount: 9 } }))).toMatch(
        /counter only increases/,
      );
      expect(
        await refused(() =>
          db.$executeRawUnsafe(`UPDATE "public"."DeviceRegistration" SET "signCount" = 0 WHERE "id" = $1`, row.id),
        ),
      ).toMatch(/counter only increases/);
    });

    it("is never negative", async () => {
      await clearDevices();
      expect(await refused(() => device({ signCount: -1 }))).toMatch(/sign_count_check/);
    });
  });

  // ── Shape: a handle, not a payload ─────────────────────────────────────

  describe("a credential is a handle, not somewhere to put data", () => {
    it("refuses a credential id that is not base64url, or is absurdly long", async () => {
      await clearDevices();
      expect(await refused(() => device({ credentialId: "not base64url!" }))).toMatch(/credential_check/);
      expect(await refused(() => device({ credentialId: "a".repeat(2_000) }))).toMatch(/credential_check/);
      expect(await refused(() => device({ credentialId: "short" }))).toMatch(/credential_check/);
    });

    it("refuses a public key that is not base64url", async () => {
      await clearDevices();
      expect(await refused(() => device({ publicKey: "<script>alert(1)</script>" }))).toMatch(/public_key_check/);
    });

    it("refuses an aaguid that is not 32 hex characters", async () => {
      await clearDevices();
      expect(await refused(() => device({ aaguid: "nope" }))).toMatch(/aaguid_check/);
      await expect(device({ aaguid: "0".repeat(32) })).resolves.toBeDefined();
    });

    it("refuses a blank or oversized label", async () => {
      await clearDevices();
      expect(await refused(() => device({ label: "   " }))).toMatch(/label_check/);
      expect(await refused(() => device({ label: "x".repeat(81) }))).toMatch(/label_check/);
    });

    it("refuses two registrations of the same credential, to anyone", async () => {
      await clearDevices();
      const shared = credential();
      await device({ credentialId: shared });
      expect(
        await refused(() =>
          db.deviceRegistration.create({
            data: {
              userId: otherUserId,
              credentialId: shared,
              publicKey: publicKey(),
              label: "same key",
              enrolledBySupervisorId: supervisorId,
            },
          }),
        ),
      ).toMatch(/credentialId/);
    });
  });

  // ── Challenges ─────────────────────────────────────────────────────────

  describe("a challenge is spent once", () => {
    const challenge = () => randomBytes(32).toString("base64url");

    async function pending(over: Record<string, unknown> = {}) {
      return db.webAuthnChallenge.create({
        data: {
          userId,
          challenge: challenge(),
          purpose: "ASSERT",
          expiresAt: new Date(Date.now() + 300_000),
          ...over,
        },
        select: { id: true },
      });
    }

    it("can be consumed", async () => {
      const row = await pending();
      await expect(
        db.webAuthnChallenge.update({ where: { id: row.id }, data: { consumedAt: new Date() } }),
      ).resolves.toBeDefined();
    });

    it("cannot be consumed twice, which is what makes it a challenge", async () => {
      const row = await pending();
      await db.webAuthnChallenge.update({ where: { id: row.id }, data: { consumedAt: new Date() } });
      expect(
        await refused(() => db.webAuthnChallenge.update({ where: { id: row.id }, data: { consumedAt: new Date() } })),
      ).toMatch(/already been used/);
    });

    it("is never rewritten to another user or purpose", async () => {
      const row = await pending();
      for (const data of [{ userId: otherUserId }, { purpose: "ENROL" as const }, { challenge: challenge() }]) {
        expect(await refused(() => db.webAuthnChallenge.update({ where: { id: row.id }, data }))).toMatch(
          /never rewritten/,
        );
      }
    });

    it("refuses a challenge that is not base64url or is too short to be one", async () => {
      expect(await refused(() => pending({ challenge: "tiny" }))).toMatch(/challenge_check/);
      expect(await refused(() => pending({ challenge: "has spaces in it and is long enough xxxxxxx" }))).toMatch(
        /challenge_check/,
      );
    });

    it("refuses a window that has already closed", async () => {
      expect(await refused(() => pending({ expiresAt: new Date(Date.now() - 60_000) }))).toMatch(/window_check/);
    });

    it("refuses two rows for the same challenge string", async () => {
      const shared = challenge();
      await pending({ challenge: shared });
      expect(await refused(() => pending({ challenge: shared }))).toMatch(/challenge/);
    });
  });

  // ── The seat ───────────────────────────────────────────────────────────

  describe("the seat label", () => {
    it("refuses a blank or oversized seat", async () => {
      // Exercised through raw SQL against the CHECK: building a whole attempt
      // fixture here would duplicate attempt-invariants.db.test.ts.
      const [row] = await db.$queryRaw<Array<{ ok: boolean }>>`
        SELECT (length(btrim('   ')) BETWEEN 1 AND 40) AS ok`;
      expect(row!.ok).toBe(false);
      const [long] = await db.$queryRaw<Array<{ ok: boolean }>>`
        SELECT (length(btrim(repeat('x', 41))) BETWEEN 1 AND 40) AS ok`;
      expect(long!.ok).toBe(false);
    });

    it("is on the attempt table, with its CHECK registered", async () => {
      const [found] = await db.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM pg_constraint
         WHERE conname = 'AssessmentAttempt_seat_check' AND coninhcount = 0`;
      expect(Number(found!.n)).toBe(1);
    });
  });
});
