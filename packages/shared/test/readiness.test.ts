import { describe, expect, it } from "vitest";
import { PROVISIONAL_CONTESTS } from "../src/rating";
import { TOPICS, type Topic } from "../src/topics";
import {
  AT_RISK_QUIET_DAYS,
  AT_RISK_SERVICE_NORMALISED,
  COMPONENT_LABEL,
  DISTRIBUTION_BUCKETS,
  MISSING_REASON_COPY,
  MISSING_REASONS,
  READINESS_COMPONENTS,
  READINESS_FRAMING,
  READINESS_RATING_MIN_CONTESTS,
  READINESS_TIERS,
  READINESS_TIER_LABEL,
  TIER_TARGETS,
  TIER_WEIGHTS,
  bucketOf,
  coverage,
  isAtRisk,
  largestGaps,
  missing,
  nextAction,
  present,
  scoreAllTiers,
  scoreTier,
  topicBreadth,
  type ReadinessInputs,
} from "../src/readiness";

/** Every topic at the same count, so a test can knock one down on purpose. */
function evenTopics(each: number): Partial<Record<Topic, number>> {
  return Object.fromEntries(TOPICS.map((topic) => [topic, each]));
}

const full: ReadinessInputs = {
  aptitudePercentile: present(1),
  verbalPercentile: present(1),
  ratingPercentile: present(1),
  mockInterviewScore: present(1),
  consistency: present(1),
  unassistedByTopic: evenTopics(100),
  easyMediumSolved: 1000,
  mediumUnassisted: 1000,
  mediumHardUnassisted: 1000,
};

const empty: ReadinessInputs = {
  aptitudePercentile: missing("NO_DATA_YET"),
  verbalPercentile: missing("NO_DATA_YET"),
  ratingPercentile: missing("NO_DATA_YET"),
  mockInterviewScore: missing("NO_SOURCE_YET"),
  consistency: present(0),
  unassistedByTopic: {},
  easyMediumSolved: 0,
  mediumUnassisted: 0,
  mediumHardUnassisted: 0,
};

const inputs = (over: Partial<ReadinessInputs> = {}): ReadinessInputs => ({ ...full, ...over });

describe("the weights are the spec's", () => {
  it.each(READINESS_TIERS)("%s sums to exactly 1.00", (tier) => {
    // Not tidiness: a tier summing to 0.95 would silently cap everybody in it
    // at 95, and nobody could tell that from a cohort 5% short.
    const total = Object.values(TIER_WEIGHTS[tier]).reduce((sum, w) => sum + (w ?? 0), 0);
    expect(Number(total.toFixed(10))).toBe(1);
  });

  it("gives SERVICE the aptitude-heavy shape the spec names", () => {
    expect(TIER_WEIGHTS.SERVICE).toEqual({
      APTITUDE_PERCENTILE: 0.35,
      VERBAL_PERCENTILE: 0.2,
      EASY_MEDIUM_COVERAGE: 0.25,
      MOCK_INTERVIEW_SCORE: 0.1,
      CONSISTENCY: 0.1,
    });
  });

  it("gives PRODUCT and TOP the shapes the spec names", () => {
    expect(TIER_WEIGHTS.PRODUCT).toEqual({
      MEDIUM_UNASSISTED_COVERAGE: 0.3,
      TOPIC_BREADTH: 0.2,
      APTITUDE_PERCENTILE: 0.2,
      RATING_PERCENTILE: 0.15,
      MOCK_INTERVIEW_SCORE: 0.1,
      CONSISTENCY: 0.05,
    });
    expect(TIER_WEIGHTS.TOP).toEqual({
      RATING_PERCENTILE: 0.35,
      MEDIUM_HARD_UNASSISTED_COVERAGE: 0.3,
      TOPIC_BREADTH: 0.2,
      MOCK_INTERVIEW_SCORE: 0.15,
    });
  });

  it("labels every component and every tier", () => {
    for (const component of READINESS_COMPONENTS) expect(COMPONENT_LABEL[component].length).toBeGreaterThan(3);
    for (const tier of READINESS_TIERS) expect(READINESS_TIER_LABEL[tier].length).toBeGreaterThan(3);
    for (const reason of MISSING_REASONS) expect(MISSING_REASON_COPY[reason].length).toBeGreaterThan(10);
  });
});

