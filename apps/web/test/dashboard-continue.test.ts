import { describe, expect, it } from "vitest";
import {
  WEEKLY_GOAL_PROBLEMS,
  campusHour,
  levelView,
  streakView,
  weekStart,
  weekStrip,
  weeklyGoalProgress,
} from "@/components/dashboard/model";

/**
 * The Continue card's CHOICE moved to `recommend()` in @recx/shared in
 * Phase 12f — seven rungs instead of four, with the reason returned beside
 * the pick — and is tested there (packages/shared/test/recommend.test.ts).
 * What is left here is the rest of the dashboard's pure arithmetic.
 */

describe("weeklyGoalProgress", () => {
  it("counts every difficulty from the WEEK bucket", () => {
    expect(WEEKLY_GOAL_PROBLEMS).toBe(3);
    expect(weeklyGoalProgress(null)).toEqual({ solved: 0, goal: 3, met: false, percent: 0 });
    expect(weeklyGoalProgress({ solvedEasy: 1, solvedMedium: 1, solvedHard: 0 })).toEqual({
      solved: 2,
      goal: 3,
      met: false,
      percent: 67,
    });
    expect(weeklyGoalProgress({ solvedEasy: 3, solvedMedium: 1, solvedHard: 1 })).toMatchObject({ solved: 5, met: true, percent: 100 });
  });

  it("never divides by zero", () => {
    expect(weeklyGoalProgress({ solvedEasy: 0, solvedMedium: 0, solvedHard: 0 }, 0)).toMatchObject({ goal: 1, percent: 0 });
  });
});

describe("streakView (effectiveStreak semantics)", () => {
  const stats = (current: number, longest: number, last: string | null) => ({
    currentStreak: current,
    longestStreak: longest,
    lastActiveDate: last ? new Date(`${last}T00:00:00Z`) : null,
  });

  it("is zero for a brand-new student", () => {
    expect(streakView(null, "2026-10-10")).toEqual({ current: 0, longest: 0, atRisk: false, activeToday: false });
    expect(streakView(stats(0, 0, null), "2026-10-10")).toMatchObject({ current: 0, atRisk: false });
  });

  it("counts today and flags yesterday's streak as at risk", () => {
    expect(streakView(stats(5, 9, "2026-10-10"), "2026-10-10")).toEqual({ current: 5, longest: 9, atRisk: false, activeToday: true });
    expect(streakView(stats(5, 9, "2026-10-09"), "2026-10-10")).toEqual({ current: 5, longest: 9, atRisk: true, activeToday: false });
  });

  it("shows 0 once a day was missed, keeping the longest", () => {
    expect(streakView(stats(5, 9, "2026-10-07"), "2026-10-10")).toEqual({ current: 0, longest: 9, atRisk: false, activeToday: false });
  });
});

describe("levelView", () => {
  it("follows the LMS curve and reports XP to the next level", () => {
    expect(levelView(0)).toMatchObject({ level: 1, xpTotal: 0, toNext: 75, percent: 0 });
    expect(levelView(75)).toMatchObject({ level: 2, toNext: 212 - 75 });
    expect(levelView(-10)).toMatchObject({ level: 1, xpTotal: 0 });
  });
});

describe("week strip (campus week, Monday first)", () => {
  it("finds the Monday of the ISO week", () => {
    expect(weekStart("2026-10-10")).toBe("2026-10-05"); // Saturday → Monday
    expect(weekStart("2026-10-05")).toBe("2026-10-05"); // Monday
    expect(weekStart("2026-10-11")).toBe("2026-10-05"); // Sunday belongs to the same week
  });

  it("lays out seven days with today's activity and future days", () => {
    // 2026-10-10 05:00 IST is Saturday on campus.
    const now = new Date("2026-10-09T23:30:00Z");
    const strip = weekStrip(
      [
        { day: "2026-10-06", submissions: 4, solved: 2 },
        { day: "2026-10-10", submissions: 1, solved: 0 },
      ],
      now,
    );
    expect(strip.map((d) => d.short)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(strip[1]).toMatchObject({ day: "2026-10-06", submissions: 4, solved: 2, isToday: false, isFuture: false });
    expect(strip[5]).toMatchObject({ day: "2026-10-10", submissions: 1, isToday: true, isFuture: false });
    expect(strip[6]).toMatchObject({ day: "2026-10-11", isFuture: true });
    expect(strip[1]?.long).toMatch(/Tuesday/);
  });
});

describe("campusHour", () => {
  it("is the Asia/Kolkata hour whatever the server zone", () => {
    expect(campusHour(new Date("2026-10-09T23:30:00Z"))).toBe(5);
    expect(campusHour(new Date("2026-10-10T18:29:00Z"))).toBe(23);
    expect(campusHour(new Date("2026-10-10T18:30:00Z"))).toBe(0);
  });
});
