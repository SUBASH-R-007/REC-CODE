/**
 * Percentile ranks within a cohort (Phase 9).
 *
 * Three of readiness's components are percentiles — aptitude, verbal and
 * contest rating — and a percentile is a claim about a student RELATIVE to
 * their peers. That makes two things matter more than the arithmetic:
 *
 *   1. **How many peers.** A percentile against eleven people is not a
 *      percentile, it is a ranking with the names filed off. Below
 *      `MIN_PERCENTILE_COHORT` the component is MISSING with
 *      `COHORT_TOO_SMALL` rather than computed — both because the number
 *      would be meaningless and because in a cohort of eleven, "you are at
 *      the 9th percentile" identifies you to anyone who can count.
 *   2. **Which peers.** The cohort is the batch, not the whole college: a
 *      second-year ranked against final-years would read as hopeless for
 *      reasons that have nothing to do with their preparation.
 *
 * Pure: no I/O, no ambient clock.
 */

/**
 * The smallest cohort a percentile may be computed in.
 *
 * Thirty is the number at which a percentile stops being a disguised
 * ranking: the gap between adjacent ranks is about three points, so no
 * single student's position is recoverable from the figure alone, and the
 * distribution is wide enough that the middle means something.
 */
export const MIN_PERCENTILE_COHORT = 30;

/**
 * Where `value` sits in `population`, as 0–1.
 *
 * The definition is the **mid-rank** one: the fraction of the population
 * strictly below, plus half the fraction equal. That matters because ties
 * are common here — a cohort where sixty students have never entered a rated
 * contest all share one rating, and with the naive "fraction below"
 * definition every one of them would read 0 while a single student one point
 * above them read 0.6. Mid-rank puts the tied group in the middle of the
 * band it actually occupies.
 *
 * `population` must include `value` itself; the caller passes the whole
 * cohort's values and the student's own among them.
 */
export function percentileRank(value: number, population: readonly number[]): number {
  if (population.length === 0) return 0;
  let below = 0;
  let equal = 0;
  for (const other of population) {
    if (other < value) below += 1;
    else if (other === other && other === value) equal += 1;
  }
  const rank = (below + equal / 2) / population.length;
  // The + 0 kills -0, which would render as "-0%" in a component table.
  return Math.min(1, Math.max(0, rank)) + 0;
}

/**
 * A sorted copy of the population, for repeated lookups.
 *
 * The nightly job ranks every student in a cohort against the same
 * population, so it sorts once and binary-searches rather than scanning the
 * cohort per student — 5,000 students against a 1,200-strong batch is six
 * million comparisons the naive way and a few thousand this way.
 */
export function sortedPopulation(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** `percentileRank` over an already-sorted population. Same definition. */
export function percentileRankSorted(value: number, sorted: readonly number[]): number {
  if (sorted.length === 0) return 0;
  const below = lowerBound(sorted, value);
  const upper = upperBound(sorted, value);
  const equal = upper - below;
  const rank = (below + equal / 2) / sorted.length;
  return Math.min(1, Math.max(0, rank)) + 0;
}

/** First index whose value is >= `value`. */
function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid]! < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** First index whose value is > `value`. */
function upperBound(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid]! <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The cohort a student is ranked in.
 *
 * The batch year, as a string, because that is the group that sits the same
 * placement season. Department is deliberately NOT part of it: a cohort of
 * one department's final years can be under thirty at a small college, and
 * "too small to rank" would then be the answer for a whole department rather
 * than a real limit. Batch is the biggest group for which the comparison is
 * still fair.
 */
export function cohortKeyFor(batchYear: number | null): string {
  return batchYear === null ? "UNKNOWN" : String(batchYear);
}

/** How many distinct buckets a histogram of a cohort uses. */
export const HISTOGRAM_BUCKETS = 10;

/**
 * A frozen distribution, so a percentile can be re-derived years later
 * rather than recomputed against a cohort that has since graduated.
 *
 * Counts per decile, which is enough to place a value to within a decile and
 * small enough to store per cohort per night. The raw values are NOT frozen:
 * a stored list of every student's rating is a stored list of every student's
 * rating, and the distribution is all a re-derivation needs.
 */
export function histogram(values: readonly number[], min: number, max: number): number[] {
  const buckets = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
  if (max <= min) {
    buckets[0] = values.length;
    return buckets;
  }
  for (const value of values) {
    const scaled = ((value - min) / (max - min)) * HISTOGRAM_BUCKETS;
    const index = Math.min(HISTOGRAM_BUCKETS - 1, Math.max(0, Math.floor(scaled)));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  return buckets;
}