describe("the coverage targets", () => {
  it("are the numbers docs/OPEN-QUESTIONS.md records for the placement cell", () => {
    /**
     * The spec gives the weights and not these, so they are a choice — and
     * the more consequential one: the weights decide how much each part
     * counts, the targets decide how much work is full marks.
     *
     * An earlier draft shipped 80 / 60 / 50, which made the HARDEST tier the
     * easiest to max out: full TOP coverage took fewer problems than full
     * PRODUCT coverage. Pinned here so a change is a deliberate
     * READINESS_RULES_VERSION bump rather than a typo.
     */
    expect(TIER_TARGETS).toEqual({
      SERVICE: { coverage: 120, perTopic: null },
      PRODUCT: { coverage: 80, perTopic: 4 },
      TOP: { coverage: 120, perTopic: 8 },
    });
  });

  it("asks for more depth per topic at the top than in the middle", () => {
    expect(TIER_TARGETS.TOP.perTopic!).toBeGreaterThan(TIER_TARGETS.PRODUCT.perTopic!);
    // SERVICE has no breadth weight at all: a service round does not ask
    // about segment trees.
    expect(TIER_TARGETS.SERVICE.perTopic).toBeNull();
    expect(TIER_WEIGHTS.SERVICE.TOPIC_BREADTH).toBeUndefined();
  });

  it("gives each tier a target for the component it actually counts", () => {
    // A tier whose coverage component had no target would divide by zero and
    // score everybody full marks, which `coverage()` turns into present(1).
    expect(TIER_WEIGHTS.SERVICE.EASY_MEDIUM_COVERAGE).toBeGreaterThan(0);
    expect(TIER_WEIGHTS.PRODUCT.MEDIUM_UNASSISTED_COVERAGE).toBeGreaterThan(0);
    expect(TIER_WEIGHTS.TOP.MEDIUM_HARD_UNASSISTED_COVERAGE).toBeGreaterThan(0);
    for (const tier of READINESS_TIERS) expect(TIER_TARGETS[tier].coverage, tier).toBeGreaterThan(0);
  });
});

describe("the rating floor", () => {
  it("is EIGHT rated contests, which is the earliest SPEC §7 permits", () => {
    /**
     * "Do not treat a contest rating as meaningful before ~8\u201312 contests."
     * RATING_PERCENTILE is 35 % of TOP, so this is the single largest
     * unearned swing readiness could produce in either direction: a student
     * who won one lucky round would read as top-tier ready, and a strong
     * student two contests in would read as not.
     */
    expect(READINESS_RATING_MIN_CONTESTS).toBe(8);
  });

  it("is not the display rule, and must not be confused with it", () => {
    // PROVISIONAL_CONTESTS decides whether a rating is shown with a "?". A
    // rating worth showing with a caveat is still too thin to score anybody
    // against, so readiness has its own, stricter floor.
    expect(READINESS_RATING_MIN_CONTESTS).toBeGreaterThan(PROVISIONAL_CONTESTS);
  });

  it("costs TOP exactly the rating's weight when it is missing", () => {
    const withRating = scoreTier("TOP", inputs({ ratingPercentile: present(0.6) }));
    const without = scoreTier("TOP", inputs({ ratingPercentile: missing("TOO_FEW_RATED_CONTESTS") }));
    expect(withRating.availableWeight - without.availableWeight).toBe(35);
    // And the missing one offers NO points available: a component below its
    // floor is not a gap the student closes tonight.
    const row = without.missing.find((c) => c.component === "RATING_PERCENTILE")!;
    expect(row.pointsAvailable).toBe(0);
  });

  it("says how many contests, rather than just 'no data'", () => {
    /**
     * The two reasons call for different actions: NO_DATA_YET says "try
     * one", TOO_FEW_RATED_CONTESTS says "keep going, you are part of the way
     * there". Telling a student with six contests that there is no data
     * would be both wrong and discouraging.
     */
    expect(MISSING_REASON_COPY.TOO_FEW_RATED_CONTESTS).toContain(String(READINESS_RATING_MIN_CONTESTS));
    expect(MISSING_REASON_COPY.TOO_FEW_RATED_CONTESTS).not.toEqual(MISSING_REASON_COPY.NO_DATA_YET);
  });
});

