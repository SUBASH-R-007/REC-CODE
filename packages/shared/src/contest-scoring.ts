/**
 * Contest scoring and the standings order (Phase 5). Pure: no I/O, no clock
 * of its own — `now` is always passed in.
 *
 * Two modes, both from SPEC §5:
 *
 *   ICPC    one point per solved problem; penalty = minutes from the
 *           contest start to the accepted submission, plus 20 per REJECTED
 *           submission on a problem that is later solved. A rejected
 *           submission on a problem never solved costs nothing.
 *   SUBTASK partial credit: the best score the judge awarded per problem,
 *           summed. The subtask aggregation itself (MIN / SUM_FRACTION) is
 *           the worker's job and arrives on the submission as `score`
 *           (see SUBTASK_AGGREGATIONS in protocol.ts) — this module never
 *           re-derives it, so there is one implementation of it.
 *
 * This module is the single source of the standings ORDER, so the live board
 * (Redis) and `rebuild-standings` (Postgres) cannot disagree.
 */

export const CONTEST_KINDS = ["ICPC", "SUBTASK"] as const;
export type ContestKind = (typeof CONTEST_KINDS)[number];

/** Minutes added to the ICPC penalty for each rejected attempt before the solve. */
export const ICPC_PENALTY_MINUTES = 20;

/** Standings freeze only applies to contests at least this long. */
export const FREEZE_MIN_DURATION_MINUTES = 90;

/** The final stretch that freezes, on a contest long enough for it. */
export const FREEZE_WINDOW_MINUTES = 30;

/**
 * One participant's record on one contest problem. This mirrors
 * ContestProblemAttempt, which is authoritative (SPEC §4e): everything here
 * is derivable from it, and nothing here reads a Submission.
 */
export interface AttemptRecord {
  readonly contestProblemId: string;
  /** REJECTED submissions before the accepted one (or in total, if unsolved). */
  readonly wrongAttempts: number;
  /** Minutes from the contest start to the accepted submission; null if unsolved. */
  readonly solvedAtMinutes: number | null;
  /** SUBTASK: best score awarded. Ignored by ICPC. */
  readonly points: number;
}

export interface ScoredParticipant {
  readonly userId: string;
  /** ICPC: problems solved. SUBTASK: summed points. */
  readonly score: number;
  /** ICPC penalty in minutes. SUBTASK: 0 — penalty is not part of that order. */
  readonly penalty: number;
  /** Minutes to the last accepted submission; null if nothing was solved. */
  readonly lastAcceptedMinutes: number | null;
  readonly solved: number;
}

/** Score one participant's attempts under one contest kind. */
export function scoreParticipant(
  userId: string,
  attempts: readonly AttemptRecord[],
  kind: ContestKind,
): ScoredParticipant {
  let solved = 0;
  let penalty = 0;
  let points = 0;
  let lastAcceptedMinutes: number | null = null;

  for (const a of attempts) {
    if (a.solvedAtMinutes !== null) {
      solved++;
      // A rejected attempt only costs penalty once the problem IS solved.
      penalty += a.solvedAtMinutes + ICPC_PENALTY_MINUTES * Math.max(0, a.wrongAttempts);
      if (lastAcceptedMinutes === null || a.solvedAtMinutes > lastAcceptedMinutes) {
        lastAcceptedMinutes = a.solvedAtMinutes;
      }
    }
    points += a.points;
  }

  return kind === "ICPC"
    ? { userId, score: solved, penalty, lastAcceptedMinutes, solved }
    : { userId, score: points, penalty: 0, lastAcceptedMinutes, solved };
}

/**
 * The standings comparator. ICPC: more score first, then less penalty, then
 * the earlier last-accepted. SUBTASK: more score first, then the earlier
 * last-accepted (no penalty). `userId` breaks a complete tie so the order is
 * total and stable — two runs of `rebuild-standings` must agree byte for
 * byte, which a non-total order cannot guarantee.
 */
