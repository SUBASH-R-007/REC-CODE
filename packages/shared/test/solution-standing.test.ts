import { describe, expect, it } from "vitest";
import {
  MIN_RANKED_PEERS,
  STANDING_BANDS,
  STANDING_REFUSAL_SENTENCE,
  growthShares,
  rankSolution,
  standingBands,
  standingSentence,
  type PeerSolution,
  type SolutionStanding,
} from "../src/solution-standing";
import { COMPLEXITY_CLASSES, type ComplexityClass } from "../src/complexity";

/** Phase 17. A position quoted against too few peers, or against the wrong peers, is worse than none. */

function peers(count: number, shape: (k: number) => Partial<PeerSolution> = () => ({})): PeerSolution[] {
  return Array.from({ length: count }, (_, k) => ({
    ms: 100 + k * 10,
    kb: 2048 + k * 64,
    growth: null,
    ...shape(k),
  }));
}

function rankedOrThrow(outcome: ReturnType<typeof rankSolution>): SolutionStanding {
  if (!outcome.ranked) throw new Error(`expected a ranking, got ${outcome.reason}`);
  return outcome;
}

describe("rankSolution", () => {
  it(`refuses below ${MIN_RANKED_PEERS} peers`, () => {
    const outcome = rankSolution({ mine: { ms: 90, kb: 2000, growth: "LINEAR" }, peers: peers(MIN_RANKED_PEERS - 1) });
    expect(outcome).toEqual({ ranked: false, reason: "TOO_FEW_PEERS", peers: MIN_RANKED_PEERS - 1 });
  });

  it("refuses when nobody else has solved it", () => {
    expect(rankSolution({ mine: { ms: 90, kb: 2000, growth: null }, peers: [] })).toMatchObject({
      ranked: false,
      peers: 0,
    });
  });

  it(`ranks at exactly ${MIN_RANKED_PEERS} peers`, () => {
    const standing = rankedOrThrow(
      rankSolution({ mine: { ms: 90, kb: 2000, growth: null }, peers: peers(MIN_RANKED_PEERS) }),
    );
    expect(standing.peers).toBe(MIN_RANKED_PEERS);
    // The population includes this submission: the student is one of the
    // accepted solutions being compared.
    expect(standing.time.population).toBe(MIN_RANKED_PEERS + 1);
  });

  it("places the fastest solution near the top but never at 100%", () => {
    const standing = rankedOrThrow(rankSolution({ mine: { ms: 1, kb: 1, growth: null }, peers: peers(20) }));
    expect(standing.time.betterThan).toBeCloseTo(1 - 0.5 / 21, 10);
    expect(standing.time.betterThan).toBeLessThan(1);
    expect(standingSentence(standing.time, "Faster", "C++")).toBe("Faster than 98% of the 21 accepted C++ solutions here.");
  });

  it("places the slowest solution at the bottom", () => {
    const standing = rankedOrThrow(rankSolution({ mine: { ms: 9999, kb: 999_999, growth: null }, peers: peers(20) }));
    expect(standing.time.betterThan).toBeCloseTo(0.5 / 21, 10);
  });

  it("puts a tied group in the middle of the band it occupies", () => {
    // Twenty identical peers and an identical submission: nobody is faster
    // than anybody, so the only honest answer is the middle.
    const standing = rankedOrThrow(
      rankSolution({ mine: { ms: 100, kb: 2048, growth: null }, peers: peers(20, () => ({ ms: 100, kb: 2048 })) }),
    );
    expect(standing.time.betterThan).toBeCloseTo(0.5, 10);
  });

  it("reports the best and the median of the population", () => {
    const standing = rankedOrThrow(
      rankSolution({ mine: { ms: 300, kb: 5000, growth: null }, peers: peers(20) }),
    );
    expect(standing.time.best).toBe(100);
    // Twenty-one readings: 100..290 by ten, plus 300. The eleventh is 200.
    expect(standing.time.median).toBe(200);
  });

  it("averages the middle pair when the population is even", () => {
    const standing = rankedOrThrow(
      rankSolution({ mine: { ms: 1000, kb: 9000, growth: null }, peers: peers(MIN_RANKED_PEERS + 1) }),
    );
    expect(standing.time.population % 2).toBe(0);
    expect(standing.time.median).toBe(205);
  });

  it("holds only finite numbers, so the whole shape survives JSON", () => {
    const standing = rankedOrThrow(
      rankSolution({
        mine: { ms: 0, kb: 0, growth: "LINEAR" },
        peers: peers(40, (k) => ({ ms: k === 0 ? 0 : k * 37, kb: 1, growth: "LINEAR" })),
      }),
    );
    expect(JSON.parse(JSON.stringify(standing))).toEqual(standing);
  });

  it("ranks time and memory independently", () => {
    // Fast and greedy: top on time, bottom on memory. One number must not
    // be allowed to speak for the other.
    const standing = rankedOrThrow(
      rankSolution({ mine: { ms: 1, kb: 999_999, growth: null }, peers: peers(20) }),
    );
    expect(standing.time.betterThan).toBeGreaterThan(0.9);
    expect(standing.space.betterThan).toBeLessThan(0.1);
  });
});

