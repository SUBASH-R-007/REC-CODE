import { describe, expect, it } from "vitest";
import {
  CALENDAR_DAY_KINDS,
  EXCLUSION_REASONS,
  LEAVE_KINDS,
  LEAVE_STATUSES,
  academicYearOf,
  calendarCovers,
  calendarExclusionReason,
  calendarLookup,
  countedDaysBetween,
  daysInclusive,
  isCountedDay,
  leaveCoveredDays,
  leaveExclusionReason,
  mergeExclusions,
  termKeyFor,
  uncoveredDays,
  type CalendarDayRow,
  type LeaveRow,
} from "../src/calendar";

const EXCLUDE = { excludeNonWorkingDays: true };
const KEEP = { excludeNonWorkingDays: false };

function cal(...rows: Array<Partial<CalendarDayRow> & { date: string }>) {
  return calendarLookup(
    rows.map((row) => ({ kind: "REGULAR" as const, isWorkingDay: true, ...row })),
  );
}

/** Every day of October 2026 as a regular working day, unless overridden. */
function october(overrides: Record<string, Partial<CalendarDayRow>> = {}) {
  return calendarLookup(
    daysInclusive("2026-10-01", "2026-10-31").map((date) => ({
      date,
      kind: "REGULAR" as const,
      isWorkingDay: true,
      ...overrides[date],
    })),
  );
}

function leave(over: Partial<LeaveRow> & { startDate: string; endDate: string }): LeaveRow {
  return { id: "l1", kind: "MEDICAL", status: "APPROVED", ...over };
}

describe("the enums mirror the schema", () => {
  it("lists calendar kinds in schema order", () => {
    expect(CALENDAR_DAY_KINDS).toEqual(["REGULAR", "HOLIDAY", "EXAM_WEEK", "SEMESTER_BREAK", "PLACEMENT_WEEK"]);
  });

  it("lists leave kinds and statuses in schema order", () => {
    expect(LEAVE_KINDS).toEqual([
      "MEDICAL",
      "BEREAVEMENT",
      "UNIVERSITY_EXAM",
      "PLACEMENT_DRIVE",
      "INTERNSHIP",
      "SPORTS_EVENT",
      "APPROVED_OTHER",
    ]);
    expect(LEAVE_STATUSES).toEqual(["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"]);
  });

  it("has an exclusion reason for every leave kind", () => {
    for (const kind of LEAVE_KINDS) {
      expect(EXCLUSION_REASONS).toContain(leaveExclusionReason(kind));
    }
  });
});