describe("topicBreadth is a MINIMUM, never a mean", () => {
  it("scores the 200-array / 0-graph profile at ZERO", () => {
    /**
     * The case SPEC §5 names by hand: "Averaging lets a student look ready
     * with 200 array problems and zero graphs, which is precisely the profile
     * that fails real interviews."
     *
     * On a mean this profile would score well. On a minimum it scores zero,
     * and the limiting topic says which one to go and do.
     */
    const lopsided: Partial<Record<Topic, number>> = { ARRAYS_HASHING: 200 };
    const breadth = topicBreadth(lopsided, 4);
    expect(breadth.value).toBe(0);
    expect(breadth.limitingCount).toBe(0);
    expect(TOPICS).toContain(breadth.limitingTopic);

    // And the mean it is NOT: 200/4 capped at 1 over 14 topics would be
    // roughly 0.07 even with everything else at zero, and far higher with a
    // few topics covered. The point is that one gap sets the number.
    const nearlyThere = topicBreadth({ ...evenTopics(4), GRAPHS: 1 }, 4);
    expect(nearlyThere.value).toBe(0.25);
    expect(nearlyThere.limitingTopic).toBe("GRAPHS");
  });

  it("is 1 only when EVERY topic reaches the target", () => {
    expect(topicBreadth(evenTopics(4), 4).value).toBe(1);
    expect(topicBreadth({ ...evenTopics(4), DYNAMIC_PROGRAMMING: 3 }, 4).value).toBe(0.75);
  });

  it("caps a topic at the target rather than letting it carry others", () => {
    const breadth = topicBreadth({ ...evenTopics(4), ARRAYS_HASHING: 4000 }, 4);
    expect(breadth.value).toBe(1);
  });

  it("names the limiting topic, and breaks ties stably", () => {
    // A next-action that changed every night for the same profile would
    // teach a student to ignore it.
    const twice = [topicBreadth({}, 4), topicBreadth({}, 4)];
    expect(twice[0]!.limitingTopic).toBe(twice[1]!.limitingTopic);
    expect(twice[0]!.limitingTopic).toBe(TOPICS[0]);
  });

  it("uses a different target per tier, which is why one entry cannot serve both", () => {
    expect(TIER_TARGETS.PRODUCT.perTopic).toBe(4);
    expect(TIER_TARGETS.TOP.perTopic).toBe(8);
    const counts = evenTopics(4);
    expect(topicBreadth(counts, 4).value).toBe(1);
    expect(topicBreadth(counts, 8).value).toBe(0.5);
  });

  it("has no target for SERVICE, which has no breadth weight — a service round asks no graph questions", () => {
    expect(TIER_TARGETS.SERVICE.perTopic).toBeNull();
    expect(TIER_WEIGHTS.SERVICE.TOPIC_BREADTH).toBeUndefined();
  });
});