describe("standingBands", () => {
  it("counts every reading once, in ascending log-spaced bands", () => {
    const values = [10, 12, 15, 20, 40, 80, 160, 300, 700, 1200, 5000];
    const bands = standingBands(values, 40);
    expect(bands).toHaveLength(STANDING_BANDS);
    expect(bands.reduce((sum, b) => sum + b.count, 0)).toBe(values.length);
    for (let k = 1; k < bands.length; k++) expect(bands[k]!.from).toBeGreaterThanOrEqual(bands[k - 1]!.from);
    expect(bands.filter((b) => b.mine)).toHaveLength(1);
  });

  it("marks the band the submission falls in", () => {
    const bands = standingBands([10, 100, 1000], 1000);
    expect(bands.at(-1)!.mine).toBe(true);
    expect(standingBands([10, 100, 1000], 10)[0]!.mine).toBe(true);
  });

  it("is one band when every reading is identical", () => {
    const bands = standingBands([50, 50, 50], 50);
    expect(bands).toEqual([{ from: 50, to: 50, count: 3, mine: true }]);
  });

  it("clamps a zero reading to the judge's own resolution rather than taking log(0)", () => {
    const bands = standingBands([0, 0, 10, 100], 0);
    expect(bands).toHaveLength(STANDING_BANDS);
    for (const band of bands) {
      expect(Number.isFinite(band.from)).toBe(true);
      expect(Number.isFinite(band.to)).toBe(true);
    }
    expect(bands.reduce((sum, b) => sum + b.count, 0)).toBe(4);
    expect(bands[0]!.mine).toBe(true);
  });

  it("puts the heavy tail in its own bands rather than the first one", () => {
    // The whole reason for a log scale: twenty fast solutions and one slow
    // one must not render as a single bar.
    const values = [...Array.from({ length: 20 }, (_, k) => 10 + k), 4000];
    const bands = standingBands(values, 11);
    expect(bands[0]!.count).toBeLessThan(values.length);
    expect(bands.at(-1)!.count).toBe(1);
  });
});

describe("growthShares", () => {
  const measured = (growth: ComplexityClass, count: number): PeerSolution[] =>
    Array.from({ length: count }, () => ({ ms: 100, kb: 2048, growth }));

  it("ascends the ladder and leaves out classes nobody reached", () => {
    const shares = growthShares([...measured("LINEARITHMIC", 7), ...measured("LINEAR", 3)], "LINEAR");
    expect(shares.map((s) => s.growth)).toEqual(["LINEAR", "LINEARITHMIC"]);
    expect(shares.map((s) => s.count)).toEqual([3, 7]);
    expect(shares.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10);
    expect(shares.filter((s) => s.mine).map((s) => s.growth)).toEqual(["LINEAR"]);
  });

  it("keeps this submission's own class even when no peer reached it", () => {
    const shares = growthShares(measured("LINEARITHMIC", 9), "CUBIC");
    expect(shares.map((s) => s.growth)).toEqual(["LINEARITHMIC", "CUBIC"]);
    expect(shares.find((s) => s.growth === "CUBIC")).toMatchObject({ count: 0, share: 0, mine: true });
  });

  it("divides by the peers whose growth was measured, not by every peer", () => {
    const peerList = [...measured("LINEAR", 2), ...peers(8)];
    const shares = growthShares(peerList, null);
    expect(shares).toEqual([{ growth: "LINEAR", count: 2, share: 1, mine: false }]);
  });

  it("marks nothing when this submission's own growth was not measured", () => {
    expect(growthShares(measured("QUADRATIC", 4), null).every((s) => !s.mine)).toBe(true);
  });

  it("is null on the standing when no peer's growth could be measured", () => {
    const standing = rankedOrThrow(rankSolution({ mine: { ms: 90, kb: 2000, growth: "LINEAR" }, peers: peers(25) }));
    expect(standing.growth).toBeNull();
    expect(standing.growthUnmeasured).toBe(25);
  });

  it("counts the peers it could not measure, so a share is readable", () => {
    const peerList = [...measured("LINEAR", 12), ...peers(13)];
    const standing = rankedOrThrow(rankSolution({ mine: { ms: 90, kb: 2000, growth: "LINEAR" }, peers: peerList }));
    expect(standing.growthUnmeasured).toBe(13);
    expect(standing.growth).toEqual([{ growth: "LINEAR", count: 12, share: 1, mine: true }]);
  });

  it("covers every class in the ladder", () => {
    const peerList = COMPLEXITY_CLASSES.flatMap((growth) => measured(growth, 4));
    const shares = growthShares(peerList, null);
    expect(shares.map((s) => s.growth)).toEqual([...COMPLEXITY_CLASSES]);
  });
});

describe("copy", () => {
  it("caps the sentence at 99% however large the population", () => {
    const standing = rankedOrThrow(
      rankSolution({ mine: { ms: 1, kb: 1, growth: null }, peers: peers(5000, (k) => ({ ms: 50 + k })) }),
    );
    expect(standing.time.betterThan).toBeGreaterThan(0.999);
    expect(standingSentence(standing.time, "Faster", "Python 3")).toContain("99%");
    expect(standingSentence(standing.time, "Faster", "Python 3")).not.toContain("100%");
  });

  it("says what the refusal is waiting for", () => {
    expect(STANDING_REFUSAL_SENTENCE.TOO_FEW_PEERS).toContain(String(MIN_RANKED_PEERS));
  });
});
