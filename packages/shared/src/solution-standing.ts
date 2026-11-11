/**
 * Where one accepted solution stands among the others (Phase 17).
 *
 * The companion to `complexity.ts`: that module says how a submission grew,
 * this one says how it compares. Both answer the same question a student
 * asks after an Accepted — "is this good?" — and neither can answer it from
 * the submission alone.
 *
 * Four rules shape everything here, and each one is a decision rather than
 * arithmetic:
 *
 *   1. **One value per student, not per submission.** A student who submits
 *      the same solution forty times while tuning it would otherwise be
 *      forty of the population, and the distribution would describe their
 *      afternoon rather than the cohort. The caller reduces to each
 *      student's own best.
 *   2. **Within one language.** Comparing a Python solution's milliseconds
 *      to a C++ solution's ranks the language, not the solution, and the
 *      student cannot act on it. A separate population per language is the
 *      only comparison that means anything.
 *   3. **Within one revision.** A problem's tests and limits are frozen per
 *      revision and change between them, so a time measured against
 *      revision 2 is not a time measured against revision 3.
 *   4. **Normalised for the host.** PRACTICE work is not restricted to a
 *      calibrated fleet the way an assessment is, so two accepted solutions
 *      can differ by a third because one was judged on a slower node. Every
 *      submission already stores the calibration of the node that judged it
 *      precisely so that a timing comparison is auditable; the caller
 *      multiplies by it, which puts every peer on one scale.
 *
 * And one refusal: below `MIN_RANKED_PEERS` there is no ranking. A
 * percentile against six people is a league table with the names removed —
 * it is both statistically empty and, on a problem six students have
 * solved, close to naming them. Pure: no I/O, no ambient clock.
 */

import { COMPLEXITY_CLASSES, type ComplexityClass } from "./complexity";
import { percentileRank } from "./percentile";

/**
 * The smallest number of other students' solutions a position is quoted
 * against.
 *
 * Twenty, which is lower than `MIN_PERCENTILE_COHORT` (30) on purpose and
 * for a different reason. That threshold guards a student's own readiness
 * percentile, where the figure is about a person and a small cohort makes it
 * identifiable. This one guards a figure about a piece of code: no name, no
 * profile and nothing that follows the student anywhere. What it has to
 * carry is only that the number means something, and twenty peers put each
 * rank about five points apart — coarse, but not noise.
 */
export const MIN_RANKED_PEERS = 20;

/** How many bars the distribution is drawn as. */
export const STANDING_BANDS = 10;

export interface StandingBand {
  /** Lower edge of the band, in the metric's own unit. */
  readonly from: number;
  /** Upper edge of the band. */
  readonly to: number;
  readonly count: number;
  /** True for the one band this submission falls in. */
  readonly mine: boolean;
}

export interface MetricStanding {
  /** This submission's own reading, in the metric's unit. */
  readonly mine: number;
  /**
   * The share of the population this submission beats, 0–1. Mid-rank, so a
   * tie sits in the middle of the band it occupies rather than at one end.
   */
  readonly betterThan: number;
  /** The whole population, which includes this submission. */
  readonly population: number;
  /** The best and the middle of the population, for scale. */
  readonly best: number;
  readonly median: number;
  readonly bands: readonly StandingBand[];
}

export interface GrowthShare {
  readonly growth: ComplexityClass;
  readonly count: number;
  /** Share of the peers whose growth was measured, 0–1. */
  readonly share: number;
  readonly mine: boolean;
}

export type StandingRefusal = "TOO_FEW_PEERS";

export interface SolutionStanding {
  readonly ranked: true;
  /** Other students counted, excluding this submission's author. */
  readonly peers: number;
  readonly time: MetricStanding;
  readonly space: MetricStanding;
  /**
   * How the peers' measured growth is spread, ascending the ladder. Null
   * when no peer's growth could be measured at all, which is a different
   * statement from "they are all the same".
   */
  readonly growth: readonly GrowthShare[] | null;
  /** Peers whose growth could not be measured, so the shares are readable. */
  readonly growthUnmeasured: number;
}

export interface StandingUnranked {
  readonly ranked: false;
  readonly reason: StandingRefusal;
  readonly peers: number;
}

export type StandingOutcome = SolutionStanding | StandingUnranked;

/** One other student's best accepted solution, already host-normalised. */
export interface PeerSolution {
  /** CPU ms on this submission's own node — see rule 4 in the header. */
  readonly ms: number;
  readonly kb: number;
  readonly growth: ComplexityClass | null;
}

export interface StandingInput {
  readonly mine: { readonly ms: number; readonly kb: number; readonly growth: ComplexityClass | null };
  readonly peers: readonly PeerSolution[];
}

