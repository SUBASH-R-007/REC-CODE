import { createPrismaClient, type Db } from "@recx/db";
import { periodKey } from "@recx/shared";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSingleConnection } from "../src/config";
import { FREEZE_GRACE_MS, LeaderboardFreezeJob, findUnfrozenPeriods, type SnapshotEntry } from "../src/leaderboard-freeze";

/**
 * The leaderboard freeze against a real Postgres (recx_test, migrations
 * applied). Opt-in: RECX_DB_TESTS=1. Buckets are written for a WEEK and a
 * MONTH in March 2098, and the job is ticked "in" 2098, so its lookback window
 * holds only this file's periods; cleanup deletes only this file's rows.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
const log = pino({ level: "silent" });

/** 16 March 2098, 06:00 IST: last week and last month are closed (and past their grace). */
const NOW = new Date("2098-03-16T06:00:00+05:30");
const WEEK_KEY = periodKey("WEEK", new Date(NOW.getTime() - 7 * 86_400_000));
const MONTH_KEY = periodKey("MONTH", new Date(NOW.getTime() - 20 * 86_400_000));
const OPEN_WEEK_KEY = periodKey("WEEK", NOW);

describe.skipIf(!ENABLED)("leaderboard freeze against recx_test", () => {
  const tag = `lbf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let db: Db;
  const ids: Record<string, string> = {};

  const snapshotKeys = [WEEK_KEY, MONTH_KEY, OPEN_WEEK_KEY];
  const clearSnapshots = () =>
    db.leaderboardSnapshot.deleteMany({ where: { periodKey: { in: snapshotKeys } } });

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    expect(WEEK_KEY < OPEN_WEEK_KEY).toBe(true);
    expect(MONTH_KEY).toBe("2098-02");
    db = createPrismaClient({ url: withSingleConnection(TEST_URL), log: [] });
    await clearSnapshots();

    const people: Array<{
      name: string;
      firstName: string;
      lastName: string;
      role?: "STUDENT" | "ADMIN";
      optOut?: boolean;
      cohort: { batchYear: number | null; departmentCode: string | null; section: string | null };
      xp: number;
      lastXpAt: string;
    }> = [
      { name: "asha", firstName: "Asha", lastName: "Raman", cohort: { batchYear: 2027, departmentCode: "CSE", section: "A" }, xp: 300, lastXpAt: "2098-03-10T10:00:00Z" },
      { name: "bala", firstName: "Bala", lastName: "Kumar", cohort: { batchYear: 2027, departmentCode: "CSE", section: "A" }, xp: 300, lastXpAt: "2098-03-10T10:00:00Z" },
      { name: "chitra", firstName: "Chitra", lastName: "Devi", cohort: { batchYear: 2028, departmentCode: "ECE", section: "B" }, xp: 100, lastXpAt: "2098-03-11T10:00:00Z" },
      { name: "deepak", firstName: "Deepak", lastName: "Nair", cohort: { batchYear: null, departmentCode: null, section: null }, xp: 50, lastXpAt: "2098-03-12T10:00:00Z" },
      { name: "optout", firstName: "Hidden", lastName: "Student", optOut: true, cohort: { batchYear: 2027, departmentCode: "CSE", section: "A" }, xp: 900, lastXpAt: "2098-03-10T09:00:00Z" },
      { name: "staff", firstName: "Staff", lastName: "Member", role: "ADMIN", cohort: { batchYear: null, departmentCode: null, section: null }, xp: 1000, lastXpAt: "2098-03-10T09:00:00Z" },
    ];
    for (const p of people) {
      const user = await db.user.create({
        data: {
          collegeId: `${tag}-${p.name}`,
          email: `${tag}-${p.name}@rec-code.example`,
          firstName: p.firstName,
          lastName: p.lastName,
          handle: `${tag}-${p.name}`,
          role: p.role ?? "STUDENT",
          leaderboardOptOut: p.optOut ?? false,
          ...p.cohort,
        },
        select: { id: true },
      });
      ids[p.name] = user.id;
      const bucket = { userId: user.id, xp: p.xp, solvedEasy: 2, solvedMedium: 1, solvedHard: 0, lastXpAt: new Date(p.lastXpAt), ...p.cohort };
      await db.xpBucket.createMany({
        data: [
          { ...bucket, period: "WEEK", periodKey: WEEK_KEY },
          { ...bucket, period: "MONTH", periodKey: MONTH_KEY },
          // The current (open) week must never be frozen.
          { ...bucket, period: "WEEK", periodKey: OPEN_WEEK_KEY },
        ],
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await clearSnapshots();
      const userIds = Object.values(ids);
      await db.xpBucket.deleteMany({ where: { userId: { in: userIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  it("finds the closed, unfrozen periods in the window — not the open one", async () => {
    const floor = periodKey("WEEK", new Date(NOW.getTime() - 8 * 7 * 86_400_000));
    const cutoff = periodKey("WEEK", new Date(NOW.getTime() - FREEZE_GRACE_MS));
    expect(await findUnfrozenPeriods(db, "WEEK", floor, cutoff)).toEqual([WEEK_KEY]);
  });

  it("a dry run decides but writes nothing", async () => {
    const report = await new LeaderboardFreezeJob({ db, log, dryRun: true }).tick(NOW);
    expect(report.frozen.map((f) => [f.period, f.periodKey, f.inserted])).toEqual([
      ["WEEK", WEEK_KEY, 0],
      ["MONTH", MONTH_KEY, 0],
    ]);
    expect(await db.leaderboardSnapshot.count({ where: { periodKey: { in: snapshotKeys } } })).toBe(0);
  });

  it("freezes each closed period once, per scope, students only, names via publicName", async () => {
    const report = await new LeaderboardFreezeJob({ db, log }).tick(NOW);
    expect(report.failed).toBe(false);
    // COLLEGE, DEPARTMENT ×2, BATCH ×2, SECTION ×2 per period.
    expect(report.frozen.map((f) => [f.period, f.periodKey, f.boards, f.inserted])).toEqual([
      ["WEEK", WEEK_KEY, 7, 7],
      ["MONTH", MONTH_KEY, 7, 7],
    ]);

    const rows = await db.leaderboardSnapshot.findMany({
      where: { period: "WEEK", periodKey: WEEK_KEY },
      orderBy: [{ scope: "asc" }, { scopeKey: "asc" }],
    });
    const boards = Object.fromEntries(
      rows.map((r) => [
        `${r.scope}/${r.scopeKey}`,
        (r.top as unknown as SnapshotEntry[]).map((e) => `${e.rank}:${e.publicName}:${e.xp}`),
      ]),
    );
    // Asha and Bala tie exactly (same XP, same time): both rank 1, listed by user id.
    const tied = (ids.asha ?? "") < (ids.bala ?? "") ? ["1:Asha R.:300", "1:Bala K.:300"] : ["1:Bala K.:300", "1:Asha R.:300"];
    expect(boards).toEqual({
      "COLLEGE/": [...tied, "3:Chitra D.:100", "4:Deepak N.:50"],
      "DEPARTMENT/CSE": tied,
      "DEPARTMENT/ECE": ["1:Chitra D.:100"],
      "BATCH/2027": tied,
      "BATCH/2028": ["1:Chitra D.:100"],
      "SECTION/2027:CSE:A": tied,
      "SECTION/2028:ECE:B": ["1:Chitra D.:100"],
    });

    // No opted-out student, no staff, no identifiers beyond the user id.
    const json = JSON.stringify(rows.map((r) => r.top));
    expect(json).not.toMatch(/Hidden|Staff|Raman|@rec-code|collegeId|email/);
    expect(json).not.toContain(ids.optout);
    expect(json).not.toContain(ids.staff);
    const entry = (rows.find((r) => r.scope === "COLLEGE")?.top as unknown as SnapshotEntry[])[0];
    expect(entry).toMatchObject({ solved: 3, solvedEasy: 2, solvedMedium: 1, solvedHard: 0 });

    expect(await db.leaderboardSnapshot.count({ where: { periodKey: OPEN_WEEK_KEY } })).toBe(0);
  });

  it("is idempotent: a second instance or a restart writes nothing more", async () => {
    const again = await new LeaderboardFreezeJob({ db, log }).tick(NOW);
    expect(again.frozen).toEqual([]);
    expect(await db.leaderboardSnapshot.count({ where: { periodKey: { in: [WEEK_KEY, MONTH_KEY] } } })).toBe(14);
  });
});
