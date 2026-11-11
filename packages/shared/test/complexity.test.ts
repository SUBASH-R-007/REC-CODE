import { describe, expect, it } from "vitest";
import {
  COMPLEXITY_CLASSES,
  COMPLEXITY_LABEL,
  COMPLEXITY_METRICS,
  COMPLEXITY_METRIC_RULES,
  COMPLEXITY_REFUSALS,
  COMPLEXITY_REFUSAL_SENTENCE,
  EXPONENT_TOLERANCE,
  MIN_FIT_POINTS,
  MIN_SIZE_RATIO,
  aggregateComplexitySamples,
  complexityCaveat,
  complexityEvidence,
  complexityHeadline,
  complexitySamplesOf,
  estimateComplexity,
  logLogSlope,
  type ComplexityClass,
  type ComplexityEstimate,
  type ComplexityMetric,
  type ComplexitySample,
} from "../src/complexity";

/**
 * Phase 17. The estimator's whole value is that it refuses rather than
 * guesses, so these tests are weighted the other way round from most: a
 * handful assert that a clean curve is recognised, and the rest assert that
 * a curve which cannot carry a claim does not get one.
 */

/** Eight doubling sizes — a realistic test suite's spread (128x). */
const SIZES = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];

/** The true shape of each class, for generating a curve to recover. */
const TRUE_SHAPE: Record<ComplexityClass, (n: number) => number> = {
  LOG: (n) => Math.log2(n),
  SQRT: Math.sqrt,
  LINEAR: (n) => n,
  LINEARITHMIC: (n) => n * Math.log2(n),
  QUADRATIC: (n) => n * n,
  CUBIC: (n) => n * n * n,
};

/**
 * A curve of `cls` scaled so its rise over `sizes` is `rise`, sitting on a
 * constant floor of `offset` — the interpreter start-up or the runtime's
 * baseline memory, which is the thing that breaks a naive log-log fit.
 */
function curve(
  cls: ComplexityClass,
  options: { sizes?: number[]; rise?: number; offset?: number; noise?: number } = {},
): ComplexitySample[] {
  const sizes = options.sizes ?? SIZES;
  const rise = options.rise ?? 400;
  const offset = options.offset ?? 0;
  const shape = TRUE_SHAPE[cls];
  const low = shape(Math.min(...sizes));
  const high = shape(Math.max(...sizes));
  const a = rise / (high - low);
  // A fixed multiplier sequence rather than Math.random: a flaky estimator
  // test would be worse than no test.
  const jitter = [1, -0.6, 0.35, -0.2, 0.8, -0.45, 0.15, -0.75, 0.5, -0.3];
  return sizes.map((n, k) => {
    const clean = offset + a * (shape(n) - low);
    const wobble = (options.noise ?? 0) * (jitter[k % jitter.length] ?? 0);
    return { bytes: n, value: Math.max(0, Math.round(clean * (1 + wobble))) };
  });
}

function fittedOrThrow(outcome: ReturnType<typeof estimateComplexity>): ComplexityEstimate {
  if (!outcome.fitted) throw new Error(`expected a fit, got ${outcome.reason}`);
  return outcome;
}

