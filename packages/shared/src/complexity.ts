import { z } from "zod";

/**
 * How a submission's time and memory GREW across the tests it ran (Phase 17).
 *
 * A student asks "what is the complexity of my solution?" and there is no
 * honest way to answer it from the source: deciding the running time of an
 * arbitrary program is the halting problem wearing a hat, and a parser that
 * counted nested `for` loops would be confidently wrong about memoisation,
 * early exits, library sorts and recursion. So this does not read the code.
 *
 * It reads what actually happened. Every submission already carries one
 * measurement per test case — CPU milliseconds and peak kilobytes — and the
 * cases of a problem come in different sizes. That is a scatter plot, and a
 * scatter plot can be fitted. The answer this module gives is therefore a
 * **measurement with a confidence**, never a proof, and the vocabulary is
 * chosen to keep that visible: an estimate is `fitted`, a class is what the
 * data is *consistent with*, and when the data cannot carry a claim the
 * answer is a refusal with a reason rather than a guess.
 *
 * ## The method
 *
 * Each candidate class is a curve `y = a · f(n) + c`, where `f` is the
 * class's own shape and `n` is the case's input size in bytes. Both unknowns
 * are linear in the parameters, so each candidate is one closed-form
 * two-parameter least-squares fit — no iteration, no local minima, no seed.
 * The candidate with the smallest residual wins. Every candidate has the
 * same two parameters, so comparing residuals directly is fair and needs no
 * AIC-style penalty.
 *
 * `c` is not a nuisance term; it is the whole reason this works at all. A
 * Python process spends 20–30 ms starting before the student's first
 * statement runs, and a C++ process reports ~2 MB of peak memory before
 * `main`. That constant floor is what makes a naive log–log regression read
 * every fast solution as sub-linear. Here it is a fitted parameter and the
 * growth term is measured on top of it.
 *
 * ## What it refuses, and why that matters more than what it reports
 *
 * Three gates run before any fitting, and each one exists because the
 * alternative is a confident wrong answer in a student's face:
 *
 *   * **Fewer than `MIN_FIT_POINTS` distinct sizes.** Six curves through
 *     four points is numerology.
 *   * **A size span under `MIN_SIZE_RATIO`.** Over a 1.5× range every curve
 *     in the ladder is a straight line, and whichever wins wins on noise.
 *     This gate also does a second job worth stating: it excludes, almost
 *     for free, the one problem shape where the byte-size x-axis is a lie.
 *     When the input is a single number — "compute f(n)" — the input bytes
 *     are log n rather than n, so a linear-time solution would be read as
 *     exponential. But a single integer written out cannot span 8× in bytes
 *     without reaching 10^15, so those problems refuse on this gate instead
 *     of being misreported on it. For every problem whose input is a list,
 *     a grid or a graph, bytes are proportional to the size of the thing
 *     and the class carries over.
 *   * **A rise under the metric's `minSpan`.** The judge reports whole
 *     milliseconds and page-quantised kilobytes. A curve whose entire rise
 *     is a handful of those is noise with a line drawn through it, and the
 *     refusal says so rather than calling it constant — because "we cannot
 *     see any growth" and "this solution is O(1)" are different statements
 *     and only the first one is true. That is also why there is no CONSTANT
 *     class in the ladder.
 *
 * After fitting, two more things can refuse: a best fit whose R² is below
 * `MIN_R_SQUARED` (nothing in the ladder describes this curve), and a curve
 * that only fits by claiming the solution gets *faster* as its input grows,
 * which no candidate is allowed to do (`a` must be positive).
 *
 * ## The second opinion
 *
 * A log–log slope is computed beside the ladder and the class is only called
 * STRONG when the two agree.
 *
 * The slope is taken **after subtracting the winning curve's own fitted
 * floor**, and that detail is the difference between a useful check and a
 * useless one. The raw slope of a curve sitting on a constant is not the
 * exponent of anything: a textbook-clean O(n²) rise of 800 ms on top of
 * 20 ms of start-up has a raw log–log slope of 0.77, so a gate on the raw
 * slope would mark almost every honest fit WEAK — which is how this was
 * first written, and the measurement said so.
 *
 * Subtracting the winner's floor means the check is not independent of the
 * winner, and the limit that creates is worth naming: it can no longer
 * detect an offset the ladder got wrong, only a shape it got wrong. That is
 * the error worth catching. It still works in the right direction — fit a
 * straight line to quadratic data and the leftover slope comes out near 2,
 * disagrees with LINEAR's nominal 1, and the fit is downgraded.
 *
 * What it cannot do is tell O(n) from O(n log n): their slopes differ by
 * about 0.09 over any range a test suite spans, and `EXPONENT_TOLERANCE` is
 * deliberately wider than that, because separating those two is the ladder's
 * job and the separation gate's.
 *
 * Pure: no I/O, no ambient clock, no randomness.
 */

