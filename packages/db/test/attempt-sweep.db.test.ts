import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autoSubmitExpired, markDisconnectedAttempts } from "../src/attempt";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type TestDb,
} from "./support/test-db";

/**
 * The two automatic writes of the attempt engine, against a live database
 * (`packages/db/src/attempt.ts`).
 *
 * This suite exists because the auto-submit sweeper is the ONLY thing in the
 * system that acts on a candidate's sitting without a human asking, and
 * because the two things most likely to be wrong about it cannot be caught by
 * a unit test:
 *
 *   1. The deadline is `expiresAt + pausedMs`, not `expiresAt`. Sweeping on
 *      bare `expiresAt` auto-submits a candidate in the middle of an
 *      invigilator-granted break — the spec calls this "the bug that voids an
 *      exam", and it only shows up against real interval arithmetic.
 *   2. Every write has to satisfy the guards migration 20261019160000 put on
 *      the table: the status machine, the submitted-status CHECK, and the
 *      write-once tuple that includes `expiresAt` itself. A sweeper that
 *      tripped any of them would fail in production and nowhere else.
 */

const tag = `sw-${randomBytes(4).toString("hex")}`;
const TITLE = RUN_DB_TESTS
  ? "attempt sweep (live database)"
  : "attempt sweep (set RECX_DB_TESTS=1 to run)";

