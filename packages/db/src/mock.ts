import {
  MOCK_PERCENTILE_MIN_ATTEMPTS,
  XP_KEYS,
  XP_RULES_VERSION,
  campusDayDate,
  gradeAnswer,
  mockXp,
  scoreSection,
  sectionPercent,
  type AnswerKey,
  type GradedAnswer,
  type SectionRule,
} from "@recx/shared";
import type { Db, DbTx } from "./index";

/**
 * Grading and finalising a mock sitting (Phase 7c), in one place because SPEC
 * §5 requires it from TWO callers and a second copy would eventually disagree
 * with the first:
 *
 *   * `apps/web` finalises when a candidate presses submit;
 *   * `apps/scheduler` finalises an attempt whose deadline has passed, which
 *     is what makes `MockAttemptStatus.AUTO_SUBMITTED` reachable at all.
 *
 * Same reasoning as `attempt.ts` for Phase 6b's auto-submit. And the same
 * character: finalising at a deadline is a DEADLINE, not a penalty. Nothing
 * here writes a flag, a band or an integrity score, and `MockAttemptStatus`
 * has no VOIDED value to reach — a practice mock has no invigilator.
 *
 * The ORDER inside the transaction is the design, not a style:
 *
 *   1. take the per-user advisory lock, because the XP daily cap is a
 *      read-then-write and the judge finalise already takes this lock for the
 *      same reason;
 *   2. GRADE every open section and close it. Grading writes `isCorrect` and
 *      `awarded` onto answer rows that `recx_refuse_closed_section_write`
 *      refuses once the section is submitted, so the grade comes first;
 *   3. sum the sections into the attempt and move its status LAST, so a crash
 *      anywhere above leaves an unfinalised sitting the sweeper picks up
 *      again rather than a half-scored one;
 *   4. roll up the question and topic counters with `{ increment: n }`, never
 *      an aggregate on read (SPEC §4(d)'s rule generalised);
 *   5. write the one XP ledger row, keyed so a retried finalise pays nothing.
 */

// ── Grading one section ─────────────────────────────────────────────────

export interface SectionScoreRow {
  readonly stateId: string;
  readonly correct: number;
  readonly wrong: number;
  readonly unanswered: number;
  readonly rawScore: number;
  readonly maxScore: number;
  readonly percent: number;
  readonly passedCutoff: boolean;
  readonly byTopic: ReadonlyArray<{ topic: string; attempted: number; correct: number; seconds: number }>;
  readonly byQuestion: ReadonlyArray<{ questionId: string; answered: boolean; correct: boolean; seconds: number }>;
}

/**
 * Grade every answer in a section, write the section's totals, then close it.
 *
 * Idempotent: a section already submitted returns null, so a retried finalise
 * and a sweeper arriving at the same moment cannot double a score.
 */