/**
 * The ladder, ascending. There is no CONSTANT rung on purpose — see the
 * `minSpan` gate above: a flat curve is reported as unmeasurable growth, not
 * as constant time.
 *
 * There is no exponential rung either, and that one is worth a sentence. An
 * O(2^n) solution does not produce a curve to fit: it passes the small cases
 * and is killed by the time limit on the first case large enough to matter,
 * and a killed case is not a measurement of anything (see
 * `complexitySamplesOf`). What a student in that position sees is a TLE and
 * the growth measured over the cases that did finish, which is the true and
 * useful half of the answer.
 */
export const COMPLEXITY_CLASSES = ["LOG", "SQRT", "LINEAR", "LINEARITHMIC", "QUADRATIC", "CUBIC"] as const;
export type ComplexityClass = (typeof COMPLEXITY_CLASSES)[number];

/** Big-O as a student writes it. The only place these strings are spelt. */
export const COMPLEXITY_LABEL: Readonly<Record<ComplexityClass, string>> = Object.freeze({
  LOG: "O(log n)",
  SQRT: "O(√n)",
  LINEAR: "O(n)",
  LINEARITHMIC: "O(n log n)",
  QUADRATIC: "O(n²)",
  CUBIC: "O(n³)",
});

/**
 * The log–log slope each class would show, for the cross-check only.
 *
 * LINEARITHMIC is 1.1 rather than 1: the slope of `n log n` is `1 + 1/ln n`,
 * which is 1.09 at n = 10^5 and 1.07 at 10^6. It is listed with the value it
 * actually has so that nobody later reads the 1 beside LINEAR as a claim
 * that the two can be told apart this way. They cannot — `EXPONENT_TOLERANCE`
 * is wider than the gap between them by design.
 */
const CLASS_EXPONENT: Readonly<Record<ComplexityClass, number>> = Object.freeze({
  LOG: 0,
  SQRT: 0.5,
  LINEAR: 1,
  LINEARITHMIC: 1.1,
  QUADRATIC: 2,
  CUBIC: 3,
});

/**
 * The class's shape at `bytes`, scaled by the largest size in the sample.
 *
 * The scaling is conditioning, not modelling: `a` absorbs any constant
 * factor, so dividing by `maxBytes` changes no fit and keeps `n³` away from
 * 10^18 in a sum of squares. The LOG and LINEARITHMIC shapes use the
 * unscaled `log2(bytes)` because an additive constant inside a logarithm is
 * absorbed by `c` the same way.
 */
function shapeOf(cls: ComplexityClass, bytes: number, maxBytes: number): number {
  const u = bytes / maxBytes;
  switch (cls) {
    case "LOG":
      return Math.log2(bytes);
    case "SQRT":
      return Math.sqrt(u);
    case "LINEAR":
      return u;
    case "LINEARITHMIC":
      return u * Math.log2(bytes);
    case "QUADRATIC":
      return u * u;
    case "CUBIC":
      return u * u * u;
  }
}

