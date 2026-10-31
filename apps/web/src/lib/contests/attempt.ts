import "server-only";

import {
  applyJudgedSubmission,
  minutesFromStart,
  rankStandings,
  scoreParticipant,
  virtualWindow,
  type AttemptRecord,
  type ContestWindow,
  type Verdict,
} from "@recx/shared";
import type { Db, DbTx } from "@recx/db";

/**
 * What a judged contest submission writes (Phase 5).
 *
 * Called from the judge-finalise transaction, under the same per-user
 * advisory lock as the XP ledger, so a verdict and its board position commit
 * together (SPEC §4, "the judge-finalise transaction").
 *
 * Two things this must NOT do, both from SPEC §4e and §7:
 *   - renumber ContestStanding.rank. Rank is one job every 15 s; 5,000
 *     renumberings a minute is a deadlock generator. This writes the
 *     student's own row and leaves `rank` alone.
 *   - recompute the whole board. It re-reads only this student's attempts
 *     (at most one row per contest problem), so the work is bounded by the
 *     problem count, not by the field size.
 *
 * The decision of what changes is pure and unit-tested in @recx/shared
 * (contest-attempt.ts); this module only reads, writes and locks.
 */

type Client = Db | DbTx;

export interface ContestSubmissionResult {
  readonly submissionId: string;
  readonly userId: string;
  readonly contestId: string;
  readonly problemVersionId: string;
  readonly verdict: Verdict;
  /** The judge's score, for SUBTASK scoring. */
  readonly score: number;
  /** When the submission was made — NOT when it was judged. */
  readonly submittedAt: Date;
}

export type ContestApplyOutcome =
  | { applied: true; solved: boolean }
  /** The submission is not part of a live rated/unrated run of this contest. */
  | { applied: false; reason: "no-contest" | "no-problem" | "not-registered" | "outside-window" };

/**
 * The window this submission is scored against: the contest's own, or the
 * student's replayed clock for a virtual run (SPEC §5 — a virtual contest
 * replays against the original clock).
 */
function windowFor(
  contest: { startsAt: Date; endsAt: Date; freezeMinutes: number },
  virtualStartsAt: Date | null,
): ContestWindow {
  const live: ContestWindow = {
    startsAt: contest.startsAt,
    endsAt: contest.endsAt,
    freezeMinutes: contest.freezeMinutes,
  };
  return virtualStartsAt ? virtualWindow(live, virtualStartsAt) : live;
}

export async function applyContestSubmission(
  tx: Client,
  input: ContestSubmissionResult,
): Promise<ContestApplyOutcome> {
  const contest = await tx.contest.findUnique({
    where: { id: input.contestId },
    select: { id: true, kind: true, startsAt: true, endsAt: true, freezeMinutes: true },
  });
  if (!contest) return { applied: false, reason: "no-contest" };

  const problem = await tx.contestProblem.findUnique({
    where: { contestId_problemVersionId: { contestId: contest.id, problemVersionId: input.problemVersionId } },
    select: { id: true },
  });
  if (!problem) return { applied: false, reason: "no-problem" };

  // A submission only scores for a run the student actually entered. A
  // VIRTUAL run is scored on its own clock and is excluded from the live
  // board by the standings reader, not here.
  const registrations = await tx.contestRegistration.findMany({
    where: { contestId: contest.id, userId: input.userId },
    select: { kind: true, virtualStartsAt: true },
  });
  if (registrations.length === 0) return { applied: false, reason: "not-registered" };
  const live = registrations.find((r) => r.kind === "RATED" || r.kind === "UNRATED");
  const virtual = registrations.find((r) => r.kind === "VIRTUAL");
  const entry = live ?? virtual;
  if (!entry) return { applied: false, reason: "not-registered" };

  const window = windowFor(contest, entry.virtualStartsAt ?? null);
  const submittedMs = input.submittedAt.getTime();
  if (submittedMs < window.startsAt.getTime() || submittedMs >= window.endsAt.getTime()) {
    // Judged after the clock ran out is fine; SUBMITTED outside it is not.
    return { applied: false, reason: "outside-window" };
  }

  const key = { contestId: contest.id, userId: input.userId, contestProblemId: problem.id };
  const existing = await tx.contestProblemAttempt.findUnique({
    where: { contestId_userId_contestProblemId: key },
    select: { wrongAttempts: true, points: true, solvedAtMinutes: true },
  });

  const change = applyJudgedSubmission(
    contest.kind,
    existing ?? { wrongAttempts: 0, points: 0, solvedAtMinutes: null },
    {
      verdict: input.verdict,
      minutesFromStart: minutesFromStart(window, input.submittedAt),
      score: input.score,
      submissionId: input.submissionId,
    },
  );

  await tx.contestProblemAttempt.upsert({
    where: { contestId_userId_contestProblemId: key },
    create: {
      ...key,
      wrongAttempts: change.wrongAttemptsDelta,
      points: change.points ?? 0,
      ...(change.solve
        ? {
            solvedAt: input.submittedAt,
            solvedAtMinutes: change.solve.solvedAtMinutes,
            penaltyMinutes: change.solve.penaltyMinutes,
            bestSubmissionId: change.solve.bestSubmissionId,
          }
        : change.bestSubmissionId
          ? { bestSubmissionId: change.bestSubmissionId }
          : {}),
    },
    update: {
      // Counters by increment, never by read-then-write.
      ...(change.wrongAttemptsDelta > 0 ? { wrongAttempts: { increment: change.wrongAttemptsDelta } } : {}),
      ...(change.points !== undefined ? { points: change.points } : {}),
      ...(change.solve
        ? {
            solvedAt: input.submittedAt,
            solvedAtMinutes: change.solve.solvedAtMinutes,
            penaltyMinutes: change.solve.penaltyMinutes,
            bestSubmissionId: change.solve.bestSubmissionId,
          }
        : change.bestSubmissionId
          ? { bestSubmissionId: change.bestSubmissionId }
          : {}),
    },
  });

  // This student's own row only. `rank` is deliberately untouched.
  await refreshOwnStanding(tx, contest.id, contest.kind, input.userId);
  return { applied: true, solved: change.solve !== undefined };
}

