import type { Db } from "@recx/db";
import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  FREEZE_GRACE_MS,
  FREEZE_RETRY_MS,
  LeaderboardFreezeJob,
  SNAPSHOT_TOP,
  boardsOf,
  buildSnapshots,
  compareStanding,
  freezeCutoffKey,
  freezeFloorKey,
  publicName,
  type StandingSource,
} from "../src/leaderboard-freeze";

const log = pino({ level: "silent" });
const MIN = 60_000;

/** Monday 12 Oct 2026, 00:00 IST — the start of ISO week 2026-W42. */
const WEEK_START = new Date("2026-10-11T18:30:00.000Z");
/** Sunday 1 Nov 2026, 00:00 IST — the start of month 2026-11. */
const MONTH_START = new Date("2026-10-31T18:30:00.000Z");

function row(patch: Partial<StandingSource> & { userId: string }): StandingSource {
  return {
    firstName: "Priya",
    lastName: "Sharma",
    xp: 100,
    solvedEasy: 1,
    solvedMedium: 0,
    solvedHard: 0,
    batchYear: 2027,
    departmentCode: "CSE",
    section: "A",
    lastXpAt: new Date("2026-10-08T10:00:00.000Z"),
    ...patch,
  };
}

describe("closed periods (campus calendar, with a grace period)", () => {
  it("a week is not closed until FREEZE_GRACE_MS after Monday 00:00 IST", () => {
    expect(freezeCutoffKey("WEEK", new Date(WEEK_START.getTime() - MIN))).toBe("2026-W41");
    expect(freezeCutoffKey("WEEK", new Date(WEEK_START.getTime() + FREEZE_GRACE_MS - MIN))).toBe("2026-W41");
    // From here every key below 2026-W42 — i.e. 2026-W41 — may be frozen.
    expect(freezeCutoffKey("WEEK", new Date(WEEK_START.getTime() + FREEZE_GRACE_MS))).toBe("2026-W42");
  });

  it("a month closes at midnight IST on the 1st, plus the grace", () => {
    expect(freezeCutoffKey("MONTH", new Date(MONTH_START.getTime() + FREEZE_GRACE_MS - MIN))).toBe("2026-10");
    expect(freezeCutoffKey("MONTH", new Date(MONTH_START.getTime() + FREEZE_GRACE_MS))).toBe("2026-11");
  });

  it("looks back a bounded number of periods", () => {
    const now = new Date(WEEK_START.getTime() + FREEZE_GRACE_MS);
    expect(freezeFloorKey("WEEK", now)).toBe("2026-W34");
    expect(freezeFloorKey("MONTH", new Date(MONTH_START.getTime() + FREEZE_GRACE_MS))).toBe("2026-07");
  });

  it("period keys sort chronologically as strings, across a year", () => {
    expect(["2027-W01", "2026-W53", "2026-W09", "2026-W41"].sort()).toEqual(["2026-W09", "2026-W41", "2026-W53", "2027-W01"]);
    expect(["2027-01", "2026-12", "2026-09"].sort()).toEqual(["2026-09", "2026-12", "2027-01"]);
  });
});