/** Which measurement is being fitted. They have different noise floors. */
export const COMPLEXITY_METRICS = ["TIME", "SPACE"] as const;
export type ComplexityMetric = (typeof COMPLEXITY_METRICS)[number];

export interface ComplexityMetricRules {
  /**
   * The smallest total rise (largest reading minus smallest) that is the
   * program rather than the instrument.
   */
  readonly minSpan: number;
  readonly unit: string;
  /** What the growth is of, for a sentence. */
  readonly noun: string;
}

/**
 * **TIME — 15 ms.** The worker reports whole CPU milliseconds, and the same
 * case on the same host varies by a millisecond or two between runs (SPEC §7:
 * timing is never promised to be deterministic). Fifteen of those is the
 * smallest rise in which a slope is the solution's and not the clock's.
 *
 * **SPACE — 512 KB.** Peak resident memory is page-quantised, and both the
 * allocator and the runtime round their requests upward in chunks far larger
 * than a page. Half a megabyte is the smallest rise that is the program's own
 * data rather than its allocator's arithmetic.
 */
export const COMPLEXITY_METRIC_RULES: Readonly<Record<ComplexityMetric, ComplexityMetricRules>> = Object.freeze({
  TIME: { minSpan: 15, unit: "ms", noun: "time" },
  SPACE: { minSpan: 512, unit: "KB", noun: "memory" },
});

/** Distinct input sizes below which no curve is fitted. */
export const MIN_FIT_POINTS = 5;

/**
 * The largest input over the smallest, below which the fit is refused.
 *
 * Eight, and the second paragraph of this file's header is the argument: it
 * is both the span below which the candidate curves are indistinguishable
 * and the span a single-number input cannot reach, which is the one shape
 * where measuring against input bytes would be measuring the wrong axis.
 */
export const MIN_SIZE_RATIO = 8;

/** Below this, no curve in the ladder describes the data. */
export const MIN_R_SQUARED = 0.5;

/**
 * Distinct sizes, span, fit and margin required before a class is called
 * STRONG. Below any of them the class is still reported, as WEAK, with the
 * runner-up named.
 *
 * **`separation` = 4 is measured, not chosen.** Residuals are squared, so
 * four times the residual is twice the RMS error — and the number comes from
 * generating each class's curve at several noise levels and reading off how
 * far the winner actually beat the runner-up:
 *
 * | noise | LOG | SQRT | LINEAR | n log n | QUADRATIC | CUBIC |
 * |---|---|---|---|---|---|---|
 * | 0% | 97,000x | 101,000x | 1,950x | 879x | 29,600x | 18,500x |
 * | 3% | 127x | 147x | 9.9x | 3.6x | 331x | 760x |
 * | 8% | 22x | 26x | 3.0x | **mislabelled**, 1.9x | 50x | 141x |
 * | 15% | 7.6x | 6.3x | 1.8x | **mislabelled**, 1.9x | 17x | 25x |
 *
 * Two things in that table decided the value. Every class except the
 * LINEAR / LINEARITHMIC pair separates by more than 6x even at 15% noise,
 * so 4 does not cost them their STRONG. And that pair is in a different
 * position from the rest: `n log n` is only 9% steeper than `n` over this
 * span, so it separates by 879x where the others manage tens of thousands
 * on perfectly clean data, and by 8% noise the two have swapped places. A
 * threshold of 4 therefore says exactly the true thing — **this method
 * distinguishes O(n) from O(n log n) only when the readings are very
 * clean**, and says WEAK with the other one named whenever they are not.
 */
export const STRONG_FIT = Object.freeze({
  points: 6,
  sizeRatio: 16,
  rSquared: 0.95,
  /** The runner-up's residual must be this many times the winner's. */
  separation: 4,
});

