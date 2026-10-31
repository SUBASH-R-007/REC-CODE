import { describe, expect, it } from "vitest";
import {
  RECOMMENDER_CTA,
  RECOMMENDER_EYEBROW,
  RECOMMENDER_RULES,
  RECOMMEND_ROTATE_AFTER,
  recommend,
  saturatedTopic,
  type RecommendInputs,
  type RecommendProblem,
  type Topic,
} from "../src/index";

const problem = (slug: string, difficulty: RecommendProblem["difficulty"] = "EASY"): RecommendProblem => ({
  id: `id-${slug}`,
  slug,
  displayCode: `P-${slug}`,
  title: slug,
  difficulty,
});

const EMPTY: RecommendInputs = {
  unfinished: null,
  revision: null,
  drive: null,
  weakTopics: [],
  plan: null,
  daily: null,
  fresh: null,
  recentTopics: [],
};

const unfinished = { problem: problem("unfinished"), attempts: 2, lastAttemptAt: new Date("2026-10-28T10:00:00Z") };
const revision = { problem: problem("revise"), overdueDays: 0, stepDays: 7 };
const drive = { companyName: "Northwind", daysAway: 5, askedCount: 3, problem: problem("asked") };
const weakGraphs = { topic: "GRAPHS" as Topic, have: 1, target: 4, problem: problem("graph-one", "MEDIUM") };
const weakTrees = { topic: "TREES" as Topic, have: 2, target: 4, problem: problem("tree-one", "MEDIUM") };
const plan = {
  title: "Blind 75",
  kind: "SHEET" as const,
  done: 4,
  total: 75,
  problem: problem("plan-next", "MEDIUM"),
};
const daily = { problem: problem("daily", "MEDIUM"), xp: 240 };
const fresh = { problem: problem("fresh"), firstEver: false };

describe("the order of the rungs", () => {
  const all: RecommendInputs = {
    unfinished,
    revision,
    drive,
    weakTopics: [weakGraphs],
    plan,
    daily,
    fresh,
    recentTopics: [],
  };

  it("finishes what the student started, above everything", () => {
    expect(recommend(all)).toMatchObject({ rule: "FINISH", problem: { slug: "unfinished" } });
  });

  it("then a problem a company whose drive is coming has been asked", () => {
    // Above the revision deliberately: a drive has a date, and a revision
    // has a schedule built to tolerate a day.
    expect(recommend({ ...all, unfinished: null })).toMatchObject({ rule: "DRIVE", problem: { slug: "asked" } });
  });

  it("then a revision that is due", () => {
    expect(recommend({ ...all, unfinished: null, drive: null })).toMatchObject({
      rule: "REVISE",
      problem: { slug: "revise" },
    });
  });

  it("then the topic holding readiness back", () => {
    expect(recommend({ ...all, unfinished: null, drive: null, revision: null })).toMatchObject({
      rule: "WEAK_TOPIC",
      problem: { slug: "graph-one" },
    });
  });

  it("then the plan, then the daily challenge, then anything", () => {
    const base = { ...all, unfinished: null, drive: null, revision: null, weakTopics: [] };
    expect(recommend(base)).toMatchObject({ rule: "PLAN", problem: { slug: "plan-next" } });
    expect(recommend({ ...base, plan: null })).toMatchObject({ rule: "DAILY", problem: { slug: "daily" } });
    expect(recommend({ ...base, plan: null, daily: null })).toMatchObject({ rule: "FRESH", problem: { slug: "fresh" } });
  });

  it("recommends nothing when there is nothing", () => {
    expect(recommend(EMPTY)).toBeNull();
  });
});