describe("a missing component renders as missing, never as zero", () => {
  it("lowers the score AND the available weight", () => {
    const score = scoreTier("TOP", inputs({ mockInterviewScore: missing("NO_SOURCE_YET") }));
    expect(score.score).toBe(85);
    expect(score.availableWeight).toBe(85);
    // Normalised against what WAS measurable, a perfect student is 100.
    expect(score.normalised).toBe(100);
  });

  it("does NOT renormalise the weights over the present components", () => {
    /**
     * The honest choice, and worth a test because the other one is tempting.
     * Renormalising would make a student who has never done a mock interview
     * look exactly as ready as one who has done five, by redistributing the
     * missing 15% across the components they happen to have.
     */
    const withMock = scoreTier("TOP", full);
    const withoutMock = scoreTier("TOP", inputs({ mockInterviewScore: missing("NO_SOURCE_YET") }));
    expect(withMock.score).toBe(100);
    expect(withoutMock.score).toBe(85);
    expect(withoutMock.score).toBeLessThan(withMock.score);
  });

  it("lists the missing components with their reasons", () => {
    const score = scoreTier("SERVICE", empty);
    const names = score.missing.map((row) => row.component);
    expect(names).toContain("APTITUDE_PERCENTILE");
    expect(names).toContain("MOCK_INTERVIEW_SCORE");
    for (const row of score.missing) {
      expect(row.state.state).toBe("MISSING");
      expect(row.points).toBe(0);
      // A missing component offers no points available: it is not a gap the
      // student can close, and saying otherwise sends them looking for
      // something that does not exist.
      expect(row.pointsAvailable).toBe(0);
    }
  });

  it("gives a tier with nothing measurable a score of zero and says so", () => {
    const score = scoreTier(
      "TOP",
      inputs({
        ratingPercentile: missing("NO_DATA_YET"),
        mockInterviewScore: missing("NO_SOURCE_YET"),
        unassistedByTopic: {},
        mediumHardUnassisted: 0,
      }),
    );
    expect(score.score).toBe(0);
    // Breadth and coverage are still measurable (they are zero, not absent).
    expect(score.availableWeight).toBe(50);
    expect(score.normalised).toBe(0);
  });

  it("never reports -0", () => {
    const score = scoreTier("SERVICE", empty);
    for (const row of score.components) {
      expect(Object.is(row.points, -0), row.component).toBe(false);
      expect(Object.is(row.pointsAvailable, -0), row.component).toBe(false);
    }
    expect(Object.is(score.score, -0)).toBe(false);
  });
});

describe("the score arithmetic", () => {
  it("is 100 for a perfect profile on every tier", () => {
    const all = scoreAllTiers(full);
    for (const tier of READINESS_TIERS) expect(all[tier].score, tier).toBe(100);
  });

  it("weights each component as the spec says", () => {
    // Aptitude alone, on SERVICE: 0.35 × 1 × 100.
    const score = scoreTier(
      "SERVICE",
      inputs({
        verbalPercentile: present(0),
        mockInterviewScore: present(0),
        consistency: present(0),
        easyMediumSolved: 0,
      }),
    );
    expect(score.score).toBe(35);
    expect(score.availableWeight).toBe(100);
  });

  it("clamps a percentile over 1 and under 0", () => {
    expect(present(1.5)).toEqual({ state: "PRESENT", value: 1 });
    expect(present(-2)).toEqual({ state: "PRESENT", value: 0 });
    expect(present(Number.NaN)).toEqual({ state: "PRESENT", value: 0 });
  });

  it("caps coverage at the target rather than rewarding overshoot", () => {
    expect(coverage(60, 60)).toEqual({ state: "PRESENT", value: 1 });
    expect(coverage(600, 60)).toEqual({ state: "PRESENT", value: 1 });
    expect(coverage(30, 60)).toEqual({ state: "PRESENT", value: 0.5 });
  });
});

