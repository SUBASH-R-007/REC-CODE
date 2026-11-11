import { describe, expect, it } from "vitest";
import { TOPICS, type Topic } from "../src/topics";
import { DISTRIBUTION_BUCKETS, TIER_TARGETS } from "../src/readiness";
import {
  cellShare,
  distribution,
  distributionCaption,
  heatmap,
  normalise,
  weakestTopics,
} from "../src/readiness-distribution";

/**
 * The cohort shapes, and the one property that matters about this module:
 * nothing in it can return a per-student row. SPEC §5 forbids a shareable
 * ranking of students by readiness, and the cheapest way to keep that true is
 * for the arithmetic to be incapable of producing one.
 */

const evenTopics = (each: number) =>
  Object.fromEntries(TOPICS.map((topic) => [topic, each])) as Partial<Record<Topic, number>>;

describe("every bucket is over the NORMALISED figure", () => {
  it("divides by what was measurable, not by 100", () => {
    /**
     * The case the whole rule exists for. Two students with the same raw
     * score, one measured out of 85 and one out of 50, are not equally
     * prepared — and a chart that bucketed the raw 40 twice would put them
     * in the same bar for a reason no reader could see.
     */
    expect(normalise({ score: 40, availableWeight: 85 })).toBe(47);
    expect(normalise({ score: 40, availableWeight: 50 })).toBe(80);
  });

  it("has no bucket for a student with nothing measurable", () => {
    expect(normalise({ score: null, availableWeight: 0 })).toBeNull();
    // And a zero denominator with a score is not representable in the
    // database either; here it simply has no normalised value.
    expect(normalise({ score: 0, availableWeight: 0 })).toBeNull();
  });

  it("counts a genuine zero as a zero", () => {
    expect(normalise({ score: 0, availableWeight: 85 })).toBe(0);
  });
});

