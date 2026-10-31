import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The board moves (Phase 12q, slice 3), against a real PostgreSQL.
 *
 * `applyContestSubmission` is Phase 5 code and the decision inside it is
 * unit-tested in `@recx/shared` (contest-attempt.test.ts) — but the module
 * that reads, writes and locks had never once run against a database, in a
 * test or in the product. It could not have: nothing ever created a
 * CONTEST submission for it to apply, so `finalizeSubmission`'s branch
 * never fired and `ContestStanding` was empty by construction.
 *
 * Slice 3 wires the submission. This is the other half: given one, the
 * attempt row and this student's standing row appear, the ICPC penalty is
 * the documented one, and a submission made outside the window is refused
 * with a reason rather than silently scored.
 *
 * `rank` is deliberately NOT asserted: one job every 15 s owns it (SPEC
 * §4e), and this path leaves it alone on purpose.
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
/** ICPC: 20 minutes per rejected attempt before the solve. */
const PENALTY = 20;

describe.skipIf(!ENABLED)("applying a judged contest submission, against recx_test", () => {
  const tag = `capply-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: import("@recx/db").Db;
  let apply: typeof import("@/lib/contests/attempt").applyContestSubmission;
  let userId = "";
  let problemId = "";
  let versionId = "";
  let contestId = "";
  let contestProblemId = "";
  let languageConfigId = "";
  const startsAt = new Date(Date.now() - 60 * MINUTE);
  const endsAt = new Date(Date.now() + 60 * MINUTE);

  /** A CONTEST submission, the kind slice 3 now creates. */
  async function submission(over: Record<string, unknown> = {}) {
    const row = await db.submission.create({
      data: {
        userId,
        problemId,
        problemVersionId: versionId,
        languageConfigId,
        language: "cpp20",
        origin: "CONTEST",
        lane: "CONTEST",
        contestId,
        status: "DONE",
        judgeState: "DONE",
        totalCases: 4,
        sourceSha256: randomBytes(32).toString("hex"),
        sourceBytes: 20,
        ...over,
      } as never,
      select: { id: true },
    });
    return row.id;
  }

  const attempt = () =>
    db.contestProblemAttempt.findUnique({
      where: { contestId_userId_contestProblemId: { contestId, userId, contestProblemId } },
      select: {
        wrongAttempts: true,
        points: true,
        solvedAtMinutes: true,
        penaltyMinutes: true,
        bestSubmissionId: true,
        solvedAt: true,
      },
    });

  const standing = () =>
    db.contestStanding.findFirst({
      where: { contestId, userId },
      select: { solved: true, score: true, penalty: true },
    });

  beforeAll(async () => {
    const { createPrismaClient } = await import("@recx/db");
    db = createPrismaClient({ url: URL(), log: [] });
    ({ applyContestSubmission: apply } = await import("@/lib/contests/attempt"));

    const user = await db.user.create({
      data: {
        collegeId: `${tag}-a`,
        email: `${tag}@rec-code.example`,
        firstName: "Board",
        lastName: "Mover",
        handle: `${tag}-a`,
        role: "STUDENT",
      },
      select: { id: true },
    });
    userId = user.id;
    const problem = await db.problem.create({
      data: {
        slug: `${tag}-add`,
        displayCode: `REC-${Math.floor(1000 + Math.random() * 8999)}`,
        title: "Add them up",
        difficulty: "EASY",
        status: "PUBLISHED",
      },
      select: { id: true },
    });
    problemId = problem.id;
    const version = await db.problemVersion.create({
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
      } as never,
      select: { id: true },
    });
    versionId = version.id;
    await db.$executeRawUnsafe(`UPDATE "ProblemVersion" SET "frozenAt" = now() WHERE id = $1`, versionId);
    const contest = await db.contest.create({
      data: {
        slug: `${tag}-round`,
        title: "A round",
        kind: "ICPC",
        status: "PUBLISHED",
        rules: "Answer them.",
        freezeMinutes: 0,
        startsAt,
        endsAt,
        createdById: userId,
      } as never,
      select: { id: true },
    });
    contestId = contest.id;
    const cp = await db.contestProblem.create({
      data: { contestId, problemVersionId: versionId, index: "A", points: 1 },
      select: { id: true },
    });
    contestProblemId = cp.id;
    await db.contestRegistration.create({ data: { contestId, userId, kind: "RATED" } as never });
    const config = await db.languageConfig.findFirstOrThrow({
      where: { key: "cpp20" },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    languageConfigId = config.id;
  }, 90_000);

  afterAll(async () => {
    if (!db) return;
    try {
      await db.$executeRawUnsafe(`DELETE FROM "SubmissionSource" WHERE "submissionId" IN (SELECT id FROM "Submission" WHERE "userId" = $1)`, userId).catch(() => undefined);
      await db.$executeRawUnsafe(`DELETE FROM "ContestStanding" WHERE "contestId" = $1`, contestId);
      await db.$executeRawUnsafe(`DELETE FROM "ContestProblemAttempt" WHERE "contestId" = $1`, contestId);
      await db.$executeRawUnsafe(`DELETE FROM "Submission" WHERE "userId" = $1`, userId);
      await db.$executeRawUnsafe(`DELETE FROM "ContestRegistration" WHERE "contestId" = $1`, contestId);
      await db.$executeRawUnsafe(`DELETE FROM "ContestProblem" WHERE "contestId" = $1`, contestId);
      await db.$executeRawUnsafe(`DELETE FROM "Contest" WHERE id = $1`, contestId);
      await db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = $1 AND "frozenAt" IS NULL`, problemId);
      if ((await db.problemVersion.count({ where: { problemId } })) === 0) {
        await db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE id = $1`, problemId);
      }
      await db.user.deleteMany({ where: { id: userId } });
    } finally {
      await db.$disconnect();
    }
  }, 90_000);

  it("counts a rejected answer as a wrong attempt and puts the student on the board", async () => {
    // Nothing on the board before: that was the whole bug.
    expect(await standing()).toBeNull();
    const id = await submission({ verdict: "WA" });
    const out = await apply(db, {
      submissionId: id,
      userId,
      contestId,
      problemVersionId: versionId,
      verdict: "WA",
      score: 0,
      submittedAt: new Date(startsAt.getTime() + 10 * MINUTE),
    });
    expect(out).toEqual({ applied: true, solved: false });
    expect(await attempt()).toMatchObject({ wrongAttempts: 1, solvedAtMinutes: null });
    // On the board with nothing solved, which is what a contestant who has
    // tried and failed should see.
    expect(await standing()).toMatchObject({ solved: 0 });
  });

  it("scores the solve, and charges 20 penalty minutes for the earlier rejection", async () => {
    const id = await submission({ verdict: "AC" });
    const out = await apply(db, {
      submissionId: id,
      userId,
      contestId,
      problemVersionId: versionId,
      verdict: "AC",
      score: 0,
      submittedAt: new Date(startsAt.getTime() + 35 * MINUTE),
    });
    expect(out).toEqual({ applied: true, solved: true });
    const row = await attempt();
    expect(row).toMatchObject({
      wrongAttempts: 1,
      solvedAtMinutes: 35,
      penaltyMinutes: 35 + PENALTY,
      bestSubmissionId: id,
    });
    expect(row?.solvedAt).not.toBeNull();
    expect(await standing()).toMatchObject({ solved: 1, score: 1, penalty: 35 + PENALTY });
  });

  it("does not move the board again for a second accepted answer", async () => {
    // ICPC: the first solve is the solve. A student who resubmits a
    // correct answer must not pay a second penalty for it.
    const before = await attempt();
    const id = await submission({ verdict: "AC" });
    await apply(db, {
      submissionId: id,
      userId,
      contestId,
      problemVersionId: versionId,
      verdict: "AC",
      score: 0,
      submittedAt: new Date(startsAt.getTime() + 50 * MINUTE),
    });
    expect(await attempt()).toMatchObject({
      solvedAtMinutes: before?.solvedAtMinutes ?? null,
      penaltyMinutes: before?.penaltyMinutes ?? 0,
      wrongAttempts: before?.wrongAttempts ?? 0,
    });
  });

  it("refuses one submitted after the clock ran out, and says why", async () => {
    // Judged late is fine; SUBMITTED late is not — and it has to come back
    // as a reason rather than as a quiet no-op, because a submission that
    // vanishes is indistinguishable from one that was never made.
    const id = await submission({ verdict: "AC" });
    expect(
      await apply(db, {
        submissionId: id,
        userId,
        contestId,
        problemVersionId: versionId,
        verdict: "AC",
        score: 0,
        submittedAt: new Date(endsAt.getTime() + MINUTE),
      }),
    ).toEqual({ applied: false, reason: "outside-window" });
  });

  it("refuses a student who is not registered", async () => {
    const stranger = await db.user.create({
      data: {
        collegeId: `${tag}-x`,
        email: `${tag}-x@rec-code.example`,
        firstName: "Not",
        lastName: "Entered",
        handle: `${tag}-x`,
        role: "STUDENT",
      },
      select: { id: true },
    });
    try {
      expect(
        await apply(db, {
          submissionId: await submission({ verdict: "AC" }),
          userId: stranger.id,
          contestId,
          problemVersionId: versionId,
          verdict: "AC",
          score: 0,
          submittedAt: new Date(startsAt.getTime() + 5 * MINUTE),
        }),
      ).toEqual({ applied: false, reason: "not-registered" });
    } finally {
      await db.user.deleteMany({ where: { id: stranger.id } });
    }
  });

  it("refuses a problem that is not in this contest", async () => {
    const other = await db.problemVersion.create({
      data: {
        problemId,
        revision: Math.floor(Math.random() * 1_000_000),
        status: "PUBLISHED",
        title: "Another revision",
        difficulty: "EASY",
        statementMd: "Add them up.",
        ioMode: "STDIN",
        compareMode: "TOKEN",
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
      } as never,
      select: { id: true },
    });
    expect(
      await apply(db, {
        submissionId: await submission({ verdict: "AC" }),
        userId,
        contestId,
        problemVersionId: other.id,
        verdict: "AC",
        score: 0,
        submittedAt: new Date(startsAt.getTime() + 5 * MINUTE),
      }),
    ).toEqual({ applied: false, reason: "no-problem" });
  });
});
