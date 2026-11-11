import { describe, expect, it } from "vitest";
import {
  HISTOGRAM_BUCKETS,
  MIN_PERCENTILE_COHORT,
  cohortKeyFor,
  histogram,
  percentileRank,
  percentileRankSorted,
  sortedPopulation,
} from "../src/percentile";

describe("percentileRank uses the mid-rank definition", () => {
  it("puts the only value in the middle", () => {
    expect(percentileRank(5, [5])).toBe(0.5);
  });

  it("puts a tied GROUP in the middle of the band it occupies", () => {
    /**
     * The case that makes mid-rank the right definition. Sixty students who
     * have never entered a rated contest share one rating; with the naive
     * "fraction strictly below" definition every one of them reads 0 while a
     * single student one point above reads 0.6, which is a cliff that exists
     * only in the arithmetic.
     */
    const population = [...Array.from({ length: 6 }, () => 1200), 1201, 1202, 1203, 1204];
    expect(percentileRank(1200, population)).toBe(0.3);
    expect(percentileRank(1201, population)).toBe(0.65);
  });

  it("ranks the lowest and highest without reaching 0 or 1", () => {
    const population = [1, 2, 3, 4];
    expect(percentileRank(1, population)).toBe(0.125);
    expect(percentileRank(4, population)).toBe(0.875);
  });

  it("is monotonic", () => {
    const population = [10, 20, 30, 40, 50];
    const ranks = population.map((value) => percentileRank(value, population));
    for (let i = 1; i < ranks.length; i += 1) expect(ranks[i]!).toBeGreaterThan(ranks[i - 1]!);
  });

  it("is 0 for an empty population rather than NaN", () => {
    expect(percentileRank(5, [])).toBe(0);
  });

  it("never returns -0", () => {
    expect(Object.is(percentileRank(-5, [0, 1, 2]), -0)).toBe(false);
  });

  it("clamps a value outside the population", () => {
    expect(percentileRank(-100, [1, 2, 3])).toBe(0);
    expect(percentileRank(100, [1, 2, 3])).toBe(1);
  });
});

describe("the sorted form agrees with the scanning form", () => {
  it("matches on every value of a population with ties", () => {
    const population = [1200, 1200, 1200, 1350, 1350, 1400, 1500, 1500, 1500, 1500, 1600];
    const sorted = sortedPopulation(population);
    for (const value of new Set(population)) {
      expect(percentileRankSorted(value, sorted), String(value)).toBe(percentileRank(value, population));
    }
  });

  it("matches for values between and outside the population", () => {
    const population = [10, 20, 30];
    const sorted = sortedPopulation(population);
    for (const value of [5, 15, 25, 35]) {
      expect(percentileRankSorted(value, sorted), String(value)).toBe(percentileRank(value, population));
    }
  });

  it("does not mutate the input", () => {
    const population = [3, 1, 2];
    sortedPopulation(population);
    expect(population).toEqual([3, 1, 2]);
  });
});

describe("the minimum cohort", () => {
  it("is thirty, and the reason is in the module", () => {
    // Below this a percentile is a disguised ranking: in a cohort of eleven,
    // "you are at the 9th percentile" identifies you to anyone who can
    // count.
    expect(MIN_PERCENTILE_COHORT).toBe(30);
  });
});

describe("the cohort key is the batch", () => {
  it("is the batch year as a string", () => {
    expect(cohortKeyFor(2027)).toBe("2027");
  });

  it("names the unknown cohort rather than leaving it empty", () => {
    // The CHECK refuses an empty cohortKey, and a student with no batch
    // recorded still needs a row that says which group they were not ranked
    // in.
    expect(cohortKeyFor(null)).toBe("UNKNOWN");
  });
});

describe("the frozen histogram", () => {
  it("counts into ten buckets", () => {
    const buckets = histogram([0, 10, 20, 30, 40, 50, 60, 70, 80, 90], 0, 100);
    expect(buckets).toHaveLength(HISTOGRAM_BUCKETS);
    expect(buckets).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it("puts the maximum in the last bucket rather than past the end", () => {
    expect(histogram([100], 0, 100)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("clamps a value outside the range", () => {
    expect(histogram([-50, 150], 0, 100)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("puts a degenerate range entirely in the first bucket", () => {
    // A cohort where everybody has the same rating: one bucket, and no
    // division by zero.
    expect(histogram([1200, 1200, 1200], 1200, 1200)).toEqual([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("totals to the population size", () => {
    const values = Array.from({ length: 97 }, (_, i) => i * 7);
    const total = histogram(values, 0, 700).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(values.length);
  });
});
