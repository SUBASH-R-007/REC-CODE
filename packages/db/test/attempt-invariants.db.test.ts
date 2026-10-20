import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type DbModule,
  type TestDb,
} from "./support/test-db";

/**
 * The attempt engine's invariants (migration 20261019160000), which are
 * where several of Phase 6's promises stop being aspirations:
 *
 *   - VOIDED is reachable ONLY from a finished status, so no automatic path
 *     can reach it (SPEC §0: no signal ever auto-penalises);
 *   - the sitting is written once — above all expiresAt, which is computed
 *     server-side at start and must not be movable afterwards;
 *   - a granted break is never taken back and a recorded event is never
 *     un-recorded;
 *   - ProctorEvent stores event SHAPE only, so the hash column cannot carry
 *     text and a CLIENT event must carry the sequence that makes
 *     suppression detectable;
 *   - ProctorEvent is really partitioned, and rows route by month.
 */

const tag = `at-${randomBytes(4).toString("hex")}`;
const TITLE = RUN_DB_TESTS
  ? "attempt engine invariants (live database)"
  : "attempt engine invariants (set RECX_DB_TESTS=1 to run)";

const SHA = "a".repeat(64);

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let mod: DbModule;
  let restoreEnv: () => void;

  let userId = "";
  let assessmentId = "";
  const attemptIds: string[] = [];
  let nextAttemptNumber = 1;

  const STARTED = new Date("2026-12-01T10:00:00.000Z");
  const EXPIRES = new Date("2026-12-01T11:00:00.000Z");

  async function refused(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return String((error as Error).message);
    }
    throw new Error("the write was expected to be refused, but it went through");
  }

  /** A fresh attempt, so each test owns its own row. */
  async function attempt(over: Record<string, unknown> = {}) {
    const row = await db.assessmentAttempt.create({
      data: {
        assessmentId,
        userId,
        attemptNumber: nextAttemptNumber++,
        seed: 1,
        startedAt: STARTED,
        expiresAt: EXPIRES,
        layout: { order: [1, 2, 3] },
        tokenHash: SHA,
        proctorMode: "ADVISORY",
        ...over,
      },
      select: { id: true, status: true },
    });
    attemptIds.push(row.id);
    return row;
  }

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, mod, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const handle = `${tag}-u`;
    const user = await db.user.create({
      data: {
        collegeId: handle.toUpperCase(),
        email: `${handle}@example.test`,
        firstName: "A",
        lastName: "Candidate",
        handle,
        role: "STUDENT",
      },
      select: { id: true },
    });
    userId = user.id;

    const a = await db.assessment.create({
      data: {
        slug: `${tag}-a`,
        title: "Attempt fixture",
        instructions: "Go.",
        opensAt: STARTED,
        closesAt: new Date("2026-12-01T20:00:00.000Z"),
        durationSec: 3600,
        maxAttempts: 5,
        createdById: userId,
      },
      select: { id: true },
    });
    assessmentId = a.id;
  });

  afterAll(async () => {
    if (!db) return;
    try {
      const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
      const off = [
        ["AssessmentAttempt", "AssessmentAttempt_machine"],
        ["AttemptSnapshot", "AttemptSnapshot_append_only"],
        ["Assessment", "Assessment_published_immutable"],
      ] as const;
      await db.$transaction([
        ...off.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" DISABLE TRIGGER "${g}"`)),
        raw(`DELETE FROM "public"."ProctorEvent" WHERE "attemptId" = ANY($1::text[])`, attemptIds),
        raw(`DELETE FROM "public"."AttemptSnapshot" WHERE "attemptId" = ANY($1::text[])`, attemptIds),
        raw(`DELETE FROM "public"."AssessmentAttempt" WHERE "userId" = $1`, userId),
        raw(`DELETE FROM "public"."Assessment" WHERE "createdById" = $1`, userId),
        raw(`DELETE FROM "public"."User" WHERE "id" = $1`, userId),
        ...off.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" ENABLE TRIGGER "${g}"`)),
      ]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  describe("the status machine", () => {
    it("starts, then submits", async () => {
      const a = await attempt();
      await db.assessmentAttempt.update({ where: { id: a.id }, data: { status: "IN_PROGRESS" } });
      const done = await db.assessmentAttempt.update({
        where: { id: a.id },
        data: { status: "SUBMITTED", submittedAt: new Date() },
        select: { status: true },
      });
      expect(done.status).toBe("SUBMITTED");
    });

    it("lets a dropped connection come back — the clock never stopped", async () => {
      const a = await attempt({ status: "IN_PROGRESS" });
      await db.assessmentAttempt.update({ where: { id: a.id }, data: { status: "DISCONNECTED" } });
      const back = await db.assessmentAttempt.update({
        where: { id: a.id },
        data: { status: "IN_PROGRESS" },
        select: { status: true },
      });
      expect(back.status).toBe("IN_PROGRESS");
    });

    it("refuses to restart a submitted attempt", async () => {
      const a = await attempt({ status: "SUBMITTED", submittedAt: new Date() });
      const message = await refused(() =>
        db.assessmentAttempt.update({ where: { id: a.id }, data: { status: "IN_PROGRESS" } }),
      );
      expect(message).toMatch(/cannot move from SUBMITTED to IN_PROGRESS/);
    });

    it("refuses VOIDED from an attempt still in progress — nothing automatic may void", async () => {
      const a = await attempt({ status: "IN_PROGRESS" });
      const message = await refused(() =>
        db.assessmentAttempt.update({ where: { id: a.id }, data: { status: "VOIDED" } }),
      );
      expect(message).toMatch(/cannot move from IN_PROGRESS to VOIDED/);
    });

    it("allows VOIDED only after a finished status (a recorded human verdict)", async () => {
      const a = await attempt({ status: "TERMINATED" });
      const voided = await db.assessmentAttempt.update({
        where: { id: a.id },
        data: { status: "VOIDED" },
        select: { status: true },
      });
      expect(voided.status).toBe("VOIDED");
    });

    it("VOIDED is terminal", async () => {
      const a = await attempt({ status: "TERMINATED" });
      await db.assessmentAttempt.update({ where: { id: a.id }, data: { status: "VOIDED" } });
      const message = await refused(() =>
        db.assessmentAttempt.update({ where: { id: a.id }, data: { status: "SUBMITTED" } }),
      );
      expect(message).toMatch(/cannot move from VOIDED/);
    });

    it("is never deleted — it is the record of a sitting", async () => {
      const a = await attempt();
      const message = await refused(() => db.assessmentAttempt.delete({ where: { id: a.id } }));
      expect(message).toMatch(/never deleted/);
    });
  });

  describe("the sitting is written once", () => {
    it("refuses moving expiresAt, and says what to do instead", async () => {
      const a = await attempt({ status: "IN_PROGRESS" });
      const message = await refused(() =>
        db.assessmentAttempt.update({
          where: { id: a.id },
          data: { expiresAt: new Date("2026-12-01T12:00:00.000Z") },
        }),
      );
      expect(message).toMatch(/written once/);
      expect(message, "the refusal points at the supported way to grant time").toMatch(/pausedMs/);
    });

    it.each([
      ["startedAt", { startedAt: new Date("2026-12-01T09:00:00.000Z") }],
      ["seed", { seed: 999 }],
      ["layout", { layout: { order: [3, 2, 1] } }],
      ["proctorMode", { proctorMode: "LAB_SUPERVISED" as const }],
    ])("refuses changing %s", async (_name, data) => {
      const a = await attempt();
      const message = await refused(() => db.assessmentAttempt.update({ where: { id: a.id }, data }));
      expect(message).toMatch(/written once/);
    });

    it("a granted break extends the clock, and only ever grows", async () => {
      const a = await attempt({ status: "IN_PROGRESS" });
      await db.assessmentAttempt.update({ where: { id: a.id }, data: { pausedMs: 300_000 } });
      const message = await refused(() =>
        db.assessmentAttempt.update({ where: { id: a.id }, data: { pausedMs: 0 } }),
      );
      expect(message).toMatch(/never taken back/);
    });

    it.each(["blurEventCount", "fullscreenExitCount", "pasteEventCount"])(
      "%s only increases — a recorded event is not un-recorded",
      async (field) => {
        const a = await attempt({ status: "IN_PROGRESS", [field]: 4 });
        const message = await refused(() =>
          db.assessmentAttempt.update({ where: { id: a.id }, data: { [field]: 1 } }),
        );
        expect(message).toMatch(/only increase/);
      },
    );
  });

  describe("AssessmentAttempt bounds", () => {
    it("refuses an expiry at or before the start", async () => {
      const message = await refused(() => attempt({ expiresAt: STARTED }));
      expect(message).toMatch(/AssessmentAttempt_window_check/);
    });

    it("refuses a score above the maximum", async () => {
      const message = await refused(() => attempt({ totalScore: 10, maxScore: 5 }));
      expect(message).toMatch(/AssessmentAttempt_score_check/);
    });

    it.each([-1, 101])("refuses integrityScore %d", async (integrityScore) => {
      const message = await refused(() => attempt({ integrityScore }));
      expect(message).toMatch(/AssessmentAttempt_integrity_check/);
    });

    it("requires submittedAt on a submitted attempt, and forbids it otherwise", async () => {
      expect(await refused(() => attempt({ status: "SUBMITTED" }))).toMatch(
        /AssessmentAttempt_submitted_check/,
      );
      expect(await refused(() => attempt({ status: "IN_PROGRESS", submittedAt: new Date() }))).toMatch(
        /AssessmentAttempt_submitted_check/,
      );
    });

    it("refuses a second attempt with the same number", async () => {
      const n = nextAttemptNumber;
      await attempt({ attemptNumber: n });
      nextAttemptNumber = n + 1;
      const message = await refused(() => attempt({ attemptNumber: n }));
      expect(message).toMatch(/Unique constraint|assessmentId_userId_attemptNumber/);
    });
  });

  describe("ProctorEvent stores shape, never content", () => {
    let attemptId = "";
    let seq = 1;

    beforeAll(async () => {
      attemptId = (await attempt({ status: "IN_PROGRESS" })).id;
    });

    const event = (over: Record<string, unknown> = {}) => ({
      attemptId,
      kind: "FOCUS_LOSS" as const,
      source: "CLIENT" as const,
      clientSeq: seq++,
      atMs: 1000,
      ...over,
    });

    it("accepts a client event with its sequence", async () => {
      const row = await db.proctorEvent.create({ data: event(), select: { id: true } });
      expect(row.id).toBeTruthy();
    });

    it("refuses a CLIENT event with no sequence — the sequence detects suppression", async () => {
      const message = await refused(() => db.proctorEvent.create({ data: event({ clientSeq: null }) }));
      expect(message).toMatch(/ProctorEvent_client_seq_check/);
    });

    it("refuses a SERVER event that carries one", async () => {
      const message = await refused(() =>
        db.proctorEvent.create({ data: event({ source: "SERVER", clientSeq: 42 }) }),
      );
      expect(message).toMatch(/ProctorEvent_client_seq_check/);
    });

    it("accepts a server-derived SNAPSHOT_JUMP with no sequence", async () => {
      const row = await db.proctorEvent.create({
        data: { attemptId, kind: "SNAPSHOT_JUMP", source: "SERVER", severity: "HIGH", atMs: 90_000 },
        select: { kind: true },
      });
      expect(row.kind).toBe("SNAPSHOT_JUMP");
    });

    it("refuses a hash that is not a sha256 — that column is not a place to smuggle text", async () => {
      const message = await refused(() =>
        db.proctorEvent.create({ data: event({ kind: "EXTERNAL_PASTE", hash: "the quick brown fox" }) }),
      );
      expect(message).toMatch(/ProctorEvent_hash_check/);
    });

    it("accepts a real sha256 and a byte size", async () => {
      const row = await db.proctorEvent.create({
        data: event({ kind: "EXTERNAL_PASTE", hash: SHA, size: 2048 }),
        select: { size: true, hash: true },
      });
      expect(row).toEqual({ size: 2048, hash: SHA });
    });

    it("refuses a payload larger than 64 KB", async () => {
      const message = await refused(() => db.proctorEvent.create({ data: event({ size: 65_537 }) }));
      expect(message).toMatch(/ProctorEvent_size_check/);
    });

    it.each([
      ["a negative atMs", { atMs: -1 }, /ProctorEvent_atMs_check/],
      ["a negative duration", { durationMs: -5 }, /ProctorEvent_duration_check/],
      ["a negative sequence", { clientSeq: -1 }, /ProctorEvent_client_seq_range_check/],
    ])("refuses %s", async (_name, over, pattern) => {
      const message = await refused(() => db.proctorEvent.create({ data: event(over) }));
      expect(message).toMatch(pattern);
    });
  });

  describe("ProctorEvent is really partitioned, by month", () => {
    it("declares a RANGE partition key on occurredAt", async () => {
      const [row] = await db.$queryRawUnsafe<Array<{ relkind: string; key: string }>>(
        `SELECT c.relkind::text AS relkind, pg_get_partkeydef(c.oid) AS key
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'ProctorEvent'`,
      );
      expect(row?.relkind, "'p' means partitioned").toBe("p");
      expect(row?.key).toBe('RANGE ("occurredAt")');
    });

    it("routes a row to the partition for its month", async () => {
      const a = await attempt({ status: "IN_PROGRESS" });
      await db.proctorEvent.createMany({
        data: [
          { attemptId: a.id, kind: "HEARTBEAT_GAP", source: "SERVER", atMs: 1, occurredAt: new Date("2026-11-15T10:00:00.000Z") },
          { attemptId: a.id, kind: "HEARTBEAT_GAP", source: "SERVER", atMs: 2, occurredAt: new Date("2027-02-15T10:00:00.000Z") },
        ],
      });
      const rows = await db.$queryRawUnsafe<Array<{ lives_in: string }>>(
        `SELECT tableoid::regclass::text AS lives_in FROM "public"."ProctorEvent"
          WHERE "attemptId" = $1 ORDER BY "occurredAt"`,
        a.id,
      );
      expect(rows.map((r) => r.lives_in)).toEqual(["proctor_event_2026_11", "proctor_event_2027_02"]);
    });

    it("has a DEFAULT partition, so an insert never fails for want of one", async () => {
      const [row] = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM pg_class WHERE relname = 'proctor_event_default'`,
      );
      expect(Number(row?.n)).toBe(1);
    });
  });

  describe("AttemptSnapshot is append-only evidence", () => {
    it("refuses an UPDATE", async () => {
      const a = await attempt({ status: "IN_PROGRESS" });
      const snap = await db.attemptSnapshot.create({
        data: {
          attemptId: a.id,
          questionId: "q1",
          atMs: 30_000,
          language: "py312",
          content: "print(1)\n",
          contentHash: SHA,
          trigger: "TICK",
        },
        select: { id: true },
      });
      const message = await refused(() =>
        db.attemptSnapshot.update({ where: { id: snap.id }, data: { content: "print(2)\n" } }),
      );
      expect(message).toMatch(/append-only evidence/);
    });

    it("refuses content over 64 KB and a bad hash", async () => {
      const a = await attempt({ status: "IN_PROGRESS" });
      const base = { attemptId: a.id, questionId: "q1", atMs: 0, language: "py312", trigger: "TICK" as const };
      expect(
        await refused(() =>
          db.attemptSnapshot.create({ data: { ...base, content: "x".repeat(65_537), contentHash: SHA } }),
        ),
      ).toMatch(/AttemptSnapshot_content_check/);
      expect(
        await refused(() => db.attemptSnapshot.create({ data: { ...base, content: "ok", contentHash: "nope" } })),
      ).toMatch(/AttemptSnapshot_hash_check/);
    });
  });

  it("refuses TRUNCATE on the attempt, its snapshots and its events", async () => {
    for (const table of ["AssessmentAttempt", "AttemptSnapshot", "Assessment", "ExamSession"]) {
      const message = await refused(() => db.$executeRawUnsafe(`TRUNCATE TABLE "public"."${table}"`));
      expect(message, table).toMatch(/TRUNCATE/i);
    }
    expect(typeof mod.PrismaClient).toBe("function");
  });
});
