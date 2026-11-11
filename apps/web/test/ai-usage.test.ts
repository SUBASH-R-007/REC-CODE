import { describe, expect, it } from "vitest";
import { foldAiUsage, type AiUsageGroup } from "@/lib/ai/usage";

/**
 * Which models answered, folded from the two rows a `groupBy` returns per
 * model (Phase 15g).
 *
 * The super-admin page reads this so that a free-text model choice has a
 * feedback loop: a model that has started failing, or one that is still
 * being asked after the setting moved on, is visible rather than inferred.
 */

const group = (over: Partial<AiUsageGroup> = {}): AiUsageGroup => ({
  modelId: "claude-sonnet-5-5",
  failed: false,
  count: 1,
  lastAt: new Date("2026-11-01T10:00:00.000Z"),
  ...over,
});

describe("folding a month of asks by model", () => {
  it("splits answered from failed, per model", () => {
    const folded = foldAiUsage([
      group({ modelId: "a-1", failed: false, count: 7 }),
      group({ modelId: "a-1", failed: true, count: 2 }),
      group({ modelId: "b-2", failed: false, count: 3 }),
    ]);
    expect(folded).toEqual([
      { modelId: "a-1", answered: 7, failed: 2, lastAt: new Date("2026-11-01T10:00:00.000Z") },
      { modelId: "b-2", answered: 3, failed: 0, lastAt: new Date("2026-11-01T10:00:00.000Z") },
    ]);
  });

  it("keeps the latest timestamp of the two rows, not the last one seen", () => {
    const folded = foldAiUsage([
      group({ modelId: "a-1", failed: true, count: 1, lastAt: new Date("2026-11-05T09:00:00.000Z") }),
      group({ modelId: "a-1", failed: false, count: 1, lastAt: new Date("2026-11-02T09:00:00.000Z") }),
    ]);
    expect(folded[0]!.lastAt).toEqual(new Date("2026-11-05T09:00:00.000Z"));
  });

  it("puts the busiest model first, counting the ones that failed", () => {
    // A model that only ever failed is the most important row on the page,
    // so it is not sorted below a model that answered less often.
    const folded = foldAiUsage([
      group({ modelId: "quiet", failed: false, count: 2 }),
      group({ modelId: "broken", failed: true, count: 9 }),
      group({ modelId: "busy", failed: false, count: 20 }),
    ]);
    expect(folded.map((m) => m.modelId)).toEqual(["busy", "broken", "quiet"]);
  });

  it("breaks a tie by name, so the page does not reshuffle between loads", () => {
    const folded = foldAiUsage([
      group({ modelId: "zeta", failed: false, count: 4 }),
      group({ modelId: "alpha", failed: false, count: 4 }),
    ]);
    expect(folded.map((m) => m.modelId)).toEqual(["alpha", "zeta"]);
  });

  it("has nothing to say about a month nobody asked in", () => {
    expect(foldAiUsage([])).toEqual([]);
  });

  it("survives a row with no timestamp", () => {
    // `_max` is null for an empty group; the page still has to render.
    const folded = foldAiUsage([group({ lastAt: null })]);
    expect(folded[0]!.lastAt).toBeNull();
  });
});