/**
 * Rescore one student's standing row from their own attempts. Bounded by the
 * contest's problem count. Leaves `rank` to the rank job.
 */
export async function refreshOwnStanding(
  tx: Client,
  contestId: string,
  kind: "ICPC" | "SUBTASK",
  userId: string,
): Promise<void> {
  const attempts = await tx.contestProblemAttempt.findMany({
    where: { contestId, userId },
    select: {
      contestProblemId: true,
      wrongAttempts: true,
      points: true,
      solvedAt: true,
      solvedAtMinutes: true,
    },
    orderBy: { contestProblemId: "asc" },
  });

  const records: AttemptRecord[] = attempts.map((a) => ({
    contestProblemId: a.contestProblemId,
    wrongAttempts: a.wrongAttempts,
    solvedAtMinutes: a.solvedAtMinutes,
    points: a.points,
  }));
  const scored = scoreParticipant(userId, records, kind);
  const lastAcceptedAt = attempts.reduce<Date | null>(
    (latest, a) => (a.solvedAt && (latest === null || a.solvedAt > latest) ? a.solvedAt : latest),
    null,
  );

  await tx.contestStanding.upsert({
    where: { contestId_userId: { contestId, userId } },
    create: {
      contestId,
      userId,
      score: scored.score,
      penalty: scored.penalty,
      solved: scored.solved,
      lastAcceptedAt,
    },
    update: {
      score: scored.score,
      penalty: scored.penalty,
      solved: scored.solved,
      lastAcceptedAt,
      version: { increment: 1 },
    },
  });
}

/**
 * The rank job: ONE pass over a contest's board, every 15 s. Ranks are
 * competition ranks, so tied participants share one — which matters because
 * the rank feeds the rating, where tying with somebody must not move your
 * rating.
 */
export async function reRankContest(tx: Client, contestId: string): Promise<number> {
  const contest = await tx.contest.findUnique({ where: { id: contestId }, select: { kind: true } });
  if (!contest) return 0;

  const rows = await tx.contestStanding.findMany({
    where: { contestId },
    select: { userId: true, score: true, penalty: true, solved: true, lastAcceptedAt: true, rank: true },
  });
  if (rows.length === 0) return 0;

  const ranked = rankStandings(
    rows.map((r) => ({
      userId: r.userId,
      score: r.score,
      penalty: r.penalty,
      solved: r.solved,
      lastAcceptedMinutes: r.lastAcceptedAt ? r.lastAcceptedAt.getTime() : null,
    })),
    contest.kind,
  );

  const current = new Map(rows.map((r) => [r.userId, r.rank]));
  let changed = 0;
  for (const row of ranked) {
    if (current.get(row.userId) === row.rank) continue;
    await tx.contestStanding.update({
      where: { contestId_userId: { contestId, userId: row.userId } },
      data: { rank: row.rank },
    });
    changed++;
  }
  if (changed > 0) {
    await tx.contest.update({ where: { id: contestId }, data: { standingsVersion: { increment: 1 } } });
  }
  return changed;
}
