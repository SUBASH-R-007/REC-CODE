import type { Db } from "@recx/db";
import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  DAILY_PREPARE_AHEAD_MS,
  DAILY_RETRY_MS,
  DAILY_REUSE_WINDOW_DAYS,
  DailyChallengeJob,
  challengeDaysToEnsure,
  challengeScore,
  nextDay,
  pickDailyChallenge,
  type ChallengeCandidate,
  type ChallengeUse,
} from "../src/daily-challenge";

const log = pino({ level: "silent" });
const MIN = 60_000;
/** Sunday 11 Oct 2026, 00:00 IST. */
const MIDNIGHT = new Date("2026-10-10T18:30:00.000Z");

const candidates: ChallengeCandidate[] = [
  { id: "p-easy-1", difficulty: "EASY" },
  { id: "p-easy-2", difficulty: "EASY" },
  { id: "p-medium-1", difficulty: "MEDIUM" },
  { id: "p-medium-2", difficulty: "MEDIUM" },
  { id: "p-hard-1", difficulty: "HARD" },
];

function daysBefore(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

describe("which days need a challenge", () => {
  it("today, on the campus calendar", () => {
    expect(challengeDaysToEnsure(new Date(MIDNIGHT.getTime() + MIN))).toEqual(["2026-10-11"]);
    expect(challengeDaysToEnsure(new Date(MIDNIGHT.getTime() - MIN))).toEqual(["2026-10-10", "2026-10-11"]);
  });

  it("tomorrow as well only in the last minutes before campus midnight", () => {
    expect(challengeDaysToEnsure(new Date(MIDNIGHT.getTime() - DAILY_PREPARE_AHEAD_MS - MIN))).toEqual(["2026-10-10"]);
    expect(challengeDaysToEnsure(new Date(MIDNIGHT.getTime() - DAILY_PREPARE_AHEAD_MS))).toEqual([
      "2026-10-10",
      "2026-10-11",
    ]);
  });

  it("steps across month and year ends", () => {
    expect(nextDay("2026-10-31")).toBe("2026-11-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
  });
});

describe("pickDailyChallenge", () => {
  const day = "2026-10-11";

  it("is deterministic for a date, and varies across dates", () => {
    const pick = pickDailyChallenge(day, candidates, []);
    expect(pickDailyChallenge(day, [...candidates].reverse(), [])).toBe(pick);
    const picks = new Set(
      Array.from({ length: 30 }, (_, i) => pickDailyChallenge(daysBefore(day, i), candidates, [])),
    );
    expect(picks.size).toBeGreaterThan(1);
    expect(challengeScore(day, "p-easy-1")).toBe(challengeScore(day, "p-easy-1"));
    expect(Number.isSafeInteger(challengeScore(day, "p-easy-1"))).toBe(true);
  });

  it("prefers Easy and Medium", () => {
    for (let i = 0; i < 60; i++) {
      const pick = pickDailyChallenge(daysBefore(day, i), candidates, []);
      expect(pick).not.toBe("p-hard-1");
    }
  });

  it("falls back to Hard when no Easy or Medium is fresh", () => {
    const recent: ChallengeUse[] = candidates
      .filter((c) => c.difficulty !== "HARD")
      .map((c, i) => ({ day: daysBefore(day, i + 1), problemId: c.id }));
    expect(pickDailyChallenge(day, candidates, recent)).toBe("p-hard-1");
  });

  it("never repeats a problem within the reuse window, either side of the date", () => {
    const pick = pickDailyChallenge(day, candidates, []);
    expect(pick).not.toBeNull();
    const usedYesterday: ChallengeUse[] = [{ day: daysBefore(day, 1), problemId: pick ?? "" }];
    expect(pickDailyChallenge(day, candidates, usedYesterday)).not.toBe(pick);
    const usedEdge: ChallengeUse[] = [{ day: daysBefore(day, DAILY_REUSE_WINDOW_DAYS - 1), problemId: pick ?? "" }];
    expect(pickDailyChallenge(day, candidates, usedEdge)).not.toBe(pick);
    const scheduledLater: ChallengeUse[] = [{ day: nextDay(nextDay(day)), problemId: pick ?? "" }];
    expect(pickDailyChallenge(day, candidates, scheduledLater)).not.toBe(pick);
    // Exactly the window ago is fresh again.
    const old: ChallengeUse[] = [{ day: daysBefore(day, DAILY_REUSE_WINDOW_DAYS), problemId: pick ?? "" }];
    expect(pickDailyChallenge(day, candidates, old)).toBe(pick);
  });

  it("ignores the date's own row when re-deciding it", () => {
    const pick = pickDailyChallenge(day, candidates, []);
    expect(pickDailyChallenge(day, candidates, [{ day, problemId: pick ?? "" }])).toBe(pick);
  });

  it("with a small catalogue, takes the least recently used", () => {
    const small: ChallengeCandidate[] = [
      { id: "a", difficulty: "EASY" },
      { id: "b", difficulty: "MEDIUM" },
      { id: "c", difficulty: "EASY" },
    ];
    const history: ChallengeUse[] = [
      { day: daysBefore(day, 1), problemId: "a" },
      { day: daysBefore(day, 2), problemId: "b" },
      { day: daysBefore(day, 3), problemId: "c" },
    ];
    expect(pickDailyChallenge(day, small, history)).toBe("c");
    // Least recently used is Hard, but an Easy/Medium is equally old: prefer it.
    const tie: ChallengeCandidate[] = [
      { id: "h", difficulty: "HARD" },
      { id: "m", difficulty: "MEDIUM" },
    ];
    const tied: ChallengeUse[] = [
      { day: daysBefore(day, 5), problemId: "h" },
      { day: daysBefore(day, 5), problemId: "m" },
    ];
    expect(pickDailyChallenge(day, tie, tied)).toBe("m");
  });

  it("returns null with no candidates", () => {
    expect(pickDailyChallenge(day, [], [])).toBeNull();
  });
});

function fakeDb(state: { existing?: Map<string, string>; candidates?: ChallengeCandidate[]; failFind?: number }) {
  const rows = state.existing ?? new Map<string, string>();
  const calls = { findUnique: 0, problems: 0, history: 0, createMany: 0 };
  let failures = state.failFind ?? 0;
  const key = (date: Date) => date.toISOString().slice(0, 10);
  const db = {
    dailyChallenge: {
      findUnique: async ({ where }: { where: { date: Date } }) => {
        calls.findUnique += 1;
        if (failures > 0) {
          failures -= 1;
          throw new Error("database unavailable");
        }
        const problemId = rows.get(key(where.date));
        return problemId ? { problemId } : null;
      },
      findMany: async () => {
        calls.history += 1;
        return [...rows].map(([day, problemId]) => ({ date: new Date(`${day}T00:00:00Z`), problemId }));
      },
      createMany: async ({ data }: { data: Array<{ date: Date; problemId: string }> }) => {
        calls.createMany += 1;
        let count = 0;
        for (const row of data) {
          if (rows.has(key(row.date))) continue;
          rows.set(key(row.date), row.problemId);
          count += 1;
        }
        return { count };
      },
    },
    problem: {
      findMany: async () => {
        calls.problems += 1;
        return state.candidates ?? candidates;
      },
    },
  };
  return { db: db as unknown as Db, rows, calls };
}

describe("DailyChallengeJob.tick", () => {
  const morning = new Date(MIDNIGHT.getTime() + 8 * 60 * MIN);

  it("creates today's row once, then does no work for the rest of the day", async () => {
    const { db, rows, calls } = fakeDb({});
    const job = new DailyChallengeJob({ db, log });
    const report = await job.tick(morning);
    expect(report.ensured).toEqual([
      { day: "2026-10-11", outcome: "created", problemId: pickDailyChallenge("2026-10-11", candidates, []) },
    ]);
    expect(rows.get("2026-10-11")).toBeDefined();
    for (let i = 1; i <= 100; i++) await job.tick(new Date(morning.getTime() + i * 10_000));
    expect(calls).toEqual({ findUnique: 1, problems: 1, history: 1, createMany: 1 });
  });

  it("never replaces a day an admin already set", async () => {
    const { db, rows, calls } = fakeDb({ existing: new Map([["2026-10-11", "admin-choice"]]) });
    const job = new DailyChallengeJob({ db, log });
    expect((await job.tick(morning)).ensured).toEqual([{ day: "2026-10-11", outcome: "exists", problemId: "admin-choice" }]);
    expect(rows.get("2026-10-11")).toBe("admin-choice");
    expect(calls.createMany).toBe(0);
  });

  it("prepares tomorrow just before midnight, avoiding today's problem", async () => {
    const { db, rows } = fakeDb({});
    const job = new DailyChallengeJob({ db, log });
    await job.tick(new Date(MIDNIGHT.getTime() - DAILY_PREPARE_AHEAD_MS + MIN));
    expect([...rows.keys()].sort()).toEqual(["2026-10-10", "2026-10-11"]);
    expect(rows.get("2026-10-10")).not.toBe(rows.get("2026-10-11"));
  });

  it("writes nothing in a dry run", async () => {
    const { db, rows } = fakeDb({});
    const report = await new DailyChallengeJob({ db, log, dryRun: true }).tick(morning);
    expect(report.ensured[0]?.outcome).toBe("would-create");
    expect(rows.size).toBe(0);
  });

  it("waits and retries when nothing is published yet, or after an error", async () => {
    const empty = fakeDb({ candidates: [] });
    const job = new DailyChallengeJob({ db: empty.db, log });
    expect((await job.tick(morning)).ensured[0]?.outcome).toBe("no-candidates");
    await job.tick(new Date(morning.getTime() + DAILY_RETRY_MS - 1));
    expect(empty.calls.findUnique).toBe(1);
    await job.tick(new Date(morning.getTime() + DAILY_RETRY_MS));
    expect(empty.calls.findUnique).toBe(2);

    const broken = fakeDb({ failFind: 1 });
    const retrying = new DailyChallengeJob({ db: broken.db, log });
    expect((await retrying.tick(morning)).failed).toBe(true);
    const later = await retrying.tick(new Date(morning.getTime() + DAILY_RETRY_MS));
    expect(later.ensured[0]?.outcome).toBe("created");
  });
});
