import "server-only";
import {
  XP_KEYS,
  XP_RULES,
  XP_RULES_VERSION,
  aptitudeXp,
  campusDayDate,
  gradeAnswer,
  isResponseCorrect,
  type AnswerKey,
} from "@recx/shared";
import { db } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { secondsOn } from "@recx/db/mock";

/**
 * Topic practice: one question at a time, with the working shown afterwards
 * (Phase 7c).
 *
 * This is the surface the phase exists for. A mock tells a student where they
 * stand; practice is where the explanation does the teaching, which is why
 * SPEC §5 makes worked explanations mandatory at publish and why the
 * explanation is returned only AFTER the answer is committed.
 *
 * XP is paid here and nowhere else in the phase at the per-question rate:
 * once per question ever, on the first correct answer, under the 200/day cap.
 * Inside a mock it is not paid at all — a 120-question mock would otherwise
 * pay up to 1,200 XP through this rule as well as `XP_RULES.mock`, and the
 * daily cap would silently become the real number.
 */

export interface PracticeOutcome {
  readonly correct: boolean;
  /** The question's own correct indexes, now that the answer is committed. */
  readonly correctOptionIndexes: readonly number[];
  readonly numericAnswer: string | null;
  readonly explanation: string;
  readonly xpAwarded: number;
  readonly xpReason: "paid" | "already_paid" | "daily_cap" | "wrong";
}