describe("snapshot boards", () => {
  it("names are publicName only: first name and last initial", () => {
    expect(publicName("Priya", "sharma")).toBe("Priya S.");
    const [college] = buildSnapshots([row({ userId: "u1" })]);
    const entry = college?.top[0];
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ["lastXpAt", "publicName", "rank", "solved", "solvedEasy", "solvedHard", "solvedMedium", "userId", "xp"].sort(),
    );
    expect(JSON.stringify(college)).not.toMatch(/Sharma|CSE|2027:/);
  });

  it("puts each student on the college, department, batch and section boards they belong to", () => {
    expect(boardsOf({ batchYear: 2027, departmentCode: "CSE", section: "A" })).toEqual([
      { scope: "COLLEGE", scopeKey: "" },
      { scope: "DEPARTMENT", scopeKey: "CSE" },
      { scope: "BATCH", scopeKey: "2027" },
      { scope: "SECTION", scopeKey: "2027:CSE:A" },
    ]);
    expect(boardsOf({ batchYear: null, departmentCode: "ECE", section: "B" })).toEqual([
      { scope: "COLLEGE", scopeKey: "" },
      { scope: "DEPARTMENT", scopeKey: "ECE" },
    ]);
    expect(boardsOf({ batchYear: null, departmentCode: null, section: null })).toEqual([{ scope: "COLLEGE", scopeKey: "" }]);
  });

  it("orders by XP, then who reached it first, then id", () => {
    const early = new Date("2026-10-08T09:00:00.000Z");
    const late = new Date("2026-10-08T11:00:00.000Z");
    const rows = [
      row({ userId: "c", xp: 100, lastXpAt: late }),
      row({ userId: "b", xp: 100, lastXpAt: early }),
      row({ userId: "a", xp: 300, lastXpAt: late }),
      row({ userId: "d", xp: 100, lastXpAt: early }),
    ];
    expect([...rows].sort(compareStanding).map((r) => r.userId)).toEqual(["a", "b", "d", "c"]);
  });

  it("ranks like the live board: competition ranks for exact ties", () => {
    const at = new Date("2026-10-08T09:00:00.000Z");
    const [college] = buildSnapshots([
      row({ userId: "a", xp: 300 }),
      row({ userId: "b", xp: 200, lastXpAt: at }),
      row({ userId: "c", xp: 200, lastXpAt: at }),
      row({ userId: "d", xp: 200, lastXpAt: new Date(at.getTime() + 1) }),
      row({ userId: "e", xp: 0 }),
    ]);
    expect(college?.top.map((e) => [e.userId, e.rank])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 2],
      ["d", 4],
      ["e", 5],
    ]);
  });

  it("builds every board present, ranked within the board, in a stable order", () => {
    const snapshots = buildSnapshots([
      row({ userId: "cse-a", xp: 500, batchYear: 2027, departmentCode: "CSE", section: "A" }),
      row({ userId: "ece-b", xp: 400, batchYear: 2028, departmentCode: "ECE", section: "B" }),
      row({ userId: "cse-b", xp: 300, batchYear: 2027, departmentCode: "CSE", section: "B" }),
      row({ userId: "loose", xp: 200, batchYear: null, departmentCode: null, section: null }),
    ]);
    expect(snapshots.map((s) => [s.scope, s.scopeKey, s.top.map((e) => `${e.rank}:${e.userId}`).join(" ")])).toEqual([
      ["COLLEGE", "", "1:cse-a 2:ece-b 3:cse-b 4:loose"],
      ["DEPARTMENT", "CSE", "1:cse-a 2:cse-b"],
      ["DEPARTMENT", "ECE", "1:ece-b"],
      ["BATCH", "2027", "1:cse-a 2:cse-b"],
      ["BATCH", "2028", "1:ece-b"],
      ["SECTION", "2027:CSE:A", "1:cse-a"],
      ["SECTION", "2027:CSE:B", "1:cse-b"],
      ["SECTION", "2028:ECE:B", "1:ece-b"],
    ]);
  });

  it("keeps the top SNAPSHOT_TOP of each board", () => {
    const rows = Array.from({ length: SNAPSHOT_TOP + 50 }, (_, i) =>
      row({ userId: `u${String(i).padStart(4, "0")}`, xp: 10_000 - i, section: i % 2 === 0 ? "A" : "B" }),
    );
    const snapshots = buildSnapshots(rows);
    const college = snapshots.find((s) => s.scope === "COLLEGE");
    expect(college?.top).toHaveLength(SNAPSHOT_TOP);
    expect(college?.top.at(-1)?.rank).toBe(SNAPSHOT_TOP);
    // Each section has 125 rows: all kept, ranked within the section.
    const sectionB = snapshots.find((s) => s.scopeKey === "2027:CSE:B");
    expect(sectionB?.top).toHaveLength(125);
    expect(sectionB?.top[0]).toMatchObject({ userId: "u0001", rank: 1 });
  });

  it("always writes the college board, even empty (it marks the period frozen)", () => {
    expect(buildSnapshots([])).toEqual([{ scope: "COLLEGE", scopeKey: "", top: [] }]);
  });

  it("carries the solved counts and the tie-break time", () => {
    const at = new Date("2026-10-08T09:00:00.000Z");
    const [college] = buildSnapshots([row({ userId: "u", solvedEasy: 3, solvedMedium: 2, solvedHard: 1, lastXpAt: at })]);
    expect(college?.top[0]).toMatchObject({ solved: 6, solvedEasy: 3, solvedMedium: 2, solvedHard: 1, lastXpAt: at.toISOString() });
  });
});

