import { describe, expect, it } from "vitest";
import { TOPICS, type Topic } from "../src/topics";
import {
  READINESS_TIERS,
  TIER_TARGETS,
  coverage,
  missing,
  nextAction,
  present,
  scoreAllTiers,
  type ReadinessInputs,
  type ReadinessTier,
} from "../src/readiness";
import {
  READINESS_EMPTY_STATES,
  READINESS_STALE_AFTER_DAYS,
  READINESS_WILL_COUNT,
  inputsFromSnapshot,
  isStale,
  rebuildSnapshot,
  snapshotDisagreements,
  storedComponentsSchema,
  topicCounts,
} from "../src/readiness-snapshot";

/**
 * The round trip, which is the only reason this module exists.
 *
 * The nightly job stores the component breakdown; every surface rebuilds the
 * inputs from it and re-scores with the SAME `scoreTier`. If the rebuild and
 * the stored scalar columns ever disagree, a student's card and the officer
 * dashboard show different numbers for the same person — so the tests below
 * are mostly one assertion made several ways.
 */

/** The job's own serialisation, lifted so the tests exercise the real shape. */
function storeOf(inputs: ReadinessInputs) {
  const scores = scoreAllTiers(inputs);
  const components: Record<string, unknown> = {};
  for (const tier of READINESS_TIERS) {
    const perComponent: Record<string, unknown> = {};
    for (const row of scores[tier].components) {
      perComponent[row.component] =
        row.state.state === "PRESENT"
          ? {
              state: "PRESENT",
              value: row.state.value,
              weight: row.weight,
              points: row.points,
              ...(row.limitingTopic
                ? { limitingTopic: row.limitingTopic, perTopicTarget: row.perTopicTarget }
                : {}),
            }
          : { state: "MISSING", reason: row.state.reason, weight: row.weight };
    }
    components[tier] = perComponent;
  }
  const column = (tier: ReadinessTier) =>
    scores[tier].availableWeight === 0 ? null : Math.round(scores[tier].score);
  return {
    components,
    topicUnassisted: Object.fromEntries(TOPICS.map((t) => [t, inputs.unassistedByTopic[t] ?? 0])),
    serviceScore: column("SERVICE"),
    productScore: column("PRODUCT"),
    topScore: column("TOP"),
    serviceAvailableWeight: Math.round(scores.SERVICE.availableWeight),
    productAvailableWeight: Math.round(scores.PRODUCT.availableWeight),
    topAvailableWeight: Math.round(scores.TOP.availableWeight),
  };
}

const evenTopics = (n: number) =>
  Object.fromEntries(TOPICS.map((t) => [t, n])) as Partial<Record<Topic, number>>;

/**
 * The spec's own fixture: 200 arrays, no graphs. The profile that looks
 * strong on an average and fails on the first graph question.
 */
const LOPSIDED: ReadinessInputs = {
  aptitudePercentile: present(0.62),
  verbalPercentile: present(0.44),
  ratingPercentile: missing("NO_DATA_YET"),
  mockInterviewScore: missing("NO_SOURCE_YET"),
  consistency: present(0.5),
  unassistedByTopic: { ...evenTopics(6), ARRAYS_HASHING: 200, GRAPHS: 0 },
  easyMediumSolved: 212,
  mediumUnassisted: 54,
  mediumHardUnassisted: 18,
};

/** Everything measurable and everything short, for the all-present case. */
const MIDDLING: ReadinessInputs = {
  aptitudePercentile: present(0.5),
  verbalPercentile: present(0.5),
  ratingPercentile: present(0.4),
  mockInterviewScore: present(0.3),
  consistency: present(0.25),
  unassistedByTopic: evenTopics(3),
  easyMediumSolved: 40,
  mediumUnassisted: 30,
  mediumHardUnassisted: 20,
};

/** Nothing at all: a brand-new account the night after it was created. */
const EMPTY: ReadinessInputs = {
  aptitudePercentile: missing("NO_DATA_YET"),
  verbalPercentile: missing("NO_DATA_YET"),
  ratingPercentile: missing("NO_DATA_YET"),
  mockInterviewScore: missing("NO_SOURCE_YET"),
  consistency: missing("NO_DATA_YET"),
  unassistedByTopic: {},
  easyMediumSolved: 0,
  mediumUnassisted: 0,
  mediumHardUnassisted: 0,
};

