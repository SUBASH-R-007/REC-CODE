import { describe, expect, it } from "vitest";
import {
  competitionRanks,
  computeRatingChanges,
  divisionOf,
  isProvisional,
  MIN_RATED_PARTICIPANTS,
  PROVISIONAL_CONTESTS,
  RATING_CLAMP,
  RATING_SEED,
  seedOf,
  type RatingParticipant,
} from "../src/rating";

/**
 * Phase 5 gate test (SPEC §5, Phase 5 "Done when"): "a rating unit test
 * reproduces a known Codeforces-shaped fixture and asserts Σdelta ≈ 0 and
 * the top-set constraint".
 *
 * "Codeforces-shaped" is taken as the shape of the algorithm's own
 * guarantees, not scraped numbers from a real round: a field of mixed
 * ratings, competition ranks with ties, and the invariants the formula is
 * supposed to hold. Those invariants are asserted directly, which is
 * stronger than matching one historical table.
 */

const RATINGS = [
  2850, 2740, 2610, 2520, 2480, 2390, 2330, 2280, 2210, 2160, 2090, 2040, 1980, 1930, 1880, 1840, 1790, 1750,
  1710, 1680, 1640, 1600, 1570, 1530, 1500, 1460, 1430, 1400, 1370, 1330, 1300, 1260, 1220, 1180, 1140, 1100,
  1050, 1000, 950, 900,
] as const;

/**
 * A 40-participant field: ratings 900..2850, finishing mostly by strength
 * with LOCAL upsets (a few places, not a few dozen) — which is what a real
 * round looks like, and what keeps every delta inside the ±200 clamp. An
 * extreme field is tested separately below, because the clamp is applied
 * last and deliberately overrides the zero-sum property.
 */