describe("the reason, which is always rendered", () => {
  it("comes back with every single rule", () => {
    const byRule = [
      recommend({ ...EMPTY, unfinished }),
      recommend({ ...EMPTY, drive }),
      recommend({ ...EMPTY, revision }),
      recommend({ ...EMPTY, weakTopics: [weakGraphs] }),
      recommend({ ...EMPTY, plan }),
      recommend({ ...EMPTY, daily }),
      recommend({ ...EMPTY, fresh }),
    ];
    expect(byRule.map((r) => r?.rule)).toEqual([...RECOMMENDER_RULES]);
    for (const picked of byRule) {
      expect(picked, "every rule explains itself").not.toBeNull();
      expect(picked!.reason.length).toBeGreaterThan(25);
      expect(picked!.reason.trim()).toMatch(/[.)]$/);
    }
  });

  it("says something a student can check, not a score", () => {
    expect(recommend({ ...EMPTY, drive })!.reason).toBe(
      "Northwind's drive is in 5 days, and 3 students reported being asked it there.",
    );
    expect(recommend({ ...EMPTY, weakTopics: [weakGraphs] })!.reason).toBe(
      "Graphs is the topic holding your readiness back — 1 of 4 unassisted solves.",
    );
    expect(recommend({ ...EMPTY, plan })!.reason).toBe("Next in Blind 75 — 4 of 75 solved in this sheet.");
  });

  it("counts attempts, days and interviews in words rather than numerals where one reads better", () => {
    expect(recommend({ ...EMPTY, unfinished: { ...unfinished, attempts: 1 } })!.reason).toContain("started this one");
    expect(recommend({ ...EMPTY, unfinished })!.reason).toContain("2 goes");
    expect(recommend({ ...EMPTY, drive: { ...drive, daysAway: 0 } })!.reason).toContain("drive is today");
    expect(recommend({ ...EMPTY, drive: { ...drive, daysAway: 1 } })!.reason).toContain("drive is tomorrow");
    expect(recommend({ ...EMPTY, drive: { ...drive, askedCount: 1 } })!.reason).toContain("one student reported");
    expect(recommend({ ...EMPTY, revision: { ...revision, overdueDays: 1 } })!.reason).toContain("yesterday");
    expect(recommend({ ...EMPTY, revision: { ...revision, overdueDays: 4 } })!.reason).toContain("4 days ago");
  });

  it("has an eyebrow and a call to action for every rule", () => {
    for (const rule of RECOMMENDER_RULES) {
      expect(RECOMMENDER_EYEBROW[rule].length).toBeGreaterThan(5);
      expect(RECOMMENDER_CTA[rule].length).toBeGreaterThan(5);
    }
  });
});

describe("topic rotation", () => {
  const graphs = "GRAPHS" as Topic;
  const trees = "TREES" as Topic;

  it("spots a rut of exactly three in a row", () => {
    expect(saturatedTopic([graphs, graphs, graphs])).toBe(graphs);
    expect(saturatedTopic([graphs, graphs, graphs, trees])).toBe(graphs);
    expect(saturatedTopic([graphs, graphs])).toBeNull();
    expect(saturatedTopic([])).toBeNull();
  });

  it("is strictly consecutive and newest-first: a different problem in the middle is not a rut", () => {
    expect(saturatedTopic([graphs, trees, graphs])).toBeNull();
    // Newest first, so a rut that ENDED is not a rut.
    expect(saturatedTopic([trees, graphs, graphs, graphs])).toBeNull();
  });

  it("moves to the next weakest topic after three in a row, and says so", () => {
    const picked = recommend({
      ...EMPTY,
      weakTopics: [weakGraphs, weakTrees],
      recentTopics: [graphs, graphs, graphs],
    });
    expect(picked).toMatchObject({ rule: "WEAK_TOPIC", problem: { slug: "tree-one" }, rotatedAwayFrom: graphs });
    expect(picked!.reason).toContain(`just done ${RECOMMEND_ROTATE_AFTER} Graphs problems in a row`);
    // And it still names the gap it IS pointing at.
    expect(picked!.reason).toContain("Trees is the topic holding your readiness back");
  });

  it("does not rotate when the rut is not the weakest topic anyway", () => {
    const picked = recommend({
      ...EMPTY,
      weakTopics: [weakGraphs, weakTrees],
      recentTopics: [trees, trees, trees],
    });
    expect(picked).toMatchObject({ problem: { slug: "graph-one" }, rotatedAwayFrom: null });
    expect(picked!.reason).not.toContain("in a row");
  });

  it("falls through to the next rung when rotation leaves no topic", () => {
    const picked = recommend({
      ...EMPTY,
      weakTopics: [weakGraphs],
      recentTopics: [graphs, graphs, graphs],
      plan,
    });
    expect(picked).toMatchObject({ rule: "PLAN" });
  });

  it("never rotates a FINISH, a REVISE or a DRIVE away", () => {
    // Those three are about one specific problem, not about a topic.
    const rut = { recentTopics: [graphs, graphs, graphs] };
    expect(recommend({ ...EMPTY, ...rut, unfinished })!.rule).toBe("FINISH");
    expect(recommend({ ...EMPTY, ...rut, revision })!.rule).toBe("REVISE");
    expect(recommend({ ...EMPTY, ...rut, drive })!.rule).toBe("DRIVE");
  });
});