describe("a stored snapshot rebuilds to the numbers it was stored with", () => {
  for (const [name, inputs] of [
    ["the lopsided 200-arrays profile", LOPSIDED],
    ["a middling profile with every component present", MIDDLING],
    ["a brand-new account with nothing measurable", EMPTY],
  ] as const) {
    it(`agrees with every scalar column: ${name}`, () => {
      const stored = storeOf(inputs);
      const { tiers } = rebuildSnapshot(stored);
      // Returns the disagreements rather than a boolean, so a failure here
      // names the column and both numbers.
      expect(snapshotDisagreements(tiers, stored)).toEqual([]);
    });
  }

  it("recovers the coverage counts exactly below the target", () => {
    const stored = storeOf(LOPSIDED);
    const rebuilt = inputsFromSnapshot(stored);
    // 54 of 60 and 18 of 50 — both under target, so both come back exactly.
    expect(rebuilt.mediumUnassisted).toBe(54);
    expect(rebuilt.mediumHardUnassisted).toBe(18);
  });

  it("caps a met coverage at the target, which costs nothing", () => {
    /**
     * 212 easy-or-mediums against a target of 80: `coverage` clamps at 1 and
     * the surplus is gone. That is not a rounding compromise — a component at
     * its target leaves zero points available, so it never reaches a gap list
     * or a next action, and the recovered count is only ever used for the
     * "N more problems" sentence.
     */
    const rebuilt = inputsFromSnapshot(storeOf(LOPSIDED));
    expect(rebuilt.easyMediumSolved).toBe(TIER_TARGETS.SERVICE.coverage);
    const scores = scoreAllTiers(rebuilt);
    const row = scores.SERVICE.components.find((c) => c.component === "EASY_MEDIUM_COVERAGE")!;
    expect(row.pointsAvailable).toBe(0);
  });

  it("recovers all fourteen breadth counts, including the zero", () => {
    const rebuilt = inputsFromSnapshot(storeOf(LOPSIDED));
    expect(rebuilt.unassistedByTopic.ARRAYS_HASHING).toBe(200);
    expect(rebuilt.unassistedByTopic.GRAPHS).toBe(0);
    expect(Object.keys(rebuilt.unassistedByTopic).sort()).toEqual([...TOPICS].sort());
  });

  it("keeps the next action identical after a round trip", () => {
    // The sentence a student acts on must survive storage unchanged, or the
    // card tells them something different from what the run decided.
    const fresh = nextAction("PRODUCT", scoreAllTiers(LOPSIDED).PRODUCT, LOPSIDED);
    const stored = storeOf(LOPSIDED);
    const back = rebuildSnapshot(stored);
    expect(nextAction("PRODUCT", back.tiers.PRODUCT, back.inputs)).toEqual(fresh);
    expect(fresh?.sentence).toContain("graphs");
  });

  it("carries a MISSING reason across unchanged, so the card says which kind", () => {
    const rebuilt = inputsFromSnapshot(storeOf(LOPSIDED));
    // NO_SOURCE_YET is not the student's to fix; NO_DATA_YET is. Collapsing
    // the two would send a student looking for a mock-interview scheduler
    // that does not exist.
    expect(rebuilt.mockInterviewScore).toEqual(missing("NO_SOURCE_YET"));
    expect(rebuilt.ratingPercentile).toEqual(missing("NO_DATA_YET"));
  });

  it("reports a disagreement rather than swallowing it", () => {
    // The self-test: break one column and the checker must name it.
    const stored = storeOf(MIDDLING);
    const { tiers } = rebuildSnapshot(stored);
    const broken = { ...stored, topScore: (stored.topScore ?? 0) + 7 };
    const found = snapshotDisagreements(tiers, broken);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("TOP: stored score");
  });
});

