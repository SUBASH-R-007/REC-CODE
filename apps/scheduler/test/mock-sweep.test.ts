import type { Db } from "@recx/db";
import { MOCK_PERCENTILE_MIN_ATTEMPTS, SCHEDULER_JOB_NAMES } from "@recx/shared";
import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOCK_STATS_INTERVAL_MS, MOCK_SWEEP_BATCH, MOCK_SWEEP_INTERVAL_MS, MockSweepJob } from "../src/mock-sweep";

/**
 * The mock sweep (Phase 7c).
 *
 * The arithmetic and the transaction are tested against a live database in
 * `packages/db/test/mock-finalise.db.test.ts`. What this file tests is the
 * JOB: its cadence, its batching, its idempotence under a race, and the
 * shape of what it may write — because this is the only path to
 * `AUTO_SUBMITTED` and it runs unattended against every sitting in the
 * system.
 *
 * Finalising at a deadline is a DEADLINE, not a penalty. The last describe
 * block is an allowlist over the job's writes, the same fence the integrity
 * SLA job has, for the same reason: a field added here later would reach
 * 5,000 students before anyone noticed.
 */

const log = pino({ level: "silent" });
const NOW = new Date("2026-10-19T12:00:00.000Z");

vi.mock("@recx/db/mock", () => ({
  dueMockAttempts: vi.fn(),
  finaliseMock: vi.fn(),
  recomputePatternStats: vi.fn(),
}));

const mocked = await import("@recx/db/mock");
const dueMockAttempts = vi.mocked(mocked.dueMockAttempts);
const finaliseMock = vi.mocked(mocked.finaliseMock);
const recomputePatternStats = vi.mocked(mocked.recomputePatternStats);

const expiresAt = new Date(NOW.getTime() - 90_000);

function fakeDb(over: { findUnique?: () => unknown } = {}) {
  const updateMany = vi.fn();
  return {
    db: {
      mockAttempt: {
        findUnique: vi.fn(async () => over.findUnique?.() ?? { expiresAt }),
        updateMany,
      },
      mockPattern: { updateMany },
    } as unknown as Db,
    updateMany,
  };
}

const job = (db: Db, dryRun = false) => new MockSweepJob({ db, log, dryRun });

const finalised = (attemptId: string, alreadyFinalised = false) => ({
  attemptId,
  totalRaw: 4,
  totalMax: 10,
  percent: 40,
  sectionsPassed: 0,
  passedOverall: false,
  xpAwarded: 100,
  alreadyFinalised,
});

beforeEach(() => {
  dueMockAttempts.mockReset();
  finaliseMock.mockReset();
  recomputePatternStats.mockReset();
  recomputePatternStats.mockResolvedValue([]);
});

describe("the job is registered", () => {
  it("is in SCHEDULER_JOB_NAMES, so /super/jobs reports on it", () => {
    // A job the ops page cannot see is a job nobody notices has stopped.
    expect(SCHEDULER_JOB_NAMES).toContain("mockSweep");
  });

  it("runs often enough to matter and not so often it polls", () => {
    expect(MOCK_SWEEP_INTERVAL_MS).toBe(30_000);
    expect(MOCK_SWEEP_BATCH).toBeLessThanOrEqual(500);
  });
});

describe("finalising overdue sittings", () => {
  it("does nothing when nothing is due", async () => {
    dueMockAttempts.mockResolvedValue([]);
    const { db } = fakeDb();
    const report = await job(db).tick(NOW);
    expect(report.autoSubmitted).toBe(0);
    expect(report.failed).toBe(false);
    expect(finaliseMock).not.toHaveBeenCalled();
  });

  it("finalises each due sitting as the sweeper, for nobody", async () => {
    dueMockAttempts.mockResolvedValue(["a1", "a2"]);
    finaliseMock.mockImplementation(async (_db, args) => finalised(args.attemptId));
    const { db } = fakeDb();

    const report = await job(db).tick(NOW);
    expect(report.autoSubmitted).toBe(2);
    for (const call of finaliseMock.mock.calls) {
      // userId null: the sweeper acts for nobody, so it cannot accidentally
      // be scoped to the wrong candidate.
      expect(call[1].userId).toBeNull();
      expect(call[1].auto).toBe(true);
    }
  });

  it("asks for a bounded batch, so one tick cannot run long on a backlog", async () => {
    dueMockAttempts.mockResolvedValue([]);
    const { db } = fakeDb();
    await job(db).tick(NOW);
    expect(dueMockAttempts).toHaveBeenCalledWith(db, MOCK_SWEEP_BATCH);
  });

  it("does not count a sitting somebody else finalised first", async () => {
    // Two scheduler instances, or a candidate pressing submit as the sweep
    // arrives. `finaliseMock`'s status move is conditional, so the loser is
    // told and must not report progress it did not make.
    dueMockAttempts.mockResolvedValue(["a1", "a2"]);
    finaliseMock.mockImplementation(async (_db, args) => finalised(args.attemptId, args.attemptId === "a1"));
    const { db } = fakeDb();
    const report = await job(db).tick(NOW);
    expect(report.autoSubmitted).toBe(1);
  });

  it("does not count a sitting that vanished between the claim and the write", async () => {
    dueMockAttempts.mockResolvedValue(["a1"]);
    finaliseMock.mockResolvedValue(null);
    const { db } = fakeDb();
    expect((await job(db).tick(NOW)).autoSubmitted).toBe(0);
  });

  it("reports the worst lateness, which is a capacity signal and not a student's problem", async () => {
    dueMockAttempts.mockResolvedValue(["a1"]);
    finaliseMock.mockImplementation(async (_db, args) => finalised(args.attemptId));
    const { db } = fakeDb({ findUnique: () => ({ expiresAt: new Date(NOW.getTime() - 300_000) }) });
    const report = await job(db).tick(NOW);
    expect(report.worstLatenessMs).toBe(300_000);
  });

  it("writes nothing on a dry run, and still reports what it would do", async () => {
    dueMockAttempts.mockResolvedValue(["a1", "a2", "a3"]);
    const { db } = fakeDb();
    const report = await job(db, true).tick(NOW);
    expect(report.autoSubmitted).toBe(3);
    expect(finaliseMock).not.toHaveBeenCalled();
    expect(recomputePatternStats).not.toHaveBeenCalled();
  });
});