function fixture(): RatingParticipant[] {
  const order = [...RATINGS.keys()];
  const swap = (a: number, b: number) => {
    [order[a], order[b]] = [order[b]!, order[a]!];
  };
  swap(2, 5);
  swap(9, 12);
  swap(17, 21);
  swap(26, 30);
  swap(33, 36);
  return order.map((ratingIndex, position) => ({
    userId: `u${ratingIndex}`,
    rating: RATINGS[ratingIndex]!,
    rank: position + 1,
  }));
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe("constants", () => {
  it("match the specification", () => {
    expect(RATING_SEED).toBe(1200);
    expect(MIN_RATED_PARTICIPANTS).toBe(30);
    expect(RATING_CLAMP).toBe(200);
    expect(PROVISIONAL_CONTESTS).toBe(5);
  });
});

describe("divisions", () => {
  it.each([
    [900, "DIV3"],
    [1399, "DIV3"],
    [1400, "DIV2"],
    [1799, "DIV2"],
    [1800, "DIV1"],
    [3000, "DIV1"],
  ])("%d is %s", (rating, division) => expect(divisionOf(rating)).toBe(division));

  it("is provisional for the first five rated contests", () => {
    expect([0, 1, 2, 3, 4].map(isProvisional)).toEqual([true, true, true, true, true]);
    expect(isProvisional(5)).toBe(false);
  });
});

describe("seedOf", () => {
  it("is 1 against an empty field (nobody can beat you)", () => {
    expect(seedOf(1500, [])).toBe(1);
  });

  it("is 1.5 against one equal rating (a coin flip)", () => {
    expect(seedOf(1500, [1500])).toBeCloseTo(1.5, 10);
  });

  it("falls as the rating rises", () => {
    const field = [1200, 1500, 1800, 2100];
    const seeds = [1000, 1500, 2000, 2500].map((r) => seedOf(r, field));
    for (let i = 1; i < seeds.length; i++) expect(seeds[i]!).toBeLessThan(seeds[i - 1]!);
  });

  it("a 400-point gap is a 10:1 favourite", () => {
    expect(seedOf(1900, [1500])).toBeCloseTo(1 + 1 / 11, 10);
  });
});

describe("the Codeforces-shaped fixture", () => {
  const participants = fixture();
  const results = computeRatingChanges(participants);

  it("rates every participant exactly once, in input order", () => {
    expect(results).toHaveLength(participants.length);
    expect(results.map((r) => r.userId)).toEqual(participants.map((p) => p.userId));
  });

  it("no delta is clamped (so the zero-sum assertion below means something)", () => {
    for (const r of results) expect(Math.abs(r.delta)).toBeLessThan(RATING_CLAMP);
  });

  it("Σdelta ≈ 0 — the field is zero-sum", () => {
    // Integer rounding leaves at most half a point per participant.
    expect(Math.abs(sum(results.map((r) => r.delta)))).toBeLessThanOrEqual(participants.length / 2);
  });

  it("the top set by pre-contest rating does not gain overall", () => {
    const n = participants.length;
    const topSize = Math.min(n, Math.round(4 * Math.sqrt(n)));
    const top = [...results]
      .sort((a, b) => b.before - a.before || a.userId.localeCompare(b.userId))
      .slice(0, topSize);
    expect(top).toHaveLength(topSize);
    // ≤ 0 up to the same rounding slack.
    expect(sum(top.map((r) => r.delta))).toBeLessThanOrEqual(topSize / 2);
  });

  it("no delta exceeds the clamp", () => {
    for (const r of results) expect(Math.abs(r.delta)).toBeLessThanOrEqual(RATING_CLAMP);
  });

  it("after = before + delta, all integers", () => {
    for (const r of results) {
      expect(Number.isInteger(r.after)).toBe(true);
      expect(Number.isInteger(r.delta)).toBe(true);
      expect(r.after).toBe(r.before + r.delta);
    }
  });

  it("stores a seed per participant, for the dispute trail", () => {
    for (const r of results) {
      expect(r.seed).toBeGreaterThan(0);
      expect(r.seed).toBeLessThanOrEqual(participants.length);
    }
  });

  it("is deterministic — the same field twice gives the same deltas", () => {
    expect(computeRatingChanges(fixture())).toEqual(results);
  });

  it("beating your seed gains rating; finishing below it loses", () => {
    for (const r of results) {
      if (r.rank < Math.floor(r.seed) - 1) expect(r.delta).toBeGreaterThan(0);
      if (r.rank > Math.ceil(r.seed) + 1) expect(r.delta).toBeLessThan(0);
    }
  });
});

describe("the clamp is applied last, and overrides zero-sum", () => {
  /** The same ratings, but the field finishes in reverse: every upset at once. */
  const reversed = [...RATINGS.keys()]
    .reverse()
    .map((ratingIndex, position) => ({
      userId: `u${ratingIndex}`,
      rating: RATINGS[ratingIndex]!,
      rank: position + 1,
    }));
  const results = computeRatingChanges(reversed);

  it("binds on an extreme field", () => {
    expect(results.some((r) => Math.abs(r.delta) === RATING_CLAMP)).toBe(true);
  });

  it("never exceeds ±200, whatever the field does", () => {
    for (const r of results) expect(Math.abs(r.delta)).toBeLessThanOrEqual(RATING_CLAMP);
  });

  it("the excess is discarded, so Σdelta is no longer ≈ 0 — the clamp wins", () => {
    // Recorded in docs/OPEN-QUESTIONS.md: the specification orders the clamp
    // last, so in a field this extreme the safety bound takes precedence
    // over the zero-sum property. Asserted so the trade-off is visible and
    // cannot change unnoticed.
    expect(Math.abs(sum(results.map((r) => r.delta)))).toBeGreaterThan(reversed.length / 2);
  });
});

describe("ordering and ties", () => {
  it("winning outright against equals gains the most", () => {
    const field: RatingParticipant[] = Array.from({ length: 10 }, (_, i) => ({
      userId: `u${i}`,
      rating: 1500,
      rank: i + 1,
    }));
    const results = computeRatingChanges(field);
    const deltas = results.map((r) => r.delta);
    expect(deltas[0]).toBeGreaterThan(0);
    expect(deltas[9]).toBeLessThan(0);
    for (let i = 1; i < deltas.length; i++) expect(deltas[i]!).toBeLessThanOrEqual(deltas[i - 1]!);
  });

  it("tied participants with the same rating get the same delta", () => {
    const field: RatingParticipant[] = [
      { userId: "a", rating: 1600, rank: 1 },
      { userId: "b", rating: 1500, rank: 2 },
      { userId: "c", rating: 1500, rank: 2 },
      { userId: "d", rating: 1400, rank: 4 },
    ];
    const [, b, c] = computeRatingChanges(field);
    expect(b!.delta).toBe(c!.delta);
  });

  it("a single participant cannot move (they are their own field)", () => {
    const [only] = computeRatingChanges([{ userId: "a", rating: 1500, rank: 1 }]);
    expect(only!.delta).toBe(0);
    expect(only!.after).toBe(1500);
  });

  it("an empty field returns nothing", () => {
    expect(computeRatingChanges([])).toEqual([]);
  });
});

describe("refusals (a wrong rating is worse than no rating)", () => {
  it.each([
    ["a non-finite rating", [{ userId: "a", rating: Number.NaN, rank: 1 }]],
    ["rank 0", [{ userId: "a", rating: 1500, rank: 0 }]],
    ["a fractional rank", [{ userId: "a", rating: 1500, rank: 1.5 }]],
  ])("throws on %s", (_name, field) => {
    expect(() => computeRatingChanges(field as RatingParticipant[])).toThrow();
  });

  it("throws when a participant appears twice", () => {
    expect(() =>
      computeRatingChanges([
        { userId: "a", rating: 1500, rank: 1 },
        { userId: "a", rating: 1500, rank: 2 },
      ]),
    ).toThrow(/more than once/);
  });
});

describe("competitionRanks", () => {
  it("gives 1, 2, 2, 4 for a tie in second place", () => {
    const rows = [{ k: "a" }, { k: "b" }, { k: "b" }, { k: "c" }];
    expect(competitionRanks(rows, (r) => r.k)).toEqual([1, 2, 2, 4]);
  });

  it("gives every row rank 1 when all tie", () => {
    expect(competitionRanks([{ k: "x" }, { k: "x" }, { k: "x" }], (r) => r.k)).toEqual([1, 1, 1]);
  });

  it("is empty for no rows", () => {
    expect(competitionRanks([], () => "")).toEqual([]);
  });
});