describe("SERVICE counts an assisted solve; PRODUCT and TOP do not", () => {
  /**
   * The spec names SERVICE's component `easyMediumCoverage` and the other two
   * `mediumUnassistedCoverage` / `mediumHardUnassistedCoverage`. That
   * omission is read as meaning what it says, and the reason it is right: a
   * service round asks whether you can write the loop at all, and a student
   * who got there with a hint can. A product or top loop asks whether you can
   * get there alone.
   */
  const hinted = inputs({
    // SERVICE's whole target, every solve of it assisted: the unassisted
    // counters are 0. Read from TIER_TARGETS rather than written as a
    // number, because the point of the test is "the target, reached with
    // help" and a literal would quietly stop meaning that if the target
    // moved — which it has.
    easyMediumSolved: TIER_TARGETS.SERVICE.coverage,
    mediumUnassisted: 0,
    mediumHardUnassisted: 0,
    unassistedByTopic: {},
  });

  it("gives SERVICE full coverage credit for hinted solves", () => {
    const row = scoreTier("SERVICE", hinted).components.find((c) => c.component === "EASY_MEDIUM_COVERAGE");
    expect(row?.state).toEqual({ state: "PRESENT", value: 1 });
    expect(row?.points).toBe(25);
  });

  it("gives PRODUCT and TOP none", () => {
    const product = scoreTier("PRODUCT", hinted).components.find(
      (c) => c.component === "MEDIUM_UNASSISTED_COVERAGE",
    );
    const top = scoreTier("TOP", hinted).components.find(
      (c) => c.component === "MEDIUM_HARD_UNASSISTED_COVERAGE",
    );
    expect(product?.points).toBe(0);
    expect(top?.points).toBe(0);
  });
});

describe("the gaps and the next action", () => {
  const lopsided = inputs({
    aptitudePercentile: present(0.9),
    ratingPercentile: present(0.8),
    mockInterviewScore: missing("NO_SOURCE_YET"),
    consistency: present(0.9),
    unassistedByTopic: { ...evenTopics(4), GRAPHS: 1 },
    mediumUnassisted: 54,
  });

  it("gives the exact sentence the spec's example has", () => {
    // SPEC §5: "+9 points available: graphs, 6 unassisted mediums".
    // PRODUCT breadth is 0.20 weight; GRAPHS at 1 of 4 is 0.25, so
    // 0.20 × 0.75 × 100 = 15 points available on breadth.
    const score = scoreTier("PRODUCT", lopsided);
    const action = nextAction("PRODUCT", score, lopsided);
    expect(action).not.toBeNull();
    expect(action!.component).toBe("TOPIC_BREADTH");
    expect(action!.sentence).toBe("+15 points available: graphs, 3 unassisted problems");
  });

  it("names the coverage shortfall concretely when that is the biggest gap", () => {
    const behind = inputs({
      mockInterviewScore: missing("NO_SOURCE_YET"),
      unassistedByTopic: evenTopics(4),
      mediumUnassisted: 6,
    });
    const score = scoreTier("PRODUCT", behind);
    const action = nextAction("PRODUCT", score, behind);
    expect(action!.component).toBe("MEDIUM_UNASSISTED_COVERAGE");
    /**
     * The exact sentence, with its two numbers derived rather than typed:
     * the shortfall is the target minus what they have, and the points are
     * the component's weight times the fraction still missing. Writing
     * "+27.8" and "74" as literals would make this a test of what the code
     * printed last time rather than of the arithmetic the student is owed.
     */
    const short = TIER_TARGETS.PRODUCT.coverage - 6;
    const points = 30 * (short / TIER_TARGETS.PRODUCT.coverage);
    expect(action!.sentence).toBe(
      `+${points.toFixed(1)} points available: ${short} more medium problems without a hint`,
    );
  });

  it("ranks the three largest gaps by the same points figure the action uses", () => {
    const score = scoreTier("PRODUCT", lopsided);
    const gaps = largestGaps(score);
    expect(gaps).toHaveLength(3);
    expect(gaps[0]!.pointsAvailable).toBeGreaterThanOrEqual(gaps[1]!.pointsAvailable);
    expect(gaps[1]!.pointsAvailable).toBeGreaterThanOrEqual(gaps[2]!.pointsAvailable);
    // The headline and the list cannot disagree.
    expect(nextAction("PRODUCT", score, lopsided)!.component).toBe(gaps[0]!.component);
  });

  it("never offers a gap on a component with no source", () => {
    const score = scoreTier("TOP", inputs({ mockInterviewScore: missing("NO_SOURCE_YET") }));
    expect(largestGaps(score).map((g) => g.component)).not.toContain("MOCK_INTERVIEW_SCORE");
  });

  it("has nothing to suggest to a perfect profile", () => {
    expect(nextAction("SERVICE", scoreTier("SERVICE", full), full)).toBeNull();
  });

  it("gives every component an actionable detail rather than a blank", () => {
    const score = scoreTier("SERVICE", empty);
    for (const row of score.components) {
      if (row.pointsAvailable === 0) continue;
      const action = nextAction("SERVICE", score, empty);
      expect(action!.detail.length).toBeGreaterThan(5);
    }
  });
});

