import { CONTEST_RANK_INTERVAL_MS } from "@recx/shared";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { ContestRankJob } from "../src/contest-rank";

/**
 * The contest rank job's cadence and its write discipline (SPEC §4e: rank is
 * recomputed by ONE job every 15 s, never per submission). The ordering it
 * applies is @recx/shared's rankStandings, unit-tested there; what is tested
 * here is that the job honours its interval, writes only rows whose rank
 * actually moved, and is safe to run twice.
 */

const log = pino({ level: "silent" });

/** A tiny fake of the two delegates the job touches. */
function fakeDb(
  contests: Array<{ id: string; kind: "ICPC" | "SUBTASK"; slug: string }>,
  standings: Record<
    string,
    Array<{
      userId: string;
      score: number;
      penalty: number;
      solved: number;
      lastAcceptedAt: Date | null;
      rank: number | null;
    }>
  >,
) {
  const updates: Array<{ userId: string; rank: number }> = [];
  const versionBumps: string[] = [];
  const db = {
    contest: {
      findMany: vi.fn(async () => contests),
      update: vi.fn(async ({ where }: { where: { id: string } }) => {
        versionBumps.push(where.id);
        return {};
      }),
    },
    contestStanding: {
      findMany: vi.fn(async ({ where }: { where: { contestId: string } }) => standings[where.contestId] ?? []),
      update: vi.fn(async ({ where, data }: { where: { contestId_userId: { userId: string } }; data: { rank: number } }) => {
        updates.push({ userId: where.contestId_userId.userId, rank: data.rank });
        return {};
      }),
    },
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  };
  return { db, updates, versionBumps };
}

const row = (userId: string, score: number, penalty: number, rank: number | null) => ({
  userId,
  score,
  penalty,
  solved: score,
  lastAcceptedAt: null,
  rank,
});

describe("cadence", () => {
  it("is due on the first tick", () => {
    const { db } = fakeDb([], {});
    const job = new ContestRankJob({ db: db as never, log, dryRun: false });
    expect(job.due(new Date(0))).toBe(true);
  });

  it("is not due again until the interval has passed", async () => {
    const { db } = fakeDb([], {});
    const job = new ContestRankJob({ db: db as never, log, dryRun: false });
    const start = new Date("2026-11-01T10:00:00.000Z");
    await job.tick(start);
    expect(job.due(new Date(start.getTime() + CONTEST_RANK_INTERVAL_MS - 1))).toBe(false);
    expect(job.due(new Date(start.getTime() + CONTEST_RANK_INTERVAL_MS))).toBe(true);
  });

  it("a tick before the interval does no work at all", async () => {
    const { db } = fakeDb([{ id: "c1", kind: "ICPC", slug: "c1" }], { c1: [row("a", 1, 10, null)] });
    const job = new ContestRankJob({ db: db as never, log, dryRun: false });
    const start = new Date("2026-11-01T10:00:00.000Z");
    await job.tick(start);
    db.contest.findMany.mockClear();
    const report = await job.tick(new Date(start.getTime() + 1_000));
    expect(db.contest.findMany).not.toHaveBeenCalled();
    expect(report).toMatchObject({ contests: 0, reranked: 0 });
  });

  it("the interval is the 15 seconds the specification asks for", () => {
    expect(CONTEST_RANK_INTERVAL_MS).toBe(15_000);
  });
});