describe("estimateComplexity", () => {
  describe("recovers a clean curve", () => {
    it.each(COMPLEXITY_CLASSES)("%s", (cls) => {
      const estimate = fittedOrThrow(estimateComplexity(curve(cls), "TIME"));
      expect(estimate.growth).toBe(cls);
      expect(estimate.rSquared).toBeGreaterThan(0.99);
    });

    it.each(COMPLEXITY_CLASSES)("%s under a constant floor", (cls) => {
      // 30 ms of Python start-up, or 2 MB of baseline RSS: the term `c` is
      // fitted for, and the one a log-log slope alone cannot survive.
      const estimate = fittedOrThrow(estimateComplexity(curve(cls, { offset: 30 }), "TIME"));
      expect(estimate.growth).toBe(cls);
    });

    /**
     * Under noise the ladder may land on the neighbouring rung, and the one
     * place that happens is LINEAR / LINEARITHMIC: `n log n` is only about
     * 9% steeper than `n` over any span a test suite covers, so 8% noise is
     * genuinely enough to swap them. The honest requirement is not that the
     * label is always exact — it is that the true class is never more than
     * one rung away AND is named as the runner-up when it is missed, so the
     * student reads it rather than being told something else.
     */
    it.each(COMPLEXITY_CLASSES)("%s with 8% noise lands on it or names it", (cls) => {
      const estimate = fittedOrThrow(estimateComplexity(curve(cls, { noise: 0.08, offset: 25 }), "TIME"));
      if (estimate.growth === cls) return;
      const rung = COMPLEXITY_CLASSES.indexOf(cls);
      const landed = COMPLEXITY_CLASSES.indexOf(estimate.growth);
      expect(Math.abs(landed - rung), `${cls} read as ${estimate.growth}`).toBe(1);
      expect(estimate.runnerUp).toBe(cls);
      expect(estimate.confidence).toBe("WEAK");
    });
  });

  it("separates quadratic from linear on the same sizes", () => {
    const linear = fittedOrThrow(estimateComplexity(curve("LINEAR", { rise: 900 }), "TIME"));
    const quadratic = fittedOrThrow(estimateComplexity(curve("QUADRATIC", { rise: 900 }), "TIME"));
    expect(linear.growth).toBe("LINEAR");
    expect(quadratic.growth).toBe("QUADRATIC");
  });

  it("calls a wide, clean, well-separated fit STRONG", () => {
    const estimate = fittedOrThrow(estimateComplexity(curve("QUADRATIC", { rise: 800, offset: 20 }), "TIME"));
    expect(estimate.confidence).toBe("STRONG");
    expect(estimate.points).toBe(SIZES.length);
    expect(estimate.sizeRatio).toBe(128);
  });

  it("calls a fit on the fewest allowed sizes WEAK", () => {
    const sizes = [1000, 2000, 4000, 8000, 16000];
    const estimate = fittedOrThrow(estimateComplexity(curve("LINEAR", { sizes, rise: 600 }), "TIME"));
    expect(estimate.points).toBe(MIN_FIT_POINTS);
    expect(estimate.confidence).toBe("WEAK");
    expect(complexityCaveat(estimate)).not.toBeNull();
  });

  /**
   * The separation table in `STRONG_FIT`'s comment, asserted. The pair this
   * method cannot reliably split is only ever called STRONG on readings
   * clean enough to split it.
   */
  it("only calls the linear / linearithmic distinction STRONG on clean readings", () => {
    const clean = fittedOrThrow(estimateComplexity(curve("LINEARITHMIC", { rise: 800, offset: 25 }), "TIME"));
    expect(clean.growth).toBe("LINEARITHMIC");
    expect(clean.confidence).toBe("STRONG");

    const noisy = fittedOrThrow(
      estimateComplexity(curve("LINEARITHMIC", { rise: 800, offset: 25, noise: 0.08 }), "TIME"),
    );
    expect(noisy.confidence).toBe("WEAK");
    expect([noisy.growth, noisy.runnerUp]).toContain("LINEARITHMIC");

    const noisyLinear = fittedOrThrow(
      estimateComplexity(curve("LINEAR", { rise: 800, offset: 25, noise: 0.08 }), "TIME"),
    );
    expect(noisyLinear.growth).toBe("LINEAR");
    expect(noisyLinear.confidence).toBe("WEAK");
  });

  it("keeps a far-apart pair STRONG through the same noise", () => {
    // Quadratic against cubic separates by 50x at 8% noise, so the
    // threshold that demotes the linear pair must not touch this one.
    const estimate = fittedOrThrow(estimateComplexity(curve("QUADRATIC", { rise: 800, offset: 25, noise: 0.08 }), "TIME"));
    expect(estimate.growth).toBe("QUADRATIC");
    expect(estimate.confidence).toBe("STRONG");
  });

  it("names the runner-up so a weak class is read as a shape", () => {
    const estimate = fittedOrThrow(estimateComplexity(curve("LINEARITHMIC"), "TIME"));
    expect(estimate.runnerUp).not.toBeNull();
    expect(estimate.runnerUp).not.toBe(estimate.growth);
  });

  describe("refuses rather than guesses", () => {
    it("below five distinct sizes", () => {
      const outcome = estimateComplexity(curve("LINEAR", { sizes: [1000, 4000, 16000, 64000] }), "TIME");
      expect(outcome).toMatchObject({ fitted: false, reason: "TOO_FEW_SIZES", points: 4 });
    });

    it("when repeated sizes leave too few distinct ones", () => {
      const samples = [1000, 1000, 1000, 4000, 4000, 16000, 16000].map((bytes, k) => ({ bytes, value: 20 + k * 40 }));
      expect(estimateComplexity(samples, "TIME")).toMatchObject({ fitted: false, reason: "TOO_FEW_SIZES", points: 3 });
    });

    it("when every case is about the same size", () => {
      const sizes = [1000, 1100, 1250, 1400, 1600, 1800];
      const outcome = estimateComplexity(curve("QUADRATIC", { sizes, rise: 900 }), "TIME");
      expect(outcome).toMatchObject({ fitted: false, reason: "SIZES_TOO_CLOSE" });
      if (outcome.fitted) throw new Error("unreachable");
      expect(outcome.sizeRatio).toBeLessThan(MIN_SIZE_RATIO);
    });

    it("a single-number input, which is the axis this cannot measure", () => {
      // "Given n <= 10^9, compute f(n)": the input is one integer, so the
      // bytes are log n and a linear solution would read as exponential.
      // Six cases, every one a different magnitude, and still under 8x.
      const samples = [
        { bytes: 2, value: 12 },
        { bytes: 4, value: 30 },
        { bytes: 6, value: 80 },
        { bytes: 8, value: 220 },
        { bytes: 10, value: 600 },
        { bytes: 11, value: 1200 },
      ];
      expect(estimateComplexity(samples, "TIME")).toMatchObject({ fitted: false, reason: "SIZES_TOO_CLOSE" });
    });

    it("when the whole rise is under the time noise floor", () => {
      const samples = SIZES.map((bytes, k) => ({ bytes, value: 4 + (k % 3) }));
      expect(estimateComplexity(samples, "TIME")).toMatchObject({ fitted: false, reason: "GROWTH_BELOW_NOISE" });
    });

    it("a flat curve is unmeasurable growth and NOT a constant-time claim", () => {
      const outcome = estimateComplexity(
        SIZES.map((bytes) => ({ bytes, value: 31 })),
        "TIME",
      );
      expect(outcome.fitted).toBe(false);
      if (outcome.fitted) throw new Error("unreachable");
      expect(outcome.reason).toBe("GROWTH_BELOW_NOISE");
      expect(COMPLEXITY_REFUSAL_SENTENCE[outcome.reason]).not.toMatch(/constant|O\(1\)/i);
      expect(COMPLEXITY_CLASSES).not.toContain("CONSTANT");
    });

    it("when memory rises by less than half a megabyte", () => {
      // 300 KB of growth on a 2 MB baseline: real, and below what a
      // page-quantised peak RSS can separate from its allocator.
      const samples = SIZES.map((bytes, k) => ({ bytes, value: 2048 + k * 40 }));
      expect(estimateComplexity(samples, "SPACE")).toMatchObject({ fitted: false, reason: "GROWTH_BELOW_NOISE" });
      // The same readings as a time curve clear the 15 ms floor.
      expect(estimateComplexity(samples, "TIME").fitted).toBe(true);
    });

    it("when the readings fall as the input grows", () => {
      const samples = SIZES.map((bytes, k) => ({ bytes, value: 900 - k * 100 }));
      expect(estimateComplexity(samples, "TIME")).toMatchObject({ fitted: false, reason: "NO_MODEL_FITS" });
    });

    it("when no curve in the ladder describes the data", () => {
      // A sawtooth: monotone in neither direction, and nothing to fit.
      const samples = SIZES.map((bytes, k) => ({ bytes, value: k % 2 === 0 ? 20 : 400 }));
      expect(estimateComplexity(samples, "TIME")).toMatchObject({ fitted: false, reason: "NO_MODEL_FITS" });
    });

    it("on no samples at all", () => {
      expect(estimateComplexity([], "TIME")).toMatchObject({ fitted: false, reason: "TOO_FEW_SIZES", points: 0 });
    });
  });

  describe("stays numerically honest", () => {
    it.each(COMPLEXITY_METRICS)("returns only finite JSON-safe numbers (%s)", (metric: ComplexityMetric) => {
      for (const cls of COMPLEXITY_CLASSES) {
        const estimate = fittedOrThrow(estimateComplexity(curve(cls, { rise: 40_000, offset: 9000 }), metric));
        expect(JSON.parse(JSON.stringify(estimate))).toEqual(estimate);
        expect(Number.isFinite(estimate.rSquared)).toBe(true);
        expect(estimate.rSquared).toBeGreaterThanOrEqual(0);
        expect(estimate.rSquared).toBeLessThanOrEqual(1);
        expect(Number.isFinite(estimate.sizeRatio)).toBe(true);
        if (estimate.exponent !== null) expect(Number.isFinite(estimate.exponent)).toBe(true);
      }
    });

    it("survives a ten-megabyte case against a cubic shape", () => {
      // n^3 at 10^7 is 10^21, and a sum of squares of that is 10^42. The
      // shapes are scaled by the largest size precisely so this conditions.
      const sizes = [10_000, 40_000, 160_000, 640_000, 2_560_000, 10_240_000];
      const estimate = fittedOrThrow(estimateComplexity(curve("CUBIC", { sizes, rise: 5000 }), "TIME"));
      expect(estimate.growth).toBe("CUBIC");
      expect(Number.isFinite(estimate.rSquared)).toBe(true);
    });

    it("ignores a zero-byte case rather than taking log2(0)", () => {
      const samples = [{ bytes: 0, value: 5 }, ...curve("LINEAR")];
      const estimate = fittedOrThrow(estimateComplexity(samples, "TIME"));
      expect(estimate.points).toBe(SIZES.length);
      expect(Number.isFinite(estimate.rSquared)).toBe(true);
    });

    it("ignores a NaN reading", () => {
      const samples = [{ bytes: 2000, value: Number.NaN }, ...curve("LINEAR")];
      expect(fittedOrThrow(estimateComplexity(samples, "TIME")).points).toBe(SIZES.length);
    });
  });

  it("agrees with the model-free slope whenever it calls a fit STRONG", () => {
    const nominal: Record<ComplexityClass, number> = {
      LOG: 0,
      SQRT: 0.5,
      LINEAR: 1,
      LINEARITHMIC: 1.1,
      QUADRATIC: 2,
      CUBIC: 3,
    };
    for (const cls of COMPLEXITY_CLASSES) {
      const estimate = fittedOrThrow(estimateComplexity(curve(cls, { rise: 800 }), "TIME"));
      if (estimate.confidence !== "STRONG") continue;
      expect(estimate.exponent).not.toBeNull();
      expect(Math.abs(estimate.exponent! - nominal[estimate.growth])).toBeLessThanOrEqual(EXPONENT_TOLERANCE);
    }
  });
});