export async function answerPracticeQuestion(args: {
  readonly userId: string;
  readonly questionId: string;
  readonly selectedIndexes: readonly number[];
  readonly numericValue: number | null;
  readonly seenAtMs: number;
  readonly answeredAtMs: number;
  readonly at: Date;
}): Promise<PracticeOutcome> {
  const question = await db.aptitudeQuestion.findFirst({
    where: { id: args.questionId, status: "PUBLISHED" },
    select: {
      id: true,
      kind: true,
      topic: true,
      correctOptionIndexes: true,
      numericAnswer: true,
      numericTolerance: true,
      explanation: true,
    },
  });
  // A RETIRED question is not practisable: retiring is allowed, serving is
  // not. The row stays for the answers that reference it.
  if (!question) throw new NotFoundError("That question is not available.");

  const key: AnswerKey = {
    kind: question.kind,
    correctOptionIndexes: question.correctOptionIndexes,
    numericAnswer: question.numericAnswer === null ? null : question.numericAnswer.toString(),
    numericTolerance: question.numericTolerance === null ? null : question.numericTolerance.toString(),
  };
  const response = { selectedIndexes: args.selectedIndexes, numericValue: args.numericValue };
  const correct = isResponseCorrect(key, response);
  const seconds = secondsOn(args.seenAtMs, args.answeredAtMs);

  const result = await db.$transaction(async (tx) => {
    // The daily cap is a read-then-write, so this user's practice answers
    // serialise here. Without the lock, two tabs answering at once would both
    // read the same running total and both pay.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"user:" + args.userId}))`;

    const day = campusDayDate(args.at);
    // Today's aptitude XP comes from the MAINTAINED column, not from an
    // aggregate over the ledger: SPEC §4(d) forbids aggregating XpEvent on a
    // request, and `xpEasy` already exists for exactly this reason (the
    // 600/day Easy cap). `tests/repo/xp-ledger.test.ts` refused the first
    // draft of this for doing the scan.
    const today = await tx.activityDay.findUnique({
      where: { userId_date: { userId: args.userId, date: day } },
      select: { xpAptitude: true },
    });
    const award = aptitudeXp({
      correct,
      // Not pre-checked. The ledger's unique `idempotencyKey` IS the "has
      // this question been paid" check: the insert below is conditional on
      // it, so asking first would be a second, weaker copy of the same
      // question — and an `xpEvent.count()` is a scan the ledger fence
      // rightly refuses (SPEC §4(d)).
      alreadyPaidForQuestion: false,
      awardedToday: today?.xpAptitude ?? 0,
    });

    let xpAwarded = 0;
    let alreadyPaid = false;
    if (award.xp > 0) {
      const paid = await tx.xpEvent.createManyAndReturn({
        data: [
          {
            userId: args.userId,
            kind: "APTITUDE",
            amount: award.xp,
            idempotencyKey: XP_KEYS.aptitude(args.userId, question.id),
            occurredAt: args.at,
            rulesVersion: XP_RULES_VERSION,
            meta: { topic: question.topic, perCorrect: XP_RULES.aptitude.perCorrect, cappedAt: award.xp },
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      xpAwarded = paid.length === 1 ? award.xp : 0;
      // Nothing inserted and nothing capped: the key was already there, so
      // this question has been paid before.
      alreadyPaid = xpAwarded === 0;
    }

    // Accuracy per topic moves on every ANSWER, right or wrong — that is what
    // makes the weakness view honest. A blank never reaches here: practice
    // commits an answer, and skipping is not answering.
    await tx.aptitudeUserTopicStat.upsert({
      where: { userId_topic: { userId: args.userId, topic: question.topic } },
      create: {
        userId: args.userId,
        topic: question.topic,
        attempted: 1,
        correct: correct ? 1 : 0,
        totalSeconds: seconds,
        lastAttemptedAt: args.at,
      },
      update: {
        attempted: { increment: 1 },
        correct: { increment: correct ? 1 : 0 },
        totalSeconds: { increment: seconds },
        lastAttemptedAt: args.at,
      },
    });

    await tx.aptitudeQuestionStat.upsert({
      where: { questionId: question.id },
      create: {
        questionId: question.id,
        timesServed: 1,
        timesAnswered: 1,
        timesCorrect: correct ? 1 : 0,
        totalSeconds: seconds,
        lastServedAt: args.at,
      },
      update: {
        timesAnswered: { increment: 1 },
        timesCorrect: { increment: correct ? 1 : 0 },
        totalSeconds: { increment: seconds },
      },
    });

    await tx.user.update({ where: { id: args.userId }, data: { lastActiveAt: args.at } });
    await tx.activityDay.upsert({
      where: { userId_date: { userId: args.userId, date: day } },
      create: {
        userId: args.userId,
        date: day,
        xp: xpAwarded,
        xpAptitude: xpAwarded,
        aptitudeAnswers: 1,
        activeSeconds: seconds,
      },
      update: {
        xp: { increment: xpAwarded },
        xpAptitude: { increment: xpAwarded },
        aptitudeAnswers: { increment: 1 },
        activeSeconds: { increment: seconds },
      },
    });

    return { xpAwarded, cappedBy: alreadyPaid ? ("already_paid" as const) : award.cappedBy };
  });

  return {
    correct,
    correctOptionIndexes: question.correctOptionIndexes,
    numericAnswer: question.numericAnswer === null ? null : question.numericAnswer.toString(),
    explanation: question.explanation,
    xpAwarded: result.xpAwarded,
    xpReason: !correct
      ? "wrong"
      : result.xpAwarded > 0
        ? "paid"
        : result.cappedBy === "already_paid"
          ? "already_paid"
          : "daily_cap",
  };
}

/**
 * Record that a practice question was SERVED.
 *
 * Separate from answering on purpose: served and answered are different
 * events, and incrementing both together would make `timesAnswered <=
 * timesServed` vacuous and bias the dud-question denominator by exactly the
 * questions people give up on.
 */
export async function recordPracticeServed(questionId: string, at: Date): Promise<void> {
  await db.aptitudeQuestionStat.upsert({
    where: { questionId },
    create: { questionId, timesServed: 1, lastServedAt: at },
    update: { timesServed: { increment: 1 }, lastServedAt: at },
  });
}

/** Grade a practice response without touching anything, for the preview path. */
export function gradePracticeResponse(key: AnswerKey, response: { selectedIndexes: readonly number[]; numericValue: number | null }) {
  return gradeAnswer(key, response, { marksPerCorrect: 1, negativeMarkFraction: 0 });
}
