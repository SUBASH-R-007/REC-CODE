import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "../src/index";
import { TRUNCATE_GUARDED } from "./support/guard-catalog";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  TEST_URL,
  testDatabaseName,
  type DbModule,
  type TestDb,
} from "./support/test-db";

/**
 * The governance and admin rules the database enforces (migrations
 * 20261010100000_phase4_admin_authoring, 20261010100050_phase4_foundation_fixes,
 * 20261010100080_phase4_foundation_fixes_2 and
 * 20261010100200_phase4_integration_hardening). For every rule: the allowed
 * path works and the forbidden path is refused, through Prisma and through
 * raw SQL.
 *   - PrivilegedOperation: full lifecycle, break-glass, the status machine,
 *     PENDING-only inserts inside the 5-minute clock window, decisions only
 *     before expiresAt and expiry only after it, decisions not dated more
 *     than 5 minutes ahead of the clock, paired decision fields,
 *     timestamps that travel with their status, bookkeeping columns, request
 *     fields, no DELETE.
 *   - AdminScope: immutable grants, set-once paired revoke, no DELETE, one
 *     active grant.
 *   - Accommodation: REQUESTED-only inserts, the status machine, fixed
 *     identity, decisions written only by the update that leaves REQUESTED
 *     and then final, attribution consistent with the status, supersession
 *     (same student, never itself, a REQUESTED successor before SUPERSEDED),
 *     decisions never dated before the request, the full workflows the admin
 *     stream implements, and the supersede rules under two interleaved
 *     connections (they lock the rows they read).
 *   - ImpersonationSession: created open, 5-minute start window, end after
 *     start and not more than 5 minutes ahead of the clock, immutable window,
 *     set-once paired end, no DELETE.
 *   - Announcement: born a draft with no recipients, free draft edits, fixed
 *     id and author, publish pair, frozen text and audience once published,
 *     set-once publish and archive, no DELETE once published.
 *   - TRUNCATE refused on every guarded table; AuditLog rows stay deletable.
 *
 * Some CHECKs back up a trigger that refuses the same write first; those are
 * also probed with the table's triggers switched off inside a transaction
 * that is always rolled back (checksOnly), so the CHECK alone is shown to
 * hold.
 *
 * DB-backed: runs only with RECX_DB_TESTS=1, against recx_test (never recx).
 * Teardown lifts the row triggers inside ONE transaction (DDL is
 * transactional, so no other session sees them disabled), deletes this
 * suite's rows, re-enables the triggers and asserts none is left disabled.
 */

const TITLE = RUN_DB_TESTS
  ? "governance invariants enforced by the database (recx_test)"
  : "governance invariants [skipped: set RECX_DB_TESTS=1 to run against recx_test on localhost:5433]";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const OP_STATUSES = ["PENDING", "APPROVED", "EXECUTING", "EXECUTED", "FAILED", "REJECTED", "CANCELLED", "EXPIRED"] as const;
type OpStatus = (typeof OP_STATUSES)[number];
const OP_FINAL: readonly OpStatus[] = ["EXECUTED", "FAILED", "REJECTED", "CANCELLED", "EXPIRED"];
const OP_ALLOWED: Record<OpStatus, readonly OpStatus[]> = {
  PENDING: ["APPROVED", "REJECTED", "CANCELLED", "EXPIRED"],
  APPROVED: ["EXECUTING"],
  EXECUTING: ["EXECUTED", "FAILED"],
  EXECUTED: [],
  FAILED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
};

const ACC_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "WITHDRAWN", "REVOKED", "SUPERSEDED"] as const;
type AccStatus = (typeof ACC_STATUSES)[number];
const ACC_FINAL: readonly AccStatus[] = ["REJECTED", "WITHDRAWN", "REVOKED", "SUPERSEDED"];
const ACC_ALLOWED: Record<AccStatus, readonly AccStatus[]> = {
  REQUESTED: ["APPROVED", "REJECTED", "WITHDRAWN"],
  APPROVED: ["REVOKED", "SUPERSEDED"],
  REJECTED: [],
  WITHDRAWN: [],
  REVOKED: [],
  SUPERSEDED: [],
};

/** The row triggers this suite's teardown lifts (they refuse DELETE). */
const DELETE_GUARDS = [
  ["PrivilegedOperation", "PrivilegedOperation_request_immutable"],
  ["AdminScope", "AdminScope_grant_immutable"],
  ["Accommodation", "Accommodation_granted_terms_immutable"],
  ["ImpersonationSession", "ImpersonationSession_immutable"],
  ["Announcement", "Announcement_published_immutable"],
] as const;

/** One UPDATE step: SET assignments plus their parameters ($2, $3 … after the row id). */
interface Step {
  set: string;
  params?: unknown[];
}

