import { describe, expect, it } from "vitest";
import {
  REVISION_DAILY_CAP,
  REVISION_INTERVALS,
  REVISION_LAST_STAGE,
  XP_KEYS,
  XP_RULES,
  addDays,
  daysBetween,
  dueQueue,
  firstSchedule,
  isDue,
  revisionReason,
  scheduleAfterLapse,
  scheduleAfterReview,
  solveXp,
  type RevisionCardLike,
} from "../src/index";

const TODAY = "2026-10-30";

function card(over: Partial<RevisionCardLike> = {}): RevisionCardLike {
  return { problemId: "p1", stage: 0, dueOn: TODAY, lapses: 0, learnedAt: null, ...over };
}

describe("the ladder", () => {
  it("is the spec's five rungs, ascending", () => {
    expect([...REVISION_INTERVALS]).toEqual([1, 3, 7, 21, 60]);
    expect(REVISION_LAST_STAGE).toBe(4);
    for (let i = 1; i < REVISION_INTERVALS.length; i++) {
      expect(REVISION_INTERVALS[i]!).toBeGreaterThan(REVISION_INTERVALS[i - 1]!);
    }
  });

  it("a new card is due tomorrow, on rung 0", () => {
    expect(firstSchedule()).toEqual({ stage: 0, intervalDays: 1, learned: false });
  });

  it("climbs one rung per review, and the gaps are the ladder's", () => {
    let stage = 0;
    for (let i = 1; i <= REVISION_LAST_STAGE; i++) {
      const next = scheduleAfterReview(stage);
      expect(next).toEqual({ stage: i, intervalDays: REVISION_INTERVALS[i]!, learned: false });
      stage = next.stage;
    }
  });

  it("clearing the last rung is the end of it", () => {
    const done = scheduleAfterReview(REVISION_LAST_STAGE);
    expect(done).toEqual({ stage: REVISION_LAST_STAGE, intervalDays: null, learned: true });
    // And it stays the end: a stage past the top cannot climb further.
    expect(scheduleAfterReview(REVISION_LAST_STAGE + 5).learned).toBe(true);
  });

  it("a lapse drops one rung and leaves the card due today", () => {
    expect(scheduleAfterLapse(3)).toEqual({ stage: 2, intervalDays: 0, learned: false });
    expect(scheduleAfterLapse(1)).toEqual({ stage: 0, intervalDays: 0, learned: false });
    // Never below the bottom, and never negative.
    expect(scheduleAfterLapse(0)).toEqual({ stage: 0, intervalDays: 0, learned: false });
    expect(scheduleAfterLapse(-3).stage).toBe(0);
  });

  it("forgetting the 21-day answer does not send you back to the start", () => {
    // The whole reason it is "down one" and not "back to zero".
    expect(scheduleAfterLapse(3).stage).toBe(2);
  });
});

describe("when a card is due", () => {
  it("today and every day after, until it is answered", () => {
    expect(isDue(card({ dueOn: TODAY }), TODAY)).toBe(true);
    expect(isDue(card({ dueOn: "2026-10-01" }), TODAY)).toBe(true);
    expect(isDue(card({ dueOn: "2026-11-01" }), TODAY)).toBe(false);
  });

  it("never once it is learned", () => {
    expect(isDue(card({ dueOn: "2020-01-01", learnedAt: new Date() }), TODAY)).toBe(false);
  });
});

describe("the day's queue", () => {
  it("shows at most three, however long the backlog", () => {
    const many = Array.from({ length: 40 }, (_, i) => card({ problemId: `p${i}`, dueOn: "2026-10-01" }));
    expect(dueQueue(many, TODAY)).toHaveLength(REVISION_DAILY_CAP);
  });

  it("puts the most overdue first — the only order a backlog survives", () => {
    const queue = dueQueue(
      [
        card({ problemId: "today", dueOn: TODAY }),
        card({ problemId: "ancient", dueOn: "2026-09-01" }),
        card({ problemId: "lastweek", dueOn: "2026-10-23" }),
      ],
      TODAY,
    );
    expect(queue.map((c) => c.problemId)).toEqual(["ancient", "lastweek", "today"]);
  });

  it("then the ones forgotten most often, then the lowest rung", () => {
    const queue = dueQueue(
      [
        card({ problemId: "easy", dueOn: TODAY, lapses: 0, stage: 1 }),
        card({ problemId: "hard", dueOn: TODAY, lapses: 4, stage: 3 }),
        card({ problemId: "newish", dueOn: TODAY, lapses: 0, stage: 0 }),
      ],
      TODAY,
    );
    expect(queue.map((c) => c.problemId)).toEqual(["hard", "newish", "easy"]);
  });

  it("is stable across reloads when everything else ties", () => {
    const cards = [card({ problemId: "b" }), card({ problemId: "a" }), card({ problemId: "c" })];
    expect(dueQueue(cards, TODAY).map((c) => c.problemId)).toEqual(["a", "b", "c"]);
    expect(dueQueue([...cards].reverse(), TODAY).map((c) => c.problemId)).toEqual(["a", "b", "c"]);
  });

  it("leaves out what is not due and what is learned", () => {
    const queue = dueQueue(
      [
        card({ problemId: "later", dueOn: "2026-12-01" }),
        card({ problemId: "done", dueOn: "2020-01-01", learnedAt: new Date() }),
        card({ problemId: "now", dueOn: TODAY }),
      ],
      TODAY,
    );
    expect(queue.map((c) => c.problemId)).toEqual(["now"]);
  });

  it("a cap of zero shows nothing rather than everything", () => {
    expect(dueQueue([card()], TODAY, 0)).toEqual([]);
    expect(dueQueue([card()], TODAY, -1)).toEqual([]);
  });
});

