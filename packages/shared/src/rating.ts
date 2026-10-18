/**
 * Contest rating (Phase 5). Pure: no I/O, no clock, no randomness, so the
 * same participants always produce the same deltas and a disputed rating can
 * be recomputed years later from the stored seed.
 *
 * The formula is the one the specification fixes, not "Elo-like":
 *
 *   seed_i  = 1 + Σ_{j≠i} 1 / (1 + 10^((R_i − R_j)/400))
 *   m_i     = sqrt(seed_i × actualRank_i)
 *   R'_i    = the rating whose seed equals m_i, by 25-iteration binary
 *             search on [0, 4000]
 *   delta_i = (R'_i − R_i) / 2
 *
 * then two corrections, in this order, and finally the clamp:
 *
 *   1. subtract Σdelta/n from everyone (the field sums to zero);
 *   2. shift the top min(n, round(4·√n)) by PRE-CONTEST rating so their
 *      delta sum is ≤ 0 (rating cannot be inflated at the top);
 *   3. clamp |delta_i| ≤ 200.
 *
 * `seed` is returned per participant because every RatingChange row stores
 * it: it is what makes a dispute reconstructable (SPEC §5, Phase 5).
 *
 * Ranks are competition ranks (1, 2, 2, 4): tied participants must share a
 * rank, or tying with someone would change your rating.
 */

/** A new account's rating. */
export const RATING_SEED = 1200;

/** Below this many rated participants a contest is unrated. */
export const MIN_RATED_PARTICIPANTS = 30;

/** No single contest may move a rating by more than this. */
export const RATING_CLAMP = 200;

/** A rating is provisional until this many rated contests are behind it. */
export const PROVISIONAL_CONTESTS = 5;

/** Binary-search bounds and iteration count for the seed inversion. */
const SEARCH_LO = 0;
const SEARCH_HI = 4000;
const SEARCH_ITERATIONS = 25;

export interface RatingParticipant {
  readonly userId: string;
  /** Rating before this contest (RATING_SEED for a first contest). */
  readonly rating: number;
  /** Competition rank, 1-based; tied participants share a rank. */
  readonly rank: number;
}

export interface RatingResult {
  readonly userId: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
  readonly rank: number;
  /** The expected rank this rating field gave them. Stored on RatingChange. */
  readonly seed: number;
}

export const DIVISIONS = ["DIV3", "DIV2", "DIV1"] as const;
export type Division = (typeof DIVISIONS)[number];

/** Div 3 below 1400, Div 2 1400–1799, Div 1 from 1800. */
export function divisionOf(rating: number): Division {
  if (rating < 1400) return "DIV3";
  if (rating < 1800) return "DIV2";
  return "DIV1";
}

export function isProvisional(contestsRated: number): boolean {
  return contestsRated < PROVISIONAL_CONTESTS;
}

/** The chance a rating of `a` finishes above one of `b`. */
function winProbability(a: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

/**
 * Expected rank of `rating` against `others`: 1 plus the chance each other
 * participant beats it. `others` is every participant's pre-contest rating
 * EXCLUDING the one being seeded.
 */
export function seedOf(rating: number, others: readonly number[]): number {
  let seed = 1;
  for (const other of others) seed += winProbability(other, rating);
  return seed;
}

/**
 * The rating whose seed against `others` equals `target`, by binary search.
 * seed() falls as rating rises, so the search goes left when the seed at the
 * midpoint is still above the target.
 */
function invertSeed(target: number, others: readonly number[]): number {
  let lo = SEARCH_LO;
  let hi = SEARCH_HI;
  for (let i = 0; i < SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (seedOf(mid, others) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Every participant's rating change for one contest.
 *
 * Returns results in the input order. Throws on a malformed field rather
 * than guessing: a wrong rating is worse than a refused computation, and
 * the caller (one transaction per contest) can abort cleanly.
 */
export function computeRatingChanges(participants: readonly RatingParticipant[]): RatingResult[] {
  const n = participants.length;
  if (n === 0) return [];
  for (const p of participants) {
    if (!Number.isFinite(p.rating)) throw new Error(`rating of ${p.userId} is not a finite number`);
    if (!Number.isInteger(p.rank) || p.rank < 1) throw new Error(`rank of ${p.userId} must be a positive integer`);
  }
  if (new Set(participants.map((p) => p.userId)).size !== n) {
    throw new Error("a participant appears more than once");
  }

  const ratings = participants.map((p) => p.rating);

  // 1. seed, target rank, inverted rating, half the difference.
  const seeds = participants.map((p, i) => seedOf(p.rating, ratings.filter((_, j) => j !== i)));
  const deltas = participants.map((p, i) => {
    const target = Math.sqrt(seeds[i]! * p.rank);
    const wanted = invertSeed(target, ratings.filter((_, j) => j !== i));
    return (wanted - p.rating) / 2;
  });

  // 2. the whole field sums to zero.
  const sum = deltas.reduce((a, b) => a + b, 0);
  const levelled = deltas.map((d) => d - sum / n);

  // 3. the top set by PRE-CONTEST rating may not gain overall: take the
  //    strongest min(n, round(4·√n)) and, if their deltas sum above zero,
  //    take that excess off them.
  //
  //    Taking it off and discarding it would undo step 2 — the field would
  //    no longer sum to zero, which is the invariant the gate asserts. So
  //    the excess is REDISTRIBUTED to the rest of the field instead of
  //    destroyed: the top set ends at exactly 0 (≤ 0 as required) and the
  //    total stays 0. Recorded in docs/OPEN-QUESTIONS.md, because the
  //    reference implementation instead applies a bounded negative
  //    increment to everyone and is deliberately deflationary.
  //
  //    For n ≤ 16, round(4·√n) ≥ n, so the whole field is the "top set":
  //    there is nobody to redistribute to, and the excess is simply removed.
  const topSize = Math.min(n, Math.round(4 * Math.sqrt(n)));
  const byRatingDesc = levelled
    .map((_, i) => i)
    .sort((a, b) => ratings[b]! - ratings[a]! || a - b);
  const top = byRatingDesc.slice(0, topSize);
  const rest = byRatingDesc.slice(topSize);
  const topSum = top.reduce((acc, i) => acc + levelled[i]!, 0);
  const corrected = [...levelled];
  if (topSize > 0 && topSum > 0) {
    const share = topSum / topSize;
    for (const i of top) corrected[i] = corrected[i]! - share;
    if (rest.length > 0) {
      const back = topSum / rest.length;
      for (const i of rest) corrected[i] = corrected[i]! + back;
    }
  }

  // 4. clamp, then round. Rounding last keeps `after` an integer and the
  //    delta exactly `after - before`, so the two can never disagree.
  return participants.map((p, i) => {
    const clamped = Math.max(-RATING_CLAMP, Math.min(RATING_CLAMP, corrected[i]!));
    const after = Math.round(p.rating + clamped);
    return {
      userId: p.userId,
      before: p.rating,
      after,
      delta: after - p.rating,
      rank: p.rank,
      seed: seeds[i]!,
    };
  });
}

/**
 * Competition ranks (1, 2, 2, 4) for an already-ordered standings list.
 * `key` returns the value participants tie on; equal keys share a rank.
 */
export function competitionRanks<T>(ordered: readonly T[], key: (row: T) => string): number[] {
  const ranks: number[] = [];
  let previous: string | null = null;
  let rank = 0;
  ordered.forEach((row, index) => {
    const k = key(row);
    if (previous === null || k !== previous) {
      rank = index + 1;
      previous = k;
    }
    ranks.push(rank);
  });
  return ranks;
}