const ROLLBACK = new Error("rolled back on purpose");

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let mod: DbModule;
  let restoreEnv: () => void = () => {};
  const tag = `gi-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const u = {
    superA: "",
    superB: "",
    admin: "",
    s1: "",
    s2: "",
    s3: "",
    s4: "",
    s5: "",
    s6: "",
    s7: "",
    s8: "",
    race1: "",
    race2: "",
    race3: "",
    race4: "",
    race5: "",
  };
  const userIds = () => Object.values(u).filter(Boolean);

  const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
  const update = (table: string, id: string, step: Step) =>
    raw(`UPDATE "public"."${table}" SET ${step.set} WHERE "id" = $1`, id, ...(step.params ?? []));

  /**
   * Runs `sql` with every user trigger on `table` switched off, inside a
   * transaction that is always rolled back, so only the CHECK constraints
   * judge the write. Resolves to the error, or to ROLLBACK when the write
   * went through.
   */
  async function checksOnly(table: string, sql: string, ...params: unknown[]): Promise<unknown> {
    try {
      await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`ALTER TABLE "public"."${table}" DISABLE TRIGGER USER`);
          await tx.$executeRawUnsafe(sql, ...params);
          throw ROLLBACK;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    } catch (error) {
      return error;
    }
    return null;
  }
  async function expectCheckOnly(name: string, table: string, sql: string, ...params: unknown[]) {
    const outcome = await checksOnly(table, sql, ...params);
    expect(outcome, `${name}: the write went through with the triggers off`).not.toBe(ROLLBACK);
    expect(String((outcome as Error | null)?.message)).toMatch(new RegExp(name));
  }

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, mod, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);
    const roles: Record<keyof typeof u, "SUPER_ADMIN" | "ADMIN" | "STUDENT"> = {
      superA: "SUPER_ADMIN",
      superB: "SUPER_ADMIN",
      admin: "ADMIN",
      s1: "STUDENT",
      s2: "STUDENT",
      s3: "STUDENT",
      s4: "STUDENT",
      s5: "STUDENT",
      s6: "STUDENT",
      s7: "STUDENT",
      s8: "STUDENT",
      race1: "STUDENT",
      race2: "STUDENT",
      race3: "STUDENT",
      race4: "STUDENT",
      race5: "STUDENT",
    };
    for (const [key, role] of Object.entries(roles) as Array<[keyof typeof u, (typeof roles)[keyof typeof u]]>) {
      const handle = `${tag}-${key}`.toLowerCase();
      const user = await db.user.create({
        data: { collegeId: handle.toUpperCase(), email: `${handle}@example.test`, firstName: key, lastName: "Test", handle, role },
        select: { id: true },
      });
      u[key] = user.id;
    }
  });

  afterAll(async () => {
    try {
      if (db && userIds().length > 0) {
        const ids = userIds();
        await db.$transaction([
          ...DELETE_GUARDS.map(([table, trigger]) => raw(`ALTER TABLE "public"."${table}" DISABLE TRIGGER "${trigger}"`)),
          raw(`DELETE FROM "public"."PrivilegedOperation" WHERE "requestedById" = ANY($1::text[])`, ids),
          raw(`DELETE FROM "public"."AdminScope" WHERE "adminId" = ANY($1::text[])`, ids),
          raw(`DELETE FROM "public"."Accommodation" WHERE "userId" = ANY($1::text[])`, ids),
          raw(`DELETE FROM "public"."ImpersonationSession" WHERE "impersonatorId" = ANY($1::text[])`, ids),
          raw(`DELETE FROM "public"."Announcement" WHERE "createdById" = ANY($1::text[])`, ids),
          ...DELETE_GUARDS.map(([table, trigger]) => raw(`ALTER TABLE "public"."${table}" ENABLE TRIGGER "${trigger}"`)),
          raw(`DELETE FROM "public"."User" WHERE "id" = ANY($1::text[])`, ids),
        ]);
        const left = await db.$queryRawUnsafe<Array<{ n: number }>>(
          `SELECT ((SELECT count(*) FROM "PrivilegedOperation" WHERE "requestedById" = ANY($1::text[]))
                 + (SELECT count(*) FROM "AdminScope" WHERE "adminId" = ANY($1::text[]))
                 + (SELECT count(*) FROM "Accommodation" WHERE "userId" = ANY($1::text[]))
                 + (SELECT count(*) FROM "ImpersonationSession" WHERE "impersonatorId" = ANY($1::text[]))
                 + (SELECT count(*) FROM "Announcement" WHERE "createdById" = ANY($1::text[]))
                 + (SELECT count(*) FROM "User" WHERE "id" = ANY($1::text[])))::int AS n`,
          ids,
        );
        expect(left[0]?.n).toBe(0);
      }
      if (db) expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db?.$disconnect();
      restoreEnv();
    }
  });

  // ── PrivilegedOperation ──────────────────────────────────────────────

  describe("PrivilegedOperation", () => {
    const base = (data: Partial<Prisma.PrivilegedOperationUncheckedCreateInput> = {}): Prisma.PrivilegedOperationUncheckedCreateInput => ({
      kind: "PII_EXPORT",
      payload: { userIds: ["u1", "u2"] },
      payloadSha256: "a".repeat(64),
      summary: `${tag}: export two students`,
      affectedCount: 2,
      reason: `${tag}: accreditation audit asked for the roster`,
      requestedById: u.superA,
      expiresAt: new Date(Date.now() + 23 * HOUR),
      ...data,
    });
    const request = async (data: Partial<Prisma.PrivilegedOperationUncheckedCreateInput> = {}) =>
      (await db.privilegedOperation.create({ data: base(data), select: { id: true } })).id;
    /** A request already past its expiry: requested 4 minutes ago (inside the insert window), expired 3 minutes ago. */
    const expiredRequest = () => request({ requestedAt: new Date(Date.now() - 4 * MINUTE), expiresAt: new Date(Date.now() - 3 * MINUTE) });
    const op = (id: string) => db.privilegedOperation.findUniqueOrThrow({ where: { id } });
    const set = (id: string, step: Step | string) => update("PrivilegedOperation", id, typeof step === "string" ? { set: step } : step);

    /** Legitimate single steps, keyed by the status they reach. */
    const STEP: Record<Exclude<OpStatus, "PENDING">, () => Step> = {
      APPROVED: () => ({ set: `"status" = 'APPROVED', "decidedById" = $2, "decidedAt" = now()`, params: [u.superB] }),
      REJECTED: () => ({ set: `"status" = 'REJECTED', "decidedById" = $2, "decidedAt" = now(), "decisionNote" = 'Out of policy.'`, params: [u.superB] }),
      CANCELLED: () => ({ set: `"status" = 'CANCELLED'` }),
      EXPIRED: () => ({ set: `"status" = 'EXPIRED'` }),
      EXECUTING: () => ({ set: `"status" = 'EXECUTING', "executionStartedAt" = now()` }),
      EXECUTED: () => ({
        set: `"status" = 'EXECUTED', "executedAt" = now(), "result" = '{"rows":2}'::jsonb, "artifactAvailableUntil" = now() + interval '1 day'`,
      }),
      FAILED: () => ({ set: `"status" = 'FAILED', "executedAt" = now(), "error" = 'executor failed'` }),
    };
    /** The path from PENDING to each status. */
    const PATH: Record<OpStatus, Array<Exclude<OpStatus, "PENDING">>> = {
      PENDING: [],
      APPROVED: ["APPROVED"],
      EXECUTING: ["APPROVED", "EXECUTING"],
      EXECUTED: ["APPROVED", "EXECUTING", "EXECUTED"],
      FAILED: ["APPROVED", "EXECUTING", "FAILED"],
      REJECTED: ["REJECTED"],
      CANCELLED: ["CANCELLED"],
      EXPIRED: ["EXPIRED"],
    };
    async function requestAt(status: OpStatus): Promise<string> {
      const id = PATH[status].includes("EXPIRED") ? await expiredRequest() : await request();
      for (const s of PATH[status]) expect(await set(id, STEP[s]())).toBe(1);
      expect((await op(id)).status).toBe(status);
      return id;
    }

    it("runs the full lifecycle: request, two-person approval, execution, three downloads; then only the counter moves", async () => {
      const id = await request();
      expect(await op(id)).toMatchObject({ status: "PENDING", decidedById: null, decidedAt: null, breakGlass: false, artifactDownloads: 0 });
      await db.privilegedOperation.update({
        where: { id },
        data: { status: "APPROVED", decidedById: u.superB, decidedAt: new Date(), decisionNote: "Checked the filter and the count." },
      });
      // The executor claims with a conditional update; a second claim matches nothing.
      const claim = () =>
        db.privilegedOperation.updateMany({ where: { id, status: "APPROVED" }, data: { status: "EXECUTING", executionStartedAt: new Date() } });
      expect((await claim()).count).toBe(1);
      expect((await claim()).count).toBe(0);
      await db.privilegedOperation.update({
        where: { id },
        data: { status: "EXECUTED", executedAt: new Date(), result: { rows: 2 }, artifactAvailableUntil: new Date(Date.now() + 24 * HOUR) },
      });
      // Three downloads through the route's conditional increment; the fourth matches nothing.
      const download = () =>
        db.privilegedOperation.updateMany({
          where: { id, status: "EXECUTED", artifactDownloads: { lt: 3 } },
          data: { artifactDownloads: { increment: 1 } },
        });
      for (let i = 0; i < 3; i++) expect((await download()).count).toBe(1);
      expect((await download()).count).toBe(0);
      const done = await op(id);
      expect(done).toMatchObject({ status: "EXECUTED", decidedById: u.superB, breakGlass: false, artifactDownloads: 3 });
      expect(done.executionStartedAt).not.toBeNull();
      expect(done.executedAt).not.toBeNull();
      expect(done.artifactAvailableUntil).not.toBeNull();

      const refused: Array<[Step | string, RegExp]> = [
        [`"artifactDownloads" = 2`, /artifactDownloads only increases/],
        [`"status" = 'PENDING'`, /EXECUTED \(final\)/],
        [`"status" = 'EXECUTING'`, /EXECUTED \(final\)/],
        [`"status" = 'FAILED'`, /EXECUTED \(final\)/],
        [`"result" = '{}'::jsonb`, /result and error/],
        [`"error" = 'late note'`, /result and error/],
        [`"artifactAvailableUntil" = "artifactAvailableUntil" + interval '1 day'`, /artifactAvailableUntil is set once/],
        [`"executedAt" = now()`, /executedAt is set once/],
        [`"executionStartedAt" = now()`, /executionStartedAt is set once/],
        [`"decidedById" = "requestedById", "breakGlass" = true`, /decision is final/],
        [`"decisionNote" = 'edited afterwards'`, /decision is final/],
        [`"decidedAt" = now()`, /decision is final/],
      ];
      for (const [step, pattern] of refused) await expect(set(id, step), String(pattern)).rejects.toThrow(pattern);
      await expect(db.privilegedOperation.update({ where: { id }, data: { artifactDownloads: { decrement: 1 } } })).rejects.toThrow(
        /artifactDownloads only increases/,
      );
      await expect(db.privilegedOperation.delete({ where: { id } })).rejects.toThrow(/cannot be deleted/);
      await expect(raw(`DELETE FROM "PrivilegedOperation" WHERE "id" = $1`, id)).rejects.toThrow(/cannot be deleted/);
      expect(await op(id)).toEqual(done);
    });

    it("break-glass: a self-approval is always flagged, can never be relabelled, and can still fail", async () => {
      const id = await request();
      // Control: a self-approval without the flag fails the two-person CHECK.
      await expect(set(id, `"status" = 'APPROVED', "decidedById" = "requestedById", "decidedAt" = now()`)).rejects.toThrow(
        /PrivilegedOperation_two_person/,
      );
      // A two-person approval may not carry the flag either.
      await expect(
        set(id, { set: `"status" = 'APPROVED', "decidedById" = $2, "decidedAt" = now(), "breakGlass" = true`, params: [u.superB] }),
      ).rejects.toThrow(/PrivilegedOperation_two_person/);
      await db.privilegedOperation.update({
        where: { id },
        data: { status: "APPROVED", decidedById: u.superA, breakGlass: true, decidedAt: new Date(), decisionNote: "Break-glass: results due in an hour." },
      });
      const approved = await op(id);
      expect(approved).toMatchObject({ status: "APPROVED", decidedById: u.superA, breakGlass: true });

      // Relabel it as a two-person approval, clear the decision, drop the flag: all refused.
      await expect(set(id, { set: `"decidedById" = $2, "breakGlass" = false`, params: [u.superB] })).rejects.toThrow(/decision is final/);
      await expect(set(id, `"decidedById" = NULL, "decidedAt" = NULL, "breakGlass" = false`)).rejects.toThrow(/decision is final/);
      await expect(db.privilegedOperation.update({ where: { id }, data: { breakGlass: false } })).rejects.toThrow(/decision is final/);
      await expect(db.privilegedOperation.update({ where: { id }, data: { decisionNote: "rewritten" } })).rejects.toThrow(/decision is final/);
      // Back to PENDING (to be "approved again" by someone else): refused.
      await expect(set(id, `"status" = 'PENDING'`)).rejects.toThrow(/cannot move from APPROVED to PENDING/);
      expect(await op(id)).toEqual(approved);

      await db.privilegedOperation.update({ where: { id }, data: { status: "EXECUTING", executionStartedAt: new Date() } });
      await db.privilegedOperation.update({ where: { id }, data: { status: "FAILED", executedAt: new Date(), error: "batch 1 of 1 failed" } });
      const failed = await op(id);
      expect(failed).toMatchObject({ status: "FAILED", breakGlass: true, error: "batch 1 of 1 failed" });
      await expect(set(id, `"status" = 'EXECUTING'`)).rejects.toThrow(/FAILED \(final\)/);
      await expect(set(id, `"error" = NULL`)).rejects.toThrow(/result and error/);
      await expect(set(id, `"artifactAvailableUntil" = now()`)).rejects.toThrow(/artifactAvailableUntil is set once/);
      expect(await op(id)).toEqual(failed);
    });

    it("allows exactly the transitions of the status machine", async () => {
      for (const from of OP_STATUSES) {
        for (const to of OP_ALLOWED[from]) {
          // PENDING → EXPIRED needs a request whose expiresAt has passed.
          const id = to === "EXPIRED" ? await expiredRequest() : await requestAt(from);
          expect(await set(id, STEP[to as Exclude<OpStatus, "PENDING">]()), `${from} -> ${to}`).toBe(1);
          expect((await op(id)).status).toBe(to);
        }
      }
    });

    it("refuses every other status change (the final statuses never change)", async () => {
      for (const from of OP_STATUSES) {
        const id = await requestAt(from);
        const before = await op(id);
        for (const to of OP_STATUSES) {
          if (to === from || OP_ALLOWED[from].includes(to)) continue;
          // Give the row a decider where it has none, so only the state machine can refuse.
          const step: Step =
            before.decidedById === null && !OP_FINAL.includes(from)
              ? { set: `"status" = '${to}', "decidedById" = $2, "decidedAt" = now()`, params: [u.superB] }
              : { set: `"status" = '${to}'` };
          const expected = OP_FINAL.includes(from) ? new RegExp(`is ${from} \\(final\\)`) : new RegExp(`cannot move from ${from} to ${to}`);
          await expect(set(id, step), `${from} -> ${to}`).rejects.toThrow(expected);
        }
        expect(await op(id)).toEqual(before);
      }
    });

    it("requires a decider on APPROVED and REJECTED (CHECK), not on CANCELLED or EXPIRED", async () => {
      const id = await request();
      await expect(set(id, `"status" = 'APPROVED'`)).rejects.toThrow(/PrivilegedOperation_decided_check/);
      await expect(set(id, `"status" = 'REJECTED', "decisionNote" = 'no'`)).rejects.toThrow(/PrivilegedOperation_decided_check/);
      await expect(db.privilegedOperation.update({ where: { id }, data: { status: "APPROVED" } })).rejects.toThrow(
        /PrivilegedOperation_decided_check/,
      );
      expect((await op(id)).status).toBe("PENDING");
      const cancelled = await request();
      await db.privilegedOperation.update({ where: { id: cancelled }, data: { status: "CANCELLED" } });
      expect(await op(cancelled)).toMatchObject({ status: "CANCELLED", decidedById: null, decidedAt: null, breakGlass: false });
      const expired = await expiredRequest();
      await db.privilegedOperation.update({ where: { id: expired }, data: { status: "EXPIRED" } });
      expect(await op(expired)).toMatchObject({ status: "EXPIRED", decidedById: null, decidedAt: null, breakGlass: false });
    });

    it("closes CANCELLED and EXPIRED without a decision: no decider, no decidedAt, no break-glass flag (CHECKs)", async () => {
      const refused: Array<[() => Promise<string>, Step, RegExp]> = [
        [request, { set: `"status" = 'CANCELLED', "breakGlass" = true` }, /PrivilegedOperation_undecided_close_check/],
        [request, { set: `"status" = 'CANCELLED', "decidedById" = $2, "decidedAt" = now()`, params: [u.superB] }, /PrivilegedOperation_undecided_close_check/],
        [request, { set: `"status" = 'CANCELLED', "decidedAt" = now()` }, /PrivilegedOperation_decision_pair_check/],
        [expiredRequest, { set: `"status" = 'EXPIRED', "decidedById" = $2, "decidedAt" = now(), "decisionNote" = 'late'`, params: [u.superB] }, /PrivilegedOperation_undecided_close_check/],
        [expiredRequest, { set: `"status" = 'EXPIRED', "breakGlass" = true` }, /PrivilegedOperation_undecided_close_check/],
      ];
      for (const [make, step, pattern] of refused) {
        const id = await make();
        await expect(set(id, step), step.set).rejects.toThrow(pattern);
        expect((await op(id)).status).toBe("PENDING");
      }
      // A cancel may carry a note; nothing is written to the row afterwards.
      const id = await request();
      expect(await set(id, `"status" = 'CANCELLED', "decisionNote" = 'Requested by mistake.'`)).toBe(1);
      await expect(set(id, `"decisionNote" = 'edited'`)).rejects.toThrow(/only by the update that leaves PENDING/);
    });

    it("pairs decidedById with decidedAt, and never dates a decision before the request (CHECKs)", async () => {
      const id = await request();
      const refused: Array<[Step, RegExp]> = [
        [{ set: `"status" = 'APPROVED', "decidedById" = $2`, params: [u.superB] }, /PrivilegedOperation_decision_pair_check/],
        [{ set: `"status" = 'REJECTED', "decidedById" = $2, "decisionNote" = 'no'`, params: [u.superB] }, /PrivilegedOperation_decision_pair_check/],
        [
          { set: `"status" = 'APPROVED', "decidedById" = $2, "decidedAt" = "requestedAt" - interval '1 second'`, params: [u.superB] },
          /PrivilegedOperation_decided_after_request_check/,
        ],
      ];
      for (const [step, pattern] of refused) await expect(set(id, step), step.set).rejects.toThrow(pattern);
      await expect(db.privilegedOperation.update({ where: { id }, data: { status: "REJECTED", decidedById: u.superB } })).rejects.toThrow(
        /PrivilegedOperation_decision_pair_check/,
      );
      expect((await op(id)).status).toBe("PENDING");
      // decidedAt equal to requestedAt is allowed.
      expect(await set(id, { set: `"status" = 'APPROVED', "decidedById" = $2, "decidedAt" = "requestedAt"`, params: [u.superB] })).toBe(1);
    });

    it("never dates a decision more than 5 minutes after the database clock (approve, reject, break-glass)", async () => {
      const clock = `(statement_timestamp() AT TIME ZONE 'UTC')`;
      const decide = (status: "APPROVED" | "REJECTED", decider: string, ahead: string): Step => ({
        set: `"status" = '${status}', "decidedById" = $2, "decidedAt" = ${clock} + interval '${ahead}'${decider === u.superA ? `, "breakGlass" = true` : ""}`,
        params: [decider],
      });
      for (const [status, decider] of [
        ["APPROVED", u.superB],
        ["REJECTED", u.superB],
        ["APPROVED", u.superA], // break-glass
      ] as const) {
        const id = await request();
        for (const ahead of ["6 minutes", "1 day", "1 year"]) {
          await expect(set(id, decide(status, decider, ahead)), `${status} +${ahead}`).rejects.toThrow(
            /decidedAt may not be more than 5 minutes after the database clock/,
          );
        }
        await expect(
          db.privilegedOperation.update({ where: { id }, data: { status, decidedById: decider, decidedAt: new Date(Date.now() + HOUR), breakGlass: decider === u.superA } }),
        ).rejects.toThrow(/more than 5 minutes after the database clock/);
        expect((await op(id)).status).toBe("PENDING");
        // Inside the tolerance (an application clock a little ahead) is accepted.
        expect(await set(id, decide(status, decider, "4 minutes"))).toBe(1);
        expect((await op(id)).status).toBe(status);
      }
      // The approve path's recipe: GREATEST(database clock, requestedAt), with requestedAt up to 5 minutes ahead.
      const early = await request({ requestedAt: new Date(Date.now() + 4 * MINUTE) });
      expect(
        await set(early, { set: `"status" = 'APPROVED', "decidedById" = $2, "decidedAt" = GREATEST(${clock}, "requestedAt")`, params: [u.superB] }),
      ).toBe(1);
    });

    it("carries executionStartedAt, executedAt and (PII_EXPORT) artifactAvailableUntil with its status (CHECKs)", async () => {
      const approved = await requestAt("APPROVED");
      await expect(set(approved, `"status" = 'EXECUTING'`)).rejects.toThrow(/PrivilegedOperation_execution_started_check/);
      await expect(db.privilegedOperation.update({ where: { id: approved }, data: { status: "EXECUTING" } })).rejects.toThrow(
        /PrivilegedOperation_execution_started_check/,
      );
      const executing = await requestAt("EXECUTING");
      await expect(set(executing, `"status" = 'EXECUTED', "artifactAvailableUntil" = now() + interval '1 day'`)).rejects.toThrow(
        /PrivilegedOperation_executed_check/,
      );
      await expect(set(executing, `"status" = 'FAILED', "error" = 'x'`)).rejects.toThrow(/PrivilegedOperation_executed_check/);
      // An EXECUTED PII_EXPORT needs its download window; the same update without it is refused.
      await expect(set(executing, `"status" = 'EXECUTED', "executedAt" = now()`)).rejects.toThrow(/PrivilegedOperation_export_artifact_check/);
      expect((await op(executing)).status).toBe("EXECUTING");
      // Other kinds have no artifact: EXECUTED without it is fine.
      const rejudge = await request({ kind: "GLOBAL_REJUDGE" });
      for (const s of ["APPROVED", "EXECUTING"] as const) expect(await set(rejudge, STEP[s]())).toBe(1);
      expect(await set(rejudge, `"status" = 'EXECUTED', "executedAt" = now(), "result" = '{"rejudged":0}'::jsonb`)).toBe(1);
      expect(await op(rejudge)).toMatchObject({ status: "EXECUTED", artifactAvailableUntil: null });
    });

    it("creates a row only as an undecided PENDING request", async () => {
      const marker = `${tag}: refused insert`;
      for (const status of OP_STATUSES.filter((s) => s !== "PENDING")) {
        await expect(
          raw(
            `INSERT INTO "PrivilegedOperation" ("id","kind","status","payload","payloadSha256","summary","affectedCount","reason","requestedById","expiresAt","decidedById","decidedAt")
             VALUES ($1, 'PII_EXPORT', '${status}', '{}'::jsonb, 'h', 's', 1, $2, $3, now() + interval '1 hour', $4, now())`,
            `${tag}-raw-${status}`,
            marker,
            u.superA,
            u.superB,
          ),
          status,
        ).rejects.toThrow(new RegExp(`must be created PENDING, not ${status}`));
      }
      await expect(db.privilegedOperation.create({ data: { ...base(), reason: marker, status: "APPROVED", decidedById: u.superB } })).rejects.toThrow(
        /must be created PENDING/,
      );
      const premature: Array<Partial<Prisma.PrivilegedOperationUncheckedCreateInput>> = [
        { decidedById: u.superB },
        { decidedAt: new Date() },
        { decisionNote: "pre-approved" },
        { breakGlass: true },
        { executionStartedAt: new Date() },
        { executedAt: new Date() },
        { result: { rows: 1 } },
        { error: "x" },
        { artifactAvailableUntil: new Date(Date.now() + DAY) },
        { artifactDownloads: 1 },
      ];
      for (const extra of premature) {
        await expect(db.privilegedOperation.create({ data: { ...base(), reason: marker, ...extra } }), JSON.stringify(extra)).rejects.toThrow(
          /undecided request/,
        );
      }
      expect(await db.privilegedOperation.count({ where: { reason: marker } })).toBe(0);
    });

    it("dates a request now: requestedAt within 5 minutes of the database clock at INSERT, and expiresAt after it", async () => {
      const marker = `${tag}: clock window`;
      const now = Date.now();
      for (const requestedAt of [new Date(now - 6 * MINUTE), new Date(now + 6 * MINUTE), new Date(now - 30 * DAY), new Date(now + 30 * DAY)]) {
        await expect(
          db.privilegedOperation.create({ data: base({ reason: marker, requestedAt, expiresAt: new Date(requestedAt.getTime() + HOUR) }) }),
          requestedAt.toISOString(),
        ).rejects.toThrow(/requestedAt must be within 5 minutes of the database clock/);
      }
      await expect(
        raw(
          `INSERT INTO "PrivilegedOperation" ("id","kind","payload","payloadSha256","summary","affectedCount","reason","requestedById","requestedAt","expiresAt")
           VALUES ($1, 'PII_EXPORT', '{}'::jsonb, 'h', 's', 1, $2, $3, now() - interval '10 minutes', now() + interval '1 hour')`,
          `${tag}-raw-backdated`,
          marker,
          u.superA,
        ),
      ).rejects.toThrow(/requestedAt must be within 5 minutes/);
      // expiresAt must come after requestedAt (CHECK); the 24-hour ceiling stays (CHECK).
      await expect(db.privilegedOperation.create({ data: base({ reason: marker, requestedAt: new Date(now), expiresAt: new Date(now) }) })).rejects.toThrow(
        /PrivilegedOperation_expires_after_request_check/,
      );
      await expect(
        db.privilegedOperation.create({ data: base({ reason: marker, requestedAt: new Date(now), expiresAt: new Date(now - MINUTE) }) }),
      ).rejects.toThrow(/PrivilegedOperation_expires_after_request_check/);
      await expect(
        db.privilegedOperation.create({ data: base({ reason: marker, requestedAt: new Date(now), expiresAt: new Date(now + DAY + SECOND) }) }),
      ).rejects.toThrow(/PrivilegedOperation_expiry/);
      expect(await db.privilegedOperation.count({ where: { reason: marker } })).toBe(0);
      // Inside the window, either side (the application clock may differ a little).
      await request({ requestedAt: new Date(now - 4 * MINUTE) });
      await request({ requestedAt: new Date(now + 4 * MINUTE), expiresAt: new Date(now + 5 * MINUTE) });
      await request(); // the default (now)
    });

    it("decides only before expiresAt, expires only after it, and still executes an approval after it", async () => {
      // Past expiry: approve, reject and break-glass are refused; EXPIRED (the sweep) and CANCELLED work.
      const late = await expiredRequest();
      const refused: Step[] = [
        STEP.APPROVED(),
        STEP.REJECTED(),
        { set: `"status" = 'APPROVED', "decidedById" = "requestedById", "decidedAt" = now(), "breakGlass" = true` },
      ];
      for (const step of refused) await expect(set(late, step), step.set).rejects.toThrow(/expired at .* can no longer be approved or rejected/);
      await expect(
        db.privilegedOperation.update({ where: { id: late }, data: { status: "APPROVED", decidedById: u.superB, decidedAt: new Date() } }),
      ).rejects.toThrow(/can no longer be approved or rejected/);
      expect((await op(late)).status).toBe("PENDING");
      expect(await set(late, STEP.EXPIRED())).toBe(1);
      const lateCancel = await expiredRequest();
      expect(await set(lateCancel, STEP.CANCELLED())).toBe(1);

      // Before expiry: the sweep cannot expire it.
      const fresh = await request();
      await expect(set(fresh, STEP.EXPIRED())).rejects.toThrow(/has not expired yet/);
      await expect(db.privilegedOperation.update({ where: { id: fresh }, data: { status: "EXPIRED" } })).rejects.toThrow(/has not expired yet/);
      // The sweep's conditional update on the database clock matches nothing yet.
      expect(await raw(`UPDATE "PrivilegedOperation" SET "status" = 'EXPIRED' WHERE "id" = $1 AND "status" = 'PENDING' AND "expiresAt" <= now()`, fresh)).toBe(0);
      expect((await op(fresh)).status).toBe("PENDING");

      // Approved just in time, executed after expiresAt has passed: allowed.
      const short = await request({ expiresAt: new Date(Date.now() + 3 * SECOND) });
      expect(await set(short, STEP.APPROVED())).toBe(1);
      await sleep(3.5 * SECOND);
      expect(await set(short, STEP.EXECUTING())).toBe(1);
      expect(await set(short, STEP.EXECUTED())).toBe(1);
      expect((await op(short)).status).toBe("EXECUTED");
    });

    it("moves the bookkeeping columns only with their own transitions", async () => {
      const id = await request();
      const pending: Array<[string, RegExp]> = [
        [`"executionStartedAt" = now()`, /executionStartedAt is set once, by APPROVED to EXECUTING/],
        [`"executedAt" = now()`, /executedAt is set once/],
        [`"result" = '{}'::jsonb`, /result and error/],
        [`"error" = 'x'`, /result and error/],
        [`"artifactAvailableUntil" = now()`, /artifactAvailableUntil is set once/],
        [`"artifactDownloads" = 1`, /artifactDownloads only increases, and only while EXECUTED/],
        [`"decisionNote" = 'thinking about it'`, /only by the update that leaves PENDING/],
      ];
      for (const [step, pattern] of pending) await expect(set(id, step), step).rejects.toThrow(pattern);

      expect(await set(id, STEP.APPROVED())).toBe(1);
      for (const [step, pattern] of [
        [`"executedAt" = now()`, /executedAt is set once/],
        [`"result" = '{}'::jsonb`, /result and error/],
        [`"artifactDownloads" = 1`, /artifactDownloads only increases/],
        [`"executionStartedAt" = now()`, /executionStartedAt is set once/],
      ] as Array<[string, RegExp]>) {
        await expect(set(id, step), step).rejects.toThrow(pattern);
      }

      expect(await set(id, STEP.EXECUTING())).toBe(1);
      for (const [step, pattern] of [
        [`"executionStartedAt" = now() + interval '1 minute'`, /executionStartedAt is set once/],
        [`"result" = '{"partial":true}'::jsonb`, /result and error/],
        [`"error" = 'progress note'`, /result and error/],
        [`"artifactAvailableUntil" = now() + interval '1 day'`, /artifactAvailableUntil is set once, by EXECUTING to EXECUTED/],
        [`"artifactDownloads" = 1`, /artifactDownloads only increases/],
        [`"status" = 'FAILED', "executedAt" = now(), "artifactAvailableUntil" = now() + interval '1 day'`, /artifactAvailableUntil is set once, by EXECUTING to EXECUTED/],
      ] as Array<[string, RegExp]>) {
        await expect(set(id, step), step).rejects.toThrow(pattern);
      }
      expect((await op(id)).status).toBe("EXECUTING");
    });

    it("keeps the request fields immutable", async () => {
      const id = await request();
      const before = await op(id);
      for (const step of [
        `"payload" = '{"userIds":["someone-else"]}'::jsonb`,
        `"payloadSha256" = 'b'`,
        `"summary" = 'edited'`,
        `"affectedCount" = 999`,
        `"reason" = 'edited'`,
        `"kind" = 'SUBMISSION_PURGE'`,
        `"requestedAt" = now()`,
        `"expiresAt" = "expiresAt" - interval '1 hour'`,
        `"id" = "id" || '-x'`,
      ]) {
        await expect(set(id, step), step).rejects.toThrow(/request fields are immutable/);
      }
      await expect(set(id, { set: `"requestedById" = $2`, params: [u.superB] })).rejects.toThrow(/request fields are immutable/);
      expect(await op(id)).toEqual(before);
    });
  });

  // ── AdminScope ───────────────────────────────────────────────────────

  describe("AdminScope", () => {
    const grant = (data: Partial<Prisma.AdminScopeUncheckedCreateInput> = {}) =>
      db.adminScope.create({
        data: { adminId: u.admin, departmentCode: "CSE", batchYear: 2027, reason: `${tag}: CSE 2027 coordinator`, grantedById: u.superA, ...data },
      });
    const scope = (id: string) => db.adminScope.findUniqueOrThrow({ where: { id } });
    const set = (id: string, step: Step | string) => update("AdminScope", id, typeof step === "string" ? { set: step } : step);

    it("grants, revokes once with the revoker, refuses a second active grant, and re-grants after a revoke", async () => {
      const first = await grant();
      await expect(
        raw(
          `INSERT INTO "AdminScope" ("id","adminId","departmentCode","batchYear","reason","grantedById") VALUES ($1, $2, 'CSE', 2027, 'dup', $3)`,
          `${tag}-dup`,
          u.admin,
          u.superA,
        ),
        // unique_violation on the only unique index over these columns: AdminScope_active_grant_key.
      ).rejects.toThrow(/23505[\s\S]*Key \("adminId", "departmentCode", "batchYear"\)/);
      await expect(grant()).rejects.toMatchObject({ code: "P2002" });
      await db.adminScope.update({ where: { id: first.id }, data: { revokedAt: new Date(), revokedById: u.superB } });
      const again = await grant();
      expect(again.id).not.toBe(first.id);
      expect((await scope(first.id)).revokedById).toBe(u.superB);
      // An all-NULL (college-wide) grant is unique too (NULLS NOT DISTINCT).
      await grant({ departmentCode: null, batchYear: null });
      await expect(grant({ departmentCode: null, batchYear: null })).rejects.toMatchObject({ code: "P2002" });
    });

    it("refuses edits of a grant, a half revoke, an undone or rewritten revoke, and DELETE", async () => {
      const active = await grant({ departmentCode: "ECE", batchYear: null });
      const revoked = await grant({ departmentCode: "MECH", batchYear: 2026 });
      await db.adminScope.update({ where: { id: revoked.id }, data: { revokedAt: new Date(), revokedById: u.superA } });
      const before = { active: await scope(active.id), revoked: await scope(revoked.id) };

      const onActive: Array<[Step | string, RegExp]> = [
        [`"departmentCode" = NULL`, /grant fields are immutable/], // widening to every department
        [`"batchYear" = 2026`, /grant fields are immutable/],
        [`"reason" = 'edited'`, /grant fields are immutable/],
        [`"grantedById" = "adminId"`, /grant fields are immutable/],
        [{ set: `"adminId" = $2`, params: [u.superB] }, /grant fields are immutable/],
        [`"createdAt" = now() - interval '1 day'`, /grant fields are immutable/],
        [`"id" = "id" || '-x'`, /grant fields are immutable/],
        [`"revokedAt" = now()`, /AdminScope_revoke_pair_check/],
        [{ set: `"revokedById" = $2`, params: [u.superA] }, /AdminScope_revoke_pair_check/],
      ];
      for (const [step, pattern] of onActive) await expect(set(active.id, step), String(pattern)).rejects.toThrow(pattern);
      await expect(db.adminScope.update({ where: { id: active.id }, data: { departmentCode: null } })).rejects.toThrow(
        /grant fields are immutable/,
      );

      const onRevoked: Array<[Step | string, RegExp]> = [
        [`"revokedAt" = NULL, "revokedById" = NULL`, /revocation is final/],
        [`"revokedAt" = now() + interval '1 day'`, /revocation is final/],
        [{ set: `"revokedById" = $2`, params: [u.superB] }, /revocation is final/],
      ];
      for (const [step, pattern] of onRevoked) await expect(set(revoked.id, step), String(pattern)).rejects.toThrow(pattern);

      for (const id of [active.id, revoked.id]) {
        await expect(db.adminScope.delete({ where: { id } })).rejects.toThrow(/never deleted/);
        await expect(raw(`DELETE FROM "AdminScope" WHERE "id" = $1`, id)).rejects.toThrow(/never deleted/);
      }
      await expect(db.adminScope.deleteMany({ where: { adminId: u.admin } })).rejects.toThrow(/never deleted/);
      expect(await scope(active.id)).toEqual(before.active);
      expect(await scope(revoked.id)).toEqual(before.revoked);
    });
  });

  // ── Accommodation ────────────────────────────────────────────────────

  describe("Accommodation", () => {
    const terms = (data: Partial<Prisma.AccommodationUncheckedCreateInput> = {}) => ({
      kinds: ["EXTRA_TIME"] as Prisma.AccommodationUncheckedCreateInput["kinds"],
      extraTimePercent: 33,
      reason: `${tag}: documented by the accessibility office`,
      validUntil: new Date(Date.now() + 120 * DAY),
      requestedById: u.admin,
      ...data,
    });
    const request = (userId: string, data: Partial<Prisma.AccommodationUncheckedCreateInput> = {}) =>
      db.accommodation.create({ data: { userId, ...terms(data) } });
    /** The data of the single UPDATE that approves a REQUESTED row (approveAccommodation). */
    const approval = (note?: string) => ({
      status: "APPROVED" as const,
      approvedBySuperAdminId: u.superA,
      grantedAt: new Date(),
      decidedById: u.superA,
      decidedAt: new Date(),
      ...(note === undefined ? {} : { decisionNote: note }),
    });
    const acc = (id: string) => db.accommodation.findUniqueOrThrow({ where: { id } });
    const set = (id: string, step: Step | string) => update("Accommodation", id, typeof step === "string" ? { set: step } : step);

    /** Legitimate steps, keyed by the status they reach (SUPERSEDED also needs a REQUESTED successor). */
    const STEP: Record<Exclude<AccStatus, "REQUESTED">, () => Step> = {
      APPROVED: () => ({
        set: `"status" = 'APPROVED', "approvedBySuperAdminId" = $2, "grantedAt" = now(), "decidedById" = $2, "decidedAt" = now()`,
        params: [u.superA],
      }),
      REJECTED: () => ({ set: `"status" = 'REJECTED', "decidedById" = $2, "decidedAt" = now(), "decisionNote" = 'Documentation missing.'`, params: [u.superA] }),
      WITHDRAWN: () => ({ set: `"status" = 'WITHDRAWN', "decidedById" = $2, "decidedAt" = now()`, params: [u.admin] }),
      REVOKED: () => ({ set: `"status" = 'REVOKED', "revokedAt" = now(), "revokedById" = $2`, params: [u.superB] }),
      SUPERSEDED: () => ({ set: `"status" = 'SUPERSEDED'` }),
    };

    /**
     * Supersedes the APPROVED row `oldId`: a REQUESTED successor, old →
     * SUPERSEDED, successor → APPROVED, all in one transaction (the order
     * the admin stream uses). Returns the successor's id.
     */
    async function supersede(oldId: string, userId: string, data: Partial<Prisma.AccommodationUncheckedCreateInput> = {}): Promise<string> {
      return db.$transaction(async (tx) => {
        const next = await tx.accommodation.create({ data: { userId, ...terms({ supersedesId: oldId, ...data }) } });
        await tx.accommodation.update({ where: { id: oldId }, data: { status: "SUPERSEDED" } });
        await tx.accommodation.update({ where: { id: next.id }, data: approval() });
        return next.id;
      });
    }
    /** A row of `userId` in `status`, leaving no REQUESTED or APPROVED row behind unless that is the status asked for. */
    async function requestAt(userId: string, status: AccStatus): Promise<string> {
      const { id } = await request(userId);
      if (status === "REQUESTED") return id;
      if (status === "REJECTED" || status === "WITHDRAWN") {
        expect(await set(id, STEP[status]())).toBe(1);
      } else {
        expect(await set(id, STEP.APPROVED())).toBe(1);
        if (status === "REVOKED") expect(await set(id, STEP.REVOKED())).toBe(1);
        if (status === "SUPERSEDED") await retire(await supersede(id, userId));
      }
      expect((await acc(id)).status).toBe(status);
      return id;
    }
    /** Leave no REQUESTED or APPROVED row behind for the user (the partial unique indexes). */
    async function retire(id: string) {
      const { status } = await acc(id);
      if (status === "REQUESTED") await set(id, STEP.WITHDRAWN());
      if (status === "APPROVED") await set(id, STEP.REVOKED());
    }

    it("runs every workflow: request → approve; request → reject; request → withdraw; approved → revoke", async () => {
      const student = u.s1;
      // request → approve (one UPDATE carries the whole decision), then approved → revoke.
      const a = await request(student);
      expect(await acc(a.id)).toMatchObject({ status: "REQUESTED", decidedById: null, grantedAt: null, revokedAt: null });
      await db.accommodation.update({ where: { id: a.id }, data: approval("Approved for this academic year.") });
      expect(await acc(a.id)).toMatchObject({ status: "APPROVED", approvedBySuperAdminId: u.superA, decidedById: u.superA });
      await db.accommodation.update({ where: { id: a.id }, data: { status: "REVOKED", revokedAt: new Date(), revokedById: u.superB } });
      expect(await acc(a.id)).toMatchObject({ status: "REVOKED", revokedById: u.superB, decisionNote: "Approved for this academic year." });

      // request → reject (decider, time and note).
      const b = await request(student);
      await db.accommodation.update({
        where: { id: b.id },
        data: { status: "REJECTED", decidedById: u.superA, decidedAt: new Date(), decisionNote: "Documentation missing." },
      });
      expect(await acc(b.id)).toMatchObject({ status: "REJECTED", decidedById: u.superA, approvedBySuperAdminId: null, grantedAt: null });

      // request → withdraw (by the requester, recorded as the decider).
      const c = await request(student);
      await db.accommodation.update({ where: { id: c.id }, data: { status: "WITHDRAWN", decidedById: u.admin, decidedAt: new Date() } });
      expect(await acc(c.id)).toMatchObject({ status: "WITHDRAWN", decidedById: u.admin });

      // A row never granted may be deleted; a granted one never.
      await expect(db.accommodation.delete({ where: { id: c.id } })).resolves.toMatchObject({ id: c.id });
      await expect(db.accommodation.delete({ where: { id: b.id } })).resolves.toMatchObject({ id: b.id });
      await expect(db.accommodation.delete({ where: { id: a.id } })).rejects.toThrow(/was granted and cannot be deleted/);
      await expect(raw(`DELETE FROM "Accommodation" WHERE "id" = $1`, a.id)).rejects.toThrow(/was granted and cannot be deleted/);
    });

    it("approves now as INSERT REQUESTED then the approving UPDATE, in one transaction (the INSERT may not be APPROVED)", async () => {
      const student = u.s6;
      await expect(db.accommodation.create({ data: { userId: student, ...terms(), ...approval() } })).rejects.toThrow(
        /must be created REQUESTED, not APPROVED/,
      );
      const id = await db.$transaction(async (tx) => {
        const row = await tx.accommodation.create({ data: { userId: student, ...terms({ requestedById: u.superA }) } });
        await tx.accommodation.update({ where: { id: row.id }, data: approval() });
        return row.id;
      });
      expect(await acc(id)).toMatchObject({ status: "APPROVED", requestedById: u.superA, approvedBySuperAdminId: u.superA });
      // approveNow with supersession: INSERT the successor REQUESTED, old → SUPERSEDED, successor → APPROVED.
      const next = await supersede(id, student, { requestedById: u.superA, extraTimePercent: 50 });
      expect(await acc(id)).toMatchObject({ status: "SUPERSEDED" });
      expect(await acc(next)).toMatchObject({ status: "APPROVED", supersedesId: id, extraTimePercent: 50 });
      await retire(next);
    });

    it("creates a row only as an open REQUESTED request", async () => {
      const student = u.s6;
      const rows = () => db.accommodation.count({ where: { userId: student } });
      const before = await rows();
      for (const status of ACC_STATUSES.filter((s) => s !== "REQUESTED")) {
        await expect(
          raw(
            `INSERT INTO "Accommodation" ("id","userId","status","kinds","reason","validUntil","requestedById","approvedBySuperAdminId","grantedAt","decidedById","decidedAt","revokedAt","revokedById","updatedAt")
             VALUES ($1, $2, '${status}', '{BREAKS}', 'r', now() + interval '30 days', $3, $4, now(), $4, now(), now(), $4, now())`,
            `${tag}-raw-${status}`,
            student,
            u.admin,
            u.superA,
          ),
          status,
        ).rejects.toThrow(new RegExp(`must be created REQUESTED, not ${status}`));
      }
      const premature: Array<Partial<Prisma.AccommodationUncheckedCreateInput>> = [
        { decidedById: u.superA },
        { decidedAt: new Date() },
        { decisionNote: "pre-approved" },
        { approvedBySuperAdminId: u.superA },
        { grantedAt: new Date() },
        { revokedAt: new Date() },
        { revokedById: u.superB },
      ];
      for (const extra of premature) {
        await expect(request(student, extra), JSON.stringify(extra)).rejects.toThrow(/must be created as an open request/);
      }
      expect(await rows()).toBe(before);
    });

    it("allows exactly the transitions of the status machine", async () => {
      for (const from of ACC_STATUSES) {
        for (const to of ACC_ALLOWED[from]) {
          const id = await requestAt(u.s2, from);
          if (to === "SUPERSEDED") {
            // The successor exists (REQUESTED) at the moment of the step, then is approved.
            const next = await request(u.s2, { supersedesId: id });
            expect(await set(id, STEP.SUPERSEDED()), `${from} -> ${to}`).toBe(1);
            await db.accommodation.update({ where: { id: next.id }, data: approval() });
            await retire(next.id);
          } else {
            expect(await set(id, STEP[to as Exclude<AccStatus, "REQUESTED">]()), `${from} -> ${to}`).toBe(1);
          }
          expect((await acc(id)).status).toBe(to);
          await retire(id);
        }
      }
    });

    it("refuses every other status change (the final statuses never change)", async () => {
      for (const from of ACC_STATUSES) {
        const id = await requestAt(u.s3, from);
        const before = await acc(id);
        for (const to of ACC_STATUSES) {
          if (to === from || ACC_ALLOWED[from].includes(to)) continue;
          const expected = ACC_FINAL.includes(from) ? new RegExp(`is ${from} \\(final\\)`) : new RegExp(`cannot move from ${from} to ${to}`);
          await expect(set(id, `"status" = '${to}'`), `${from} -> ${to}`).rejects.toThrow(expected);
        }
        expect(await acc(id)).toEqual(before);
        await retire(id);
      }
    });

    it("never changes id, userId, requestedById or requestedAt; freezes documentFileId once granted", async () => {
      const open = await request(u.s4, { documentFileId: "doc-1" });
      const identity: Array<Step | string> = [
        { set: `"userId" = $2`, params: [u.s5] },
        { set: `"requestedById" = $2`, params: [u.superA] },
        `"requestedAt" = "requestedAt" - interval '1 day'`,
        `"id" = "id" || '-x'`,
      ];
      for (const step of identity) await expect(set(open.id, step), JSON.stringify(step)).rejects.toThrow(/id, userId, requestedById and requestedAt never change/);
      await expect(db.accommodation.update({ where: { id: open.id }, data: { userId: u.s5 } })).rejects.toThrow(/never change/);
      // While REQUESTED, the document reference may still change.
      await db.accommodation.update({ where: { id: open.id }, data: { documentFileId: "doc-2" } });
      await db.accommodation.update({ where: { id: open.id }, data: approval() });
      for (const step of identity) await expect(set(open.id, step), JSON.stringify(step)).rejects.toThrow(/never change/);
      for (const step of [`"documentFileId" = 'doc-3'`, `"documentFileId" = NULL`]) {
        await expect(set(open.id, step), step).rejects.toThrow(/terms are immutable/);
      }
      expect(await acc(open.id)).toMatchObject({ userId: u.s4, requestedById: u.admin, documentFileId: "doc-2" });
      await retire(open.id);
    });

    it("writes the decision only in the update that leaves REQUESTED, then never again", async () => {
      // On an open request: no decision field without leaving REQUESTED.
      const open = await request(u.s4);
      const onOpen: Array<Step | string> = [
        { set: `"decidedById" = $2, "decidedAt" = now()`, params: [u.superA] },
        `"decisionNote" = 'thinking about it'`,
        { set: `"approvedBySuperAdminId" = $2`, params: [u.superA] },
        `"grantedAt" = now()`,
      ];
      for (const step of onOpen) await expect(set(open.id, step), JSON.stringify(step)).rejects.toThrow(/written only by the update that leaves REQUESTED/);
      await retire(open.id);

      // Approved with a note: every decision field is final.
      const noted = await request(u.s4);
      await db.accommodation.update({ where: { id: noted.id }, data: approval("Approved for this academic year.") });
      const approved = await acc(noted.id);
      const final: Array<Step | string> = [
        { set: `"decidedById" = $2`, params: [u.superB] },
        `"decidedAt" = now() + interval '1 minute'`,
        `"decidedAt" = NULL`,
        `"decisionNote" = 'rewritten'`,
        `"decisionNote" = NULL`,
        { set: `"approvedBySuperAdminId" = $2`, params: [u.superB] },
        `"grantedAt" = now() + interval '1 minute'`,
      ];
      for (const step of final) await expect(set(noted.id, step), JSON.stringify(step)).rejects.toThrow(/set once and then final/);
      expect(await acc(noted.id)).toEqual(approved);
      // Revoked: the revoke fields are final, and a revoke reason cannot go into decisionNote.
      expect(await set(noted.id, STEP.REVOKED())).toBe(1);
      const revoked = await acc(noted.id);
      for (const step of [`"revokedAt" = now() + interval '1 day'`, `"revokedAt" = NULL`, { set: `"revokedById" = $2`, params: [u.superA] }]) {
        await expect(set(noted.id, step), JSON.stringify(step)).rejects.toThrow(/set once and then final|Accommodation_revoke_pair_check/);
      }
      expect(await acc(noted.id)).toEqual(revoked);

      // Approved without a note: the note cannot be added later, not even by the revoke.
      const plain = await requestAt(u.s4, "APPROVED");
      await expect(db.accommodation.update({ where: { id: plain }, data: { decisionNote: "Added later." } })).rejects.toThrow(
        /written only by the update that leaves REQUESTED/,
      );
      await expect(set(plain, `"status" = 'REVOKED', "revokedAt" = now(), "revokedById" = '${u.superB}', "decisionNote" = 'Revoked: no longer needed.'`)).rejects.toThrow(
        /written only by the update that leaves REQUESTED/,
      );
      await retire(plain);

      const rejected = await requestAt(u.s4, "REJECTED");
      await expect(set(rejected, `"decisionNote" = 'softened'`)).rejects.toThrow(/set once and then final/);
    });

    it("keeps attribution consistent with the status (CHECKs, with and without the triggers)", async () => {
      const student = u.s5;
      // Through the triggers: the decision update itself must carry the attribution.
      const open = await request(student);
      const refused: Array<[Step, RegExp]> = [
        [{ set: `"status" = 'APPROVED', "approvedBySuperAdminId" = $2, "grantedAt" = now()`, params: [u.superA] }, /Accommodation_granted_attribution_check/],
        [{ set: `"status" = 'APPROVED', "approvedBySuperAdminId" = $2, "grantedAt" = now(), "decidedById" = $2`, params: [u.superA] }, /Accommodation_granted_attribution_check/],
        [{ set: `"status" = 'REJECTED', "decisionNote" = 'no'` }, /Accommodation_closed_attribution_check/],
        [{ set: `"status" = 'WITHDRAWN'` }, /Accommodation_closed_attribution_check/],
        [{ set: `"status" = 'REJECTED', "decidedById" = $2, "decidedAt" = now(), "approvedBySuperAdminId" = $2`, params: [u.superA] }, /Accommodation_closed_attribution_check/],
        [{ set: `"status" = 'REJECTED', "decidedById" = $2, "decidedAt" = now(), "grantedAt" = now()`, params: [u.superA] }, /Accommodation_granted_status_check/],
        [{ set: `"status" = 'REJECTED', "decidedById" = $2, "decidedAt" = now(), "revokedAt" = now(), "revokedById" = $2`, params: [u.superA] }, /Accommodation_revoke_pair_check/],
        [{ set: `${STEP.APPROVED().set}, "revokedAt" = now(), "revokedById" = $2` , params: [u.superA] }, /Accommodation_revoke_pair_check/],
      ];
      for (const [step, pattern] of refused) await expect(set(open.id, step), step.set).rejects.toThrow(pattern);
      expect((await acc(open.id)).status).toBe("REQUESTED");
      await retire(open.id);

      const granted = await requestAt(student, "APPROVED");
      await expect(set(granted, `"status" = 'REVOKED'`)).rejects.toThrow(/Accommodation_revoke_pair_check/);
      await expect(set(granted, `"status" = 'REVOKED', "revokedAt" = now()`)).rejects.toThrow(/Accommodation_revoke_pair_check/);
      await expect(set(granted, { set: `"status" = 'REVOKED', "revokedById" = $2`, params: [u.superB] })).rejects.toThrow(/Accommodation_revoke_pair_check/);
      await expect(set(granted, { set: `"revokedAt" = now(), "revokedById" = $2`, params: [u.superB] })).rejects.toThrow(/Accommodation_revoke_pair_check/);
      expect((await acc(granted)).status).toBe("APPROVED");
      await retire(granted);

      // The CHECKs alone (triggers off, rolled back), for the states the triggers refuse first.
      const withdrawn = await requestAt(student, "WITHDRAWN");
      const approvedId = await requestAt(student, "APPROVED");
      const probe = await request(student);
      const on = (id: string, setSql: string) => [`UPDATE "public"."Accommodation" SET ${setSql} WHERE "id" = $1`, id] as const;
      await expectCheckOnly("Accommodation_requested_undecided_check", "Accommodation", ...on(probe.id, `"decidedById" = 'x', "decidedAt" = now()`));
      await expectCheckOnly("Accommodation_requested_undecided_check", "Accommodation", ...on(probe.id, `"decisionNote" = 'x'`));
      await expectCheckOnly("Accommodation_closed_attribution_check", "Accommodation", ...on(withdrawn, `"decidedById" = NULL`));
      await expectCheckOnly("Accommodation_granted_attribution_check", "Accommodation", ...on(approvedId, `"decidedAt" = NULL`));
      await expectCheckOnly("Accommodation_revoke_pair_check", "Accommodation", ...on(approvedId, `"status" = 'REVOKED'`));
      await expectCheckOnly("Accommodation_revoke_pair_check", "Accommodation", ...on(withdrawn, `"revokedAt" = now(), "revokedById" = 'x'`));
      // Control: a consistent write goes through with the triggers off.
      expect(await checksOnly("Accommodation", ...on(approvedId, `"status" = 'REVOKED', "revokedAt" = now(), "revokedById" = 'x'`))).toBe(ROLLBACK);
      await retire(probe.id);
      await retire(approvedId);
    });

    it("never dates a decision or a grant before the request (CHECKs, with and without the triggers)", async () => {
      const student = u.s5;
      const open = await request(student);
      const before = `"requestedAt" - interval '1 second'`;
      const refused: Array<[Step, RegExp]> = [
        [
          { set: `"status" = 'APPROVED', "approvedBySuperAdminId" = $2, "grantedAt" = ${before}, "decidedById" = $2, "decidedAt" = now()`, params: [u.superA] },
          /Accommodation_granted_after_request_check/,
        ],
        [
          { set: `"status" = 'APPROVED', "approvedBySuperAdminId" = $2, "grantedAt" = now(), "decidedById" = $2, "decidedAt" = ${before}`, params: [u.superA] },
          /Accommodation_decided_after_request_check/,
        ],
        [{ set: `"status" = 'REJECTED', "decidedById" = $2, "decidedAt" = ${before}, "decisionNote" = 'no'`, params: [u.superA] }, /Accommodation_decided_after_request_check/],
        [{ set: `"status" = 'WITHDRAWN', "decidedById" = $2, "decidedAt" = "requestedAt" - interval '1 day'`, params: [u.admin] }, /Accommodation_decided_after_request_check/],
      ];
      for (const [step, pattern] of refused) await expect(set(open.id, step), step.set).rejects.toThrow(pattern);
      const row = await acc(open.id);
      await expect(
        db.accommodation.update({ where: { id: open.id }, data: { ...approval(), grantedAt: new Date(row.requestedAt.getTime() - DAY) } }),
      ).rejects.toThrow(/Accommodation_granted_after_request_check/);
      expect((await acc(open.id)).status).toBe("REQUESTED");
      // A decision dated exactly at the request is allowed (approve-now writes one clock reading to both).
      expect(
        await set(open.id, { set: `"status" = 'APPROVED', "approvedBySuperAdminId" = $2, "grantedAt" = "requestedAt", "decidedById" = $2, "decidedAt" = "requestedAt"`, params: [u.superA] }),
      ).toBe(1);
      // The CHECKs alone (triggers off, rolled back): the trigger refuses rewriting a decision first.
      const on = (setSql: string) => [`UPDATE "public"."Accommodation" SET ${setSql} WHERE "id" = $1`, open.id] as const;
      await expectCheckOnly("Accommodation_granted_after_request_check", "Accommodation", ...on(`"grantedAt" = ${before}`));
      await expectCheckOnly("Accommodation_decided_after_request_check", "Accommodation", ...on(`"decidedAt" = ${before}`));
      await expectCheckOnly("Accommodation_decided_after_request_check", "Accommodation", ...on(`"requestedAt" = "decidedAt" + interval '1 second'`));
      await retire(open.id);
    });

    it("supersedes only an accommodation of the same student, never itself", async () => {
      const mine = await requestAt(u.s7, "APPROVED");
      const theirs = await requestAt(u.s8, "APPROVED");
      await expect(request(u.s7, { supersedesId: theirs })).rejects.toThrow(/supersedesId must name another accommodation of the same student/);
      await expect(
        raw(
          `INSERT INTO "Accommodation" ("id","userId","kinds","reason","validUntil","requestedById","supersedesId","updatedAt")
           VALUES ($1, $2, '{BREAKS}', 'r', now() + interval '30 days', $3, $1, now())`,
          `${tag}-self`,
          u.s7,
          u.admin,
        ),
      ).rejects.toThrow(/cannot supersede itself/);
      const open = await request(u.s7);
      await expect(db.accommodation.update({ where: { id: open.id }, data: { supersedesId: theirs } })).rejects.toThrow(
        /supersedesId must name another accommodation of the same student/,
      );
      await expect(set(open.id, `"supersedesId" = "id"`)).rejects.toThrow(/cannot supersede itself/);
      await db.accommodation.update({ where: { id: open.id }, data: { supersedesId: mine } });
      await db.accommodation.update({ where: { id: open.id }, data: { supersedesId: null } });
      await retire(open.id);
      await retire(mine);
      await retire(theirs);
    });

    it("moves APPROVED → SUPERSEDED only while a REQUESTED successor of the same student exists, in the order the indexes need", async () => {
      const student = u.s1;
      const old = await requestAt(student, "APPROVED");
      // No successor at all.
      await expect(set(old, STEP.SUPERSEDED())).rejects.toThrow(/without its successor/);
      await expect(db.accommodation.update({ where: { id: old }, data: { status: "SUPERSEDED" } })).rejects.toThrow(/without its successor/);
      // A successor that is no longer open does not count.
      const withdrawn = await request(student, { supersedesId: old });
      await set(withdrawn.id, STEP.WITHDRAWN());
      await expect(set(old, STEP.SUPERSEDED())).rejects.toThrow(/without its successor/);
      await db.accommodation.delete({ where: { id: withdrawn.id } });
      expect((await acc(old)).status).toBe("APPROVED");

      const next = await request(student, { kinds: ["EXTRA_TIME", "BREAKS"], allowBreaks: true, breakMinutes: 10, supersedesId: old });
      // Wrong order: approving the new row first violates the one-APPROVED-per-user index.
      await expect(
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE "Accommodation" SET "status" = 'APPROVED', "approvedBySuperAdminId" = $2, "grantedAt" = now(), "decidedById" = $2, "decidedAt" = now() WHERE "id" = $1`,
            next.id,
            u.superA,
          );
          await tx.$executeRawUnsafe(`UPDATE "Accommodation" SET "status" = 'SUPERSEDED' WHERE "id" = $1`, old);
        }),
        // unique_violation on ("userId") while a second row becomes APPROVED: Accommodation_one_approved_per_user.
      ).rejects.toThrow(/23505[\s\S]*Key \("userId"\)/);
      expect((await acc(old)).status).toBe("APPROVED");
      expect((await acc(next.id)).status).toBe("REQUESTED");

      // Right order, one transaction (approveAccommodation with supersedesId).
      await db.$transaction(async (tx) => {
        await tx.accommodation.update({ where: { id: old }, data: { status: "SUPERSEDED" } });
        await tx.accommodation.update({ where: { id: next.id }, data: approval() });
      });
      expect(await acc(old)).toMatchObject({ status: "SUPERSEDED" });
      expect(await acc(next.id)).toMatchObject({ status: "APPROVED", supersedesId: old });
      await expect(set(old, `"status" = 'APPROVED'`)).rejects.toThrow(/SUPERSEDED \(final\)/);
      await expect(set(next.id, `"supersedesId" = NULL`)).rejects.toThrow(/terms are immutable/);
      const approved = await db.accommodation.findMany({ where: { userId: student, status: "APPROVED" }, select: { id: true } });
      expect(approved).toEqual([{ id: next.id }]);
      await retire(next.id);
    });

    it("a successor whose predecessor is already SUPERSEDED keeps its link, is never deleted and can only be approved", async () => {
      const student = u.s2;
      const old = await requestAt(student, "APPROVED");
      const next = await request(student, { supersedesId: old });
      // Old → SUPERSEDED committed on its own (the app does both steps in one transaction).
      expect(await set(old, STEP.SUPERSEDED())).toBe(1);
      for (const [step, label] of [
        [STEP.WITHDRAWN(), "withdraw"],
        [STEP.REJECTED(), "reject"],
        [{ set: `"supersedesId" = NULL` }, "unlink"],
      ] as Array<[Step, string]>) {
        await expect(set(next.id, step), label).rejects.toThrow(/replaces a SUPERSEDED accommodation/);
      }
      await expect(db.accommodation.delete({ where: { id: next.id } })).rejects.toThrow(/replaces a SUPERSEDED accommodation/);
      await expect(raw(`DELETE FROM "Accommodation" WHERE "id" = $1`, next.id)).rejects.toThrow(/replaces a SUPERSEDED accommodation/);
      expect((await acc(next.id)).status).toBe("REQUESTED");
      await db.accommodation.update({ where: { id: next.id }, data: approval() });
      expect(await acc(next.id)).toMatchObject({ status: "APPROVED", supersedesId: old });
      await retire(next.id);

      // While the predecessor is still APPROVED, an open successor may be withdrawn or deleted as usual.
      const current = await requestAt(student, "APPROVED");
      const draft = await request(student, { supersedesId: current });
      await db.accommodation.delete({ where: { id: draft.id } });
      const again = await request(student, { supersedesId: current });
      expect(await set(again.id, STEP.WITHDRAWN())).toBe(1);
      await retire(current);
    });

    /**
     * The supersede rules lock the rows they read (20261010100200), so two
     * transactions can no longer each act on a snapshot the other is about
     * to change. Each case holds transaction 1 open on its own connection,
     * starts transaction 2's statement on a second connection, proves from
     * pg_locks that it WAITS (it does not run on its snapshot), then commits
     * transaction 1 and checks that transaction 2 is refused. Without the
     * locks, transaction 2 never waits and both commit: A SUPERSEDED with no
     * open successor (races r1–r3 of the fix-2 verification).
     */
    describe("supersede rules under concurrency (two connections, interleaved deterministically)", () => {
      let c1: TestDb;
      let c2: TestDb;
      beforeAll(() => {
        c1 = mod.createPrismaClient({ url: TEST_URL, log: [] });
        c2 = mod.createPrismaClient({ url: TEST_URL, log: [] });
      });
      afterAll(async () => {
        await c1?.$disconnect();
        await c2?.$disconnect();
      });

      interface TxLike {
        $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
        $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
      }
      interface OpenTx {
        pid: number;
        exec(sql: string, ...params: unknown[]): Promise<number>;
        commit(): Promise<void>;
        rollback(): Promise<void>;
      }

      /** A transaction on `client`, held open until commit() or rollback(). */
      async function begin(client: TestDb): Promise<OpenTx> {
        let finish!: (commit: boolean) => void;
        const finished = new Promise<boolean>((resolve) => (finish = resolve));
        let opened!: (tx: TxLike) => void;
        const ready = new Promise<TxLike>((resolve) => (opened = resolve));
        const done = client.$transaction(
          async (tx) => {
            opened(tx);
            if (!(await finished)) throw ROLLBACK;
          },
          { timeout: 60_000, maxWait: 10_000 },
        );
        const tx = await Promise.race([
          ready,
          done.then(() => {
            throw new Error("the transaction ended before it opened");
          }),
        ]);
        const [row] = await tx.$queryRawUnsafe<Array<{ pid: number }>>("SELECT pg_backend_pid() AS pid");
        return {
          pid: row!.pid,
          exec: (sql, ...params) => tx.$executeRawUnsafe(sql, ...params),
          commit: async () => {
            finish(true);
            await done;
          },
          rollback: async () => {
            finish(false);
            await done.catch((error: unknown) => {
              if (error !== ROLLBACK) throw error;
            });
          },
        };
      }

      type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };
      const settle = (p: Promise<unknown>): Promise<Outcome> =>
        p.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );

      /** Resolves once backend `pid` waits for a lock it was not granted; fails if `pending` settles first (it did not wait). */
      async function expectWaiting(pid: number, pending: Promise<Outcome>): Promise<void> {
        let settled: Outcome | null = null;
        void pending.then((o) => (settled = o));
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [row] = await db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
            `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = $1::int AND NOT granted) AS waiting`,
            pid,
          );
          if (row?.waiting) return;
          if (settled) {
            const s = settled as Outcome;
            throw new Error(`transaction 2 did not wait for transaction 1; it ${s.ok ? "went through" : `failed: ${String((s.error as Error)?.message)}`}`);
          }
          await sleep(20);
        }
        throw new Error("transaction 2 neither waited nor finished within 10 s");
      }

      const SUPERSEDE = `UPDATE "public"."Accommodation" SET "status" = 'SUPERSEDED' WHERE "id" = $1`;
      const APPROVE = `UPDATE "public"."Accommodation" SET "status" = 'APPROVED', "approvedBySuperAdminId" = $2, "grantedAt" = now(), "decidedById" = $2, "decidedAt" = now() WHERE "id" = $1`;
      /** withdrawAccommodation's UPDATE (it also unlinks the request). */
      const WITHDRAW = `UPDATE "public"."Accommodation" SET "status" = 'WITHDRAWN', "decidedById" = $2, "decidedAt" = now(), "supersedesId" = NULL WHERE "id" = $1`;
      const DELETE = `DELETE FROM "public"."Accommodation" WHERE "id" = $1`;

      /** An APPROVED accommodation A of `student` and its REQUESTED successor B. */
      async function pair(student: string): Promise<{ a: string; b: string }> {
        const a = await requestAt(student, "APPROVED");
        const b = (await request(student, { supersedesId: a, extraTimePercent: 50 })).id;
        return { a, b };
      }

      it("r1: T1 supersedes A; T2's withdraw of the successor B waits for T1, then is refused", async () => {
        const { a, b } = await pair(u.race1);
        const t1 = await begin(c1);
        const t2 = await begin(c2);
        try {
          expect(await t1.exec(SUPERSEDE, a)).toBe(1);
          const second = settle(t2.exec(WITHDRAW, b, u.admin));
          await expectWaiting(t2.pid, second);
          await t1.commit();
          const outcome = await second;
          expect(outcome.ok, "T2 withdrew the successor of a SUPERSEDED accommodation").toBe(false);
          expect(String((outcome as { error: Error }).error?.message)).toMatch(/replaces a SUPERSEDED accommodation/);
        } finally {
          await t2.rollback();
          await t1.rollback().catch(() => {});
        }
        expect(await acc(a)).toMatchObject({ status: "SUPERSEDED" });
        expect(await acc(b)).toMatchObject({ status: "REQUESTED", supersedesId: a });
        await db.accommodation.update({ where: { id: b }, data: approval() });
        await retire(b);
      });

      it("r2: T1 supersedes A; T2's DELETE of the successor B waits for T1, then is refused", async () => {
        const { a, b } = await pair(u.race2);
        const t1 = await begin(c1);
        const t2 = await begin(c2);
        try {
          expect(await t1.exec(SUPERSEDE, a)).toBe(1);
          const second = settle(t2.exec(DELETE, b));
          await expectWaiting(t2.pid, second);
          await t1.commit();
          const outcome = await second;
          expect(outcome.ok, "T2 deleted the successor of a SUPERSEDED accommodation").toBe(false);
          expect(String((outcome as { error: Error }).error?.message)).toMatch(/replaces a SUPERSEDED accommodation and cannot be deleted/);
        } finally {
          await t2.rollback();
          await t1.rollback().catch(() => {});
        }
        expect(await acc(a)).toMatchObject({ status: "SUPERSEDED" });
        expect(await acc(b)).toMatchObject({ status: "REQUESTED", supersedesId: a });
        await db.accommodation.update({ where: { id: b }, data: approval() });
        await retire(b);
      });

      it("r3: T1 withdraws the successor B; T2's supersede of A waits for T1, then is refused (no open successor)", async () => {
        const { a, b } = await pair(u.race3);
        const t1 = await begin(c1);
        const t2 = await begin(c2);
        try {
          expect(await t1.exec(WITHDRAW, b, u.admin)).toBe(1);
          const second = settle(t2.exec(SUPERSEDE, a));
          await expectWaiting(t2.pid, second);
          await t1.commit();
          const outcome = await second;
          expect(outcome.ok, "T2 superseded A after its only successor was withdrawn").toBe(false);
          expect(String((outcome as { error: Error }).error?.message)).toMatch(/without its successor/);
        } finally {
          await t2.rollback();
          await t1.rollback().catch(() => {});
        }
        expect(await acc(a)).toMatchObject({ status: "APPROVED" });
        expect(await acc(b)).toMatchObject({ status: "WITHDRAWN", supersedesId: null });
        await retire(a);
      });

      it("r4: the full supersede (A SUPERSEDED, then B APPROVED) in T1; T2's withdraw of B waits, then is refused", async () => {
        const { a, b } = await pair(u.race4);
        const t1 = await begin(c1);
        const t2 = await begin(c2);
        try {
          expect(await t1.exec(SUPERSEDE, a)).toBe(1);
          const second = settle(t2.exec(WITHDRAW, b, u.admin));
          await expectWaiting(t2.pid, second);
          // T1 may still approve the successor it holds FOR SHARE while T2 waits for it.
          expect(await t1.exec(APPROVE, b, u.superA)).toBe(1);
          await t1.commit();
          const outcome = await second;
          expect(outcome.ok).toBe(false);
          expect(String((outcome as { error: Error }).error?.message)).toMatch(/cannot move from APPROVED to WITHDRAWN/);
        } finally {
          await t2.rollback();
          await t1.rollback().catch(() => {});
        }
        expect(await acc(a)).toMatchObject({ status: "SUPERSEDED" });
        expect(await acc(b)).toMatchObject({ status: "APPROVED", supersedesId: a });
        await retire(b);
      });

      it("r5: with a short lock_timeout, T2's withdraw fails on the lock T1 holds instead of reading past it", async () => {
        const { a, b } = await pair(u.race5);
        const t1 = await begin(c1);
        const t2 = await begin(c2);
        try {
          expect(await t1.exec(SUPERSEDE, a)).toBe(1);
          await t2.exec(`SET LOCAL lock_timeout = '300ms'`);
          await expect(t2.exec(WITHDRAW, b, u.admin)).rejects.toThrow(/lock timeout|55P03/);
          await t1.commit();
        } finally {
          await t2.rollback();
          await t1.rollback().catch(() => {});
        }
        expect(await acc(a)).toMatchObject({ status: "SUPERSEDED" });
        expect(await acc(b)).toMatchObject({ status: "REQUESTED", supersedesId: a });
        await db.accommodation.update({ where: { id: b }, data: approval() });
        await retire(b);
      });
    });
  });

  // ── ImpersonationSession ─────────────────────────────────────────────

  describe("ImpersonationSession", () => {
    const start = (data: Partial<Prisma.ImpersonationSessionUncheckedCreateInput> = {}) =>
      db.impersonationSession.create({
        data: {
          impersonatorId: u.superA,
          targetUserId: u.s1,
          reason: `${tag}: student reports a blank dashboard`,
          expiresAt: new Date(Date.now() + 14 * MINUTE),
          ...data,
        },
      });
    const session = (id: string) => db.impersonationSession.findUniqueOrThrow({ where: { id } });
    const set = (id: string, step: Step | string) => update("ImpersonationSession", id, typeof step === "string" ? { set: step } : step);

    it("starts, ends exactly once, and is never reopened, edited or deleted", async () => {
      const s = await start();
      const live = await session(s.id);
      const refused: Array<[Step | string, RegExp]> = [
        [`"startedAt" = "startedAt" + interval '5 minutes', "expiresAt" = "expiresAt" + interval '5 minutes'`, /is immutable/], // sliding the window
        [`"expiresAt" = "expiresAt" + interval '1 minute'`, /is immutable/], // an extension inside the 15-minute box
        [`"expiresAt" = "startedAt" + interval '1 minute'`, /is immutable/],
        [{ set: `"impersonatorId" = $2`, params: [u.superB] }, /is immutable/],
        [{ set: `"targetUserId" = $2`, params: [u.s2] }, /is immutable/],
        [`"reason" = 'edited'`, /is immutable/],
        [`"endedAt" = now()`, /ImpersonationSession_end_pair_check/],
        [`"endReason" = 'ENDED'`, /ImpersonationSession_end_pair_check/],
      ];
      for (const [step, pattern] of refused) await expect(set(s.id, step), String(pattern)).rejects.toThrow(pattern);
      expect(await session(s.id)).toEqual(live);

      // Close is a conditional update on endedAt IS NULL: exactly one path wins.
      const close = (endReason: "ENDED" | "EXPIRED") =>
        db.impersonationSession.updateMany({ where: { id: s.id, endedAt: null }, data: { endedAt: new Date(), endReason } });
      expect((await close("ENDED")).count).toBe(1);
      expect((await close("EXPIRED")).count).toBe(0);
      const ended = await session(s.id);
      expect(ended.endReason).toBe("ENDED");

      for (const step of [`"endedAt" = NULL, "endReason" = NULL`, `"endReason" = 'REVOKED'`, `"endedAt" = now() + interval '1 minute'`]) {
        await expect(set(s.id, step), step).rejects.toThrow(/has ended: the end is final/);
      }
      await expect(db.impersonationSession.update({ where: { id: s.id }, data: { endedAt: null, endReason: null } })).rejects.toThrow(
        /the end is final/,
      );
      await expect(db.impersonationSession.delete({ where: { id: s.id } })).rejects.toThrow(/never deleted/);
      await expect(raw(`DELETE FROM "ImpersonationSession" WHERE "id" = $1`, s.id)).rejects.toThrow(/never deleted/);
      expect(await session(s.id)).toEqual(ended);
    });

    it("refuses an empty or over-long window and impersonating yourself (CHECKs)", async () => {
      const now = Date.now();
      await expect(start({ startedAt: new Date(now), expiresAt: new Date(now) })).rejects.toThrow(/ImpersonationSession_window_check/);
      await expect(start({ startedAt: new Date(now), expiresAt: new Date(now - MINUTE) })).rejects.toThrow(/ImpersonationSession_window_check/);
      await expect(start({ startedAt: new Date(now), expiresAt: new Date(now + 15 * MINUTE + 1) })).rejects.toThrow(/ImpersonationSession_box/);
      await expect(start({ targetUserId: u.superA })).rejects.toThrow(/ImpersonationSession_not_self/);
      await expect(start({ startedAt: new Date(now), expiresAt: new Date(now + 15 * MINUTE) })).resolves.toBeTruthy();
    });

    it("starts now: startedAt within 5 minutes of the database clock at INSERT", async () => {
      const now = Date.now();
      for (const startedAt of [new Date(now - 6 * MINUTE), new Date(now + 6 * MINUTE), new Date(now + DAY), new Date(now - DAY)]) {
        await expect(start({ startedAt, expiresAt: new Date(startedAt.getTime() + 10 * MINUTE) }), startedAt.toISOString()).rejects.toThrow(
          /startedAt must be within 5 minutes of the database clock/,
        );
      }
      await expect(
        raw(
          `INSERT INTO "ImpersonationSession" ("id","impersonatorId","targetUserId","reason","startedAt","expiresAt")
           VALUES ($1, $2, $3, 'r', now() + interval '1 day', now() + interval '1 day 10 minutes')`,
          `${tag}-tomorrow`,
          u.superA,
          u.s2,
        ),
      ).rejects.toThrow(/startedAt must be within 5 minutes/);
      await expect(start({ startedAt: new Date(now - 4 * MINUTE), expiresAt: new Date(now + 10 * MINUTE) })).resolves.toBeTruthy();
      await expect(start({ startedAt: new Date(now + 4 * MINUTE), expiresAt: new Date(now + 15 * MINUTE) })).resolves.toBeTruthy();
      // The database default (raw INSERT without startedAt) is inside the window.
      expect(
        await raw(
          `INSERT INTO "ImpersonationSession" ("id","impersonatorId","targetUserId","reason","expiresAt") VALUES ($1, $2, $3, 'r', now() + interval '10 minutes')`,
          `${tag}-default-start`,
          u.superA,
          u.s3,
        ),
      ).toBe(1);
    });

    it("never ends before it started (CHECK)", async () => {
      const s = await start({ startedAt: new Date(Date.now() - 2 * MINUTE), expiresAt: new Date(Date.now() + 10 * MINUTE) });
      await expect(set(s.id, `"endedAt" = "startedAt" - interval '1 second', "endReason" = 'ENDED'`)).rejects.toThrow(
        /ImpersonationSession_end_after_start_check/,
      );
      expect((await session(s.id)).endedAt).toBeNull();
      expect(await set(s.id, `"endedAt" = "startedAt", "endReason" = 'ENDED'`)).toBe(1);
    });

    it("is created open: an INSERT carries no endedAt or endReason", async () => {
      const marker = `${tag}: born ended`;
      const count = () => db.impersonationSession.count({ where: { reason: marker } });
      for (const extra of [{ endedAt: new Date(), endReason: "ENDED" as const }, { endedAt: new Date() }, { endReason: "REVOKED" as const }]) {
        await expect(start({ reason: marker, ...extra }), JSON.stringify(extra)).rejects.toThrow(/must be created open/);
      }
      await expect(
        raw(
          `INSERT INTO "ImpersonationSession" ("id","impersonatorId","targetUserId","reason","expiresAt","endedAt","endReason")
           VALUES ($1, $2, $3, $4, now() + interval '10 minutes', now(), 'ENDED')`,
          `${tag}-born-ended`,
          u.superA,
          u.s4,
          marker,
        ),
      ).rejects.toThrow(/must be created open/);
      expect(await count()).toBe(0);
    });

    it("never ends more than 5 minutes after the database clock", async () => {
      const clock = `(statement_timestamp() AT TIME ZONE 'UTC')`;
      const s = await start({ targetUserId: u.s5 });
      for (const ahead of ["6 minutes", "1 day", "1 year"]) {
        await expect(set(s.id, `"endedAt" = ${clock} + interval '${ahead}', "endReason" = 'ENDED'`), ahead).rejects.toThrow(
          /endedAt may not be more than 5 minutes after the database clock/,
        );
      }
      await expect(
        db.impersonationSession.update({ where: { id: s.id }, data: { endedAt: new Date(Date.now() + HOUR), endReason: "REVOKED" } }),
      ).rejects.toThrow(/more than 5 minutes after the database clock/);
      expect((await session(s.id)).endedAt).toBeNull();
      // Inside the tolerance is accepted (the close path writes GREATEST(now(), startedAt)).
      expect(await set(s.id, `"endedAt" = ${clock} + interval '4 minutes', "endReason" = 'ENDED'`)).toBe(1);
      const ahead = await start({ targetUserId: u.s6, startedAt: new Date(Date.now() + 4 * MINUTE), expiresAt: new Date(Date.now() + 15 * MINUTE) });
      expect(await set(ahead.id, `"endedAt" = GREATEST((now() AT TIME ZONE 'UTC'), "startedAt"), "endReason" = 'ENDED'`)).toBe(1);
    });
  });

  // ── Announcement ─────────────────────────────────────────────────────

  describe("Announcement", () => {
    const set = (id: string, step: Step | string) => update("Announcement", id, typeof step === "string" ? { set: step } : step);
    const draft = (data: Partial<Prisma.AnnouncementUncheckedCreateInput> = {}) =>
      db.announcement.create({
        data: {
          title: "Lab timetable",
          body: "Lab sessions move to the afternoon.",
          audienceBatchYear: 2027,
          audienceDepartmentCode: "CSE",
          endsAt: new Date(Date.now() + 7 * DAY),
          createdById: u.admin,
          ...data,
        },
      });

    it("edits a draft freely, then freezes the text, audience and recipient count at publish", async () => {
      const a = await draft();
      // A draft: the text and audience are editable (recipientCount stays 0 until the publish UPDATE).
      await db.announcement.update({
        where: { id: a.id },
        data: { title: "Lab timetable (revised)", body: "Lab sessions move to 2 pm.", tone: "IMPORTANT", link: "/sheets", audienceSection: "A" },
      });
      // Publish: publishedAt, publishedById and recipientCount in one UPDATE.
      await db.announcement.update({ where: { id: a.id }, data: { publishedAt: new Date(), publishedById: u.admin, recipientCount: 4 } });
      const published = await db.announcement.findUniqueOrThrow({ where: { id: a.id } });

      const frozen: Array<Step | string> = [
        `"title" = 'Edited title'`,
        `"body" = 'Edited body'`,
        `"tone" = 'INFO'`,
        `"link" = NULL`,
        `"audienceBatchYear" = 2026`,
        `"audienceDepartmentCode" = 'ECE'`,
        `"audienceSection" = NULL`,
        `"recipientCount" = 5`,
      ];
      for (const step of frozen) await expect(set(a.id, step), JSON.stringify(step)).rejects.toThrow(/is published: its text and audience are immutable/);
      await expect(db.announcement.update({ where: { id: a.id }, data: { body: "Edited via Prisma" } })).rejects.toThrow(/is published/);
      for (const step of [`"publishedAt" = NULL`, `"publishedAt" = now() + interval '1 hour'`, { set: `"publishedById" = $2`, params: [u.superA] }]) {
        await expect(set(a.id, step), JSON.stringify(step)).rejects.toThrow(/are set once/);
      }
      expect(await db.announcement.findUniqueOrThrow({ where: { id: a.id } })).toEqual(published);

      // Still writable after publish: the banner end, and archiving (once).
      await db.announcement.update({ where: { id: a.id }, data: { endsAt: new Date(Date.now() + DAY) } });
      await db.announcement.update({ where: { id: a.id }, data: { archivedAt: new Date(), archivedById: u.admin } });
      for (const step of [`"archivedAt" = NULL`, `"archivedAt" = now() + interval '1 hour'`, { set: `"archivedById" = $2`, params: [u.superA] }]) {
        await expect(set(a.id, step), JSON.stringify(step)).rejects.toThrow(/are set once/);
      }
      const after = await db.announcement.findUniqueOrThrow({ where: { id: a.id } });
      expect({ title: after.title, body: after.body, recipientCount: after.recipientCount, publishedAt: after.publishedAt }).toEqual({
        title: published.title,
        body: published.body,
        recipientCount: 4,
        publishedAt: published.publishedAt,
      });
    });

    it("is created as an unpublished draft with recipientCount 0", async () => {
      const marker = `${tag} born published`;
      const premature: Array<Partial<Prisma.AnnouncementUncheckedCreateInput>> = [
        { publishedAt: new Date(), publishedById: u.admin },
        { publishedAt: new Date() },
        { publishedById: u.admin },
        { archivedAt: new Date() },
        { archivedById: u.admin },
        { recipientCount: 999_999 },
      ];
      for (const extra of premature) {
        await expect(draft({ title: marker, ...extra }), JSON.stringify(extra)).rejects.toThrow(/must be created as an unpublished draft/);
      }
      await expect(
        raw(
          `INSERT INTO "Announcement" ("id","title","body","endsAt","publishedAt","publishedById","recipientCount","createdById","updatedAt")
           VALUES ($1, $2, 'b', now() + interval '1 day', now(), $3, 5, $3, now())`,
          `${tag}-born-published`,
          marker,
          u.admin,
        ),
      ).rejects.toThrow(/must be created as an unpublished draft/);
      expect(await db.announcement.count({ where: { title: marker } })).toBe(0);
    });

    it("publishes publishedAt and publishedById together (CHECK)", async () => {
      const a = await draft();
      await expect(set(a.id, `"publishedAt" = now(), "recipientCount" = 3`)).rejects.toThrow(/Announcement_publish_pair_check/);
      await expect(set(a.id, { set: `"publishedById" = $2`, params: [u.admin] })).rejects.toThrow(/Announcement_publish_pair_check/);
      await expect(db.announcement.update({ where: { id: a.id }, data: { publishedAt: new Date() } })).rejects.toThrow(
        /Announcement_publish_pair_check/,
      );
      expect((await db.announcement.findUniqueOrThrow({ where: { id: a.id } })).publishedAt).toBeNull();
      expect(await set(a.id, { set: `"publishedAt" = now(), "publishedById" = $2, "recipientCount" = 3`, params: [u.admin] })).toBe(1);
    });

    it("counts no recipients on a draft (CHECK): recipientCount is written by the publish UPDATE", async () => {
      const a = await draft();
      await expect(set(a.id, `"recipientCount" = 1`)).rejects.toThrow(/Announcement_draft_recipients_check/);
      await expect(db.announcement.update({ where: { id: a.id }, data: { recipientCount: 999_999 } })).rejects.toThrow(
        /Announcement_draft_recipients_check/,
      );
      await expectCheckOnly("Announcement_draft_recipients_check", "Announcement", `UPDATE "public"."Announcement" SET "recipientCount" = 3 WHERE "id" = $1`, a.id);
      expect((await db.announcement.findUniqueOrThrow({ where: { id: a.id } })).recipientCount).toBe(0);
      // The publish UPDATE sets the count with publishedAt and publishedById; a publish to nobody keeps 0.
      expect(await set(a.id, { set: `"publishedAt" = now(), "publishedById" = $2, "recipientCount" = 7`, params: [u.admin] })).toBe(1);
      const empty = await draft();
      expect(await set(empty.id, { set: `"publishedAt" = now(), "publishedById" = $2`, params: [u.admin] })).toBe(1);
    });

    it("never changes id or createdById, draft or published", async () => {
      const d = await draft();
      const live = await draft();
      await db.announcement.update({ where: { id: live.id }, data: { publishedAt: new Date(), publishedById: u.admin, recipientCount: 2 } });
      for (const id of [d.id, live.id]) {
        const before = await db.announcement.findUniqueOrThrow({ where: { id } });
        for (const step of [`"id" = "id" || '-renamed'`, { set: `"createdById" = $2`, params: [u.superA] } as Step]) {
          await expect(set(id, step), JSON.stringify(step)).rejects.toThrow(/id and createdById never change/);
        }
        await expect(db.announcement.update({ where: { id }, data: { createdById: u.superB } })).rejects.toThrow(/id and createdById never change/);
        expect(await db.announcement.findUniqueOrThrow({ where: { id } })).toEqual(before);
      }
      // The draft is still editable otherwise.
      await db.announcement.update({ where: { id: d.id }, data: { title: "Lab timetable (draft 2)" } });
    });

    it("deletes a draft, never a published announcement (archived or not)", async () => {
      const d = await draft();
      await expect(db.announcement.delete({ where: { id: d.id } })).resolves.toMatchObject({ id: d.id });
      const live = await draft();
      await db.announcement.update({ where: { id: live.id }, data: { publishedAt: new Date(), publishedById: u.admin, recipientCount: 2 } });
      const archived = await draft();
      await db.announcement.update({ where: { id: archived.id }, data: { publishedAt: new Date(), publishedById: u.admin } });
      await db.announcement.update({ where: { id: archived.id }, data: { archivedAt: new Date(), archivedById: u.admin } });
      for (const id of [live.id, archived.id]) {
        await expect(db.announcement.delete({ where: { id } })).rejects.toThrow(/was published and cannot be deleted/);
        await expect(raw(`DELETE FROM "Announcement" WHERE "id" = $1`, id)).rejects.toThrow(/was published and cannot be deleted/);
      }
      await expect(db.announcement.deleteMany({ where: { id: { in: [live.id, archived.id] } } })).rejects.toThrow(/cannot be deleted/);
      expect(await db.announcement.count({ where: { id: { in: [live.id, archived.id] } } })).toBe(2);
    });
  });

  // ── TRUNCATE ─────────────────────────────────────────────────────────

  describe("TRUNCATE", () => {
    it("every guarded table has an enabled BEFORE TRUNCATE statement trigger running recx_refuse_truncate", async () => {
      const rows = await db.$queryRawUnsafe<Array<{ table: string; trigger: string; enabled: string; before: boolean; statement: boolean }>>(
        `SELECT c.relname AS "table", t.tgname AS "trigger", t.tgenabled::text AS enabled,
                (t.tgtype & 2) <> 0 AS before, (t.tgtype & 1) = 0 AS statement
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE NOT t.tgisinternal AND (t.tgtype & 32) <> 0 AND p.proname = 'recx_refuse_truncate'
          ORDER BY 1`,
      );
      expect(rows.map((r) => r.table).sort()).toEqual([...TRUNCATE_GUARDED].sort());
      for (const r of rows) expect(r, r.table).toMatchObject({ trigger: `${r.table}_no_truncate`, enabled: "O", before: true, statement: true });
    });

    it.each(TRUNCATE_GUARDED)("TRUNCATE %s is refused (inside a transaction that is always rolled back)", async (table) => {
      // A table another table references can only be truncated with CASCADE
      // (Postgres checks the foreign keys before it fires TRUNCATE triggers).
      const [{ referenced } = { referenced: false }] = await db.$queryRawUnsafe<Array<{ referenced: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE contype = 'f' AND confrelid = $1::regclass AND conrelid <> confrelid) AS referenced`,
        `"public"."${table}"`,
      );
      const count = async () =>
        (await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM "public"."${table}"`))[0]!.n;
      const before = await count();
      let outcome: unknown = null;
      try {
        await db.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(`TRUNCATE "public"."${table}"${referenced ? " CASCADE" : ""}`);
            throw ROLLBACK;
          },
          { timeout: 30_000, maxWait: 10_000 },
        );
      } catch (error) {
        outcome = error;
      }
      expect(outcome, `TRUNCATE ${table} went through (rolled back)`).not.toBe(ROLLBACK);
      expect(String((outcome as Error | null)?.message)).toMatch(new RegExp(`${table} cannot be truncated`));
      expect(await count()).toBe(before);
    });

    it("AuditLog rows can still be deleted one by one (the 3-year retention purge) but never updated", async () => {
      const row = await db.auditLog.create({
        data: { action: `${tag}.retention-probe`, entityType: "Test", chainDay: "1970-01-01", prevHash: "0".repeat(64), hash: "f".repeat(64) },
      });
      await expect(db.auditLog.update({ where: { id: row.id }, data: { action: "edited" } })).rejects.toThrow(/append-only/i);
      expect(await raw(`DELETE FROM "AuditLog" WHERE "id" = $1`, row.id)).toBe(1);
    });
  });
});