/**
 * How far the model-free log–log slope may sit from the class's nominal one.
 *
 * Wider than the 0.09 that separates O(n) from O(n log n), deliberately: the
 * cross-check is there to catch a ladder that has gone badly wrong, not to
 * re-decide what the ladder is for.
 */
export const EXPONENT_TOLERANCE = 0.5;

export type ComplexityConfidence = "STRONG" | "WEAK";

export type ComplexityRefusal =
  /** Fewer than MIN_FIT_POINTS distinct input sizes ran and passed. */
  | "TOO_FEW_SIZES"
  /** The cases that ran are all about the same size. */
  | "SIZES_TOO_CLOSE"
  /** The readings barely moved: the rise is under the metric's noise floor. */
  | "GROWTH_BELOW_NOISE"
  /** Nothing in the ladder fits, or the curve falls as the input grows. */
  | "NO_MODEL_FITS";

export const COMPLEXITY_REFUSALS = [
  "TOO_FEW_SIZES",
  "SIZES_TOO_CLOSE",
  "GROWTH_BELOW_NOISE",
  "NO_MODEL_FITS",
] as const satisfies readonly ComplexityRefusal[];

/**
 * What a student reads instead of a class. Every one of them says what the
 * data could not support; none of them implies a class by the back door —
 * in particular GROWTH_BELOW_NOISE does not say "so it is probably
 * constant", because that is precisely the claim the reading cannot carry.
 */
export const COMPLEXITY_REFUSAL_SENTENCE: Readonly<Record<ComplexityRefusal, string>> = Object.freeze({
  TOO_FEW_SIZES:
    "The tests this ran on do not come in enough different sizes to measure growth — that needs at least five, and it is a property of the problem rather than of your solution.",
  SIZES_TOO_CLOSE:
    "The tests this ran on are all roughly the same size, so there is no range to measure growth over.",
  GROWTH_BELOW_NOISE:
    "The readings barely moved across these tests, so there is no growth here big enough to measure against the judge's own precision.",
  NO_MODEL_FITS: "The readings do not follow any of the growth curves this compares against.",
});

/** One case's measurement: the bytes it was given, and what it cost. */
export interface ComplexitySample {
  readonly bytes: number;
  readonly value: number;
}

export interface ComplexityEstimate {
  readonly fitted: true;
  readonly growth: ComplexityClass;
  readonly confidence: ComplexityConfidence;
  /** The next-best class, when there is one. Worth showing when WEAK. */
  readonly runnerUp: ComplexityClass | null;
  /** Coefficient of determination of the winning curve, 0–1. */
  readonly rSquared: number;
  /**
   * The log–log slope of the readings once the winning curve's constant
   * floor is removed — the second opinion described in the header. Null
   * when fewer than three readings are left above that floor.
   */
  readonly exponent: number | null;
  /** Distinct input sizes the fit used. */
  readonly points: number;
  /** Largest input size over the smallest. */
  readonly sizeRatio: number;
}

export interface ComplexityUnmeasured {
  readonly fitted: false;
  readonly reason: ComplexityRefusal;
  readonly points: number;
  readonly sizeRatio: number;
}

export type ComplexityOutcome = ComplexityEstimate | ComplexityUnmeasured;

/**
 * One reading per distinct input size, ascending, keeping the **smallest**
 * reading at each size.
 *
 * Two cases can be the same number of bytes and different work, and timing
 * noise is one-sided: a case is never faster than the work it does, and is
 * sometimes slower because of the scheduler, a cold cache or a neighbour on
 * the host. The minimum is therefore the cleanest view of the curve, which
 * is the same reasoning the SQL calibration benchmark uses when it scores
 * the fastest of five runs.
 *
 * Sizes under one byte are dropped rather than clamped: `log2(0)` is not a
 * number, and a case with no input is not a point on a size axis.
 */
