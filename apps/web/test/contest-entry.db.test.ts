import { randomBytes } from "node:crypto";
import { freeDisplayCode } from "./support/display-code";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Which contest a submission belongs to (Phase 12q, slice 3), against a
 * real PostgreSQL.
 *
 * This is the step that did not exist. `submitSolution` wrote
 * `origin: "PRACTICE"` for every submission in the product, so Phase 5's
 * scoring — attempt row, points, penalty, board — was never reached from
 * the application and `ContestStanding` stayed empty however many contests
 * ran. The decision is made here, and it is DERIVED from the rows rather
 * than passed by the page: there is no link to forge, and the arena, the
 * catalogue and a bookmark all count the same way.
 *
 * Which makes these the rules worth pinning against a real database,
 * because each one is a way for a student's answer to land in the wrong
 * place — or in no place at all.
 *
 * Opt-in: RECX_DB_TESTS=1.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const URL = () => process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";

vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
});

const MINUTE = 60_000;

describe.skipIf(!ENABLED)("the live contest entry, against recx_test", () => {
  const tag = `centry-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let findLiveContestEntry: typeof import("@/lib/contests/entry").findLiveContestEntry;
  let userId = "";
  let otherId = "";
  let problemId = "";
  let liveVersionId = "";
  let pinnedVersionId = "";
  const contestIds: string[] = [];

  /** A frozen, published version — what a contest pin is allowed to point at. */
  async function frozen(over: Record<string, unknown> = {}) {
    const v = await db.problemVersion.create({
      data: {
        problemId,
        revision: Math.floor(Math.random() * 1_000_000),
        status: "PUBLISHED",
        title: "Add them up",
        difficulty: "EASY",
        statementMd: "Add them up.",
        ioMode: "STDIN",
        compareMode: "TOKEN",
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
        ...over,
      } as never,
      select: { id: true, ioMode: true },
    });
    await db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "frozenAt" = now() WHERE id = $1`, v.id);
    return v;
  }

  async function contest(over: Record<string, unknown>) {
    const row = await db.contest.create({
      data: {
        slug: `${tag}-${randomBytes(3).toString("hex")}`,
        title: "A round",
        kind: "ICPC",
        status: "PUBLISHED",
        rules: "Answer them.",
        freezeMinutes: 0,
        createdById: userId,
        ...over,
      } as never,
      select: { id: true },
    });
    contestIds.push(row.id);
    return row.id;
  }

  const pin = (contestId: string, versionId: string, index = "A") =>
    db.contestProblem.create({ data: { contestId, problemVersionId: versionId, index, points: 1 } });

  const register = (contestId: string, over: Record<string, unknown> = {}) =>
    db.contestRegistration.create({ data: { contestId, userId, kind: "RATED", ...over } as never });

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({ url: URL(), log: [] });
    ({ findLiveContestEntry } = await import("@/lib/contests/entry"));

    for (const [which, into] of [
      ["a", (id: string) => (userId = id)],
      ["b", (id: string) => (otherId = id)],
    ] as const) {
      const u = await db.user.create({
        data: {
          collegeId: `${tag}-${which}`,
          email: `${tag}-${which}@rec-code.example`,
          firstName: "Con",
          lastName: "Testant",
          handle: `${tag}-${which}`,
          role: which === "a" ? "STUDENT" : "ADMIN",
        },
        select: { id: true },
      });
      into(u.id);
    }
    const problem = await db.problem.create({
      data: {
        slug: `${tag}-add`,
        displayCode: await freeDisplayCode(db),
        title: "Add them up",
        difficulty: "EASY",
        status: "PUBLISHED",
      },
      select: { id: true },
    });
    problemId = problem.id;
    liveVersionId = (await frozen()).id;
    pinnedVersionId = (await frozen()).id;
    await db.problem.update({ where: { id: problemId }, data: { liveVersionId } });
  }, 90_000);

  afterAll(async () => {
    if (!db) return;
    try {
      for (const id of contestIds) {
        await db.$executeRawUnsafe(`DELETE FROM "ContestRegistration" WHERE "contestId" = $1`, id);
        await db.$executeRawUnsafe(`DELETE FROM "ContestProblem" WHERE "contestId" = $1`, id);
        await db.$executeRawUnsafe(`DELETE FROM "Contest" WHERE id = $1`, id);
      }
      await db.$executeRawUnsafe(`UPDATE "Problem" SET "liveVersionId" = NULL WHERE id = $1`, problemId);
      // A frozen version is immutable, a DELETE included, so only the
      // unfrozen ones go; the Problem stays if any version is left.
      await db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = $1 AND "frozenAt" IS NULL`, problemId);
      if ((await db.problemVersion.count({ where: { problemId } })) === 0) {
        await db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE id = $1`, problemId);
      }
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    } finally {
      await db.$disconnect();
    }
  }, 90_000);

  const now = () => new Date();
  const ask = (at = now()) => findLiveContestEntry(db, { userId, problemId, now: at });

  it("is nothing at all when the problem is in no contest", async () => {
    expect(await ask()).toBeNull();
  });

  it("is nothing when the contest holds it but the student never registered", async () => {
    // Registration is the line between watching a contest and being in it.
    const id = await contest({ startsAt: new Date(Date.now() - MINUTE), endsAt: new Date(Date.now() + 60 * MINUTE) });
    await pin(id, liveVersionId);
    expect(await ask()).toBeNull();
  });

  it("is the contest once they are registered and the clock is running", async () => {
    const id = await contest({ startsAt: new Date(Date.now() - MINUTE), endsAt: new Date(Date.now() + 60 * MINUTE) });
    await pin(id, pinnedVersionId, "B");
    await register(id);
    const entry = await ask();
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({ contestId: id, index: "B", virtual: false });
  });

  it("names the version the CONTEST pinned, not the problem's live one", async () => {
    // The reason pinning exists: republishing a problem mid-contest must
    // not change the question. The live version here is a different row.
    const entry = await ask();
    expect(entry?.problemVersionId).toBe(pinnedVersionId);
    expect(pinnedVersionId).not.toBe(liveVersionId);
  });

  it("is nothing at the closing instant, and nothing before the start", async () => {
    // The registered contest above runs from a minute ago to an hour
    // ahead, and it is the only one this student is in. So the instant it
    // closes, and any instant before it opened, belong to no contest —
    // half-open, the same way applyContestSubmission reads it.
    const entry = await ask();
    expect(entry).not.toBeNull();
    expect(await ask(new Date(entry!.endsAt.getTime()))).toBeNull();
    expect(await ask(new Date(entry!.endsAt.getTime() - 1))).not.toBeNull();
    expect(await ask(new Date(Date.now() - 2 * MINUTE))).toBeNull();
  });

  it("ignores a contest that is still a DRAFT", async () => {
    const id = await contest({
      status: "DRAFT",
      startsAt: new Date(Date.now() - MINUTE),
      endsAt: new Date(Date.now() + 60 * MINUTE),
    });
    await pin(id, liveVersionId);
    await register(id);
    const entry = await ask();
    // The one from the earlier test is still live; this draft adds nothing.
    expect(entry?.contestId).not.toBe(id);
  });

  it("follows a VIRTUAL run onto its own clock, and says it is virtual", async () => {
    // A contest that ended long ago, replayed now: the live window is
    // closed, the student's own window is open.
    const started = new Date(Date.now() - 10 * MINUTE);
    const id = await contest({
      startsAt: new Date(Date.now() - 400 * MINUTE),
      endsAt: new Date(Date.now() - 300 * MINUTE),
    });
    await pin(id, liveVersionId);
    await db.contestRegistration.create({
      data: { contestId: id, userId: otherId, kind: "VIRTUAL", virtualStartsAt: started } as never,
    });
    const theirs = await findLiveContestEntry(db, { userId: otherId, problemId, now: new Date() });
    expect(theirs).toMatchObject({ contestId: id, virtual: true });
    // 100 minutes of contest from their start, so their clock is still on.
    expect(theirs!.endsAt.getTime()).toBe(started.getTime() + 100 * MINUTE);
  });

  it("when two live contests hold it, picks the clock that runs out first, deterministically", async () => {
    // Unusual but permitted: ContestProblem is unique per (contest,
    // version) only. Whatever the rule is it must be the same every call,
    // or an answer lands in a different contest depending on row order.
    const soon = await contest({ startsAt: new Date(Date.now() - MINUTE), endsAt: new Date(Date.now() + 5 * MINUTE) });
    await pin(soon, liveVersionId, "C");
    await register(soon);
    const first = await ask();
    expect(first?.contestId).toBe(soon);
    for (let i = 0; i < 3; i++) expect((await ask())?.contestId).toBe(soon);
  });

  it("refuses to let a SQL problem into a contest at all, by trigger", async () => {
    /**
     * Phase 12q.3's own consequence. CONTEST is a sensitive lane, served
     * only by a node with fresh calibration; the SQL engine has none, and
     * it is the only engine that can judge a query. So a SQL question in a
     * running contest would now queue a submission NO node may claim —
     * worse than the practice query it used to be, because the student
     * waits for ever. The rule is said to the admin instead.
     */
    const sql = await frozen({ ioMode: "SQL", compareMode: "ROWS", sqlDialect: "postgres17", sqlOrdered: false });
    expect(sql.ioMode).toBe("SQL");
    const id = await contest({
      status: "DRAFT",
      startsAt: new Date(Date.now() + 60 * MINUTE),
      endsAt: new Date(Date.now() + 120 * MINUTE),
    });
    await expect(pin(id, sql.id, "Z")).rejects.toThrow(/is a SQL problem, which is not set in a contest yet/);
  });
});
