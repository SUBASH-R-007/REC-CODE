import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPrismaClient, type Db, type DbTx } from "@recx/db";
import {
  LANGUAGE_CATALOG,
  XP_KEYS,
  XP_RULES,
  XP_RULES_VERSION,
  campusDay,
  type Topic,
  type Verdict,
} from "@recx/shared";
import { bucketKeys, dayAsDate, PROGRESS_BADGES, PROGRESS_NOTIFICATION_KIND } from "@/lib/progress/rules";

/**
 * The progress engine against a real Postgres (recx_test, migrations
 * applied): applySubmissionProgress inside a transaction holding the per-user
 * advisory lock, exactly as finalize.ts runs it. Covers the status row,
 * ProblemStat, the XP ledger (exactly once), the three buckets, ActivityDay,
 * UserStats (counters, JSON topic / language counters, streak), daily
 * challenge, assisted solves, the daily caps, streak milestones, badges,
 * notifications, study plans, the rejudge rule and the savepoint.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database). Activity is dated in a random stretch of 2097 so
 * the global DailyChallenge rows it writes never meet real dates.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";

type ApplyModule = typeof import("@/lib/progress/apply");

describe.skipIf(!ENABLED)("progress engine against recx_test", () => {
  const tag = `prog-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let db: Db;
  let apply: ApplyModule;
  let languageConfigId = "";
  const users = { main: "", other: "" };
  type ProblemName = "easy" | "medium" | "hard" | "hard2" | "easy2" | "rejudged" | "streak" | "internal";
  const problems = {} as Record<ProblemName, { id: string; versionId: string }>;
  const createdBadgeIds: string[] = [];
  let planId = "";

  // Six consecutive campus days somewhere in 2097.
  const startOffset = Math.floor(Math.random() * 300);
  const day = (n: number) => campusDay(new Date(Date.UTC(2097, 0, 1 + startOffset + n, 6)));
  const at = (n: number, time: string) => new Date(`${day(n)}T${time}:00+05:30`);

  async function createProblem(name: string, difficulty: "EASY" | "MEDIUM" | "HARD", topics: Topic[] = []) {
    const problem = await db.problem.create({
      data: {
        slug: `${tag}-${name}`,
        displayCode: `${tag}-${name}`.toUpperCase(),
        title: `Progress ${name}`,
        difficulty,
        // DRAFT: progress does not look at the status, and a draft can never
        // be picked as a daily challenge by a scheduler test running alongside.
        tags: { create: topics.map((topic) => ({ topic })) },
      },
      select: { id: true },
    });
    const version = await db.problemVersion.create({
      data: {
        problemId: problem.id,
        revision: 1,
        title: `Progress ${name}`,
        difficulty,
        statementMd: "Test.",
        ioMode: "STDIN",
        timeLimitMs: 1000,
      },
      select: { id: true },
    });
    return { id: problem.id, versionId: version.id };
  }

  async function createSubmission(
    userId: string,
    problem: { id: string; versionId: string },
    verdict: Verdict,
    createdAt: Date,
  ): Promise<string> {
    const row = await db.submission.create({
      data: {
        userId,
        problemId: problem.id,
        problemVersionId: problem.versionId,
        languageConfigId,
        language: "cpp20",
        origin: "PRACTICE",
        lane: "PRACTICE",
        status: "DONE",
        judgeState: "DONE",
        verdict,
        sourceSha256: "0".repeat(64),
        sourceBytes: 1,
        createdAt,
        judgedAt: createdAt,
      },
      select: { id: true },
    });
    return row.id;
  }

  const lockUser = (tx: DbTx, userId: string) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('user:' || ${userId}::text))`;

  /** What finalize does: lock the user, then apply — in one transaction. */
  function progress(
    submissionId: string,
    userId: string,
    problem: { id: string; versionId: string },
    verdict: Verdict,
    submittedAt: Date,
    options: { rejudge?: boolean } = {},
  ) {
    return db.$transaction(async (tx) => {
      await lockUser(tx, userId);
      return apply.applySubmissionProgress(tx, {
        submissionId,
        userId,
        problemId: problem.id,
        problemVersionId: problem.versionId,
        language: "cpp20",
        verdict,
        submittedAt,
        now: new Date(submittedAt.getTime() + 2_000),
        rejudge: options.rejudge ?? false,
      });
    });
  }

  async function judge(userId: string, problem: { id: string; versionId: string }, verdict: Verdict, createdAt: Date) {
    const id = await createSubmission(userId, problem, verdict, createdAt);
    return { id, outcome: await progress(id, userId, problem, verdict, createdAt) };
  }

  const status = (problemId: string, userId = users.main) =>
    db.userProblemStatus.findUnique({ where: { userId_problemId: { userId, problemId } } });
  const stat = (problemId: string) => db.problemStat.findUniqueOrThrow({ where: { problemId } });
  const stats = (userId = users.main) => db.userStats.findUniqueOrThrow({ where: { userId } });
  const activity = (n: number, userId = users.main) =>
    db.activityDay.findUnique({ where: { userId_date: { userId, date: dayAsDate(day(n)) } } });
  const buckets = (userId = users.main) =>
    db.xpBucket.findMany({ where: { userId }, orderBy: [{ period: "asc" }, { periodKey: "asc" }] });
  const events = (userId = users.main) => db.xpEvent.findMany({ where: { userId }, orderBy: { id: "asc" } });

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    db = createPrismaClient({ url: TEST_URL, log: [] });
    apply = await import("@/lib/progress/apply");

    const rt = LANGUAGE_CATALOG.cpp20;
    const fields = { label: rt.label, version: rt.version, runtime: JSON.parse(JSON.stringify(rt)), enabled: true, isCurrent: true };
    languageConfigId = (
      await db.languageConfig.upsert({
        where: { key_toolchainId: { key: "cpp20", toolchainId: rt.toolchainId } },
        create: { key: "cpp20", toolchainId: rt.toolchainId, ...fields },
        update: {},
        select: { id: true },
      })
    ).id;

    for (const name of ["main", "other"] as const) {
      users[name] = (
        await db.user.create({
          data: {
            collegeId: `${tag}-${name}`,
            email: `${tag}-${name}@rec-code.example`,
            firstName: "Progress",
            lastName: name === "main" ? "Tester" : "Other",
            handle: `${tag}-${name}`,
            batchYear: 2027,
            departmentCode: "CSE",
            section: "A",
          },
          select: { id: true },
        })
      ).id;
    }

    problems.easy = await createProblem("easy", "EASY", ["ARRAYS_HASHING", "TWO_POINTERS"]);
    problems.medium = await createProblem("medium", "MEDIUM", ["GRAPHS"]);
    problems.hard = await createProblem("hard", "HARD", ["DYNAMIC_PROGRAMMING"]);
    problems.hard2 = await createProblem("hard2", "HARD", ["GREEDY"]);
    problems.easy2 = await createProblem("easy2", "EASY", ["STRINGS"]);
    problems.rejudged = await createProblem("rejudged", "EASY");
    problems.streak = await createProblem("streak", "MEDIUM");
    problems.internal = await createProblem("internal", "EASY");

    // The badge catalogue is seeded by content; create only the rows missing here.
    for (const badge of PROGRESS_BADGES) {
      const existing = await db.badge.findUnique({ where: { key: badge.key }, select: { id: true } });
      if (existing) continue;
      const row = await db.badge.create({
        data: { key: badge.key, name: `Test ${badge.key}`, description: `Test badge ${badge.key}.`, icon: "award" },
        select: { id: true },
      });
      createdBadgeIds.push(row.id);
    }

    // A one-item study plan containing the easy problem.
    const plan = await db.studyPlan.create({
      data: {
        slug: tag,
        kind: "SHEET",
        title: "Progress test plan",
        description: "Test.",
        itemsTotal: 1,
        sections: { create: { title: "Only section" } },
      },
      select: { id: true, sections: { select: { id: true } } },
    });
    planId = plan.id;
    await db.studyPlanItem.create({
      data: { planId, sectionId: plan.sections[0]!.id, problemId: problems.easy.id },
    });
    await db.studyPlanEnrollment.create({ data: { userId: users.main, planId, itemsTotal: 1 } });
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    try {
      const userIds = Object.values(users).filter(Boolean);
      const problemIds = Object.values(problems).map((p) => p.id);
      const byUser = (table: string) => db.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "userId" = ANY($1::text[])`, userIds);
      await db.$transaction([
        // The ledger is append-only by trigger; teardown lifts it inside this
        // one transaction (DDL is transactional; no other session sees it off).
        db.$executeRawUnsafe(`ALTER TABLE "XpEvent" DISABLE TRIGGER "XpEvent_append_only"`),
        byUser("XpEvent"),
        db.$executeRawUnsafe(`ALTER TABLE "XpEvent" ENABLE TRIGGER "XpEvent_append_only"`),
        ...[
          "XpBucket",
          "ActivityDay",
          "UserStats",
          "UserProblemStatus",
          "UserBadge",
          "Notification",
          "HintReveal",
          "EditorialView",
          "ProblemActivity",
          "StudyPlanEnrollment",
          "Submission",
        ].map(byUser),
        db.$executeRawUnsafe(`DELETE FROM "StudyPlan" WHERE "slug" = $1`, tag),
        db.$executeRawUnsafe(`DELETE FROM "DailyChallenge" WHERE "problemId" = ANY($1::text[])`, problemIds),
        db.$executeRawUnsafe(
          `DELETE FROM "Hint" WHERE "problemVersionId" IN (SELECT "id" FROM "ProblemVersion" WHERE "problemId" = ANY($1::text[]))`,
          problemIds,
        ),
        db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = ANY($1::text[])`, problemIds),
        db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE "id" = ANY($1::text[])`, problemIds),
        db.$executeRawUnsafe(`DELETE FROM "Badge" WHERE "id" = ANY($1::text[])`, createdBadgeIds),
        db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, userIds),
      ]);
    } finally {
      await db.$disconnect();
    }
  }, 60_000);

  it("a wrong answer is an attempt: status, ProblemStat, ActivityDay, UserStats and streak — no XP", async () => {
    const { outcome } = await judge(users.main, problems.easy, "WA", at(0, "10:00"));
    expect(outcome).toEqual({ firstSolve: false, assisted: false, xp: { solve: 0, streak: 0 }, streak: 1, badges: [] });

    expect(await status(problems.easy.id)).toMatchObject({
      status: "ATTEMPTED",
      attempts: 1,
      failedAttempts: 1,
      firstAttemptAt: at(0, "10:00"),
      lastAttemptAt: at(0, "10:00"),
      firstAcceptedAt: null,
    });
    expect(await stat(problems.easy.id)).toMatchObject({
      submissions: 1,
      accepted: 0,
      attempters: 1,
      solvers: 0,
      acceptanceRate: 0,
    });
    expect(await activity(0)).toMatchObject({ submissions: 1, accepted: 0, solved: 0, xp: 0, xpEasy: 0 });
    expect(await stats()).toMatchObject({
      submissions: 1,
      accepted: 0,
      solvedTotal: 0,
      currentStreak: 1,
      longestStreak: 1,
      lastActiveDate: dayAsDate(day(0)),
      xpTotal: 0,
    });
    expect(await events()).toEqual([]);
    expect(await buckets()).toEqual([]);
    const user = await db.user.findUniqueOrThrow({ where: { id: users.main }, select: { lastActiveAt: true } });
    expect(user.lastActiveAt).not.toBeNull();
  });

  it("the first AC on the daily challenge pays 2x once and moves every counter", async () => {
    await db.dailyChallenge.create({ data: { date: dayAsDate(day(0)), problemId: problems.easy.id } });
    await db.problemActivity.create({ data: { userId: users.main, problemId: problems.easy.id, activeSeconds: 300 } });

    const submittedAt = at(0, "10:05");
    const { id, outcome } = await judge(users.main, problems.easy, "AC", submittedAt);
    const xp = XP_RULES.firstSolve.EASY * XP_RULES.dailyChallengeMultiplier;
    expect(outcome).toMatchObject({ firstSolve: true, assisted: false, xp: { solve: xp, streak: 0 }, streak: 1 });
    expect(outcome.badges).toEqual(["first-solve"]);

    expect(await status(problems.easy.id)).toMatchObject({
      status: "SOLVED",
      attempts: 2,
      failedAttempts: 1,
      firstAcceptedAt: submittedAt,
      bestSubmissionId: id,
      solvedLanguage: "cpp20",
      assisted: false,
      activeSecondsToSolve: 300,
    });

    const [event] = await events();
    expect(event).toMatchObject({
      kind: "DAILY_CHALLENGE",
      amount: xp,
      idempotencyKey: XP_KEYS.solve(users.main, problems.easy.id),
      rulesVersion: XP_RULES_VERSION,
      problemId: problems.easy.id,
      submissionId: id,
      occurredAt: submittedAt,
    });
    expect(event?.meta).toMatchObject({ difficulty: "EASY", assisted: false, capped: false, dailyChallenge: true });

    const keys = bucketKeys(submittedAt);
    const rows = await buckets();
    expect(rows).toHaveLength(3);
    for (const key of keys) {
      expect(rows.find((b) => b.period === key.period && b.periodKey === key.periodKey)).toMatchObject({
        xp,
        solvedEasy: 1,
        solvedMedium: 0,
        solvedHard: 0,
        batchYear: 2027,
        departmentCode: "CSE",
        section: "A",
      });
    }

    expect(await activity(0)).toMatchObject({ submissions: 2, accepted: 1, solved: 1, xp, xpEasy: xp });
    expect(await stats()).toMatchObject({
      submissions: 2,
      accepted: 1,
      solvedEasy: 1,
      solvedTotal: 1,
      assistedSolves: 0,
      xpTotal: xp,
      languageCounts: { cpp20: 1 },
      topicSolved: { ARRAYS_HASHING: 1, TWO_POINTERS: 1 },
      topicAssisted: {},
    });
    expect(await stat(problems.easy.id)).toMatchObject({
      submissions: 2,
      accepted: 1,
      attempters: 1,
      solvers: 1,
      acceptanceRate: 0.5,
    });

    // Badge + notification, and the one-item study plan completed.
    const badge = await db.userBadge.findMany({ where: { userId: users.main }, select: { badge: { select: { key: true } } } });
    expect(badge.map((b) => b.badge.key)).toEqual(["first-solve"]);
    const notes = await db.notification.findMany({ where: { userId: users.main } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: PROGRESS_NOTIFICATION_KIND.badge, link: "/dashboard" });
    expect(notes[0]?.title).toMatch(/^You earned the .+ badge$/);
    const enrollment = await db.studyPlanEnrollment.findUniqueOrThrow({
      where: { userId_planId: { userId: users.main, planId } },
    });
    expect(enrollment.itemsDone).toBe(1);
    expect(enrollment.completedAt).not.toBeNull();
  });

  it("is idempotent for XP: applying the same accepted submission again awards nothing", async () => {
    const accepted = await db.submission.findFirstOrThrow({
      where: { userId: users.main, problemId: problems.easy.id, verdict: "AC" },
      select: { id: true, createdAt: true },
    });
    const before = { stats: await stats(), buckets: await buckets(), day: await activity(0) };
    const outcome = await progress(accepted.id, users.main, problems.easy, "AC", accepted.createdAt);
    expect(outcome).toMatchObject({ firstSolve: false, xp: { solve: 0, streak: 0 }, badges: [] });

    const ledger = await db.xpEvent.findMany({ where: { idempotencyKey: XP_KEYS.solve(users.main, problems.easy.id) } });
    expect(ledger).toHaveLength(1);
    const after = await stats();
    expect(after).toMatchObject({
      xpTotal: before.stats.xpTotal,
      solvedTotal: before.stats.solvedTotal,
      solvedEasy: before.stats.solvedEasy,
      languageCounts: before.stats.languageCounts,
      topicSolved: before.stats.topicSolved,
    });
    expect((await buckets()).map((b) => [b.period, b.xp, b.solvedEasy])).toEqual(
      before.buckets.map((b) => [b.period, b.xp, b.solvedEasy]),
    );
    expect((await activity(0))?.xp).toBe(before.day?.xp);
    expect((await status(problems.easy.id))?.bestSubmissionId).toBe(accepted.id);
    const enrollment = await db.studyPlanEnrollment.findUniqueOrThrow({
      where: { userId_planId: { userId: users.main, planId } },
    });
    expect(enrollment.itemsDone).toBe(1);
  });

  it("an editorial seen before submitting makes the solve assisted (40 %); a hint revealed after does not", async () => {
    await db.editorialView.create({
      data: { userId: users.main, problemId: problems.medium.id, firstViewedAt: at(0, "10:50") },
    });
    const medium = await judge(users.main, problems.medium, "AC", at(0, "11:00"));
    const assistedXp = Math.round(XP_RULES.firstSolve.MEDIUM * XP_RULES.assistedMultiplier);
    expect(medium.outcome).toMatchObject({ firstSolve: true, assisted: true, xp: { solve: assistedXp } });
    expect(medium.outcome.badges).toEqual(["first-medium"]);
    expect(await status(problems.medium.id)).toMatchObject({ status: "SOLVED", assisted: true });

    // Tier-3 hint revealed AFTER the submission was created: not assisted.
    const hint = await db.hint.create({
      data: { problemVersionId: problems.hard.versionId, tier: 3, contentMd: "Think about subproblems." },
      select: { id: true },
    });
    await db.hintReveal.create({
      data: {
        userId: users.main,
        problemId: problems.hard.id,
        hintId: hint.id,
        tier: 3,
        context: "PRACTICE",
        revealedAt: at(0, "12:30"),
      },
    });
    const hard = await judge(users.main, problems.hard, "AC", at(0, "12:00"));
    expect(hard.outcome).toMatchObject({ firstSolve: true, assisted: false, xp: { solve: XP_RULES.firstSolve.HARD } });
    expect(hard.outcome.badges).toEqual(["first-hard"]);

    const s = await stats();
    expect(s).toMatchObject({ solvedMedium: 1, solvedHard: 1, solvedTotal: 3, assistedSolves: 1 });
    expect(s.topicAssisted).toEqual({ GRAPHS: 1 });
    expect(s.topicSolved).toEqual({ ARRAYS_HASHING: 1, TWO_POINTERS: 1, DYNAMIC_PROGRAMMING: 1 });
    expect(s.languageCounts).toEqual({ cpp20: 3 });
    expect(await activity(0)).toMatchObject({
      xp: XP_RULES.firstSolve.EASY * XP_RULES.dailyChallengeMultiplier + assistedXp + XP_RULES.firstSolve.HARD,
      xpEasy: XP_RULES.firstSolve.EASY * XP_RULES.dailyChallengeMultiplier,
    });
  });

  it("applies the daily caps; a fully capped first solve still records its event once", async () => {
    // Earlier XP on day 1 (as if from other solves): 10 short of the total cap.
    await db.activityDay.create({
      data: { userId: users.main, date: dayAsDate(day(1)), xp: XP_RULES.caps.totalPerDay - 10 },
    });
    const statsBefore = await stats();

    // Tier-3 hint revealed BEFORE submitting: assisted, then capped to 10.
    const hint = await db.hint.create({
      data: { problemVersionId: problems.hard2.versionId, tier: 3, contentMd: "Sort first." },
      select: { id: true },
    });
    await db.hintReveal.create({
      data: {
        userId: users.main,
        problemId: problems.hard2.id,
        hintId: hint.id,
        tier: 3,
        context: "PRACTICE",
        revealedAt: at(1, "08:00"),
      },
    });
    const hard2 = await judge(users.main, problems.hard2, "AC", at(1, "09:00"));
    expect(hard2.outcome).toMatchObject({ firstSolve: true, assisted: true, xp: { solve: 10 }, streak: 2 });
    const capped = await db.xpEvent.findUniqueOrThrow({ where: { idempotencyKey: XP_KEYS.solve(users.main, problems.hard2.id) } });
    expect(capped.amount).toBe(10);
    expect(capped.meta).toMatchObject({ capped: true, assisted: true, uncapped: Math.round(XP_RULES.firstSolve.HARD * XP_RULES.assistedMultiplier) });

    // The day is now at the cap: an Easy first solve pays 0 but is recorded once.
    const allBefore = await db.xpBucket.findUniqueOrThrow({
      where: { period_periodKey_userId: { period: "ALL_TIME", periodKey: "all", userId: users.main } },
    });
    const easy2 = await judge(users.main, problems.easy2, "AC", at(1, "09:30"));
    expect(easy2.outcome).toMatchObject({ firstSolve: true, xp: { solve: 0 } });
    const zero = await db.xpEvent.findUniqueOrThrow({ where: { idempotencyKey: XP_KEYS.solve(users.main, problems.easy2.id) } });
    expect(zero).toMatchObject({ amount: 0, kind: "SOLVE" });
    expect(zero.meta).toMatchObject({ capped: true, difficulty: "EASY" });

    const allAfter = await db.xpBucket.findUniqueOrThrow({
      where: { period_periodKey_userId: { period: "ALL_TIME", periodKey: "all", userId: users.main } },
    });
    expect(allAfter.xp).toBe(allBefore.xp);
    expect(allAfter.solvedEasy).toBe(allBefore.solvedEasy + 1);
    // No XP: the tie-break time does not move.
    expect(allAfter.lastXpAt.getTime()).toBe(allBefore.lastXpAt.getTime());

    expect(await activity(1)).toMatchObject({ xp: XP_RULES.caps.totalPerDay, xpEasy: 0, solved: 2, submissions: 2 });
    const statsAfter = await stats();
    expect(statsAfter.xpTotal).toBe(statsBefore.xpTotal + 10);
    expect(statsAfter).toMatchObject({ solvedTotal: 5, currentStreak: 2, longestStreak: 2, lastActiveDate: dayAsDate(day(1)) });
  });

  it("a 7-day streak pays its milestone once, with a badge and notifications", async () => {
    // Fast-forward: as if the student had been active every day up to day 4.
    await db.userStats.update({
      where: { userId: users.main },
      data: { currentStreak: 6, longestStreak: 6, lastActiveDate: dayAsDate(day(4)) },
    });
    const xpBefore = (await stats()).xpTotal;
    const { outcome } = await judge(users.main, problems.streak, "WA", at(5, "07:00"));
    const milestoneXp = XP_RULES.streakMilestones[7];
    expect(outcome).toMatchObject({ firstSolve: false, streak: 7, xp: { solve: 0, streak: milestoneXp } });
    expect(outcome.badges).toEqual(["streak-7"]);

    const event = await db.xpEvent.findUniqueOrThrow({ where: { idempotencyKey: XP_KEYS.streak(users.main, 7) } });
    expect(event).toMatchObject({ kind: "STREAK_MILESTONE", amount: milestoneXp, problemId: null });
    expect(await stats()).toMatchObject({ currentStreak: 7, longestStreak: 7, xpTotal: xpBefore + milestoneXp });
    expect(await activity(5)).toMatchObject({ submissions: 1, xp: milestoneXp, xpEasy: 0 });
    const kinds = (await db.notification.findMany({ where: { userId: users.main }, select: { kind: true } })).map((n) => n.kind);
    expect(kinds.filter((k) => k === PROGRESS_NOTIFICATION_KIND.streak)).toHaveLength(1);

    // Same day again: no second milestone.
    const again = await judge(users.main, problems.streak, "WA", at(5, "07:30"));
    expect(again.outcome).toMatchObject({ streak: 7, xp: { streak: 0 }, badges: [] });
    expect(await db.xpEvent.count({ where: { idempotencyKey: XP_KEYS.streak(users.main, 7) } })).toBe(1);
  });

  it("buckets agree with the user's XP total in every period", async () => {
    const { xpTotal } = await stats();
    const rows = await buckets();
    const sum = (period: string) => rows.filter((b) => b.period === period).reduce((s, b) => s + b.xp, 0);
    expect(sum("ALL_TIME")).toBe(xpTotal);
    expect(sum("MONTH")).toBe(xpTotal);
    expect(sum("WEEK")).toBe(xpTotal);
  });

  it("a rejudge credits a missed first solve once and never recounts the attempt", async () => {
    const wrong = await judge(users.main, problems.rejudged, "WA", at(5, "08:00"));
    const before = { stats: await stats(), stat: await stat(problems.rejudged.id), status: await status(problems.rejudged.id) };
    expect(before.status).toMatchObject({ attempts: 1, failedAttempts: 1, status: "ATTEMPTED" });

    // The admin's rejudge finds the solution correct.
    await db.submission.update({ where: { id: wrong.id }, data: { lane: "REJUDGE", verdict: "AC" } });
    const credited = await progress(wrong.id, users.main, problems.rejudged, "AC", at(5, "08:00"), { rejudge: true });
    expect(credited).toMatchObject({ firstSolve: true, streak: null, xp: { solve: XP_RULES.firstSolve.EASY } });
    expect(await status(problems.rejudged.id)).toMatchObject({ status: "SOLVED", attempts: 1, failedAttempts: 1, bestSubmissionId: wrong.id });
    expect(await stat(problems.rejudged.id)).toMatchObject({ submissions: 1, accepted: 0, attempters: 1, solvers: 1 });
    const after = await stats();
    expect(after).toMatchObject({
      submissions: before.stats.submissions,
      accepted: before.stats.accepted,
      solvedTotal: before.stats.solvedTotal + 1,
      currentStreak: before.stats.currentStreak,
    });

    // Rejudged again (any verdict): nothing changes.
    const noop = await progress(wrong.id, users.main, problems.rejudged, "WA", at(5, "08:00"), { rejudge: true });
    expect(noop).toMatchObject({ firstSolve: false, xp: { solve: 0, streak: 0 }, streak: null });
    expect(await stats()).toMatchObject({ solvedTotal: after.solvedTotal, xpTotal: after.xpTotal });
  });

  it("an internal error changes nothing", async () => {
    const before = await stats();
    const { outcome } = await judge(users.main, problems.internal, "IE", at(5, "09:00"));
    expect(outcome).toEqual({ firstSolve: false, assisted: false, xp: { solve: 0, streak: 0 }, streak: null, badges: [] });
    expect(await status(problems.internal.id)).toBeNull();
    expect(await db.problemStat.findUnique({ where: { problemId: problems.internal.id } })).toBeNull();
    expect(await stats()).toMatchObject({ submissions: before.submissions, updatedAt: before.updatedAt });
  });

  it("concurrent finalises of two students on one problem both land in ProblemStat", async () => {
    const before = await stat(problems.medium.id);
    await Promise.all([
      judge(users.other, problems.medium, "AC", at(2, "10:00")),
      judge(users.main, problems.medium, "WA", at(2, "10:00")),
    ]);
    const after = await stat(problems.medium.id);
    expect(after).toMatchObject({
      submissions: before.submissions + 2,
      accepted: before.accepted + 1,
      attempters: before.attempters + 1,
      solvers: before.solvers + 1,
    });
    expect(after.acceptanceRate).toBeCloseTo(after.accepted / after.submissions, 10);
  });

  it("a failing progress write is rolled back to its savepoint and the transaction still commits", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const marker = `${tag}-savepoint`;
      const userBefore = await db.user.findUniqueOrThrow({ where: { id: users.other }, select: { lastActiveAt: true } });
      const submissionId = await createSubmission(users.other, problems.hard, "WA", at(3, "10:00"));
      const outcome = await db.$transaction(async (tx) => {
        await lockUser(tx, users.other);
        const result = await apply.applySubmissionProgressSafely(tx, {
          submissionId,
          userId: users.other,
          // No such problem: the status upsert violates its foreign key.
          problemId: `${tag}-missing`,
          problemVersionId: problems.hard.versionId,
          language: "cpp20",
          verdict: "WA",
          submittedAt: at(3, "10:00"),
          now: at(3, "10:01"),
          rejudge: false,
        });
        // The verdict's own writes continue after the rollback.
        await tx.notification.create({ data: { userId: users.other, kind: "TEST", title: marker, body: marker } });
        return result;
      });
      expect(outcome).toBeNull();
      expect(quiet).toHaveBeenCalledOnce();
      expect(await db.notification.count({ where: { userId: users.other, title: marker } })).toBe(1);
      // Everything progress wrote before the failure was rolled back.
      const userAfter = await db.user.findUniqueOrThrow({ where: { id: users.other }, select: { lastActiveAt: true } });
      expect(userAfter.lastActiveAt?.getTime()).toBe(userBefore.lastActiveAt?.getTime());
      expect(await activity(3, users.other)).toBeNull();
    } finally {
      quiet.mockRestore();
    }
  });
});