describe("daysInclusive", () => {
  it("includes both ends", () => {
    expect(daysInclusive("2026-10-01", "2026-10-03")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("returns the single day when the ends are equal", () => {
    expect(daysInclusive("2026-10-01", "2026-10-01")).toEqual(["2026-10-01"]);
  });

  it("returns nothing for a backwards range rather than looping forever", () => {
    expect(daysInclusive("2026-10-03", "2026-10-01")).toEqual([]);
  });

  it("crosses a month boundary", () => {
    expect(daysInclusive("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("crosses a year boundary and a leap day", () => {
    expect(daysInclusive("2027-12-31", "2028-01-01")).toEqual(["2027-12-31", "2028-01-01"]);
    expect(daysInclusive("2028-02-28", "2028-03-01")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  });
});

describe("isCountedDay", () => {
  it("counts a regular working day", () => {
    expect(isCountedDay("2026-10-05", cal({ date: "2026-10-05" }), EXCLUDE)).toBe(true);
  });

  it("counts a day with no calendar row — the harshest reading, gated by calendarCovers", () => {
    expect(isCountedDay("2026-10-05", cal(), EXCLUDE)).toBe(true);
    expect(calendarCovers("2026-10-04", "2026-10-05", cal())).toBe(false);
  });

  it.each(["HOLIDAY", "EXAM_WEEK", "SEMESTER_BREAK", "PLACEMENT_WEEK"] as const)(
    "never counts a %s day, whatever the toggle says",
    (kind) => {
      const rows = cal({ date: "2026-10-05", kind, isWorkingDay: true });
      expect(isCountedDay("2026-10-05", rows, EXCLUDE)).toBe(false);
      expect(isCountedDay("2026-10-05", rows, KEEP)).toBe(false);
    },
  );

  it("lets an exam week truthfully say it is a working day", () => {
    // The spec's two columns answer different questions; nothing forces an
    // exam week to claim the college was shut.
    const rows = cal({ date: "2026-10-05", kind: "EXAM_WEEK", isWorkingDay: true });
    expect(rows.get("2026-10-05")?.isWorkingDay).toBe(true);
    expect(isCountedDay("2026-10-05", rows, EXCLUDE)).toBe(false);
  });

  it("is the one thing excludeNonWorkingDays switches", () => {
    const sunday = cal({ date: "2026-10-04", isWorkingDay: false });
    expect(isCountedDay("2026-10-04", sunday, EXCLUDE)).toBe(false);
    expect(isCountedDay("2026-10-04", sunday, KEEP)).toBe(true);
  });
});

describe("calendarExclusionReason", () => {
  it("names the kind", () => {
    expect(calendarExclusionReason("2026-10-05", cal({ date: "2026-10-05", kind: "HOLIDAY" }), EXCLUDE)).toBe(
      "HOLIDAY",
    );
  });

  it("names NON_WORKING only while the toggle is on", () => {
    const sunday = cal({ date: "2026-10-04", isWorkingDay: false });
    expect(calendarExclusionReason("2026-10-04", sunday, EXCLUDE)).toBe("NON_WORKING");
    expect(calendarExclusionReason("2026-10-04", sunday, KEEP)).toBeNull();
  });

  it("is null for a counted day and for an unknown day", () => {
    expect(calendarExclusionReason("2026-10-05", cal({ date: "2026-10-05" }), EXCLUDE)).toBeNull();
    expect(calendarExclusionReason("2026-10-05", cal(), EXCLUDE)).toBeNull();
  });
});

describe("countedDaysBetween", () => {
  it("excludes the day the student was last active", () => {
    // They worked that day. Counting it would make somebody who solved a
    // problem this morning already one day idle.
    expect(countedDaysBetween("2026-10-01", "2026-10-03", october(), EXCLUDE)).toEqual([
      "2026-10-02",
      "2026-10-03",
    ]);
  });

  it("includes the last day — the 02:00 sweep judges the day that just ended", () => {
    expect(countedDaysBetween("2026-10-01", "2026-10-02", october(), EXCLUDE)).toEqual(["2026-10-02"]);
  });

  it("is empty when no day has passed", () => {
    expect(countedDaysBetween("2026-10-03", "2026-10-03", october(), EXCLUDE)).toEqual([]);
  });

  it("skips holidays, exam weeks, breaks and placement weeks inside the window", () => {
    const rows = october({
      "2026-10-02": { kind: "HOLIDAY", isWorkingDay: false },
      "2026-10-03": { kind: "EXAM_WEEK" },
      "2026-10-04": { kind: "SEMESTER_BREAK", isWorkingDay: false },
      "2026-10-05": { kind: "PLACEMENT_WEEK" },
    });
    expect(countedDaysBetween("2026-10-01", "2026-10-07", rows, EXCLUDE)).toEqual([
      "2026-10-06",
      "2026-10-07",
    ]);
  });

  it("counts a whole quiet fortnight", () => {
    expect(countedDaysBetween("2026-10-01", "2026-10-15", october(), EXCLUDE)).toHaveLength(14);
  });
});

describe("leaveCoveredDays", () => {
  it("covers both end dates", () => {
    const days = leaveCoveredDays([leave({ startDate: "2026-10-03", endDate: "2026-10-05" })], "2026-10-01", "2026-10-10");
    expect([...days.keys()]).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(days.get("2026-10-03")).toBe("MEDICAL");
  });

  it.each(["REQUESTED", "REJECTED", "CANCELLED"] as const)("ignores a %s row", (status) => {
    // Or a student could stop the counter by asking.
    const days = leaveCoveredDays(
      [leave({ startDate: "2026-10-03", endDate: "2026-10-05", status })],
      "2026-10-01",
      "2026-10-10",
    );
    expect(days.size).toBe(0);
  });

  it("clips a leave that starts before the window", () => {
    const days = leaveCoveredDays([leave({ startDate: "2026-09-20", endDate: "2026-10-02" })], "2026-10-01", "2026-10-10");
    expect([...days.keys()]).toEqual(["2026-10-01", "2026-10-02"]);
  });

  it("clips a leave that ends after the window", () => {
    const days = leaveCoveredDays([leave({ startDate: "2026-10-09", endDate: "2026-11-30" })], "2026-10-01", "2026-10-10");
    expect([...days.keys()]).toEqual(["2026-10-09", "2026-10-10"]);
  });

  it("ignores a leave entirely outside the window", () => {
    expect(
      leaveCoveredDays([leave({ startDate: "2026-11-01", endDate: "2026-11-05" })], "2026-10-01", "2026-10-10").size,
    ).toBe(0);
  });

  it("keeps the first kind when two leaves touch one day", () => {
    const days = leaveCoveredDays(
      [
        leave({ id: "a", startDate: "2026-10-03", endDate: "2026-10-04", kind: "MEDICAL" }),
        leave({ id: "b", startDate: "2026-10-04", endDate: "2026-10-05", kind: "SPORTS_EVENT" }),
      ],
      "2026-10-01",
      "2026-10-10",
    );
    expect(days.get("2026-10-04")).toBe("MEDICAL");
  });
});

describe("mergeExclusions", () => {
  const days = daysInclusive("2026-10-02", "2026-10-06");

  it("returns two arrays of the same length, aligned and ascending", () => {
    const merged = mergeExclusions({
      days: [...days].reverse(),
      cal: october({ "2026-10-05": { kind: "HOLIDAY", isWorkingDay: false } }),
      excludeNonWorkingDays: true,
      activeDays: new Set(["2026-10-03"]),
      leaveDays: new Map([["2026-10-02", "MEDICAL" as const]]),
    });
    expect(merged.excludedDates).toEqual(["2026-10-02", "2026-10-03", "2026-10-05"]);
    expect(merged.excludedReason).toEqual(["MEDICAL_LEAVE", "ACTIVE", "HOLIDAY"]);
    expect(merged.excludedDates).toHaveLength(merged.excludedReason.length);
  });

  it("gives a holiday inside a leave range exactly one reason, and it is the holiday", () => {
    // The college was shut. That is true of every student that day and needs
    // no medical note to explain it.
    const merged = mergeExclusions({
      days,
      cal: october({ "2026-10-04": { kind: "HOLIDAY", isWorkingDay: false } }),
      excludeNonWorkingDays: true,
      activeDays: new Set(),
      leaveDays: leaveCoveredDays([leave({ startDate: "2026-10-03", endDate: "2026-10-05" })], "2026-10-02", "2026-10-06"),
    });
    expect(merged.excludedDates).toEqual(["2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(merged.excludedReason).toEqual(["MEDICAL_LEAVE", "HOLIDAY", "MEDICAL_LEAVE"]);
    expect(merged.excludedDates.filter((d) => d === "2026-10-04")).toHaveLength(1);
  });

  it("prefers ACTIVE over a leave, because the student actually worked", () => {
    const merged = mergeExclusions({
      days: ["2026-10-03"],
      cal: october(),
      excludeNonWorkingDays: true,
      activeDays: new Set(["2026-10-03"]),
      leaveDays: new Map([["2026-10-03", "MEDICAL" as const]]),
    });
    expect(merged.excludedReason).toEqual(["ACTIVE"]);
  });

  it("records nothing for a plain counted day", () => {
    const merged = mergeExclusions({
      days,
      cal: october(),
      excludeNonWorkingDays: true,
      activeDays: new Set(),
      leaveDays: new Map(),
    });
    expect(merged).toEqual({ excludedDates: [], excludedReason: [] });
  });

  it("uses only reasons the evidence schema knows", () => {
    const merged = mergeExclusions({
      days,
      cal: october({ "2026-10-02": { isWorkingDay: false }, "2026-10-03": { kind: "PLACEMENT_WEEK" } }),
      excludeNonWorkingDays: true,
      activeDays: new Set(["2026-10-04"]),
      leaveDays: new Map([["2026-10-05", "BEREAVEMENT" as const]]),
    });
    for (const reason of merged.excludedReason) expect(EXCLUSION_REASONS).toContain(reason);
    expect(merged.excludedReason).toEqual(["NON_WORKING", "PLACEMENT_WEEK", "ACTIVE", "BEREAVEMENT_LEAVE"]);
  });
});

describe("calendarCovers", () => {
  it("is true when every day of the window has a row", () => {
    expect(calendarCovers("2026-10-01", "2026-10-10", october())).toBe(true);
  });

  it("is false for an empty calendar — the sweep escalates nobody", () => {
    expect(calendarCovers("2026-10-01", "2026-10-10", calendarLookup([]))).toBe(false);
  });

  it("is false when one day in the middle is missing", () => {
    const rows = calendarLookup(
      daysInclusive("2026-10-01", "2026-10-10")
        .filter((date) => date !== "2026-10-07")
        .map((date) => ({ date, kind: "REGULAR" as const, isWorkingDay: true })),
    );
    expect(calendarCovers("2026-10-01", "2026-10-10", rows)).toBe(false);
    expect(uncoveredDays("2026-10-01", "2026-10-10", rows)).toEqual(["2026-10-07"]);
  });

  it("does not require a row for the last-active day itself", () => {
    const rows = cal({ date: "2026-10-02" });
    expect(calendarCovers("2026-10-01", "2026-10-02", rows)).toBe(true);
  });

  it("is true for an empty window", () => {
    expect(calendarCovers("2026-10-02", "2026-10-02", calendarLookup([]))).toBe(true);
  });
});

describe("termKeyFor", () => {
  it("names the last semester break that ended on or before the day", () => {
    const rows = cal(
      { date: "2026-05-18", kind: "SEMESTER_BREAK", isWorkingDay: false },
      { date: "2026-12-20", kind: "SEMESTER_BREAK", isWorkingDay: false },
    );
    expect(termKeyFor("2026-10-05", rows)).toBe("T2026-05-18");
    expect(termKeyFor("2027-01-05", rows)).toBe("T2026-12-20");
  });

  it("includes a break on the day itself", () => {
    const rows = cal({ date: "2026-10-05", kind: "SEMESTER_BREAK", isWorkingDay: false });
    expect(termKeyFor("2026-10-05", rows)).toBe("T2026-10-05");
  });

  it("falls back to the academic year, which allows fewer self-clears", () => {
    expect(termKeyFor("2026-10-05", october())).toBe("AY2026");
    expect(termKeyFor("2027-03-05", calendarLookup([]))).toBe("AY2026");
  });

  it("is stable across a term, so one self-clear covers the whole of it", () => {
    const rows = cal({ date: "2026-05-18", kind: "SEMESTER_BREAK", isWorkingDay: false });
    expect(termKeyFor("2026-06-01", rows)).toBe(termKeyFor("2026-11-30", rows));
  });
});

describe("academicYearOf", () => {
  it("starts in June", () => {
    expect(academicYearOf("2026-06-01")).toBe(2026);
    expect(academicYearOf("2026-05-31")).toBe(2025);
    expect(academicYearOf("2026-12-31")).toBe(2026);
    expect(academicYearOf("2027-01-01")).toBe(2026);
  });
});
