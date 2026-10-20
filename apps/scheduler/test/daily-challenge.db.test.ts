import { createPrismaClient, type Db } from "@recx/db";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSingleConnection } from "../src/config";
import { DailyChallengeJob, dayAsDate, ensureDailyChallenge, pickDailyChallenge } from "../src/daily-challenge";

/**
 * The daily challenge against a real Postgres (recx_test, migrations
 * applied). Opt-in: RECX_DB_TESTS=1. The job is ticked on dates in 2098, so
 * the global DailyChallenge rows it writes never meet a real date; cleanup
 * deletes exactly those rows and this file's problems.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
const log = pino({ level: "silent" });

describe.skipIf(!ENABLED)("daily challenge against recx_test", () => {
  const tag = `dct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let db: Db;
  const problemIds: string[] = [];
  // A random stretch of 2098, so two runs never share a date.
  const offset = Math.floor(Math.random() * 300);
  const day = (n: number) => new Date(Date.UTC(2098, 0, 1 + offset + n)).toISOString().slice(0, 10);
  /** 08:00 IST on day n. */
  const morningOf = (n: number) => new Date(`${day(n)}T08:00:00+05:30`);
  const testDates = () => [0, 1, 2, 3].map((n) => dayAsDate(day(n)));

  async function publishedProblem(name: string, difficulty: "EASY" | "MEDIUM" | "HARD") {
    const problem = await db.problem.create({
      data: { slug: `${tag}-${name}`, displayCode: `${tag}-${name}`.toUpperCase(), title: name, difficulty, status: "PUBLISHED" },
      select: { id: true },
    });
    const version = await db.problemVersion.create({
      data: {
        problemId: problem.id,
        revision: 1,
        title: name,
        difficulty,
        statementMd: "Test.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    await db.problem.update({ where: { id: problem.id }, data: { liveVersionId: version.id } });
    problemIds.push(problem.id);
    return problem.id;
  }

  async function candidatesAndHistory(onDay: string) {
    const date = dayAsDate(onDay);
    const [candidates, history] = await Promise.all([
      db.problem.findMany({ where: { status: "PUBLISHED", liveVersionId: { not: null } }, select: { id: true, difficulty: true } }),
      db.dailyChallenge.findMany({
        where: { date: { gte: new Date(date.getTime() - 400 * 86_400_000), lte: new Date(date.getTime() + 30 * 86_400_000) } },
        select: { date: true, problemId: true },
      }),
    ]);
    return { candidates, history: history.map((h) => ({ day: h.date.toISOString().slice(0, 10), problemId: h.problemId })) };
  }

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    db = createPrismaClient({ url: withSingleConnection(TEST_URL), log: [] });
    await publishedProblem("easy", "EASY");
    await publishedProblem("medium", "MEDIUM");
    await publishedProblem("hard", "HARD");
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await db.dailyChallenge.deleteMany({ where: { OR: [{ date: { in: testDates() } }, { problemId: { in: problemIds } }] } });
      await db.problem.updateMany({ where: { id: { in: problemIds } }, data: { liveVersionId: null } });
      await db.problemVersion.deleteMany({ where: { problemId: { in: problemIds } } });
      await db.problem.deleteMany({ where: { id: { in: problemIds } } });
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  it("creates today's challenge from the published catalogue, deterministically", async () => {
    const { candidates, history } = await candidatesAndHistory(day(0));
    const expected = pickDailyChallenge(day(0), candidates, history);
    expect(expected).not.toBeNull();
    const report = await new DailyChallengeJob({ db, log }).tick(morningOf(0));
    expect(report).toEqual({ ensured: [{ day: day(0), outcome: "created", problemId: expected }], failed: false });
    const row = await db.dailyChallenge.findUniqueOrThrow({ where: { date: dayAsDate(day(0)) } });
    expect(row.problemId).toBe(expected);
    const problem = await db.problem.findUniqueOrThrow({ where: { id: row.problemId }, select: { status: true, liveVersionId: true } });
    expect(problem.status).toBe("PUBLISHED");
    expect(problem.liveVersionId).not.toBeNull();
  });

  it("is idempotent: another instance finds the row and keeps it", async () => {
    const first = await db.dailyChallenge.findUniqueOrThrow({ where: { date: dayAsDate(day(0)) } });
    const again = await ensureDailyChallenge(db, day(0));
    expect(again).toEqual({ outcome: "exists", problemId: first.problemId });
    expect(await db.dailyChallenge.count({ where: { date: dayAsDate(day(0)) } })).toBe(1);
  });

  it("does not repeat yesterday's problem", async () => {
    const yesterday = await db.dailyChallenge.findUniqueOrThrow({ where: { date: dayAsDate(day(0)) } });
    const today = await ensureDailyChallenge(db, day(1));
    expect(today.outcome).toBe("created");
    expect(today.problemId).not.toBe(yesterday.problemId);
  });

  it("never replaces a day an admin set first", async () => {
    const hard = problemIds[2]!;
    await db.dailyChallenge.create({ data: { date: dayAsDate(day(3)), problemId: hard } });
    const report = await new DailyChallengeJob({ db, log }).tick(morningOf(3));
    expect(report.ensured).toEqual([{ day: day(3), outcome: "exists", problemId: hard }]);
  });

  it("a dry run writes nothing", async () => {
    const report = await new DailyChallengeJob({ db, log, dryRun: true }).tick(morningOf(2));
    expect(report.ensured[0]?.outcome).toBe("would-create");
    expect(await db.dailyChallenge.findUnique({ where: { date: dayAsDate(day(2)) } })).toBeNull();
  });
});
