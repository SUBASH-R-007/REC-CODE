import { createHash, randomBytes } from "node:crypto";
import { MOCK_PERCENTILE_MIN_ATTEMPTS, XP_KEYS, XP_RULES } from "@recx/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dueMockAttempts, finaliseMock, recomputePatternStats, secondsOn } from "../src/mock";
import {
  applyMigrations,
  disabledTriggers,
  openTestDb,
  RUN_DB_TESTS,
  testDatabaseName,
  type TestDb,
} from "./support/test-db";

/**
 * Finalising a mock sitting, against a live database (Phase 7c).
 *
 * The transaction this exercises is where the whole phase's arithmetic meets
 * the whole phase's invariants, and three of its properties cannot be proved
 * anywhere else:
 *
 *   * the ORDER — grade, then close, then move the status. The database's own
 *     trigger refuses the grading writes if the order is wrong, so a passing
 *     run here IS the proof;
 *   * IDEMPOTENCE — a re-finalise writes no second ledger row and does not
 *     double a score, because the status move is conditional and the ledger
 *     key is unique;
 *   * the negative-marking arithmetic end to end, on rows Postgres accepted,
 *     including the rule a candidate would dispute first: an unanswered
 *     question scores exactly zero.
 */

const run = randomBytes(3).readUIntBE(0, 3) % 90_000 + 10_000;
const TITLE = RUN_DB_TESTS
  ? "finalising a mock sitting (live database)"
  : "finalising a mock sitting (set RECX_DB_TESTS=1 to run)";

const WORKED = "Ten percent is one tenth of the number, so dividing 250 by ten gives 25 without the formula.";

