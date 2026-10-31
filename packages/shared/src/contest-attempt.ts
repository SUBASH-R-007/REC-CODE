/**
 * What one judged contest submission does to its attempt row (Phase 5).
 * Pure, so the rule is unit-tested and the database write is mechanical.
 *
 * SPEC §5 and §4e: ContestProblemAttempt is authoritative, so this decides
 * exactly what changes on it. The ICPC rule is "a 20-minute penalty per
 * rejected submission on a later-solved problem", which means the count of
 * rejected attempts is kept whether or not the problem is ever solved, and
 * only turns into penalty once it is.
 */
import { ICPC_PENALTY_MINUTES, type ContestKind } from "./contest-scoring";
import type { Verdict } from "./verdict";

/**
 * Verdicts that do NOT count as a rejected attempt:
 *
 *   AC       the solve itself;
 *   IE       our failure, not the student's — SPEC §4 excludes an
 *            INTERNAL_ERROR from scoring entirely, so it must never cost a
 *            student 20 minutes;
 *   SKIPPED  not a whole-submission verdict (a test skipped behind a failed
 *            dependency), kept here so the list is exhaustive.
 *
 * Everything else is a rejected submission, CE included: a compile error is
 * a submission the judge rejected, and the narrower reading of "per rejected
 * submission" counts it (docs/OPEN-QUESTIONS.md).
 */
const NOT_A_REJECTION: readonly Verdict[] = ["AC", "IE", "SKIPPED"];

export function isRejectedAttempt(verdict: Verdict): boolean {
  return !NOT_A_REJECTION.includes(verdict);
}

/**
 * Verdicts whose score means something. In subtask scoring a WA, TLE or RE
 * overall can still have earned subtask points, so almost everything counts
 * — but an IE carries no verdict the student produced, and a SKIPPED test
 * ran nothing, so their scores are noise and must never raise the best.
 */
const NO_MEANINGFUL_SCORE: readonly Verdict[] = ["IE", "SKIPPED"];

export function carriesScore(verdict: Verdict): boolean {
  return !NO_MEANINGFUL_SCORE.includes(verdict);
}

/** The attempt row as it stands before this submission is applied. */
export interface AttemptState {
  readonly wrongAttempts: number;
  readonly points: number;
  /** Null while unsolved. Once set, the solve is final (first AC wins). */
  readonly solvedAtMinutes: number | null;
}

export interface JudgedContestSubmission {
  readonly verdict: Verdict;
  /** Minutes from the contest start (this student's start, if virtual). */
  readonly minutesFromStart: number;
  /** The judge's score for this submission. SUBTASK only. */
  readonly score: number;
  readonly submissionId: string;
}

/**
 * The fields to write. `undefined` means "leave it alone", which keeps the
 * caller's update minimal and lets counters use { increment }.
 */
export interface AttemptChange {
  /** Increment for wrongAttempts; 0 means no change. */
  readonly wrongAttemptsDelta: number;
  /** Set only on the submission that solves the problem. */
  readonly solve?: {
    readonly solvedAtMinutes: number;
    readonly penaltyMinutes: number;
    readonly bestSubmissionId: string;
  };
  /** SUBTASK: the new best score, when this submission beat it. */
  readonly points?: number;
  /** SUBTASK: the submission that holds the best score. */
  readonly bestSubmissionId?: string;
}

/**
 * Apply one judged submission to an attempt.
 *
 *   ICPC     the FIRST accepted submission solves the problem, and its
 *            penalty is its minute plus 20 per rejection recorded before it.
 *            A later submission on a solved problem changes nothing — it
 *            cannot un-solve it, and it must not add penalty.
 *   SUBTASK  partial credit: the best score wins, and the submission that
 *            set it is remembered. An accepted submission also marks the
 *            solve, so the board can show solved counts.
 */
export function applyJudgedSubmission(
  kind: ContestKind,
  state: AttemptState,
  judged: JudgedContestSubmission,
): AttemptChange {
  const alreadySolved = state.solvedAtMinutes !== null;
  const rejected = isRejectedAttempt(judged.verdict);

  // A rejection on an already-solved problem is recorded but never
  // penalised: the solve's penalty was fixed when it happened.
  const wrongAttemptsDelta = rejected && !alreadySolved ? 1 : 0;

  if (kind === "SUBTASK") {
    const beatsBest = carriesScore(judged.verdict) && judged.score > state.points;
    const change: AttemptChange = {
      wrongAttemptsDelta,
      ...(beatsBest ? { points: judged.score, bestSubmissionId: judged.submissionId } : {}),
      ...(judged.verdict === "AC" && !alreadySolved
        ? {
            solve: {
              solvedAtMinutes: judged.minutesFromStart,
              // SUBTASK ordering ignores penalty; keep it 0 so the column
              // never implies a penalty the board does not use.
              penaltyMinutes: 0,
              bestSubmissionId: judged.submissionId,
            },
          }
        : {}),
    };
    return change;
  }

  if (judged.verdict === "AC" && !alreadySolved) {
    return {
      wrongAttemptsDelta: 0,
      solve: {
        solvedAtMinutes: judged.minutesFromStart,
        penaltyMinutes: judged.minutesFromStart + ICPC_PENALTY_MINUTES * state.wrongAttempts,
        bestSubmissionId: judged.submissionId,
      },
    };
  }

  return { wrongAttemptsDelta };
}