describe("aggregateComplexitySamples", () => {
  it("keeps the smallest reading per distinct size, ascending", () => {
    const samples = [
      { bytes: 4000, value: 90 },
      { bytes: 1000, value: 40 },
      { bytes: 4000, value: 61 },
      { bytes: 4000, value: 75 },
    ];
    expect(aggregateComplexitySamples(samples)).toEqual([
      { bytes: 1000, value: 40 },
      { bytes: 4000, value: 61 },
    ]);
  });

  it("drops sizes under a byte, negative readings and non-finite numbers", () => {
    const samples = [
      { bytes: 0, value: 10 },
      { bytes: -5, value: 10 },
      { bytes: 1000, value: -1 },
      { bytes: Number.POSITIVE_INFINITY, value: 10 },
      { bytes: 2000, value: Number.NaN },
      { bytes: 3000, value: 12 },
    ];
    expect(aggregateComplexitySamples(samples)).toEqual([{ bytes: 3000, value: 12 }]);
  });

  it("keeps a zero reading, which is a measurement", () => {
    expect(aggregateComplexitySamples([{ bytes: 1000, value: 0 }])).toEqual([{ bytes: 1000, value: 0 }]);
  });
});

describe("logLogSlope", () => {
  it("recovers the exponent of a pure power law", () => {
    for (const power of [1, 2, 3]) {
      const samples = SIZES.map((bytes) => ({ bytes, value: bytes ** power }));
      expect(logLogSlope(samples)!).toBeCloseTo(power, 6);
    }
  });

  it("is null below three positive readings", () => {
    expect(logLogSlope([{ bytes: 1000, value: 5 }, { bytes: 2000, value: 9 }])).toBeNull();
    expect(
      logLogSlope([
        { bytes: 1000, value: 0 },
        { bytes: 2000, value: 0 },
        { bytes: 4000, value: 8 },
      ]),
    ).toBeNull();
  });

  it("is null when every case is one size", () => {
    expect(logLogSlope([1, 2, 3, 4].map((k) => ({ bytes: 1000, value: k })))).toBeNull();
  });
});

