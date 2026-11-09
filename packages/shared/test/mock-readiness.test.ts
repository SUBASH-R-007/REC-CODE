import { describe, expect, it } from "vitest";
import {
  MOCK_READINESS_MIN,
  MOCK_READINESS_WINDOW,
  mockInterviewComponent,
  mockInterviewNote,
  mockInterviewValue,
  type MockRating,
} from "../src/mock-readiness";
import { READINESS_RULES_VERSION, scoreAllTiers, type ReadinessInputs } from "../src/readiness";

const rating = (communication: number, problemSolving: number, code: number): MockRating => ({
  communication,
  problemSolving,
  code,
});

describe("one interview's value", () => {
  it("maps 1 to 0 and 5 to 1", () => {
    // A 1 is the bottom of the scale, not a twentieth of it: dividing by 5
    // would make a candidate who was rated 1 on everything score 0.2.
    expect(mockInterviewValue(rating(1, 1, 1))).toBe(0);
    expect(mockInterviewValue(rating(5, 5, 5))).toBe(1);
  });

  it("puts straight 3s at the halfway mark", () => {
    expect(mockInterviewValue(rating(3, 3, 3))).toBeCloseTo(0.5, 10);
  });

  it("weights the three equally", () => {
    // Nothing here knows whether communication matters more than code for a
    // given company, so a weight would be inventing the interviewer's own
    // judgement. Any permutation of the same three numbers is one value.
    const a = mockInterviewValue(rating(5, 3, 1));
    expect(mockInterviewValue(rating(1, 5, 3))).toBeCloseTo(a, 10);
    expect(mockInterviewValue(rating(3, 1, 5))).toBeCloseTo(a, 10);
  });

  it("stays inside 0..1 for ratings outside the documented range", () => {
    // Unreachable through the UI; a clamp so a bad row cannot produce a
    // component value the readiness CHECKs would refuse.
    expect(mockInterviewValue(rating(9, 9, 9))).toBe(1);
    expect(mockInterviewValue(rating(0, 0, 0))).toBe(0);
  });
});

describe("the component", () => {
  it("is MISSING below the minimum, with the reason the student can act on", () => {
    expect(mockInterviewComponent([])).toEqual({ state: "MISSING", reason: "NO_DATA_YET" });
    expect(mockInterviewComponent([rating(5, 5, 5)])).toEqual({ state: "MISSING", reason: "NO_DATA_YET" });
    expect(MOCK_READINESS_MIN).toBe(2);
  });

  it("never says NO_SOURCE_YET, which was only true while the scheduler did not exist", () => {
    const value = mockInterviewComponent([]);
    expect(value.state === "MISSING" && value.reason).not.toBe("NO_SOURCE_YET");
  });

  it("averages the window once there are enough", () => {
    const value = mockInterviewComponent([rating(5, 5, 5), rating(1, 1, 1)]);
    expect(value).toEqual({ state: "PRESENT", value: 0.5 });
  });

  it("takes the most recent three and ignores what came before", () => {
    // A student who was poor in October and good in February is good in
    // February. The two 1s at the end are older and must not count.
    const newestFirst = [rating(5, 5, 5), rating(5, 5, 5), rating(5, 5, 5), rating(1, 1, 1), rating(1, 1, 1)];
    expect(mockInterviewComponent(newestFirst)).toEqual({ state: "PRESENT", value: 1 });
    expect(MOCK_READINESS_WINDOW).toBe(3);
  });

  it("is not the best of them", () => {
    // Taking the maximum would make the number a high-water mark; practice
    // is about the trend.
    const value = mockInterviewComponent([rating(1, 1, 1), rating(5, 5, 5)]);
    expect(value).not.toEqual({ state: "PRESENT", value: 1 });
  });
});

describe("what a student is told", () => {
  it("counts the interviews that actually counted, not the ones they sat", () => {
    expect(mockInterviewNote(1)).toContain("most recent rated mock interview");
    expect(mockInterviewNote(2)).toContain("2 most recent");
    // Five sat, three counted: saying "your 5 most recent" would be wrong.
    expect(mockInterviewNote(5)).toContain("3 most recent");
  });
});

describe("the tier arithmetic now reaches 100", () => {
  const base: ReadinessInputs = {
    aptitudePercentile: { state: "PRESENT", value: 1 },
    verbalPercentile: { state: "PRESENT", value: 1 },
    ratingPercentile: { state: "PRESENT", value: 1 },
    mockInterviewScore: { state: "PRESENT", value: 1 },
    consistency: { state: "PRESENT", value: 1 },
    unassistedByTopic: Object.fromEntries(
      (
        [
          "ARRAYS",
          "STRINGS",
          "HASHING",
          "TWO_POINTERS",
          "SORTING",
          "BINARY_SEARCH",
          "STACKS_QUEUES",
          "LINKED_LISTS",
          "TREES",
          "GRAPHS",
          "GREEDY",
          "DP",
          "MATH",
          "BIT_MANIPULATION",
        ] as const
      ).map((topic) => [topic, 50]),
    ),
    easyMediumSolved: 500,
    mediumUnassisted: 500,
    mediumHardUnassisted: 500,
  };

  it("gives a perfect profile the whole weight, which version 1 could not", () => {
    const scores = scoreAllTiers(base);
    // The entry this closes said: "no TOP score can exceed 85", because 15
    // points of TOP were permanently unmeasurable. `availableWeight` is a
    // percentage, so the whole weight is 100 — and that, rather than any
    // particular score, is the thing that changed.
    expect(scores.TOP.availableWeight).toBeCloseTo(100, 8);
    expect(scores.TOP.score).not.toBeNull();
  });

  it("scores the same profile higher with the component than without it", () => {
    // Like for like: identical inputs, the component present at 1 against
    // the component missing. The missing version divides by 85 and the
    // present one by 100, so the comparison is the honest way to show that
    // the fifteen points are now reachable rather than renormalised away.
    const withIt = scoreAllTiers(base).TOP;
    const withoutIt = scoreAllTiers({ ...base, mockInterviewScore: { state: "MISSING", reason: "NO_DATA_YET" } }).TOP;
    expect(withIt.availableWeight).toBeGreaterThan(withoutIt.availableWeight);
    expect(withIt.score!).toBeGreaterThan(withoutIt.score!);
  });

  it("still withholds the weight when the component is missing", () => {
    const scores = scoreAllTiers({ ...base, mockInterviewScore: { state: "MISSING", reason: "NO_DATA_YET" } });
    // Nothing is renormalised: a student who has never sat one must not look
    // exactly as ready as one who has sat five. 15% of TOP goes with it.
    expect(scores.TOP.availableWeight).toBeCloseTo(85, 8);
    expect(scores.TOP.score).not.toBeNull();
    expect(scores.TOP.score!).toBeLessThanOrEqual(85);
  });

  it("is a new rules version, because the same number means something else", () => {
    // A version-1 62 was 62 out of an available 85; a version-2 62 is 62 out
    // of 100. Two meanings must not share a version.
    expect(READINESS_RULES_VERSION).toBeGreaterThanOrEqual(2);
  });
});