export function compareStandings(a: ScoredParticipant, b: ScoredParticipant, kind: ContestKind): number {
  if (a.score !== b.score) return b.score - a.score;
  if (kind === "ICPC" && a.penalty !== b.penalty) return a.penalty - b.penalty;
  const aLast = a.lastAcceptedMinutes;
  const bLast = b.lastAcceptedMinutes;
  if (aLast !== bLast) {
    if (aLast === null) return 1;
    if (bLast === null) return -1;
    return aLast - bLast;
  }
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/**
 * The value participants must share to count as tied for RANK. It excludes
 * `userId` on purpose: the comparator uses the id to make the ORDER total,
 * but two participants level on score, penalty and timing are genuinely
 * tied and must share a rank (it feeds the rating, where tying with somebody
 * must not move your rating).
 */
export function standingsTieKey(row: ScoredParticipant, kind: ContestKind): string {
  const last = row.lastAcceptedMinutes === null ? "-" : String(row.lastAcceptedMinutes);
  return kind === "ICPC" ? `${row.score}|${row.penalty}|${last}` : `${row.score}|${last}`;
}

export interface RankedParticipant extends ScoredParticipant {
  /** Competition rank: tied participants share it (1, 2, 2, 4). */
  readonly rank: number;
}

/** Order and rank a whole field. Pure, total, and stable. */
export function rankStandings(
  participants: readonly ScoredParticipant[],
  kind: ContestKind,
): RankedParticipant[] {
  const ordered = [...participants].sort((a, b) => compareStandings(a, b, kind));
  const ranked: RankedParticipant[] = [];
  let previousKey: string | null = null;
  let rank = 0;
  ordered.forEach((row, index) => {
    const key = standingsTieKey(row, kind);
    if (previousKey === null || key !== previousKey) {
      rank = index + 1;
      previousKey = key;
    }
    ranked.push({ ...row, rank });
  });
  return ranked;
}

// ── Freeze ───────────────────────────────────────────────────────────────

export interface ContestWindow {
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** 0 disables the freeze even on a long contest. */
  readonly freezeMinutes: number;
}

export function contestDurationMinutes(window: ContestWindow): number {
  return (window.endsAt.getTime() - window.startsAt.getTime()) / 60_000;
}

/**
 * May this contest freeze at all? Only contests of at least 90 minutes
 * (SPEC §5), and only with a positive freeze window that does not swallow
 * the whole contest.
 */
export function canFreeze(window: ContestWindow): boolean {
  const duration = contestDurationMinutes(window);
  return duration >= FREEZE_MIN_DURATION_MINUTES && window.freezeMinutes > 0 && window.freezeMinutes < duration;
}

/** The moment the board freezes, or null if this contest never freezes. */
export function freezeStartsAt(window: ContestWindow): Date | null {
  if (!canFreeze(window)) return null;
  return new Date(window.endsAt.getTime() - window.freezeMinutes * 60_000);
}

/**
 * Is the public board frozen at `now`? True from the freeze moment until the
 * contest ends; never before the start, and never after the end (the final
 * board is published as soon as the contest is over).
 */
export function isFrozen(window: ContestWindow, now: Date): boolean {
  const from = freezeStartsAt(window);
  if (from === null) return false;
  const t = now.getTime();
  return t >= from.getTime() && t < window.endsAt.getTime();
}

/** Minutes from the contest start, floored — the unit ICPC penalties use. */
export function minutesFromStart(window: ContestWindow, at: Date): number {
  return Math.floor((at.getTime() - window.startsAt.getTime()) / 60_000);
}

// ── Virtual contests ─────────────────────────────────────────────────────

/**
 * A virtual contest replays the original clock: the participant's own start
 * maps onto the contest's start, so penalties and the freeze behave exactly
 * as they did live. It is unrated and excluded from standings (SPEC §5), so
 * it never reaches rankStandings for the real board.
 */
export function virtualWindow(window: ContestWindow, virtualStartsAt: Date): ContestWindow {
  const duration = window.endsAt.getTime() - window.startsAt.getTime();
  return {
    startsAt: virtualStartsAt,
    endsAt: new Date(virtualStartsAt.getTime() + duration),
    freezeMinutes: window.freezeMinutes,
  };
}