export async function gradeAndCloseSection(
  tx: DbTx,
  args: { readonly stateId: string; readonly at: Date },
): Promise<SectionScoreRow | null> {
  const state = await tx.mockSectionState.findUnique({
    where: { id: args.stateId },
    select: {
      id: true,
      submittedAt: true,
      section: {
        select: {
          key: true,
          label: true,
          questionCount: true,
          timeLimitSec: true,
          cutoffPercent: true,
          marksPerCorrect: true,
          negativeMarkFraction: true,
          allowBackNavigation: true,
        },
      },
      answers: {
        select: {
          id: true,
          questionId: true,
          selectedIndexes: true,
          numericValue: true,
          firstSeenAtMs: true,
          answeredAtMs: true,
          question: {
            select: {
              kind: true,
              topic: true,
              correctOptionIndexes: true,
              numericAnswer: true,
              numericTolerance: true,
            },
          },
        },
      },
    },
  });
  if (!state || state.submittedAt !== null) return null;

  const rule: SectionRule = {
    key: state.section.key,
    label: state.section.label,
    timeLimitSec: state.section.timeLimitSec,
    questionCount: state.section.questionCount,
    cutoffPercent: state.section.cutoffPercent,
    marksPerCorrect: state.section.marksPerCorrect,
    negativeMarkFraction: state.section.negativeMarkFraction,
    allowBackNavigation: state.section.allowBackNavigation,
  };

  const graded: GradedAnswer[] = [];
  const byTopic = new Map<string, { topic: string; attempted: number; correct: number; seconds: number }>();
  const byQuestion: Array<{ questionId: string; answered: boolean; correct: boolean; seconds: number }> = [];

  for (const answer of state.answers) {
    const key: AnswerKey = {
      kind: answer.question.kind,
      correctOptionIndexes: answer.question.correctOptionIndexes,
      numericAnswer: answer.question.numericAnswer === null ? null : answer.question.numericAnswer.toString(),
      numericTolerance: answer.question.numericTolerance === null ? null : answer.question.numericTolerance.toString(),
    };
    const result = gradeAnswer(
      key,
      {
        selectedIndexes: answer.selectedIndexes,
        numericValue: answer.numericValue === null ? null : answer.numericValue.toString(),
      },
      rule,
    );
    graded.push(result);

    // An UNANSWERED question is not graded: there is nothing to be right
    // about and nothing is earned, so BOTH columns stay null.
    // `MockAttemptAnswer_graded_check` holds them together — it refused the
    // first draft of this for writing `isCorrect: null, awarded: 0`, which
    // is a half-graded row and exactly what the CHECK exists to catch.
    await tx.mockAttemptAnswer.update({
      where: { id: answer.id },
      data:
        result.state === "UNANSWERED"
          ? { isCorrect: null, awarded: null }
          : { isCorrect: result.isCorrect, awarded: result.awarded },
    });

    const seconds = secondsOn(answer.firstSeenAtMs, answer.answeredAtMs);
    const answered = result.state !== "UNANSWERED";
    byQuestion.push({ questionId: answer.questionId, answered, correct: result.state === "CORRECT", seconds });

    // Only ANSWERED questions move a topic's accuracy. A blank is not a wrong
    // answer, and counting it as attempted would make a student who ran out
    // of time look weaker at the topic than they are.
    if (!answered) continue;
    const topic = byTopic.get(answer.question.topic) ?? {
      topic: answer.question.topic,
      attempted: 0,
      correct: 0,
      seconds: 0,
    };
    topic.attempted += 1;
    topic.correct += result.state === "CORRECT" ? 1 : 0;
    topic.seconds += seconds;
    byTopic.set(answer.question.topic, topic);
  }

  const score = scoreSection(rule, graded);

  await tx.mockSectionState.update({
    where: { id: state.id },
    data: {
      correctCount: score.correct,
      wrongCount: score.wrong,
      unansweredCount: score.unanswered,
      rawScore: score.rawScore,
      maxScore: score.maxScore,
      percent: score.percent,
      passedCutoff: score.passedCutoff,
      // Last, and in the same statement as the totals: the section is closed
      // only once its score is written.
      submittedAt: args.at,
    },
  });

  return {
    stateId: state.id,
    correct: score.correct,
    wrong: score.wrong,
    unanswered: score.unanswered,
    rawScore: score.rawScore,
    maxScore: score.maxScore,
    percent: score.percent,
    passedCutoff: score.passedCutoff,
    byTopic: [...byTopic.values()],
    byQuestion,
  };
}

/** Seconds on a question, bounded so a tab left open cannot report hours. */
export function secondsOn(firstSeenAtMs: number, answeredAtMs: number | null): number {
  if (answeredAtMs === null) return 0;
  const seconds = Math.round((answeredAtMs - firstSeenAtMs) / 1_000);
  // Past half an hour the tab was simply left open, and recording it would
  // poison every pacing average.
  return Math.min(Math.max(0, seconds), 1_800);
}

// ── Finalising a sitting ────────────────────────────────────────────────

export interface FinalisedMock {
  readonly attemptId: string;
  readonly totalRaw: number;
  readonly totalMax: number;
  readonly percent: number;
  readonly sectionsPassed: number;
  readonly passedOverall: boolean;
  readonly xpAwarded: number;
  readonly alreadyFinalised: boolean;
}