/**
 * The bands of a log-scale histogram, and which one holds `mine`.
 *
 * Log scale because accepted times are heavy-tailed: on any problem worth
 * setting, the slowest accepted solution is often twenty times the fastest,
 * and ten linear bands would put every solution in the first one and draw a
 * chart that says nothing. A reading below one is clamped to one before the
 * logarithm — one millisecond and one kilobyte are the judge's own
 * resolution, so nothing is lost that was ever measured.
 */
export function standingBands(values: readonly number[], mine: number): StandingBand[] {
  const safe = values.map((v) => Math.max(1, v));
  const low = Math.min(...safe);
  const high = Math.max(...safe);
  const mineSafe = Math.max(1, mine);
  if (!(high > low)) {
    return [{ from: low, to: high, count: safe.length, mine: true }];
  }
  const logLow = Math.log10(low);
  const logHigh = Math.log10(high);
  const width = (logHigh - logLow) / STANDING_BANDS;
  const counts = new Array<number>(STANDING_BANDS).fill(0);
  const bandOf = (value: number): number =>
    Math.min(STANDING_BANDS - 1, Math.max(0, Math.floor((Math.log10(value) - logLow) / width)));
  for (const v of safe) {
    const band = bandOf(v);
    counts[band] = (counts[band] ?? 0) + 1;
  }
  const mineBand = bandOf(mineSafe);
  return counts.map((count, k) => ({
    from: Math.round(10 ** (logLow + k * width)),
    to: Math.round(10 ** (logLow + (k + 1) * width)),
    count,
    mine: k === mineBand,
  }));
}

function metricStanding(mine: number, peerValues: readonly number[]): MetricStanding {
  const population = [...peerValues, mine];
  const sorted = [...population].sort((a, b) => a - b);
  const half = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1 ? sorted[half]! : ((sorted[half - 1] ?? 0) + (sorted[half] ?? 0)) / 2;
  return {
    mine,
    // Lower is better for both metrics, so the share beaten is the share
    // that is NOT at or below this reading.
    betterThan: 1 - percentileRank(mine, population),
    population: population.length,
    best: sorted[0] ?? mine,
    median,
    bands: standingBands(population, mine),
  };
}

/**
 * The growth classes of the peers, ascending the ladder, with this
 * submission's own class marked.
 *
 * A class nobody reached is left out, except this submission's own: a
 * student who wrote the only quadratic solution on the problem should see
 * that, and a chart that silently omitted their row would be answering a
 * different question.
 */
export function growthShares(peers: readonly PeerSolution[], mine: ComplexityClass | null): GrowthShare[] {
  const measured = peers.filter((p) => p.growth !== null);
  const counts = new Map<ComplexityClass, number>();
  for (const p of measured) counts.set(p.growth!, (counts.get(p.growth!) ?? 0) + 1);
  const shares: GrowthShare[] = [];
  for (const growth of COMPLEXITY_CLASSES) {
    const count = counts.get(growth) ?? 0;
    if (count === 0 && growth !== mine) continue;
    shares.push({
      growth,
      count,
      share: measured.length === 0 ? 0 : count / measured.length,
      mine: growth === mine,
    });
  }
  return shares;
}

/** Where this submission sits, or why it is not placed. */
export function rankSolution(input: StandingInput): StandingOutcome {
  const peers = input.peers.length;
  if (peers < MIN_RANKED_PEERS) return { ranked: false, reason: "TOO_FEW_PEERS", peers };
  const measured = input.peers.filter((p) => p.growth !== null).length;
  return {
    ranked: true,
    peers,
    time: metricStanding(input.mine.ms, input.peers.map((p) => p.ms)),
    space: metricStanding(input.mine.kb, input.peers.map((p) => p.kb)),
    growth: measured === 0 ? null : growthShares(input.peers, input.mine.growth),
    growthUnmeasured: peers - measured,
  };
}

/**
 * "Faster than 78% of the 142 accepted C++ solutions here."
 *
 * Never 100%: with the mid-rank definition the fastest solution in a
 * population of 500 computes to 99.9%, and rounding that up would tell a
 * student they are faster than a population they are a member of. The best
 * reading this sentence can carry is 99%.
 */
export function standingSentence(standing: MetricStanding, verb: string, languageLabel: string): string {
  const percent = Math.min(99, Math.round(standing.betterThan * 100));
  return `${verb} than ${percent}% of the ${standing.population} accepted ${languageLabel} solutions here.`;
}

/** What a student reads instead of a position. */
export const STANDING_REFUSAL_SENTENCE: Readonly<Record<StandingRefusal, string>> = Object.freeze({
  TOO_FEW_PEERS: `Fewer than ${MIN_RANKED_PEERS} other students have an accepted solution to this revision in this language, so there is nothing here to rank against yet.`,
});