/** A stand-in for the three calls the job makes. */
function fakeDb(unfrozen: Record<string, string[]>, options: { failQueries?: number } = {}) {
  const calls = { queryRaw: [] as unknown[][], findMany: 0, createMany: 0 };
  let failures = options.failQueries ?? 0;
  const db = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.queryRaw.push(values);
      if (failures > 0) {
        failures -= 1;
        throw new Error("database unavailable");
      }
      return (unfrozen[String(values[0])] ?? []).map((periodKey) => ({ periodKey }));
    },
    xpBucket: {
      findMany: async () => {
        calls.findMany += 1;
        return [];
      },
    },
    leaderboardSnapshot: {
      createMany: async (args: { data: unknown[] }) => {
        calls.createMany += 1;
        return { count: args.data.length };
      },
    },
  };
  return { db: db as unknown as Db, calls };
}

describe("LeaderboardFreezeJob.tick", () => {
  const afterClose = new Date(WEEK_START.getTime() + FREEZE_GRACE_MS + MIN);

  it("catches up once, then costs nothing until a period closes", async () => {
    const { db, calls } = fakeDb({ WEEK: ["2026-W41"], MONTH: ["2026-09"] });
    const job = new LeaderboardFreezeJob({ db, log });

    const first = await job.tick(afterClose);
    expect(first.failed).toBe(false);
    expect(first.frozen.map((f) => `${f.period}:${f.periodKey}`)).toEqual(["WEEK:2026-W41", "MONTH:2026-09"]);
    expect(calls.queryRaw).toHaveLength(2);
    expect(calls.createMany).toBe(2);

    // Every following tick in the same week: no query at all.
    for (let i = 1; i <= 50; i++) await job.tick(new Date(afterClose.getTime() + i * 10_000));
    expect(calls.queryRaw).toHaveLength(2);

    // The next Monday (plus grace): the WEEK cut-off moves; MONTH does not.
    await job.tick(new Date(afterClose.getTime() + 7 * 86_400_000));
    expect(calls.queryRaw).toHaveLength(3);
    expect(calls.queryRaw[2]?.[0]).toBe("WEEK");
  });

  it("does not freeze the week that just ended before its grace has passed", async () => {
    const { db, calls } = fakeDb({});
    const job = new LeaderboardFreezeJob({ db, log });
    await job.tick(new Date(WEEK_START.getTime() + MIN));
    // The cut-off passed to the query is still the closing week itself.
    expect(calls.queryRaw[0]?.slice(0, 3)).toEqual(["WEEK", "2026-W33", "2026-W41"]);
  });

  it("writes nothing in a dry run", async () => {
    const { db, calls } = fakeDb({ WEEK: ["2026-W41"] });
    const job = new LeaderboardFreezeJob({ db, log, dryRun: true });
    const report = await job.tick(afterClose);
    expect(report.frozen).toEqual([expect.objectContaining({ periodKey: "2026-W41", inserted: 0 })]);
    expect(calls.createMany).toBe(0);
  });

  it("backs off after a failure and retries", async () => {
    const { db, calls } = fakeDb({ WEEK: ["2026-W41"] }, { failQueries: 1 });
    const job = new LeaderboardFreezeJob({ db, log });
    expect((await job.tick(afterClose)).failed).toBe(true);
    await job.tick(new Date(afterClose.getTime() + FREEZE_RETRY_MS - 1));
    expect(calls.queryRaw).toHaveLength(1);
    const retried = await job.tick(new Date(afterClose.getTime() + FREEZE_RETRY_MS));
    expect(retried.failed).toBe(false);
    expect(retried.frozen.map((f) => f.periodKey)).toEqual(["2026-W41"]);
  });
});