describe("ranking", () => {
  const now = new Date("2026-11-01T10:00:00.000Z");

  it("writes ranks for an unranked board", async () => {
    const { db, updates, versionBumps } = fakeDb([{ id: "c1", kind: "ICPC", slug: "c1" }], {
      c1: [row("a", 1, 50, null), row("b", 2, 10, null), row("c", 2, 40, null)],
    });
    const job = new ContestRankJob({ db: db as never, log, dryRun: false });
    const report = await job.tick(now);
    expect(report).toMatchObject({ contests: 1, reranked: 3, failed: false });
    expect(updates).toEqual([
      { userId: "b", rank: 1 },
      { userId: "c", rank: 2 },
      { userId: "a", rank: 3 },
    ]);
    expect(versionBumps).toEqual(["c1"]);
  });

  it("writes nothing when every rank is already right (idempotent)", async () => {
    const { db, updates, versionBumps } = fakeDb([{ id: "c1", kind: "ICPC", slug: "c1" }], {
      c1: [row("b", 2, 10, 1), row("c", 2, 40, 2), row("a", 1, 50, 3)],
    });
    const job = new ContestRankJob({ db: db as never, log, dryRun: false });
    const report = await job.tick(now);
    expect(report).toMatchObject({ contests: 1, reranked: 0, unchanged: 1 });
    expect(updates).toEqual([]);
    expect(versionBumps, "standingsVersion is not bumped for a no-op").toEqual([]);
  });

  it("writes only the rows whose rank moved", async () => {
    const { db, updates } = fakeDb([{ id: "c1", kind: "ICPC", slug: "c1" }], {
      // b and c are already correct; a is wrong.
      c1: [row("b", 2, 10, 1), row("c", 2, 40, 2), row("a", 1, 50, 99)],
    });
    const job = new ContestRankJob({ db: db as never, log, dryRun: false });
    await job.tick(now);
    expect(updates).toEqual([{ userId: "a", rank: 3 }]);
  });

  it("gives tied participants the same rank", async () => {
    const { db, updates } = fakeDb([{ id: "c1", kind: "ICPC", slug: "c1" }], {
      c1: [row("a", 2, 20, null), row("b", 2, 20, null), row("c", 1, 5, null)],
    });
    const job = new ContestRankJob({ db: db as never, log, dryRun: false });
    await job.tick(now);
    expect(updates).toEqual([
      { userId: "a", rank: 1 },
      { userId: "b", rank: 1 },
      { userId: "c", rank: 3 },
    ]);
  });

  it("counts an empty board as unchanged", async () => {
    const { db, updates } = fakeDb([{ id: "c1", kind: "ICPC", slug: "c1" }], { c1: [] });
    const job = new ContestRankJob({ db: db as never, log, dryRun: false });
    const report = await job.tick(now);
    expect(report).toMatchObject({ contests: 1, reranked: 0, unchanged: 1 });
    expect(updates).toEqual([]);
  });

  it("only considers RUNNING and FINISHED contests", async () => {
    const { db } = fakeDb([], {});
    const job = new ContestRankJob({ db: db as never, log, dryRun: false });
    await job.tick(now);
    expect(db.contest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: { in: ["RUNNING", "FINISHED"] } } }),
    );
  });

  it("ranks several contests in one pass", async () => {
    const { db, versionBumps } = fakeDb(
      [
        { id: "c1", kind: "ICPC", slug: "c1" },
        { id: "c2", kind: "SUBTASK", slug: "c2" },
      ],
      { c1: [row("a", 1, 0, null)], c2: [row("b", 100, 0, null)] },
    );
    const job = new ContestRankJob({ db: db as never, log, dryRun: false });
    const report = await job.tick(now);
    expect(report).toMatchObject({ contests: 2, reranked: 2 });
    expect(versionBumps).toEqual(["c1", "c2"]);
  });

  it("--dry-run reports the work without writing", async () => {
    const { db, updates, versionBumps } = fakeDb([{ id: "c1", kind: "ICPC", slug: "c1" }], {
      c1: [row("a", 1, 0, null)],
    });
    const job = new ContestRankJob({ db: db as never, log, dryRun: true });
    const report = await job.tick(now);
    expect(report.reranked).toBe(1);
    expect(updates).toEqual([]);
    expect(versionBumps).toEqual([]);
  });

  it("a failure is reported, not thrown (the next tick retries)", async () => {
    const { db } = fakeDb([], {});
    db.contest.findMany = vi.fn(async () => {
      throw new Error("database down");
    });
    const job = new ContestRankJob({ db: db as never, log, dryRun: false });
    const report = await job.tick(now);
    expect(report.failed).toBe(true);
    expect(report.error).toMatch(/database down/);
  });
});