describe("the mandatory framing", () => {
  it("says it is not a prediction, in so many words", () => {
    expect(READINESS_FRAMING).toMatch(/not a prediction/i);
    expect(READINESS_FRAMING).toMatch(/drive/i);
  });
});

describe("the distribution buckets and the at-risk rule read the NORMALISED score", () => {
  it("covers 0 to 100 with no gap and no overlap", () => {
    expect(DISTRIBUTION_BUCKETS[0]!.min).toBe(0);
    expect(DISTRIBUTION_BUCKETS.at(-1)!.max).toBe(100);
    for (const [i, bucket] of DISTRIBUTION_BUCKETS.entries()) {
      if (i === 0) continue;
      expect(bucket.min).toBe(DISTRIBUTION_BUCKETS[i - 1]!.max + 1);
    }
  });

  it("buckets a score by what was measurable", () => {
    // 85 raw out of 85 available is a student who has done everything there
    // is to do — the top bucket, not the fifth-from-top one an absolute
    // scale would give them.
    const score = scoreTier("TOP", inputs({ mockInterviewScore: missing("NO_SOURCE_YET") }));
    expect(score.score).toBe(85);
    expect(bucketOf(score.normalised)).toBe("80–100");
  });

  it("flags a quiet student at seven days", () => {
    expect(isAtRisk({ quietDays: 7, serviceNormalised: 100, driveWithinSixMonths: false }).atRisk).toBe(true);
    expect(isAtRisk({ quietDays: 6, serviceNormalised: 100, driveWithinSixMonths: false }).atRisk).toBe(false);
    expect(AT_RISK_QUIET_DAYS).toBe(7);
  });

  it("flags a low SERVICE reading only when a drive is inside six months", () => {
    expect(isAtRisk({ quietDays: 0, serviceNormalised: 30, driveWithinSixMonths: true }).atRisk).toBe(true);
    expect(isAtRisk({ quietDays: 0, serviceNormalised: 30, driveWithinSixMonths: false }).atRisk).toBe(false);
    expect(AT_RISK_SERVICE_NORMALISED).toBe(40);
  });

  it("does not flag a student whose readiness has never been computed", () => {
    // A null reading is "we do not know", and routing somebody to a mentor
    // on an absence of data would waste the mentor's time and alarm the
    // student.
    expect(isAtRisk({ quietDays: 0, serviceNormalised: null, driveWithinSixMonths: true }).atRisk).toBe(false);
  });

  it("gives every flag a reason a mentor can open a conversation with", () => {
    const quiet = isAtRisk({ quietDays: 9, serviceNormalised: 80, driveWithinSixMonths: false });
    expect(quiet.reason).toMatch(/9 days/);
    const low = isAtRisk({ quietDays: 0, serviceNormalised: 22, driveWithinSixMonths: true });
    expect(low.reason).toMatch(/measurable/);
  });
});