describe("what the student is told", () => {
  it("names the day and the rung", () => {
    expect(revisionReason(card({ stage: 2, dueOn: TODAY }), TODAY)).toBe("Due today, on the 7-day step.");
    expect(revisionReason(card({ stage: 0, dueOn: "2026-10-29" }), TODAY)).toBe("Due yesterday, on the 1-day step.");
    expect(revisionReason(card({ stage: 4, dueOn: "2026-10-20" }), TODAY)).toBe("Due 10 days ago, on the 60-day step.");
  });

  it("counts the times they have had to relearn it", () => {
    expect(revisionReason(card({ lapses: 1 }), TODAY)).toContain("You have had to relearn it once.");
    expect(revisionReason(card({ lapses: 3 }), TODAY)).toContain("You have had to relearn it 3 times.");
    expect(revisionReason(card({ lapses: 0 }), TODAY)).not.toContain("relearn");
  });

  it("is one sentence a student could argue with", () => {
    for (const stage of [0, 1, 2, 3, 4]) {
      const text = revisionReason(card({ stage }), TODAY);
      expect(text).toMatch(/^Due /);
      expect(text).toMatch(/step\.$|times\.$|once\.$/);
    }
  });
});

describe("the calendar arithmetic", () => {
  it("adds days across a month and a year boundary", () => {
    expect(addDays("2026-10-30", 1)).toBe("2026-10-31");
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-12-30", 7)).toBe("2027-01-06");
    expect(addDays("2026-10-30", 0)).toBe("2026-10-30");
  });

  it("every rung lands on a real date", () => {
    for (const days of REVISION_INTERVALS) {
      expect(addDays("2027-02-26", days)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    // 2028 is a leap year: the 1-day step from the 28th is the 29th.
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("counts whole days in both directions", () => {
    expect(daysBetween("2026-10-30", "2026-11-02")).toBe(3);
    expect(daysBetween("2026-11-02", "2026-10-30")).toBe(-3);
    expect(daysBetween(TODAY, TODAY)).toBe(0);
  });
});

describe("what a revision pays", () => {
  it("is a quarter of the first solve, by difficulty", () => {
    for (const difficulty of ["EASY", "MEDIUM", "HARD"] as const) {
      const full = XP_RULES.firstSolve[difficulty];
      expect(solveXp({ difficulty, firstSolve: false, assisted: false, dailyChallenge: false, revision: true })).toBe(
        Math.round(full * XP_RULES.revisionMultiplier),
      );
    }
  });

  it("is keyed on the campus day, so a retried finalise pays nothing", () => {
    expect(XP_KEYS.revision("u1", "p1", TODAY)).toBe(`revision:u1:p1:${TODAY}`);
    expect(XP_KEYS.revision("u1", "p1", TODAY)).toBe(XP_KEYS.revision("u1", "p1", TODAY));
    expect(XP_KEYS.revision("u1", "p1", "2026-10-31")).not.toBe(XP_KEYS.revision("u1", "p1", TODAY));
  });

  it("is NOT keyed on the rung, because a lapsed card has to climb one twice", () => {
    // 0 → 1 → 2, lapse back to 1, then 1 → 2 again. A rung-keyed ledger row
    // would have been spent on the first climb, and because the ladder only
    // moves when the ledger did, the card would have been stuck for good.
    const climbed = XP_KEYS.revision("u1", "p1", "2026-10-02");
    const reclimbed = XP_KEYS.revision("u1", "p1", "2026-11-02");
    expect(reclimbed).not.toBe(climbed);
  });
});