describe("the distribution counts, and says what it left out", () => {
  const rows = [
    { score: 0, availableWeight: 100 }, // 0
    { score: 25, availableWeight: 100 }, // 25
    { score: 50, availableWeight: 100 }, // 50
    { score: 70, availableWeight: 100 }, // 70
    { score: 85, availableWeight: 100 }, // 85
    { score: null, availableWeight: 0 },
    { score: null, availableWeight: 0 },
  ];

  it("puts one in each of the five fixed buckets", () => {
    const dist = distribution("PRODUCT", rows);
    expect(dist.buckets.map((b) => b.count)).toEqual([1, 1, 1, 1, 1]);
    expect(dist.buckets.map((b) => b.label)).toEqual(DISTRIBUTION_BUCKETS.map((b) => b.label));
  });

  it("reports the unmeasurable students rather than dropping them", () => {
    /**
     * A bar chart over 5 of 7 students, drawn without saying so, is the most
     * misleading thing this surface could do — and at cohort scale it would
     * be a chart over 400 of 5,000.
     */
    const dist = distribution("PRODUCT", rows);
    expect(dist.measured).toBe(5);
    expect(dist.unmeasurable).toBe(2);
    expect(dist.measured + dist.unmeasurable).toBe(rows.length);
  });

  it("totals to the number measured, always", () => {
    const dist = distribution("TOP", rows);
    expect(dist.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(dist.measured);
  });

  it("says in its caption that the figure is out of what was measurable", () => {
    const caption = distributionCaption(distribution("TOP", rows));
    expect(caption).toContain("MEASURABLE");
    expect(caption).toContain("5 of 7");
    expect(caption).toContain("2 had nothing measurable");
  });

  it("drops the caveat when there is nothing to caveat", () => {
    const caption = distributionCaption(distribution("SERVICE", [{ score: 50, availableWeight: 100 }]));
    expect(caption).toContain("all 1 students");
    expect(caption).not.toContain("nothing measurable");
  });

  it("is empty, not broken, for an empty cohort", () => {
    const dist = distribution("SERVICE", []);
    expect(dist.measured).toBe(0);
    expect(dist.buckets.every((b) => b.count === 0)).toBe(true);
  });

  it("uses FIXED boundaries, so two terms are comparable", () => {
    // Quintiles over the data would move with the cohort, and comparing
    // terms is the only reason to keep a distribution at all.
    const tight = distribution("PRODUCT", [
      { score: 50, availableWeight: 100 },
      { score: 51, availableWeight: 100 },
      { score: 52, availableWeight: 100 },
    ]);
    expect(tight.buckets.find((b) => b.label === "40–59")!.count).toBe(3);
    expect(tight.buckets.filter((b) => b.count > 0)).toHaveLength(1);
  });
});

describe("the heatmap is counts, with a denominator in every cell", () => {
  const cohort = [
    { section: "A", topicUnassisted: { ...evenTopics(6), GRAPHS: 0 } },
    { section: "A", topicUnassisted: { ...evenTopics(6), GRAPHS: 1 } },
    { section: "B", topicUnassisted: evenTopics(6) },
    { section: null, topicUnassisted: {} },
  ];

  it("counts students short of the tier's per-topic target", () => {
    const map = heatmap(cohort, "PRODUCT");
    expect(map.perTopicTarget).toBe(TIER_TARGETS.PRODUCT.perTopic);
    const graphsA = map.cells.find((c) => c.section === "A" && c.topic === "GRAPHS")!;
    // Both of section A are under 4 unassisted graph solves.
    expect(graphsA).toMatchObject({ behind: 2, total: 2 });
    const treesA = map.cells.find((c) => c.section === "A" && c.topic === "TREES")!;
    expect(treesA).toMatchObject({ behind: 0, total: 2 });
  });

  it("asks for more depth at TOP, so more students are behind", () => {
    const product = heatmap(cohort, "PRODUCT").cells.reduce((n, c) => n + c.behind, 0);
    const top = heatmap(cohort, "TOP").cells.reduce((n, c) => n + c.behind, 0);
    expect(top).toBeGreaterThan(product);
  });

  it("keeps a student with no section, under a labelled row", () => {
    /**
     * Dropping them would make the column totals disagree with the cohort
     * size, and an unexplained gap in a count is worse than a row labelled
     * with a dash.
     */
    const map = heatmap(cohort);
    expect(map.sections).toContain("—");
    // One cell per section for a single topic, so their totals are the
    // section sizes and they must add up to the cohort. (A Set here would
    // collapse two sections that happen to be the same size, which is how
    // this assertion got written wrongly the first time.)
    const perSection = map.cells.filter((c) => c.topic === "TREES").map((c) => c.total);
    expect(perSection).toHaveLength(map.sections.length);
    expect(perSection.reduce((a, b) => a + b, 0)).toBe(cohort.length);
  });

  it("covers all fourteen topics for every section", () => {
    const map = heatmap(cohort);
    expect(map.cells).toHaveLength(map.sections.length * TOPICS.length);
    expect(map.topics).toEqual([...TOPICS]);
  });

  it("gives a share for the colour, which is a redundant encoding", () => {
    const map = heatmap(cohort);
    const graphsA = map.cells.find((c) => c.section === "A" && c.topic === "GRAPHS")!;
    expect(cellShare(graphsA)).toBe(1);
    expect(cellShare({ section: "X", topic: "TREES", behind: 0, total: 0 })).toBe(0);
  });
});

describe("the only ranking the phase permits ranks the SYLLABUS", () => {
  it("names the topics the cohort is weakest on, worst first", () => {
    /**
     * Topics, not students. "Nobody here has touched graphs" is a teaching
     * decision a head of department can act on without ever seeing a name.
     */
    const map = heatmap([
      { section: "A", topicUnassisted: { ...evenTopics(9), GRAPHS: 0, DYNAMIC_PROGRAMMING: 1 } },
      { section: "B", topicUnassisted: { ...evenTopics(9), GRAPHS: 0 } },
    ]);
    const weakest = weakestTopics(map, 2);
    expect(weakest[0]!.topic).toBe("GRAPHS");
    expect(weakest[0]).toMatchObject({ behind: 2, total: 2 });
    expect(weakest[1]!.topic).toBe("DYNAMIC_PROGRAMMING");
  });

  it("breaks ties on TOPICS order, so the answer is stable between runs", () => {
    const map = heatmap([{ section: "A", topicUnassisted: {} }]);
    expect(weakestTopics(map, 3).map((t) => t.topic)).toEqual([...TOPICS].slice(0, 3));
  });

  it("returns nothing for an empty cohort", () => {
    expect(weakestTopics(heatmap([]), 3)).toEqual([]);
  });
});

describe("the module cannot produce a ranking of students", () => {
  it("exports no function that returns a per-student row", async () => {
    /**
     * Asserted over the module's actual exports rather than trusted. A
     * function returning `{ student, score }[]` "for the chart" would be one
     * sort() away from the thing SPEC §5 forbids, and the sort would live in
     * a page where nobody would look for it.
     */
    const module = await import("../src/readiness-distribution");
    const rows = [
      { score: 70, availableWeight: 85 },
      { score: 20, availableWeight: 85 },
    ];
    const cohort = [{ section: "A", topicUnassisted: evenTopics(1) }];

    const outputs: unknown[] = [
      distribution("TOP", rows),
      heatmap(cohort),
      weakestTopics(heatmap(cohort)),
      normalise(rows[0]!),
      cellShare({ section: "A", topic: "TREES", behind: 1, total: 2 }),
      distributionCaption(distribution("TOP", rows)),
    ];
    // Every export is accounted for above, so a new one has to be considered
    // here before this passes again.
    expect(Object.keys(module).sort()).toEqual([
      "cellShare",
      "distribution",
      "distributionCaption",
      "heatmap",
      "normalise",
      "weakestTopics",
    ]);

    // Nothing any of them returns carries a user id or a student name.
    const text = JSON.stringify(outputs);
    expect(text).not.toMatch(/userId|collegeId|studentId|firstName|handle/i);
  });
});