describe("the statistics pass", () => {
  it("runs on the first tick, so a fresh deployment is not blind", async () => {
    dueMockAttempts.mockResolvedValue([]);
    recomputePatternStats.mockResolvedValue([
      { patternId: "p1", finalizedAttemptCount: 40, medianPercent: 51 },
      { patternId: "p2", finalizedAttemptCount: 3, medianPercent: 80 },
    ]);
    const { db } = fakeDb();
    const report = await job(db).tick(NOW);
    expect(report.patternsRestated).toBe(2);
    // Only the first has enough of a cohort for the percentile term.
    expect(report.patternsWithCohort).toBe(1);
    expect(MOCK_PERCENTILE_MIN_ATTEMPTS).toBe(30);
  });

  it("does not run again on the next tick", async () => {
    // A median that moved between two candidates' finalises would make two
    // identical papers pay different XP for no reason either could see.
    dueMockAttempts.mockResolvedValue([]);
    const { db } = fakeDb();
    const sweep = job(db);
    await sweep.tick(NOW);
    const second = await sweep.tick(new Date(NOW.getTime() + MOCK_SWEEP_INTERVAL_MS));
    expect(recomputePatternStats).toHaveBeenCalledTimes(1);
    expect(second.patternsRestated).toBe(0);
  });

  it("runs again a day later", async () => {
    dueMockAttempts.mockResolvedValue([]);
    const { db } = fakeDb();
    const sweep = job(db);
    await sweep.tick(NOW);
    await sweep.tick(new Date(NOW.getTime() + MOCK_STATS_INTERVAL_MS));
    expect(recomputePatternStats).toHaveBeenCalledTimes(2);
  });

  it("is nightly, not per tick", () => {
    expect(MOCK_STATS_INTERVAL_MS).toBe(24 * 3_600_000);
  });
});

describe("a failing tick", () => {
  it("reports the failure instead of throwing, so the scheduler keeps ticking", async () => {
    dueMockAttempts.mockRejectedValue(new Error("the database went away"));
    const { db } = fakeDb();
    const report = await job(db).tick(NOW);
    expect(report.failed).toBe(true);
    expect(report.error).toContain("the database went away");
    expect(report.autoSubmitted).toBe(0);
  });

  it("keeps the sittings it already finalised when the statistics pass fails", async () => {
    // A sitting that finalised IS finalised: its result has published and its
    // XP is written. Reporting zero would make the next tick look like it had
    // made no progress.
    dueMockAttempts.mockResolvedValue(["a1"]);
    finaliseMock.mockImplementation(async (_db, args) => finalised(args.attemptId));
    recomputePatternStats.mockRejectedValue(new Error("statistics failed"));
    const { db } = fakeDb();
    const report = await job(db).tick(NOW);
    expect(report.failed).toBe(true);
    expect(report.autoSubmitted).toBe(1);
    expect(report.patternsRestated).toBe(0);
  });
});

describe("what this job can never do", () => {
  it("finalises only, and always as an automatic submission", async () => {
    dueMockAttempts.mockResolvedValue(["a1"]);
    finaliseMock.mockImplementation(async (_db, args) => finalised(args.attemptId));
    const { db } = fakeDb();
    await job(db).tick(NOW);

    // The job's whole surface is finaliseMock + recomputePatternStats. It has
    // no status to pass and no field to set: `auto: true` is the only thing
    // it decides, and MockAttemptStatus has no VOIDED or TERMINATED value for
    // it to reach even if a later edit tried.
    const args = finaliseMock.mock.calls[0]![1];
    expect(Object.keys(args).sort()).toEqual(["at", "attemptId", "auto", "userId"]);
    expect(args.auto).toBe(true);
  });

  it("never writes a score, a band or a flag of its own", async () => {
    dueMockAttempts.mockResolvedValue(["a1"]);
    finaliseMock.mockImplementation(async (_db, args) => finalised(args.attemptId));
    const { db, updateMany } = fakeDb();
    await job(db).tick(NOW);
    // Everything it writes goes through finaliseMock, which the live suite
    // covers. The job itself touches no table directly.
    expect(updateMany).not.toHaveBeenCalled();
  });
});
