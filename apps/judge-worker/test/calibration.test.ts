import { describe, expect, it } from "vitest";
import { CALIBRATION_SOURCE, CALIBRATION_WORK_UNITS, calibrationScore, median } from "../src/calibration";

describe("median", () => {
  it("returns the middle value for an odd count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5])).toBe(5);
  });

  it("averages the two middle values for an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([10, 20])).toBe(15);
  });

  it("does not mutate the input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });

  it("is NaN for an empty list", () => {
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe("calibrationScore", () => {
  it("is work units per CPU second, taken as the median across runs", () => {
    // 1000 ms → score = WORK / 1 s; 500 ms → WORK / 0.5 s; 2000 ms → WORK / 2 s.
    const score = calibrationScore([1000, 500, 2000]);
    // scores are WORK, 2·WORK, WORK/2 → median is WORK.
    expect(score).toBe(Math.round(CALIBRATION_WORK_UNITS));
  });

  it("gives a higher score to a faster node (less CPU time)", () => {
    const fast = calibrationScore([800, 800, 800])!;
    const slow = calibrationScore([1600, 1600, 1600])!;
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBe(2 * slow);
  });

  it("ignores non-positive samples and returns null when there are none", () => {
    expect(calibrationScore([0, 0])).toBeNull();
    expect(calibrationScore([])).toBeNull();
    expect(calibrationScore([0, 1000])).toBe(Math.round(CALIBRATION_WORK_UNITS));
  });

  it("accepts an explicit work-unit count", () => {
    expect(calibrationScore([1000], 500)).toBe(500);
  });
});

describe("CALIBRATION_SOURCE", () => {
  it("is a self-contained C program that prints its result and embeds the work count", () => {
    expect(CALIBRATION_SOURCE).toContain("int main");
    expect(CALIBRATION_SOURCE).toContain("printf");
    expect(CALIBRATION_SOURCE).toContain(`${CALIBRATION_WORK_UNITS}ULL`);
  });
});