const SHA = "b".repeat(64);

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;

  let userId = "";
  let assessmentId = "";
  const attemptIds: string[] = [];
  let nextAttemptNumber = 1;

  /**
   * An attempt whose deadline is `expiresInSec` from now. Relative to the
   * database's own clock, because that is the clock the sweeper's SQL reads;
   * a fixture pinned to a literal date would pass or fail by the calendar.
   */
  async function attempt(over: {
    expiresInSec: number;
    status?: "NOT_STARTED" | "IN_PROGRESS" | "DISCONNECTED" | "SUBMITTED";
    pausedMs?: number;
    lastHeartbeatSecondsAgo?: number | null;
  }): Promise<string> {
    const expiresAt = new Date(Date.now() + over.expiresInSec * 1000);
    // Derived from the deadline, not from now: `AssessmentAttempt_window_check`
    // requires expiresAt > startedAt, and a long-overdue fixture has a
    // deadline well in the past.
    const startedAt = new Date(expiresAt.getTime() - 3_600_000);
    const row = await db.assessmentAttempt.create({
      data: {
        assessmentId,
        userId,
        attemptNumber: nextAttemptNumber++,
        seed: 1,
        startedAt,
        expiresAt,
        pausedMs: over.pausedMs ?? 0,
        layout: { order: [1] },
        tokenHash: SHA,
        proctorMode: "ADVISORY",
        status: over.status ?? "IN_PROGRESS",
        submittedAt: over.status === "SUBMITTED" ? new Date() : null,
        lastHeartbeatAt:
          over.lastHeartbeatSecondsAgo == null
            ? null
            : new Date(Date.now() - over.lastHeartbeatSecondsAgo * 1000),
      },
      select: { id: true },
    });
    attemptIds.push(row.id);
    return row.id;
  }

  const read = (id: string) =>
    db.assessmentAttempt.findUniqueOrThrow({
      where: { id },
      select: { status: true, submittedAt: true, expiresAt: true, pausedMs: true, version: true },
    });

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
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
        title: "Sweep fixture",
        instructions: "Go.",
        opensAt: new Date(Date.now() - 3_600_000),
        closesAt: new Date(Date.now() + 36_000_000),
        durationSec: 3600,
        // The CHECK caps this at 5 (ASSESSMENT_LIMITS). Nothing ties an
        // attempt's number to it, and the unique key is
        // (assessmentId, userId, attemptNumber), so the fixture keeps
        // counting past 5 to give every test its own row.
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
        ["Assessment", "Assessment_published_immutable"],
      ] as const;
      await db.$transaction([
        ...off.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" DISABLE TRIGGER "${g}"`)),
        raw(`DELETE FROM "public"."ProctorEvent" WHERE "attemptId" = ANY($1::text[])`, attemptIds),
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

  // ── Auto-submit: the deadline ──────────────────────────────────────────

  describe("autoSubmitExpired", () => {
    it("finalises a sitting whose clock has run out", async () => {
      const id = await attempt({ expiresInSec: -30 });
      const [row] = await autoSubmitExpired(db, { limit: 10, attemptId: id });
      expect(row?.id).toBe(id);
      expect(row?.previousStatus).toBe("IN_PROGRESS");
      expect(await read(id)).toMatchObject({ status: "AUTO_SUBMITTED" });
    });

    it("leaves a sitting that still has time", async () => {
      const id = await attempt({ expiresInSec: 600 });
      expect(await autoSubmitExpired(db, { limit: 10, attemptId: id })).toEqual([]);
      expect((await read(id)).status).toBe("IN_PROGRESS");
    });

    it("finalises a DISCONNECTED sitting too — a dropped connection does not suspend the deadline", async () => {
      // SPEC §5 names only IN_PROGRESS; a DISCONNECTED attempt past its
      // deadline would otherwise never finalise, holding a seat on the
      // dashboard for ever and never scoring the work it already has.
      const id = await attempt({ expiresInSec: -30, status: "DISCONNECTED" });
      const [row] = await autoSubmitExpired(db, { limit: 10, attemptId: id });
      expect(row?.previousStatus).toBe("DISCONNECTED");
      expect((await read(id)).status).toBe("AUTO_SUBMITTED");
    });

    it("does NOT auto-submit during an invigilator-granted break", async () => {
      // The clock reads as expired, but pausedMs has pushed the real deadline
      // 10 minutes out. Sweeping on bare expiresAt would end this exam.
      const id = await attempt({ expiresInSec: -60, pausedMs: 600_000 });
      expect(await autoSubmitExpired(db, { limit: 10, attemptId: id })).toEqual([]);
      expect((await read(id)).status).toBe("IN_PROGRESS");
    });

    it("auto-submits once the granted break has also run out", async () => {
      const id = await attempt({ expiresInSec: -700, pausedMs: 600_000 });
      const [row] = await autoSubmitExpired(db, { limit: 10, attemptId: id });
      expect(row?.id).toBe(id);
      expect(row?.pausedMs).toBe(600_000);
    });

    it("records submittedAt at the deadline, not at the moment it noticed", async () => {
      // A sweeper that ran late must not record a later submission time than
      // the candidate actually had.
      const id = await attempt({ expiresInSec: -300 });
      await autoSubmitExpired(db, { limit: 10, attemptId: id });
      const row = await read(id);
      expect(row.submittedAt).not.toBeNull();
      expect(Math.abs(row.submittedAt!.getTime() - row.expiresAt.getTime())).toBeLessThan(1_000);
    });

    it("adds pausedMs to the recorded submission time", async () => {
      const id = await attempt({ expiresInSec: -700, pausedMs: 60_000 });
      await autoSubmitExpired(db, { limit: 10, attemptId: id });
      const row = await read(id);
      const expected = row.expiresAt.getTime() + 60_000;
      expect(Math.abs(row.submittedAt!.getTime() - expected)).toBeLessThan(1_000);
    });

    it("reports how late it was", async () => {
      const id = await attempt({ expiresInSec: -120 });
      const [row] = await autoSubmitExpired(db, { limit: 10, attemptId: id });
      expect(row!.lateMs).toBeGreaterThanOrEqual(119_000);
      expect(row!.lateMs).toBeLessThan(130_000);
    });

    it("is idempotent: a second pass finalises nothing", async () => {
      const id = await attempt({ expiresInSec: -30 });
      expect(await autoSubmitExpired(db, { limit: 10, attemptId: id })).toHaveLength(1);
      expect(await autoSubmitExpired(db, { limit: 10, attemptId: id })).toEqual([]);
    });

    it("never re-submits an attempt the candidate submitted themselves", async () => {
      const id = await attempt({ expiresInSec: -30, status: "SUBMITTED" });
      expect(await autoSubmitExpired(db, { limit: 10, attemptId: id })).toEqual([]);
      expect((await read(id)).status).toBe("SUBMITTED");
    });

    it("never touches a sitting that has not started", async () => {
      const id = await attempt({ expiresInSec: -30, status: "NOT_STARTED" });
      expect(await autoSubmitExpired(db, { limit: 10, attemptId: id })).toEqual([]);
      expect((await read(id)).status).toBe("NOT_STARTED");
    });

    it("bumps version so a concurrent optimistic write cannot clobber the finalisation", async () => {
      const id = await attempt({ expiresInSec: -30 });
      const before = (await read(id)).version;
      await autoSubmitExpired(db, { limit: 10, attemptId: id });
      expect((await read(id)).version).toBe(before + 1);
    });

    it("does not move expiresAt — the write-once trigger would refuse it", async () => {
      const id = await attempt({ expiresInSec: -45 });
      const before = (await read(id)).expiresAt.getTime();
      await autoSubmitExpired(db, { limit: 10, attemptId: id });
      expect((await read(id)).expiresAt.getTime()).toBe(before);
    });

    it("honours the batch limit and takes the most overdue first", async () => {
      /**
       * This is the one test here that sweeps the WHOLE table rather than one
       * id, so it is the one test that can be derailed by another suite's
       * fixture: `recx_test` is shared, vitest runs files in parallel, and an
       * overdue IN_PROGRESS sitting belonging to somebody else would be
       * picked first and this assertion would be about their row.
       *
       * Draining first makes the ordering claim about THIS test's two rows.
       * It cost a Linux gate to find, and the failure looked like a bug in
       * the sweep's ORDER BY rather than what it was.
       */
      await autoSubmitExpired(db, { limit: 500 });
      const far = await attempt({ expiresInSec: -900 });
      const near = await attempt({ expiresInSec: -5 });
      const rows = await autoSubmitExpired(db, { limit: 1 });
      // Only one, and it is the one that has been waiting longest.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(far);
      expect((await read(near)).status).toBe("IN_PROGRESS");
      await autoSubmitExpired(db, { limit: 50 });
    });

    it("writes nothing on a dry run, but still reports what it would do", async () => {
      const id = await attempt({ expiresInSec: -30 });
      const rows = await autoSubmitExpired(db, { limit: 10, attemptId: id, dryRun: true });
      expect(rows).toHaveLength(1);
      expect((await read(id)).status).toBe("IN_PROGRESS");
    });

    it("does nothing at all with a zero limit", async () => {
      const id = await attempt({ expiresInSec: -30 });
      expect(await autoSubmitExpired(db, { limit: 0, attemptId: id })).toEqual([]);
      expect((await read(id)).status).toBe("IN_PROGRESS");
    });

    it("never reaches VOIDED — only a recorded human verdict may void a sitting", async () => {
      // SPEC §0: no signal ever auto-penalises. The one automatic action in
      // the system must be unable to express a penalty at all.
      const id = await attempt({ expiresInSec: -30 });
      await autoSubmitExpired(db, { limit: 10, attemptId: id });
      expect((await read(id)).status).not.toBe("VOIDED");
      const [counts] = await db.$queryRaw<Array<{ voided: bigint }>>`
        SELECT count(*) AS voided FROM "AssessmentAttempt"
         WHERE "userId" = ${userId} AND "status" = 'VOIDED'`;
      expect(Number(counts!.voided)).toBe(0);
    });

    it("leaves the integrity score alone — a deadline is not a finding", async () => {
      const id = await attempt({ expiresInSec: -30 });
      await autoSubmitExpired(db, { limit: 10, attemptId: id });
      const row = await db.assessmentAttempt.findUniqueOrThrow({
        where: { id },
        select: { integrityScore: true },
      });
      expect(row.integrityScore).toBe(100);
    });

    it("records no proctoring event: being finalised at the deadline is not evidence", async () => {
      const id = await attempt({ expiresInSec: -30 });
      await autoSubmitExpired(db, { limit: 10, attemptId: id });
      expect(await db.proctorEvent.count({ where: { attemptId: id } })).toBe(0);
    });

    it("two concurrent sweeps finalise each attempt exactly once", async () => {
      // What SKIP LOCKED is for: a second scheduler instance must divide the
      // batch rather than block on it or finalise a row twice.
      const ids = await Promise.all([
        attempt({ expiresInSec: -40 }),
        attempt({ expiresInSec: -41 }),
        attempt({ expiresInSec: -42 }),
        attempt({ expiresInSec: -43 }),
      ]);
      const [a, b] = await Promise.all([
        autoSubmitExpired(db, { limit: 50 }),
        autoSubmitExpired(db, { limit: 50 }),
      ]);
      const claimed = [...a, ...b].map((r) => r.id).filter((id) => ids.includes(id));
      expect(new Set(claimed).size).toBe(claimed.length);
      for (const id of ids) expect((await read(id)).status).toBe("AUTO_SUBMITTED");
    });
  });

  // ── Presence: the 45-second rule ───────────────────────────────────────

  describe("markDisconnectedAttempts", () => {
    it("marks a sitting that has stopped beating", async () => {
      const id = await attempt({ expiresInSec: 600, lastHeartbeatSecondsAgo: 90 });
      const [row] = await markDisconnectedAttempts(db, { silentAfterSeconds: 45, limit: 10 });
      expect(row).toBeDefined();
      expect((await read(id)).status).toBe("DISCONNECTED");
    });

    it("leaves a sitting that beat recently", async () => {
      const id = await attempt({ expiresInSec: 600, lastHeartbeatSecondsAgo: 10 });
      await markDisconnectedAttempts(db, { silentAfterSeconds: 45, limit: 10 });
      expect((await read(id)).status).toBe("IN_PROGRESS");
    });

    it("leaves a sitting that has never beaten — it may simply have just started", async () => {
      const id = await attempt({ expiresInSec: 600, lastHeartbeatSecondsAgo: null });
      await markDisconnectedAttempts(db, { silentAfterSeconds: 45, limit: 10 });
      expect((await read(id)).status).toBe("IN_PROGRESS");
    });

    it("leaves an already-expired sitting for the auto-submit pass", async () => {
      const id = await attempt({ expiresInSec: -30, lastHeartbeatSecondsAgo: 300 });
      await markDisconnectedAttempts(db, { silentAfterSeconds: 45, limit: 10 });
      expect((await read(id)).status).toBe("IN_PROGRESS");
    });

    it("reports how long the candidate has been silent", async () => {
      await attempt({ expiresInSec: 600, lastHeartbeatSecondsAgo: 300 });
      const rows = await markDisconnectedAttempts(db, { silentAfterSeconds: 45, limit: 10 });
      const row = rows.find((r) => r.silentSeconds >= 290);
      expect(row).toBeDefined();
      expect(row!.silentSeconds).toBeLessThan(320);
    });

    it("records nothing against the candidate: DISCONNECTED is never a flag", async () => {
      const id = await attempt({ expiresInSec: 600, lastHeartbeatSecondsAgo: 120 });
      await markDisconnectedAttempts(db, { silentAfterSeconds: 45, limit: 10 });
      const row = await db.assessmentAttempt.findUniqueOrThrow({
        where: { id },
        select: { integrityScore: true, maxHeartbeatGapSeconds: true },
      });
      expect(row.integrityScore).toBe(100);
      // The reconnecting heartbeat measures the gap from the bitmap; the
      // sweeper guessing it here would double-count.
      expect(row.maxHeartbeatGapSeconds).toBe(0);
      expect(await db.proctorEvent.count({ where: { attemptId: id } })).toBe(0);
    });

    it("writes nothing on a dry run", async () => {
      const id = await attempt({ expiresInSec: 600, lastHeartbeatSecondsAgo: 90 });
      const rows = await markDisconnectedAttempts(db, {
        silentAfterSeconds: 45,
        limit: 10,
        dryRun: true,
      });
      expect(rows.some((r) => r.id === id)).toBe(true);
      expect((await read(id)).status).toBe("IN_PROGRESS");
    });

    it("is idempotent: a DISCONNECTED sitting is not re-marked", async () => {
      await attempt({ expiresInSec: 600, lastHeartbeatSecondsAgo: 90 });
      const first = await markDisconnectedAttempts(db, { silentAfterSeconds: 45, limit: 10 });
      expect(first.length).toBeGreaterThan(0);
      const second = await markDisconnectedAttempts(db, { silentAfterSeconds: 45, limit: 10 });
      expect(second).toEqual([]);
    });
  });
});