describe("the stored component schema", () => {
  it("accepts what the job writes", () => {
    expect(storedComponentsSchema.safeParse(storeOf(MIDDLING).components).success).toBe(true);
  });

  it("refuses a value outside 0..1, which would be a weight mistaken for a value", () => {
    const parsed = storedComponentsSchema.safeParse({
      SERVICE: { CONSISTENCY: { state: "PRESENT", value: 35, weight: 0.1, points: 3.5 } },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a MISSING entry with no reason", () => {
    const parsed = storedComponentsSchema.safeParse({
      SERVICE: { CONSISTENCY: { state: "MISSING", weight: 0.1 } },
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses an unknown state outright rather than defaulting it", () => {
    const parsed = storedComponentsSchema.safeParse({
      SERVICE: { CONSISTENCY: { state: "ZERO", weight: 0.1 } },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("topicCounts narrows a stored row to the taxonomy this build knows", () => {
  it("keeps every known topic and drops the rest", () => {
    const counts = topicCounts({ GRAPHS: 4, SEGMENT_TREES: 9 });
    expect(counts.GRAPHS).toBe(4);
    expect(Object.keys(counts)).toEqual(["GRAPHS"]);
  });

  it("returns an empty set for a row it cannot read, rather than throwing", () => {
    // An old row is unreadable, not fatal: the page shows zero breadth
    // counts, and the tier scores come from `components` regardless.
    expect(topicCounts(null)).toEqual({});
    expect(topicCounts({ GRAPHS: "four" })).toEqual({});
  });
});

describe("a stale figure is labelled stale, and a fresh one is not", () => {
  it("is not stale the morning after, or the evening after that", () => {
    // The job runs at 02:30, so the normal case is under 24 hours old. A
    // "stale" label on the normal case teaches students to ignore the label.
    expect(isStale("2026-10-20", "2026-10-20")).toBe(false);
    expect(isStale("2026-10-20", "2026-10-21")).toBe(false);
    expect(isStale("2026-10-20", "2026-10-22")).toBe(false);
  });

  it("is stale once the nightly run has missed", () => {
    expect(isStale("2026-10-20", "2026-10-23")).toBe(true);
    expect(READINESS_STALE_AFTER_DAYS).toBe(2);
  });

  it("is not stale for a date in the future, which is a clock problem", () => {
    expect(isStale("2026-10-25", "2026-10-20")).toBe(false);
  });

  it("does not throw on an unparseable day", () => {
    expect(isStale("not-a-day", "2026-10-20")).toBe(false);
  });
});

describe("the empty states say which of the three causes it is", () => {
  it("never shows a zero, in either state's copy", () => {
    for (const state of Object.values(READINESS_EMPTY_STATES)) {
      expect(state.body).not.toMatch(/\b0\b|\bzero\b/i);
      expect(state.heading.length).toBeGreaterThan(10);
    }
  });

  it("tells a new student what it will be computed FROM", () => {
    expect(READINESS_EMPTY_STATES.NONE.body).toMatch(/overnight/);
    expect(READINESS_WILL_COUNT.length).toBeGreaterThanOrEqual(4);
    // The distinction the whole scoring rests on, said in the list.
    expect(READINESS_WILL_COUNT.join(" ")).toMatch(/without a hint/);
    expect(READINESS_WILL_COUNT.join(" ")).toMatch(/fourteen topics/);
  });

  it("offers a graduate the thing they actually want", () => {
    expect(READINESS_EMPTY_STATES.EXCLUDED.cta).toMatch(/signed/i);
  });

  it("never calls a missing figure a failure, in any copy here", () => {
    const all = [
      ...Object.values(READINESS_EMPTY_STATES).flatMap((s) => [s.heading, s.body, s.cta]),
      ...READINESS_WILL_COUNT,
    ].join(" ");
    expect(all).not.toMatch(/\b(fail|failing|behind|at risk|weak|poor)\b/i);
  });
});

describe("a component at its target is not a gap", () => {
  it("leaves no points available once coverage reaches 1", () => {
    // Guards the arithmetic the recovered-count cap depends on.
    expect(coverage(80, 80)).toEqual(present(1));
    expect(coverage(200, 80)).toEqual(present(1));
  });
});