export function aggregateComplexitySamples(samples: readonly ComplexitySample[]): ComplexitySample[] {
  const best = new Map<number, number>();
  for (const s of samples) {
    if (!Number.isFinite(s.bytes) || !Number.isFinite(s.value) || s.bytes < 1 || s.value < 0) continue;
    const seen = best.get(s.bytes);
    if (seen === undefined || s.value < seen) best.set(s.bytes, s.value);
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0]).map(([bytes, value]) => ({ bytes, value }));
}

interface Fit {
  readonly cls: ComplexityClass;
  readonly rss: number;
  /** The fitted constant floor — start-up time, or baseline memory. */
  readonly offset: number;
}

/**
 * `y = a·f + c` by ordinary least squares, or null when the shape cannot
 * carry this data: a column of identical `f` values (no slope is defined),
 * or a slope that falls. A solution does not get faster as its input grows,
 * so a curve that only fits by saying it does is not a fit of anything.
 */
function fitShape(points: readonly ComplexitySample[], cls: ComplexityClass, maxBytes: number): Fit | null {
  const n = points.length;
  let sf = 0;
  let sy = 0;
  let sff = 0;
  let sfy = 0;
  for (const p of points) {
    const f = shapeOf(cls, p.bytes, maxBytes);
    sf += f;
    sy += p.value;
    sff += f * f;
    sfy += f * p.value;
  }
  // The test is RELATIVE to the sum of squares, not against Number.EPSILON:
  // `denom` is a squared quantity, so on readings in the millions a column of
  // identical shapes cancels to something far larger than EPSILON and an
  // absolute threshold would pass it and divide by rounding error.
  const denom = n * sff - sf * sf;
  if (!Number.isFinite(denom) || denom <= 1e-12 * Math.abs(n * sff)) return null;
  const a = (n * sfy - sf * sy) / denom;
  if (!Number.isFinite(a) || a <= 0) return null;
  const c = (sy - a * sf) / n;
  let rss = 0;
  for (const p of points) {
    const residual = a * shapeOf(cls, p.bytes, maxBytes) + c - p.value;
    rss += residual * residual;
  }
  return Number.isFinite(rss) && Number.isFinite(c) ? { cls, rss, offset: c } : null;
}

/**
 * The slope of log(value) against log(bytes). Null below three positive
 * readings, because two points define a slope whatever they are and a slope
 * from two points is not a second opinion.
 */
export function logLogSlope(points: readonly ComplexitySample[]): number | null {
  const usable = points.filter((p) => p.value > 0 && p.bytes >= 1);
  if (usable.length < 3) return null;
  const n = usable.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of usable) {
    const x = Math.log(p.bytes);
    const y = Math.log(p.value);
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (!Number.isFinite(denom) || denom <= 1e-12 * Math.abs(n * sxx)) return null;
  const slope = (n * sxy - sx * sy) / denom;
  return Number.isFinite(slope) ? slope : null;
}

/**
 * The class this run's readings are consistent with, or why they carry none.
 *
 * `samples` is one entry per case that RAN AND PASSED — see
 * `complexitySamplesOf` for why a killed or wrong case is not a measurement.
 */
