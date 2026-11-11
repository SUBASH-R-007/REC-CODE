import { describe, expect, it } from "vitest";
import { STREAK_MILESTONES, type StreakState, type Verdict } from "@recx/shared";
import {
  PROGRESS_BADGES,
  attemptWindow,
  badgeNotification,
  badgesCrossed,
  bucketKeys,
  dateAsDay,
  dayAsDate,
  planProgress,
  solvedIncrements,
  streakNotification,
  type BadgeCounters,
  type PriorProblemStatus,
  type ProgressFacts,
} from "@/lib/progress/rules";

// 10:00 IST on Saturday 10 October 2026.
const SAT = new Date("2026-10-10T04:30:00.000Z");
const fresh: StreakState = { current: 0, longest: 0, lastActiveDate: null };
const attempted: PriorProblemStatus = {
  status: "ATTEMPTED",
  firstAttemptAt: new Date("2026-10-08T10:00:00.000Z"),
  lastAttemptAt: new Date("2026-10-09T10:00:00.000Z"),
};
const solved: PriorProblemStatus = { ...attempted, status: "SOLVED" };

const facts = (patch: Partial<ProgressFacts>): ProgressFacts => ({
  verdict: "WA",
  rejudge: false,
  submittedAt: SAT,
  prior: null,
  streak: fresh,
  ...patch,
});

describe("planProgress: what a finalised practice submission changes", () => {
  it("counts every judged verdict as an attempt, and only AC as accepted", () => {
    const judged: Verdict[] = ["AC", "WA", "TLE", "MLE", "RE", "CE", "OLE", "PARTIAL"];
    for (const verdict of judged) {
      const plan = planProgress(facts({ verdict }));
      expect(plan?.countAttempt, verdict).toBe(true);
      expect(plan?.accepted, verdict).toBe(verdict === "AC");
      expect(plan?.failed, verdict).toBe(verdict !== "AC");
    }
  });

  it("ignores an internal error entirely (never an attempt, never a streak day)", () => {
    expect(planProgress(facts({ verdict: "IE" }))).toBeNull();
    expect(planProgress(facts({ verdict: "IE", rejudge: true }))).toBeNull();
  });

  it("marks the first attempt and the first solve", () => {
    const first = planProgress(facts({ verdict: "AC" }));
    expect(first).toMatchObject({ firstAttempt: true, firstSolve: true, day: "2026-10-10" });

    const afterWa = planProgress(facts({ verdict: "AC", prior: attempted }));
    expect(afterWa).toMatchObject({ firstAttempt: false, firstSolve: true });

    const wrongFirst = planProgress(facts({ verdict: "WA" }));
    expect(wrongFirst).toMatchObject({ firstAttempt: true, firstSolve: false });
  });

  it("keeps the first solve: a later AC is counted but is not a solve", () => {
    const plan = planProgress(facts({ verdict: "AC", prior: solved }));
    expect(plan).toMatchObject({ countAttempt: true, accepted: true, firstSolve: false, firstAttempt: false });
  });

  it("uses the campus day of submission, not UTC", () => {
    // 23:59 IST on the 9th is 18:29 UTC; 00:01 IST on the 10th is 18:31 UTC.
    expect(planProgress(facts({ submittedAt: new Date("2026-10-09T18:29:00.000Z") }))?.day).toBe("2026-10-09");
    expect(planProgress(facts({ submittedAt: new Date("2026-10-09T18:31:00.000Z") }))?.day).toBe("2026-10-10");
  });

  describe("streak (a judged submission is the qualifying activity)", () => {
    it("starts, continues, holds within a day and resets after a gap", () => {
      expect(planProgress(facts({}))?.streak?.after).toEqual({ current: 1, longest: 1, lastActiveDate: "2026-10-10" });

      const yesterday: StreakState = { current: 4, longest: 9, lastActiveDate: "2026-10-09" };
      expect(planProgress(facts({ streak: yesterday }))?.streak?.after).toEqual({
        current: 5,
        longest: 9,
        lastActiveDate: "2026-10-10",
      });

      const today: StreakState = { current: 5, longest: 9, lastActiveDate: "2026-10-10" };
      expect(planProgress(facts({ streak: today }))?.streak?.after).toEqual(today);

      const gap: StreakState = { current: 5, longest: 9, lastActiveDate: "2026-10-07" };
      expect(planProgress(facts({ streak: gap }))?.streak?.after).toEqual({
        current: 1,
        longest: 9,
        lastActiveDate: "2026-10-10",
      });
    });

    it("a compile error still keeps the streak", () => {
      const yesterday: StreakState = { current: 2, longest: 2, lastActiveDate: "2026-10-09" };
      expect(planProgress(facts({ verdict: "CE", streak: yesterday }))?.streak?.after.current).toBe(3);
    });

    it("a late-finalised older submission never rewinds the streak", () => {
      const ahead: StreakState = { current: 3, longest: 3, lastActiveDate: "2026-10-11" };
      expect(planProgress(facts({ streak: ahead }))?.streak?.after).toEqual(ahead);
    });

    it("reports a milestone the first time the longest streak crosses it", () => {
      for (const milestone of STREAK_MILESTONES) {
        const before: StreakState = { current: milestone - 1, longest: milestone - 1, lastActiveDate: "2026-10-09" };
        expect(planProgress(facts({ streak: before }))?.streak?.milestone).toBe(milestone);
      }
      const atSix: StreakState = { current: 6, longest: 6, lastActiveDate: "2026-10-10" };
      expect(planProgress(facts({ streak: atSix }))?.streak?.milestone).toBeNull(); // same day: no advance
    });

    it("does not pay a milestone twice when a broken streak climbs back", () => {
      const again: StreakState = { current: 6, longest: 12, lastActiveDate: "2026-10-09" };
      const plan = planProgress(facts({ streak: again }));
      expect(plan?.streak?.after.current).toBe(7);
      expect(plan?.streak?.milestone).toBeNull();
    });
  });

  describe("rejudge (lane REJUDGE)", () => {
    it("credits a missed first solve and nothing else", () => {
      const plan = planProgress(facts({ verdict: "AC", rejudge: true, prior: attempted }));
      expect(plan).toMatchObject({
        countAttempt: false,
        accepted: false,
        failed: false,
        firstAttempt: false,
        firstSolve: true,
        streak: null,
      });
    });

    it("changes nothing when there is no new solve (never takes a solve away)", () => {
      expect(planProgress(facts({ verdict: "AC", rejudge: true, prior: solved }))).toBeNull();
      expect(planProgress(facts({ verdict: "WA", rejudge: true, prior: solved }))).toBeNull();
      expect(planProgress(facts({ verdict: "WA", rejudge: true, prior: attempted }))).toBeNull();
    });

    it("creates the status row when the original judging was never counted", () => {
      expect(planProgress(facts({ verdict: "AC", rejudge: true, prior: null }))).toMatchObject({
        firstAttempt: true,
        firstSolve: true,
        countAttempt: false,
      });
    });
  });
});