describe.skipIf(!RUN_DB_TESTS)(TITLE, () => {
  let db: TestDb;
  let restoreEnv: () => void;
  let userId = "";
  const questionIds: string[] = [];
  let nextCode = 1;
  let nextSlug = 1;

  /** A pattern with one negatively marked section of four questions. */
  async function pattern(over: Record<string, unknown> = {}) {
    const row = await db.mockPattern.create({
      data: {
        slug: `fin-${run}-${nextSlug++}`,
        name: "Finalise fixture",
        funnelLabel: "A finalise-test funnel",
        sourceNote: "Written for the finalise test suite, 2026.",
        description: "A pattern the finalise test suite uses; it models nobody at all.",
      },
      select: { id: true },
    });
    const section = await db.aptitudeSection.create({
      data: {
        patternId: row.id,
        position: 1,
        key: "quantitative",
        label: "Quantitative aptitude",
        area: "QUANTITATIVE",
        topicMix: [{ topic: "PERCENTAGES", count: 4 }],
        questionCount: 4,
        timeLimitSec: 600,
        cutoffPercent: 50,
        marksPerCorrect: 1,
        negativeMarkFraction: 0.25,
        ...over,
      } as never,
      select: { id: true },
    });
    return { patternId: row.id, sectionId: section.id };
  }

  /**
   * A sitting with `correct` right answers, `wrong` wrong ones and `blank`
   * left alone — the shape every scoring assertion below needs.
   */
  async function sitting(args: {
    patternId: string;
    sectionId: string;
    correct: number;
    wrong: number;
    blank: number;
    attemptNumber?: number;
  }) {
    const startedAt = new Date(Date.now() - 600_000);
    const attempt = await db.mockAttempt.create({
      data: {
        patternId: args.patternId,
        userId,
        attemptNumber: args.attemptNumber ?? 1,
        seed: 1,
        startedAt,
        expiresAt: new Date(startedAt.getTime() + 1_200_000),
        layout: { v: 1, sections: [] },
      },
      select: { id: true },
    });
    const state = await db.mockSectionState.create({
      data: {
        attemptId: attempt.id,
        sectionId: args.sectionId,
        position: 1,
        startedAt,
        endsAt: new Date(startedAt.getTime() + 600_000),
      },
      select: { id: true },
    });

    let position = 0;
    const answer = async (selected: number[] | null) => {
      const questionId = questionIds[position]!;
      await db.mockAttemptAnswer.create({
        data: {
          attemptId: attempt.id,
          sectionStateId: state.id,
          questionId,
          position: position++,
          selectedIndexes: selected ?? [],
          firstSeenAtMs: 0,
          answeredAtMs: selected === null ? null : 20_000,
        },
      });
      // The real path records a SERVING in `serveIndex` before an answer can
      // exist, and `AptitudeQuestionStat_counts_check` (timesAnswered <=
      // timesServed) depends on that. The fixture writes answer rows
      // directly, so it owes the same serving — without it the roll-up's
      // increment would be refused, which is the CHECK doing its job.
      await db.aptitudeQuestionStat.upsert({
        where: { questionId },
        create: { questionId, timesServed: 1, lastServedAt: new Date() },
        update: { timesServed: { increment: 1 }, lastServedAt: new Date() },
      });
    };

    for (let i = 0; i < args.correct; i++) await answer([0]);
    for (let i = 0; i < args.wrong; i++) await answer([1]);
    for (let i = 0; i < args.blank; i++) await answer(null);
    return { attemptId: attempt.id, stateId: state.id };
  }

  beforeAll(async () => {
    const dbName = testDatabaseName();
    applyMigrations();
    ({ db, restore: restoreEnv } = await openTestDb());
    const [current] = await db.$queryRawUnsafe<Array<{ name: string }>>("SELECT current_database() AS name");
    expect(current?.name).toBe(dbName);
    expect(await disabledTriggers(db)).toEqual([]);

    const user = await db.user.create({
      data: {
        collegeId: `FIN${run}`,
        email: `fin-${run}@example.test`,
        firstName: "A",
        lastName: "Candidate",
        handle: `fin-${run}`,
        role: "STUDENT",
      },
      select: { id: true },
    });
    userId = user.id;

    // Four published questions, option 0 correct on every one.
    for (let i = 0; i < 4; i++) {
      const question = await db.aptitudeQuestion.create({
        data: {
          displayCode: `APT-${run}${String(nextCode++).padStart(4, "0")}`,
          area: "QUANTITATIVE",
          topic: "PERCENTAGES",
          kind: "SINGLE_CHOICE",
          difficulty: "EASY",
          status: "PUBLISHED",
          publishedAt: new Date(),
          stem: `What is ${(i + 1) * 10}% of 250?`,
          options: ["right", "wrong", "also wrong", "wrong too"],
          correctOptionIndexes: [0],
          explanation: WORKED,
          expectedSeconds: 45,
          origin: "FACULTY",
          contentHash: createHash("sha256").update(`fin-${run}-${i}`).digest("hex"),
        },
        select: { id: true },
      });
      questionIds.push(question.id);
    }
  });

  afterAll(async () => {
    if (!db) return;
    try {
      const raw = (sql: string, ...params: unknown[]) => db.$executeRawUnsafe(sql, ...params);
      const off = [
        ["MockAttempt", "MockAttempt_written_once"],
        ["MockAttemptAnswer", "MockAttemptAnswer_closed_section"],
        ["AptitudeSection", "AptitudeSection_pattern_frozen"],
        ["MockPattern", "MockPattern_scoring_frozen"],
        ["AptitudeQuestion", "AptitudeQuestion_published_immutable"],
        ["XpEvent", "XpEvent_append_only"],
      ] as const;
      await db.$transaction([
        ...off.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" DISABLE TRIGGER "${g}"`)),
        raw(`DELETE FROM "public"."XpEvent" WHERE "userId" = $1`, userId),
        raw(`DELETE FROM "public"."ActivityDay" WHERE "userId" = $1`, userId),
        raw(`DELETE FROM "public"."MockAttemptAnswer" WHERE "attemptId" IN (SELECT "id" FROM "public"."MockAttempt" WHERE "userId" = $1)`, userId),
        raw(`DELETE FROM "public"."MockSectionState" WHERE "attemptId" IN (SELECT "id" FROM "public"."MockAttempt" WHERE "userId" = $1)`, userId),
        raw(`DELETE FROM "public"."MockAttempt" WHERE "userId" = $1`, userId),
        raw(`DELETE FROM "public"."AptitudeUserTopicStat" WHERE "userId" = $1`, userId),
        raw(`DELETE FROM "public"."AptitudeQuestionStat" WHERE "questionId" = ANY($1::text[])`, questionIds),
        raw(`DELETE FROM "public"."AptitudeSection" WHERE "patternId" IN (SELECT "id" FROM "public"."MockPattern" WHERE "slug" LIKE $1)`, `fin-${run}-%`),
        raw(`DELETE FROM "public"."MockPattern" WHERE "slug" LIKE $1`, `fin-${run}-%`),
        raw(`DELETE FROM "public"."AptitudeQuestion" WHERE "id" = ANY($1::text[])`, questionIds),
        ...off.map(([t, g]) => raw(`ALTER TABLE "public"."${t}" ENABLE TRIGGER "${g}"`)),
        raw(`DELETE FROM "public"."User" WHERE "id" = $1`, userId),
      ]);
      expect(await disabledTriggers(db)).toEqual([]);
    } finally {
      await db.$disconnect();
      restoreEnv?.();
    }
  });

  // ── The arithmetic, end to end ───────────────────────────────────────

  describe("the score", () => {
    it("deducts the fraction for a wrong answer and nothing for a blank", async () => {
      // Two right, one wrong, one blank, with a quarter-mark penalty:
      // 2 − 0.25 = 1.75 out of 4, which is 43.75% and under the 50% cutoff.
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 2, wrong: 1, blank: 1 });

      const result = await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });
      expect(result).not.toBeNull();
      expect(result!.totalRaw).toBe(1.75);
      expect(result!.totalMax).toBe(4);
      expect(result!.percent).toBe(43.75);
      expect(result!.passedOverall).toBe(false);
      expect(result!.sectionsPassed).toBe(0);
    });

    it("writes exactly zero on the blank, and never a penalty", async () => {
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 0, wrong: 0, blank: 4 });
      await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });

      const answers = await db.mockAttemptAnswer.findMany({
        where: { attemptId },
        select: { isCorrect: true, awarded: true },
      });
      expect(answers).toHaveLength(4);
      // UNANSWERED: isCorrect null and awarded null, and the CHECK
      // MockAttemptAnswer_blank_not_penalised would have refused anything
      // negative.
      expect(answers.every((row) => row.isCorrect === null && row.awarded === null)).toBe(true);
    });

    it("floors the reported percent at zero while keeping the raw total honest", async () => {
      // All four wrong at a quarter mark each: raw −1, reported 0%.
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 0, wrong: 4, blank: 0 });
      const result = await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });
      expect(result!.totalRaw).toBe(-1);
      expect(result!.percent).toBe(0);
    });

    it("clears a cutoff reached exactly", async () => {
      // Three right, one blank, no penalty: 3/4 = 75%.
      const { patternId, sectionId } = await pattern({ negativeMarkFraction: 0 });
      const { attemptId } = await sitting({ patternId, sectionId, correct: 3, wrong: 0, blank: 1 });
      const result = await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });
      expect(result!.percent).toBe(75);
      expect(result!.passedOverall).toBe(true);
      expect(result!.sectionsPassed).toBe(1);
    });

    it("writes the section's own counts and verdict", async () => {
      const { patternId, sectionId } = await pattern();
      const { attemptId, stateId } = await sitting({ patternId, sectionId, correct: 2, wrong: 1, blank: 1 });
      await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });

      const state = await db.mockSectionState.findUniqueOrThrow({ where: { id: stateId } });
      expect(state.correctCount).toBe(2);
      expect(state.wrongCount).toBe(1);
      expect(state.unansweredCount).toBe(1);
      expect(state.rawScore).toBe(1.75);
      expect(state.percent).toBe(43.75);
      expect(state.passedCutoff).toBe(false);
      // Closed, and only once its score was written.
      expect(state.submittedAt).not.toBeNull();
    });
  });

  // ── The order ────────────────────────────────────────────────────────

  describe("the order grade-then-close", () => {
    it("grades every answer even though closing would refuse the write", async () => {
      // recx_refuse_closed_section_write refuses any answer write once the
      // section is submitted. A passing run here IS the proof that the
      // grading happened first: if the order were reversed, Postgres would
      // have raised and the whole transaction would have rolled back.
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 4, wrong: 0, blank: 0 });
      await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });

      const graded = await db.mockAttemptAnswer.count({ where: { attemptId, awarded: { not: null } } });
      expect(graded).toBe(4);
    });

    it("moves the status last, so the result is never half-written", async () => {
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 4, wrong: 0, blank: 0 });
      await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });

      const attempt = await db.mockAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(attempt.status).toBe("SUBMITTED");
      expect(attempt.finalizedAt).not.toBeNull();
      expect(attempt.passedOverall).toBe(true);
      // CHECK MockAttempt_finalised_check would have refused a status with no
      // result behind it.
      expect(attempt.percent).toBe(100);
      expect(attempt.version).toBe(1);
    });

    it("records AUTO_SUBMITTED when the sweeper is the caller", async () => {
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 1, wrong: 0, blank: 3 });
      // userId null: the sweeper acts for nobody.
      const result = await finaliseMock(db, { attemptId, userId: null, at: new Date(), auto: true });
      expect(result!.alreadyFinalised).toBe(false);
      const attempt = await db.mockAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(attempt.status).toBe("AUTO_SUBMITTED");
    });
  });

  // ── Idempotence ──────────────────────────────────────────────────────

  describe("finalising twice", () => {
    it("does not double a score and writes no second ledger row", async () => {
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 4, wrong: 0, blank: 0 });

      const first = await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });
      const second = await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });

      expect(first!.alreadyFinalised).toBe(false);
      expect(second!.alreadyFinalised).toBe(true);
      expect(second!.percent).toBe(first!.percent);
      expect(second!.xpAwarded).toBe(0);

      const ledger = await db.xpEvent.count({ where: { idempotencyKey: XP_KEYS.mock(attemptId) } });
      expect(ledger).toBe(1);
    });

    it("refuses a candidate finalising somebody else's sitting", async () => {
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 1, wrong: 0, blank: 3 });
      // Scoped by userId in a `where` clause: an id is not authorisation.
      expect(await finaliseMock(db, { attemptId, userId: "someone-else", at: new Date(), auto: false })).toBeNull();
      const attempt = await db.mockAttempt.findUniqueOrThrow({ where: { id: attemptId } });
      expect(attempt.status).toBe("IN_PROGRESS");
    });

    it("returns null for a sitting that does not exist", async () => {
      expect(await finaliseMock(db, { attemptId: "nope", userId, at: new Date(), auto: false })).toBeNull();
    });
  });

  // ── XP ───────────────────────────────────────────────────────────────

  describe("the XP a sitting pays", () => {
    it("pays the base and no percentile term before the pattern has a cohort", async () => {
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 4, wrong: 0, blank: 0 });
      const result = await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });
      expect(result!.xpAwarded).toBe(XP_RULES.mock.base);

      const row = await db.xpEvent.findFirstOrThrow({
        where: { idempotencyKey: XP_KEYS.mock(attemptId) },
        select: { kind: true, amount: true, meta: true },
      });
      expect(row.kind).toBe("MOCK");
      const meta = row.meta as { percentileCounted: boolean; cohortFloor: number };
      expect(meta.percentileCounted).toBe(false);
      // Written down so a ledger row is explainable years later.
      expect(meta.cohortFloor).toBe(MOCK_PERCENTILE_MIN_ATTEMPTS);
    });

    it("adds the percentile term once the pattern has one", async () => {
      const { patternId, sectionId } = await pattern({ negativeMarkFraction: 0 });
      // Pretend the cohort exists: the sweeper's nightly pass would set these.
      await db.mockPattern.update({
        where: { id: patternId },
        data: { finalizedAttemptCount: MOCK_PERCENTILE_MIN_ATTEMPTS, medianPercent: 50 },
      });
      const { attemptId } = await sitting({ patternId, sectionId, correct: 4, wrong: 0, blank: 0 });
      const result = await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });
      // 100% against a median of 50 is 50 points above it.
      expect(result!.xpAwarded).toBe(XP_RULES.mock.base + 50 * XP_RULES.mock.perPercentileAboveMedian);
    });

    it("records the day as active, whether or not XP was paid", async () => {
      // Phase 8's candidate set reads User [status, lastActiveAt] and counts
      // days with a qualifying ActivityDay.
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 1, wrong: 3, blank: 0 });
      await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });

      const days = await db.activityDay.findMany({ where: { userId }, select: { mocksFinalised: true } });
      expect(days.length).toBeGreaterThan(0);
      expect(days.reduce((sum, day) => sum + day.mocksFinalised, 0)).toBeGreaterThan(0);
      const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { lastActiveAt: true } });
      expect(user.lastActiveAt).not.toBeNull();
    });
  });

  // ── The maintained counters ──────────────────────────────────────────

  describe("the maintained counters", () => {
    it("moves the per-topic roll-up on answered questions only", async () => {
      // A blank is not a wrong answer, and counting it as attempted would
      // make a student who ran out of time look weaker than they are.
      await db.aptitudeUserTopicStat.deleteMany({ where: { userId } });
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 2, wrong: 1, blank: 1 });
      await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });

      const stat = await db.aptitudeUserTopicStat.findUniqueOrThrow({
        where: { userId_topic: { userId, topic: "PERCENTAGES" } },
      });
      expect(stat.attempted).toBe(3);
      expect(stat.correct).toBe(2);
      expect(stat.lastAttemptedAt).not.toBeNull();
    });

    it("moves the per-question counters without making timesAnswered exceed timesServed", async () => {
      // The CHECK would refuse it, which is what makes it protective rather
      // than decorative.
      await db.aptitudeQuestionStat.deleteMany({ where: { questionId: { in: questionIds } } });
      const { patternId, sectionId } = await pattern();
      const { attemptId } = await sitting({ patternId, sectionId, correct: 4, wrong: 0, blank: 0 });
      await finaliseMock(db, { attemptId, userId, at: new Date(), auto: false });

      const stats = await db.aptitudeQuestionStat.findMany({ where: { questionId: { in: questionIds } } });
      expect(stats).toHaveLength(4);
      for (const stat of stats) {
        expect(stat.timesAnswered).toBeLessThanOrEqual(stat.timesServed);
        expect(stat.timesCorrect).toBeLessThanOrEqual(stat.timesAnswered);
      }
    });

    it("bounds the seconds it records, so a tab left open cannot report hours", () => {
      expect(secondsOn(0, 20_000)).toBe(20);
      expect(secondsOn(0, null)).toBe(0);
      expect(secondsOn(5_000, 1_000)).toBe(0);
      expect(secondsOn(0, 9_000_000)).toBe(1_800);
    });
  });

  // ── The sweeper's two passes ─────────────────────────────────────────

  describe("the sweeper", () => {
    it("finds a sitting whose deadline has passed and not one that is live", async () => {
      const { patternId, sectionId } = await pattern();
      const live = await sitting({ patternId, sectionId, correct: 1, wrong: 0, blank: 3 });
      const overdue = await pattern();
      const startedAt = new Date(Date.now() - 7_200_000);
      const expired = await db.mockAttempt.create({
        data: {
          patternId: overdue.patternId,
          userId,
          attemptNumber: 1,
          seed: 1,
          startedAt,
          expiresAt: new Date(startedAt.getTime() + 600_000),
          layout: { v: 1, sections: [] },
        },
        select: { id: true },
      });

      const due = await dueMockAttempts(db, 50);
      expect(due).toContain(expired.id);
      expect(due).not.toContain(live.attemptId);
    });

    it("restates each pattern's cohort statistics from finalised attempts only", async () => {
      const { patternId, sectionId } = await pattern({ negativeMarkFraction: 0 });
      // Two finalised sittings at 100% and 25%, and one abandoned.
      const a = await sitting({ patternId, sectionId, correct: 4, wrong: 0, blank: 0, attemptNumber: 1 });
      await finaliseMock(db, { attemptId: a.attemptId, userId, at: new Date(), auto: false });
      const b = await sitting({ patternId, sectionId, correct: 1, wrong: 0, blank: 3, attemptNumber: 2 });
      await finaliseMock(db, { attemptId: b.attemptId, userId, at: new Date(), auto: false });
      const c = await sitting({ patternId, sectionId, correct: 4, wrong: 0, blank: 0, attemptNumber: 3 });
      await db.mockAttempt.update({ where: { id: c.attemptId }, data: { status: "ABANDONED" } });

      const stats = await recomputePatternStats(db);
      const mine = stats.find((row) => row.patternId === patternId);
      // An abandoned sitting is not a data point about the paper, and
      // including it would drag every median toward the people who walked
      // away.
      expect(mine?.finalizedAttemptCount).toBe(2);
      expect(mine?.medianPercent).toBe(62.5); // the mean of 100 and 25

      const pattern_ = await db.mockPattern.findUniqueOrThrow({
        where: { id: patternId },
        select: { finalizedAttemptCount: true, medianPercent: true },
      });
      expect(pattern_.finalizedAttemptCount).toBe(2);
      expect(pattern_.medianPercent).toBe(62.5);
    });

    it("leaves a pattern nobody has sat with a null median rather than a zero", async () => {
      // Zero would read as "everybody scored nothing", which is a different
      // statement from "nobody has sat this".
      const { patternId } = await pattern();
      const stats = await recomputePatternStats(db);
      const mine = stats.find((row) => row.patternId === patternId);
      expect(mine?.finalizedAttemptCount).toBe(0);
      expect(mine?.medianPercent).toBeNull();
    });
  });
});