export async function finaliseMock(
  db: Db,
  args: {
    readonly attemptId: string;
    /** Null for the sweeper, which acts for nobody. */
    readonly userId: string | null;
    readonly at: Date;
    readonly auto: boolean;
  },
): Promise<FinalisedMock | null> {
  const where = args.userId === null ? { id: args.attemptId } : { id: args.attemptId, userId: args.userId };
  const sitting = await db.mockAttempt.findFirst({
    where,
    select: {
      id: true,
      userId: true,
      patternId: true,
      status: true,
      percent: true,
      totalRaw: true,
      totalMax: true,
      sectionsPassed: true,
      passedOverall: true,
    },
  });
  if (!sitting) return null;
  if (sitting.status !== "IN_PROGRESS") {
    return {
      attemptId: sitting.id,
      totalRaw: sitting.totalRaw,
      totalMax: sitting.totalMax,
      percent: sitting.percent,
      sectionsPassed: sitting.sectionsPassed,
      passedOverall: sitting.passedOverall ?? false,
      xpAwarded: 0,
      alreadyFinalised: true,
    };
  }

  return db.$transaction(async (tx) => {
    // The daily XP cap is read-then-write, so this user's finalises serialise
    // here — exactly as the judge finalise does.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"user:" + sitting.userId}))`;

    const states = await tx.mockSectionState.findMany({
      where: { attemptId: sitting.id },
      orderBy: { position: "asc" },
      select: { id: true, submittedAt: true, rawScore: true, maxScore: true, passedCutoff: true },
    });

    const scored: SectionScoreRow[] = [];
    for (const state of states) {
      const row = await gradeAndCloseSection(tx, { stateId: state.id, at: args.at });
      if (row) scored.push(row);
    }

    // Sections closed earlier in the sitting keep the score they were given
    // then: re-grading them would be a second opinion on a closed section,
    // and the first one is what the candidate was shown.
    const closedEarlier = states.filter((state) => state.submittedAt !== null);
    const totalRaw = round6(
      scored.reduce((sum, row) => sum + row.rawScore, 0) + closedEarlier.reduce((sum, row) => sum + row.rawScore, 0),
    );
    const totalMax = round6(
      scored.reduce((sum, row) => sum + row.maxScore, 0) + closedEarlier.reduce((sum, row) => sum + row.maxScore, 0),
    );
    const passed =
      scored.filter((row) => row.passedCutoff).length +
      closedEarlier.filter((row) => row.passedCutoff === true).length;
    const percent = sectionPercent(totalRaw, totalMax);
    const passedOverall = states.length > 0 && passed === states.length;

    // Conditional on IN_PROGRESS: a candidate pressing submit as the sweeper
    // arrives produces ONE result, not two.
    const moved = await tx.mockAttempt.updateMany({
      where: { id: sitting.id, status: "IN_PROGRESS" },
      data: {
        status: args.auto ? "AUTO_SUBMITTED" : "SUBMITTED",
        finalizedAt: args.at,
        totalRaw,
        totalMax,
        percent,
        sectionsPassed: passed,
        passedOverall,
        version: { increment: 1 },
      },
    });
    if (moved.count !== 1) {
      const current = await tx.mockAttempt.findUniqueOrThrow({
        where: { id: sitting.id },
        select: { totalRaw: true, totalMax: true, percent: true, sectionsPassed: true, passedOverall: true },
      });
      return {
        attemptId: sitting.id,
        totalRaw: current.totalRaw,
        totalMax: current.totalMax,
        percent: current.percent,
        sectionsPassed: current.sectionsPassed,
        passedOverall: current.passedOverall ?? false,
        xpAwarded: 0,
        alreadyFinalised: true,
      };
    }

    await rollUpCounters(tx, { userId: sitting.userId, scored, at: args.at });

    const pattern = await tx.mockPattern.findUniqueOrThrow({
      where: { id: sitting.patternId },
      select: { medianPercent: true, finalizedAttemptCount: true, slug: true },
    });
    const award = mockXp({
      percent,
      medianPercent: pattern.medianPercent,
      finalizedAttemptCount: pattern.finalizedAttemptCount,
    });

    const paid = await tx.xpEvent.createManyAndReturn({
      data: [
        {
          userId: sitting.userId,
          kind: "MOCK",
          amount: award.xp,
          idempotencyKey: XP_KEYS.mock(sitting.id),
          occurredAt: args.at,
          rulesVersion: XP_RULES_VERSION,
          meta: {
            patternSlug: pattern.slug,
            percent,
            percentileCounted: award.percentileCounted,
            aboveMedian: award.aboveMedian,
            // Written down so a ledger row is explainable years later, when
            // the pattern's median has moved on.
            medianAtFinalise: pattern.medianPercent,
            cohortFloor: MOCK_PERCENTILE_MIN_ATTEMPTS,
            auto: args.auto,
          },
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    const xpAwarded = paid.length === 1 ? award.xp : 0;

    // A candidate who sat a full mock was active, whether or not XP was paid
    // — Phase 8's candidate set reads `User [status, lastActiveAt]` and
    // counts days with a qualifying ActivityDay.
    await tx.user.update({ where: { id: sitting.userId }, data: { lastActiveAt: args.at } });
    const date = campusDayDate(args.at);
    await tx.activityDay.upsert({
      where: { userId_date: { userId: sitting.userId, date } },
      create: { userId: sitting.userId, date, xp: xpAwarded, mocksFinalised: 1 },
      update: { xp: { increment: xpAwarded }, mocksFinalised: { increment: 1 } },
    });

    return {
      attemptId: sitting.id,
      totalRaw,
      totalMax,
      percent,
      sectionsPassed: passed,
      passedOverall,
      xpAwarded,
      alreadyFinalised: false,
    };
  });
}

/**
 * The maintained counters.
 *
 * `timesServed` is NOT incremented here: served and answered are different
 * events, and moving both at finalise would make `timesAnswered <=
 * timesServed` vacuous and bias the dud-question denominator by exactly the
 * attempts that went badly. A row created here starts with both at one, which
 * is the honest reading for a question first answered before any serving was
 * recorded.
 */
async function rollUpCounters(
  tx: DbTx,
  args: { readonly userId: string; readonly scored: readonly SectionScoreRow[]; readonly at: Date },
): Promise<void> {
  for (const section of args.scored) {
    for (const question of section.byQuestion) {
      if (!question.answered) continue;
      await tx.aptitudeQuestionStat.upsert({
        where: { questionId: question.questionId },
        create: {
          questionId: question.questionId,
          timesServed: 1,
          timesAnswered: 1,
          timesCorrect: question.correct ? 1 : 0,
          totalSeconds: question.seconds,
        },
        update: {
          timesAnswered: { increment: 1 },
          timesCorrect: { increment: question.correct ? 1 : 0 },
          totalSeconds: { increment: question.seconds },
        },
      });
    }

    for (const topic of section.byTopic) {
      await tx.aptitudeUserTopicStat.upsert({
        where: { userId_topic: { userId: args.userId, topic: topic.topic as never } },
        create: {
          userId: args.userId,
          topic: topic.topic as never,
          attempted: topic.attempted,
          correct: topic.correct,
          totalSeconds: topic.seconds,
          lastAttemptedAt: args.at,
        },
        update: {
          attempted: { increment: topic.attempted },
          correct: { increment: topic.correct },
          totalSeconds: { increment: topic.seconds },
          lastAttemptedAt: args.at,
        },
      });
    }
  }
}

// ── The sweeper's two jobs ──────────────────────────────────────────────

/**
 * Sittings whose deadline has passed and which nobody finalised.
 *
 * `FOR UPDATE SKIP LOCKED` has no Prisma equivalent, and without it two
 * scheduler instances would block on each other's rows instead of dividing
 * the batch — the same reason `attempt.ts` holds raw SQL.
 */
export async function dueMockAttempts(db: Db, limit: number): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id"
       FROM "MockAttempt"
      WHERE "status" = 'IN_PROGRESS'
        AND "expiresAt" <= (now() AT TIME ZONE 'UTC')
      ORDER BY "expiresAt" ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    limit,
  );
  return rows.map((row) => row.id);
}

export interface PatternStats {
  readonly patternId: string;
  readonly finalizedAttemptCount: number;
  readonly medianPercent: number | null;
}

/**
 * Recompute each pattern's cohort statistics.
 *
 * The median is computed in Postgres with `percentile_cont`, over the
 * `[patternId, percent DESC]` index, because doing it in the application
 * would mean reading every finalised attempt's percent into memory — and the
 * whole point of the maintained columns is that no page and no job scans.
 *
 * The count is of FINALISED attempts only. An abandoned sitting is not a data
 * point about the paper, and including it would drag every median down toward
 * the people who walked away.
 */
export async function recomputePatternStats(db: Db): Promise<PatternStats[]> {
  const rows = await db.$queryRawUnsafe<Array<{ patternId: string; attempts: bigint; median: number | null }>>(
    `SELECT p."id" AS "patternId",
            COUNT(a."id") AS "attempts",
            percentile_cont(0.5) WITHIN GROUP (ORDER BY a."percent") AS "median"
       FROM "MockPattern" AS p
       LEFT JOIN "MockAttempt" AS a
         ON a."patternId" = p."id"
        AND a."status" IN ('SUBMITTED', 'AUTO_SUBMITTED')
      GROUP BY p."id"`,
  );

  const stats: PatternStats[] = [];
  for (const row of rows) {
    const finalizedAttemptCount = Number(row.attempts);
    const medianPercent = row.median === null ? null : Math.round(row.median * 100) / 100;
    stats.push({ patternId: row.patternId, finalizedAttemptCount, medianPercent });
    await db.mockPattern.updateMany({
      where: { id: row.patternId },
      data: { finalizedAttemptCount, medianPercent },
    });
  }
  return stats;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000 + 0;
}