export function estimateComplexity(
  samples: readonly ComplexitySample[],
  metric: ComplexityMetric,
): ComplexityOutcome {
  const points = aggregateComplexitySamples(samples);
  const minBytes = points[0]?.bytes ?? 0;
  const maxBytes = points[points.length - 1]?.bytes ?? 0;
  const sizeRatio = minBytes > 0 ? maxBytes / minBytes : 0;
  // Rounded here as well as on the estimate: a refusal is stored too, and a
  // ratio of 1.3000000000000002 in a jsonb column is noise nobody wants.
  const shape = { points: points.length, sizeRatio: Math.round(sizeRatio * 10) / 10 };

  if (points.length < MIN_FIT_POINTS) return { fitted: false, reason: "TOO_FEW_SIZES", ...shape };
  if (sizeRatio < MIN_SIZE_RATIO) return { fitted: false, reason: "SIZES_TOO_CLOSE", ...shape };

  const values = points.map((p) => p.value);
  const span = Math.max(...values) - Math.min(...values);
  if (span < COMPLEXITY_METRIC_RULES[metric].minSpan) {
    return { fitted: false, reason: "GROWTH_BELOW_NOISE", ...shape };
  }

  const fits: Fit[] = [];
  for (const cls of COMPLEXITY_CLASSES) {
    const fit = fitShape(points, cls, maxBytes);
    if (fit !== null) fits.push(fit);
  }
  if (fits.length === 0) return { fitted: false, reason: "NO_MODEL_FITS", ...shape };
  fits.sort((a, b) => a.rss - b.rss);

  const best = fits[0]!;
  const runnerUp = fits[1] ?? null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const tss = values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0);
  // The span gate above guarantees tss > 0, so this division is safe.
  const rSquared = Math.min(1, Math.max(0, 1 - best.rss / tss));
  if (rSquared < MIN_R_SQUARED) return { fitted: false, reason: "NO_MODEL_FITS", ...shape };

  // The second opinion, measured on the growth term alone: see
  // `exponent` below for why the floor has to come off first.
  const exponent = logLogSlope(points.map((p) => ({ bytes: p.bytes, value: p.value - best.offset })));
  const separation = best.rss <= 0 ? Infinity : runnerUp === null ? Infinity : runnerUp.rss / best.rss;
  const agrees = exponent !== null && Math.abs(exponent - CLASS_EXPONENT[best.cls]) <= EXPONENT_TOLERANCE;
  const strong =
    points.length >= STRONG_FIT.points &&
    sizeRatio >= STRONG_FIT.sizeRatio &&
    rSquared >= STRONG_FIT.rSquared &&
    separation >= STRONG_FIT.separation &&
    agrees;

  return {
    fitted: true,
    growth: best.cls,
    confidence: strong ? "STRONG" : "WEAK",
    runnerUp: runnerUp?.cls ?? null,
    // Rounded so the stored estimate reads the same as the rendered one.
    rSquared: Math.round(rSquared * 1000) / 1000,
    exponent: exponent === null ? null : Math.round(exponent * 100) / 100,
    points: points.length,
    sizeRatio: Math.round(sizeRatio * 10) / 10,
  };
}

// ── Building the samples from a judged run ──────────────────────────────

/** One case of a judged run, as the stored result keeps it. */
export interface JudgedCase {
  readonly i: number;
  readonly v: string;
  readonly ms: number;
  readonly kb: number;
}

/**
 * The time and memory samples of a judged run, given each case's input size.
 *
 * **Only cases whose verdict is AC become samples**, and the reason is the
 * heart of this: a case killed at the time limit reports the limit rather
 * than the work, a case that crashed reports where it died, and a wrong
 * answer may have taken a shortcut past the work the curve is supposed to
 * describe. Each of those is a reading of something other than the
 * algorithm finishing, and a curve fitted through them would describe the
 * judge's limits.
 *
 * It is also why this is useful on a **TLE**: with `stopOnFirstFailure` the
 * cases before the killed one did finish, and the growth measured over them
 * is exactly the evidence a student needs for why the next one did not.
 *
 * A case with no size (an interactive problem generates its input, an
 * output-only problem's submission IS the answer) simply contributes no
 * sample, and the refusal gates then say there is nothing to measure.
 */
export function complexitySamplesOf(
  cases: readonly JudgedCase[],
  bytesByIndex: ReadonlyMap<number, number>,
): { time: ComplexitySample[]; space: ComplexitySample[] } {
  const time: ComplexitySample[] = [];
  const space: ComplexitySample[] = [];
  for (const c of cases) {
    if (c.v !== "AC") continue;
    const bytes = bytesByIndex.get(c.i);
    if (bytes === undefined || bytes < 1) continue;
    time.push({ bytes, value: c.ms });
    space.push({ bytes, value: c.kb });
  }
  return { time, space };
}