describe("complexitySamplesOf", () => {
  const bytes = new Map([
    [0, 100],
    [1, 2000],
    [2, 40_000],
    [3, 800_000],
  ]);

  it("takes AC cases only", () => {
    const cases = [
      { i: 0, v: "AC", ms: 10, kb: 2048 },
      { i: 1, v: "AC", ms: 40, kb: 3000 },
      { i: 2, v: "TLE", ms: 2000, kb: 9000 },
      { i: 3, v: "WA", ms: 30, kb: 2500 },
    ];
    const { time, space } = complexitySamplesOf(cases, bytes);
    expect(time).toEqual([
      { bytes: 100, value: 10 },
      { bytes: 2000, value: 40 },
    ]);
    expect(space).toEqual([
      { bytes: 100, value: 2048 },
      { bytes: 2000, value: 3000 },
    ]);
  });

  it("never lets a killed case become a point on the curve", () => {
    // The reading at the time limit is the limit, not the work: a curve
    // through it would describe the judge.
    const cases = [
      { i: 0, v: "AC", ms: 10, kb: 2048 },
      { i: 1, v: "TLE", ms: 2000, kb: 2048 },
      { i: 2, v: "MLE", ms: 900, kb: 262_144 },
      { i: 3, v: "RE", ms: 120, kb: 4000 },
    ];
    expect(complexitySamplesOf(cases, bytes).time).toEqual([{ bytes: 100, value: 10 }]);
  });

  it("skips a case with no recorded size", () => {
    const cases = [
      { i: 0, v: "AC", ms: 10, kb: 2048 },
      { i: 9, v: "AC", ms: 90, kb: 5000 },
    ];
    expect(complexitySamplesOf(cases, bytes).time).toEqual([{ bytes: 100, value: 10 }]);
  });

  it("skips a SKIPPED case", () => {
    expect(complexitySamplesOf([{ i: 0, v: "SKIPPED", ms: 0, kb: 0 }], bytes).time).toEqual([]);
  });
});