describe("attemptWindow", () => {
  it("starts at the submission and only ever widens", () => {
    expect(attemptWindow(null, SAT)).toEqual({ firstAttemptAt: SAT, lastAttemptAt: SAT });
    expect(attemptWindow(attempted, SAT)).toEqual({ firstAttemptAt: attempted.firstAttemptAt, lastAttemptAt: SAT });
    const earlier = new Date("2026-10-01T00:00:00.000Z");
    expect(attemptWindow(attempted, earlier)).toEqual({ firstAttemptAt: earlier, lastAttemptAt: attempted.lastAttemptAt });
  });
});

describe("bucket keys (campus calendar)", () => {
  it("is ALL_TIME / MONTH / WEEK", () => {
    expect(bucketKeys(SAT)).toEqual([
      { period: "ALL_TIME", periodKey: "all" },
      { period: "MONTH", periodKey: "2026-10" },
      { period: "WEEK", periodKey: "2026-W41" },
    ]);
  });

  it("rolls the week over at Monday 00:00 IST and the month at the 1st, IST", () => {
    // Sunday 11 Oct 23:59 IST vs Monday 12 Oct 00:00 IST.
    expect(bucketKeys(new Date("2026-10-11T18:29:00.000Z"))[2]?.periodKey).toBe("2026-W41");
    expect(bucketKeys(new Date("2026-10-11T18:30:00.000Z"))[2]?.periodKey).toBe("2026-W42");
    // 31 Oct 23:59 IST vs 1 Nov 00:00 IST.
    expect(bucketKeys(new Date("2026-10-31T18:29:00.000Z"))[1]?.periodKey).toBe("2026-10");
    expect(bucketKeys(new Date("2026-10-31T18:30:00.000Z"))[1]?.periodKey).toBe("2026-11");
  });

  it("uses the ISO week-year at the turn of the year", () => {
    // Fri 1 Jan 2027 belongs to 2026-W53 (2026 has 53 ISO weeks).
    expect(bucketKeys(new Date("2027-01-01T06:00:00.000Z"))[2]?.periodKey).toBe("2026-W53");
    expect(bucketKeys(new Date("2027-01-04T06:00:00.000Z"))[2]?.periodKey).toBe("2027-W01");
  });
});

