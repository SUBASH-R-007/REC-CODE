import "server-only";
import type { DbTx } from "@recx/db";
import {
  REVISION_INTERVALS,
  XP_KEYS,
  addDays,
  firstSchedule,
  scheduleAfterLapse,
  scheduleAfterReview,
  type DifficultyKey,
  type XpRules,
} from "@recx/shared";
import { dayAsDate, revisionAward, type DayXp, type XpAward } from "./rules";

/**
 * Spaced revision inside the progress engine (Phase 12c).
 *
 * Two moments, and nothing in between:
 *
 *   * a FIRST solve writes the card, due tomorrow;
 *   * a judged submission on a problem whose card is DUE moves it — up a
 *     rung and away for longer when it is accepted, down a rung and still
 *     due today when it is not.
 *
 * A submission on a card that is not due does nothing at all. A student
 * polishing an old solution is not revising, and a schedule that moved every
 * time they opened a problem would be a schedule they could not predict.
 *
 * Runs inside the finalise transaction under the per-user advisory lock, so
 * the read-then-write on the card cannot interleave with the same student's
 * other results. The XP is an ordinary ledger row with its own idempotency
 * key, and the card is only moved when that row was actually inserted — so a
 * retried finalise can neither pay twice nor advance the ladder twice.
 */

export interface RevisionInput {
  userId: string;
  problemId: string;
  submissionId: string;
  /** The campus day of the submission ("yyyy-mm-dd"). */
  day: string;
  /** The finalise moment. */
  now: Date;
  accepted: boolean;
  firstSolve: boolean;
  /** False on a rejudge: an admin re-running an old submission is not a review. */
  countAttempt: boolean;
  /**
   * The pinned version the submission was judged against. Its difficulty is
   * what a revision pays on, and it is read only in the one branch that
   * pays — most submissions are not reviews, and none of them should buy a
   * query to find that out.
   */
  problemVersionId: string;
  /** XP already earned today, for the caps. */
  earnedToday: DayXp;
  rules: XpRules;
  rulesVersion: number;
  /** The account is paused: the row is written, the boards do not move. */
  restricted: boolean;
  /** Inserts an XpEvent unless its key exists; true when this call inserted it. */
  insertXpEvent: (event: {
    userId: string;
    kind: "REVISION";
    amount: number;
    idempotencyKey: string;
    problemId: string;
    submissionId: string;
    occurredAt: Date;
    meta: Record<string, unknown>;
    rulesVersion: number;
  }) => Promise<boolean>;
}

export interface RevisionOutcome {
  /** A card was created by this submission. */
  created: boolean;
  /** A due card went up a rung. */
  reviewed: boolean;
  /** A due card went down a rung. */
  lapsed: boolean;
  /** The card cleared the last rung and will not come back. */
  learned: boolean;
  /** XP inserted by this call. */
  xp: number;
  /** The award, for the notification copy; null when nothing was paid. */
  award: XpAward | null;
  /** The revised problem's difficulty, so the caller can bill the Easy cap. */
  difficulty: DifficultyKey | null;
}

const nothing = (): RevisionOutcome => ({
  created: false,
  reviewed: false,
  lapsed: false,
  learned: false,
  xp: 0,
  award: null,
  difficulty: null,
});

export async function applyRevision(tx: DbTx, input: RevisionInput): Promise<RevisionOutcome> {
  const { userId, problemId, day } = input;
  if (!input.countAttempt) return nothing();

  if (input.firstSolve) {
    const first = firstSchedule();
    // createMany + skipDuplicates: a card may already exist if the student
    // solved this problem, had the solve reversed, and solved it again. The
    // older card's schedule is the one that means something.
    const made = await tx.revisionCard.createMany({
      data: [{ userId, problemId, stage: first.stage, dueOn: dayAsDate(addDays(day, first.intervalDays ?? 1)) }],
      skipDuplicates: true,
    });
    return { ...nothing(), created: made.count > 0 };
  }

  const card = await tx.revisionCard.findUnique({
    where: { userId_problemId: { userId, problemId } },
    select: { stage: true, dueOn: true, reviews: true, lapses: true, learnedAt: true },
  });
  if (!card || card.learnedAt !== null) return nothing();
  const dueOn = card.dueOn.toISOString().slice(0, 10);
  if (dueOn > day) return nothing();

  if (!input.accepted) {
    const next = scheduleAfterLapse(card.stage);
    await tx.revisionCard.update({
      where: { userId_problemId: { userId, problemId } },
      // Still due today: the student is looking at it right now, and that is
      // the cheapest moment they will ever have to fix it.
      data: { stage: next.stage, dueOn: dayAsDate(day), lapses: { increment: 1 } },
    });
    return { ...nothing(), lapsed: true };
  }

  const next = scheduleAfterReview(card.stage);
  const version = await tx.problemVersion.findUniqueOrThrow({
    where: { id: input.problemVersionId },
    select: { difficulty: true },
  });
  const difficulty = version.difficulty as DifficultyKey;
  const award = revisionAward(difficulty, input.earnedToday, input.rules);
  const inserted = await input.insertXpEvent({
    userId,
    kind: "REVISION",
    amount: award.amount,
    // One payment per problem per campus day (see XP_KEYS.revision): a
    // retried finalise computes the same key and pays nothing, and a card
    // that lapsed back down a rung can still climb it again.
    idempotencyKey: XP_KEYS.revision(userId, problemId, day),
    problemId,
    submissionId: input.submissionId,
    occurredAt: input.now,
    meta: {
      difficulty,
      fromStage: card.stage,
      toStage: next.stage,
      intervalDays: next.intervalDays,
      learned: next.learned,
      capped: award.capped,
      uncapped: award.uncapped,
      day,
      restricted: input.restricted,
    },
    rulesVersion: input.rulesVersion,
  });
  // The ladder moves only when the ledger did. If the row was already there
  // this finalise is a repeat, and a repeat must change nothing.
  if (!inserted) return nothing();

  await tx.revisionCard.update({
    where: { userId_problemId: { userId, problemId } },
    data: {
      stage: next.stage,
      dueOn: next.learned ? dayAsDate(addDays(day, REVISION_INTERVALS[next.stage]!)) : dayAsDate(addDays(day, next.intervalDays!)),
      reviews: { increment: 1 },
      lastReviewAt: input.now,
      learnedAt: next.learned ? input.now : null,
    },
  });

  return { created: false, reviewed: true, lapsed: false, learned: next.learned, xp: award.amount, award, difficulty };
}