describe("copy", () => {
  it("has a label for every class and a sentence for every refusal", () => {
    for (const cls of COMPLEXITY_CLASSES) expect(COMPLEXITY_LABEL[cls]).toMatch(/^O\(/);
    for (const reason of COMPLEXITY_REFUSALS) expect(COMPLEXITY_REFUSAL_SENTENCE[reason].length).toBeGreaterThan(20);
    expect(Object.keys(COMPLEXITY_REFUSAL_SENTENCE).sort()).toEqual([...COMPLEXITY_REFUSALS].sort());
    for (const metric of COMPLEXITY_METRICS) expect(COMPLEXITY_METRIC_RULES[metric].minSpan).toBeGreaterThan(0);
  });

  it("writes a headline, the evidence and the caveat", () => {
    const estimate = fittedOrThrow(estimateComplexity(curve("LINEARITHMIC", { rise: 800, offset: 20 }), "TIME"));
    expect(complexityHeadline("TIME", estimate)).toBe("Time grows like O(n log n)");
    expect(complexityHeadline("SPACE", estimate)).toBe("Memory grows like O(n log n)");
    expect(complexityEvidence(estimate)).toMatch(/^Measured over 8 test sizes spanning 128×, fit /);
    const weak = fittedOrThrow(
      estimateComplexity(curve("LINEAR", { sizes: [1000, 2000, 4000, 8000, 16000], rise: 600 }), "TIME"),
    );
    expect(complexityCaveat(weak)).toMatch(/shape of the curve/);
  });

  it("never promises a proof", () => {
    const all = [
      ...Object.values(COMPLEXITY_REFUSAL_SENTENCE),
      complexityEvidence(fittedOrThrow(estimateComplexity(curve("LINEAR"), "TIME"))),
    ].join(" ");
    expect(all).not.toMatch(/\b(prove[ns]?|guarantee[ds]?|certain)\b/i);
  });
});