describe("day helpers for @db.Date columns", () => {
  it("round-trips a campus day through UTC midnight", () => {
    expect(dayAsDate("2026-10-10").toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(dateAsDay(dayAsDate("2028-02-29"))).toBe("2028-02-29");
  });
});

describe("solvedIncrements", () => {
  it("adds one to the solved difficulty on a first solve only", () => {
    expect(solvedIncrements("EASY", true)).toEqual({ solvedEasy: 1, solvedMedium: 0, solvedHard: 0 });
    expect(solvedIncrements("MEDIUM", true)).toEqual({ solvedEasy: 0, solvedMedium: 1, solvedHard: 0 });
    expect(solvedIncrements("HARD", true)).toEqual({ solvedEasy: 0, solvedMedium: 0, solvedHard: 1 });
    expect(solvedIncrements("HARD", false)).toEqual({ solvedEasy: 0, solvedMedium: 0, solvedHard: 0 });
  });
});

describe("badges", () => {
  const zero: BadgeCounters = { solvedTotal: 0, solvedMedium: 0, solvedHard: 0, longestStreak: 0 };

  it("uses the content catalogue keys", () => {
    expect(PROGRESS_BADGES.map((b) => b.key)).toEqual([
      "first-solve",
      "ten-solves",
      "fifty-solves",
      "first-medium",
      "first-hard",
      "streak-7",
      "streak-30",
    ]);
  });

  it("awards on crossing a threshold, once", () => {
    expect(badgesCrossed(zero, { ...zero, solvedTotal: 1 })).toEqual(["first-solve"]);
    expect(badgesCrossed(zero, { ...zero, solvedTotal: 1, solvedHard: 1 })).toEqual(["first-solve", "first-hard"]);
    expect(badgesCrossed({ ...zero, solvedTotal: 9 }, { ...zero, solvedTotal: 10 })).toEqual(["ten-solves"]);
    expect(badgesCrossed({ ...zero, solvedTotal: 49 }, { ...zero, solvedTotal: 50 })).toEqual(["fifty-solves"]);
    expect(badgesCrossed({ ...zero, solvedTotal: 10 }, { ...zero, solvedTotal: 11 })).toEqual([]);
    expect(badgesCrossed({ ...zero, solvedTotal: 3 }, { ...zero, solvedTotal: 4, solvedMedium: 1 })).toEqual([
      "first-medium",
    ]);
  });

  it("awards streak badges when the longest streak first reaches 7 and 30", () => {
    expect(badgesCrossed({ ...zero, longestStreak: 6 }, { ...zero, longestStreak: 7 })).toEqual(["streak-7"]);
    expect(badgesCrossed({ ...zero, longestStreak: 29 }, { ...zero, longestStreak: 30 })).toEqual(["streak-30"]);
    expect(badgesCrossed({ ...zero, longestStreak: 7 }, { ...zero, longestStreak: 7 })).toEqual([]);
  });
});

describe("notification text", () => {
  it("names the badge", () => {
    expect(badgeNotification({ name: "First Solve", description: "Solved a first problem." })).toEqual({
      title: "You earned the First Solve badge",
      body: "Solved a first problem.",
    });
  });

  it("says how much streak XP was added, and says so honestly when capped", () => {
    expect(streakNotification(7, { uncapped: 30, amount: 30, capped: false }).body).toMatch(/\+30 XP\.$/);
    expect(streakNotification(30, { uncapped: 100, amount: 40, capped: true }).body).toMatch(
      /\+40 XP \(reduced by today's XP limit\)/,
    );
    const none = streakNotification(100, { uncapped: 300, amount: 0, capped: true });
    expect(none.title).toBe("You earned a 100-day streak");
    expect(none.body).toMatch(/No bonus XP was added/);
  });
});