// ── The stored estimate ─────────────────────────────────────────────────

/**
 * Bumped whenever a change here would make a new estimate disagree with a
 * stored one — a rung added to the ladder, a threshold moved, the fitting
 * changed. Stored with every estimate so a row can be read against the
 * rules that produced it rather than against today's, which is the same
 * reason a submission stores the calibration of the node that judged it.
 */
export const COMPLEXITY_ESTIMATOR_VERSION = 1;

export interface ComplexityDetail {
  readonly version: number;
  readonly time: ComplexityOutcome;
  readonly space: ComplexityOutcome;
}

const estimateSchema = z.object({
  fitted: z.literal(true),
  growth: z.enum(COMPLEXITY_CLASSES),
  confidence: z.enum(["STRONG", "WEAK"]),
  runnerUp: z.enum(COMPLEXITY_CLASSES).nullable().catch(null),
  rSquared: z.number().finite().min(0).max(1),
  exponent: z.number().finite().nullable().catch(null),
  points: z.number().int().nonnegative(),
  sizeRatio: z.number().finite().nonnegative(),
});

const unmeasuredSchema = z.object({
  fitted: z.literal(false),
  reason: z.enum(COMPLEXITY_REFUSALS),
  points: z.number().int().nonnegative(),
  sizeRatio: z.number().finite().nonnegative(),
});

export const complexityOutcomeSchema = z.union([estimateSchema, unmeasuredSchema]);

export const complexityDetailSchema = z.object({
  version: z.number().int().nonnegative(),
  time: complexityOutcomeSchema,
  space: complexityOutcomeSchema,
});

/**
 * A stored `Submission.complexityDetail`, or null.
 *
 * Lenient in one direction only: a row written by a different estimator
 * version still reads, because the shape is what changes last and a stored
 * measurement is still a measurement. A row that does not parse reads as
 * null and the surface says nothing, which is the right failure for a
 * decoration on a verdict.
 */
export function readComplexityDetail(raw: unknown): ComplexityDetail | null {
  const parsed = complexityDetailSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The class a fitted outcome names, or null. What the enum columns store. */
export function storedComplexityClass(outcome: ComplexityOutcome): ComplexityClass | null {
  return outcome.fitted ? outcome.growth : null;
}

// ── Copy ────────────────────────────────────────────────────────────────

/** "Time grows like O(n log n)" — the one line a student reads first. */
export function complexityHeadline(metric: ComplexityMetric, estimate: ComplexityEstimate): string {
  const noun = COMPLEXITY_METRIC_RULES[metric].noun;
  return `${noun[0]!.toUpperCase()}${noun.slice(1)} grows like ${COMPLEXITY_LABEL[estimate.growth]}`;
}

/** What the estimate was measured over. Always shown, so a weak fit is visible. */
export function complexityEvidence(estimate: ComplexityEstimate): string {
  const span = estimate.sizeRatio >= 10 ? Math.round(estimate.sizeRatio) : estimate.sizeRatio;
  return `Measured over ${estimate.points} test sizes spanning ${span}×, fit ${estimate.rSquared.toFixed(2)}.`;
}

/**
 * The caveat a weak fit carries, or null. A STRONG fit still carries the
 * standing disclaimer the surface shows once; this is the extra sentence for
 * a class the data does not pin down.
 */
export function complexityCaveat(estimate: ComplexityEstimate): string | null {
  if (estimate.confidence === "STRONG") return null;
  if (estimate.runnerUp === null) {
    return "The data is thin, so read this as the shape of the curve rather than the exact class.";
  }
  return `${COMPLEXITY_LABEL[estimate.runnerUp]} is nearly as good a fit, so read this as the shape of the curve rather than the exact class.`;
}
