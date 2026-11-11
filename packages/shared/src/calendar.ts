/**
 * The academic calendar, and which days a student owes work on (Phase 8a).
 *
 * Everything here is pure: no I/O, no Prisma, no ambient clock. The caller
 * passes the days it has loaded and the policy toggles it resolved, and gets
 * back a decision it can put in an evidence row. That is not tidiness — the
 * numbers these functions return are the numbers a disputed lockout is argued
 * from months later, so they have to be reproducible from their inputs alone.
 *
 * A "day" is always a campus day, "yyyy-MM-dd" in Asia/Kolkata, the same unit
 * `time.ts` uses for streaks and daily caps. Never a `Date` with a time on it:
 * a window that starts "on the 3rd" and a window that starts "on the 3rd at
 * 00:00 in whatever zone the server booted in" are different windows, and only
 * one of them is the one the college means.
 */

import { dayDifference } from "./time";

export const CALENDAR_DAY_KINDS = ["REGULAR", "HOLIDAY", "EXAM_WEEK", "SEMESTER_BREAK", "PLACEMENT_WEEK"] as const;
export type CalendarDayKind = (typeof CALENDAR_DAY_KINDS)[number];

export const LEAVE_KINDS = [
  "MEDICAL",
  "BEREAVEMENT",
  "UNIVERSITY_EXAM",
  "PLACEMENT_DRIVE",
  "INTERNSHIP",
  "SPORTS_EVENT",
  "APPROVED_OTHER",
] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "CANCELLED"] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** Student-facing names. A leave kind is read by the student who asked for it. */
export const LEAVE_KIND_LABEL: Record<LeaveKind, string> = {
  MEDICAL: "Medical",
  BEREAVEMENT: "Bereavement",
  UNIVERSITY_EXAM: "University exam",
  PLACEMENT_DRIVE: "Placement drive",
  INTERNSHIP: "Internship",
  SPORTS_EVENT: "Sports event",
  APPROVED_OTHER: "Other, approved",
};

export const CALENDAR_DAY_KIND_LABEL: Record<CalendarDayKind, string> = {
  REGULAR: "Regular day",
  HOLIDAY: "Holiday",
  EXAM_WEEK: "Exam week",
  SEMESTER_BREAK: "Semester break",
  PLACEMENT_WEEK: "Placement week",
};

/** One row of the academic calendar, as the counter needs it. */
export interface CalendarDayRow {
  readonly date: string;
  readonly kind: CalendarDayKind;
  readonly isWorkingDay: boolean;
}

/** An approved leave, as the counter needs it. Both end dates inclusive. */
export interface LeaveRow {
  readonly id: string;
  readonly kind: LeaveKind;
  readonly startDate: string;
  readonly endDate: string;
  readonly status: LeaveStatus;
}

/**
 * The calendar as a lookup. A day the college never entered is absent, and
 * absent is NOT the same as regular — see `calendarCovers`.
 */
export type CalendarLookup = ReadonlyMap<string, CalendarDayRow>;

export function calendarLookup(days: readonly CalendarDayRow[]): CalendarLookup {
  const map = new Map<string, CalendarDayRow>();
  for (const day of days) map.set(day.date, day);
  return map;
}

/**
 * The reason a day did not count, one word, recorded positionally beside the
 * date in the evidence JSON.
 *
 * `ACTIVE` is in the same list as the calendar reasons on purpose: a day the
 * student worked and a day the college closed are both days nobody may hold
 * against them, and an evidence row that distinguished them in shape rather
 * than in value would need two readers.
 */
export const EXCLUSION_REASONS = [
  "HOLIDAY",
  "EXAM_WEEK",
  "SEMESTER_BREAK",
  "PLACEMENT_WEEK",
  "NON_WORKING",
  "MEDICAL_LEAVE",
  "BEREAVEMENT_LEAVE",
  "UNIVERSITY_EXAM_LEAVE",
  "PLACEMENT_DRIVE_LEAVE",
  "INTERNSHIP_LEAVE",
  "SPORTS_EVENT_LEAVE",
  "APPROVED_OTHER_LEAVE",
  "ACTIVE",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export function leaveExclusionReason(kind: LeaveKind): ExclusionReason {
  return `${kind}_LEAVE` as ExclusionReason;
}

/** Every day in `[fromDay, toDay]`, ascending. Both ends inclusive. */
export function daysInclusive(fromDay: string, toDay: string): string[] {
  const span = dayDifference(fromDay, toDay);
  if (span < 0) return [];
  const out: string[] = [];
  const start = Date.parse(`${fromDay}T00:00:00Z`);
  for (let i = 0; i <= span; i += 1) {
    out.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Does this day count against a student?
 *
 * `kind <> REGULAR` always excludes: nobody owes work during a semester break,
 * and that is structural rather than a preference. `isWorkingDay = false` is
 * the weekend and the odd declared-off working day, and THAT is what the
 * policy's `excludeNonWorkingDays` switches — which is why the two columns are
 * read separately and why no CHECK ties them together. An exam week is a
 * working week and the calendar may truthfully say so.
 *
 * A day with no calendar row counts. That is the harshest reading, which is
 * why no escalation is allowed to rest on it: `calendarCovers` is the gate,
 * and the sweep holds everybody back while it is false.
 */
export function isCountedDay(
  day: string,
  cal: CalendarLookup,
  options: { readonly excludeNonWorkingDays: boolean },
): boolean {
  const row = cal.get(day);
  if (!row) return true;
  if (row.kind !== "REGULAR") return false;
  if (options.excludeNonWorkingDays && !row.isWorkingDay) return false;
  return true;
}

/** Why a calendar day did not count, or null when it did. */
export function calendarExclusionReason(
  day: string,
  cal: CalendarLookup,
  options: { readonly excludeNonWorkingDays: boolean },
): ExclusionReason | null {
  const row = cal.get(day);
  if (!row) return null;
  if (row.kind === "HOLIDAY") return "HOLIDAY";
  if (row.kind === "EXAM_WEEK") return "EXAM_WEEK";
  if (row.kind === "SEMESTER_BREAK") return "SEMESTER_BREAK";
  if (row.kind === "PLACEMENT_WEEK") return "PLACEMENT_WEEK";
  if (options.excludeNonWorkingDays && !row.isWorkingDay) return "NON_WORKING";
  return null;
}

/**
 * The counted campus days in `(fromDay, toDay]` — exclusive of the first,
 * inclusive of the last.
 *
 * Exclusive of the first because `fromDay` is the day the student was last
 * active: they worked that day, so counting it would mean a student who solved
 * a problem this morning is already one day idle. Inclusive of the last
 * because today is over as far as the 02:00 sweep is concerned — it runs after
 * midnight and evaluates the day that just ended.
 */
export function countedDaysBetween(
  fromDay: string,
  toDay: string,
  cal: CalendarLookup,
  options: { readonly excludeNonWorkingDays: boolean },
): string[] {
  const all = daysInclusive(fromDay, toDay);
  return all.slice(1).filter((day) => isCountedDay(day, cal, options));
}

/**
 * Which days an approved leave covers, and under which kind.
 *
 * `APPROVED` only — a `REQUESTED` row excuses nothing, or a student could
 * stop the counter by asking. The exclusion constraint on the table means two
 * approved leaves never overlap for one student, so a day maps to exactly one
 * kind; `first wins` here is belt-and-braces for data loaded before that
 * constraint existed.
 */
export function leaveCoveredDays(
  leaves: readonly LeaveRow[],
  fromDay: string,
  toDay: string,
): Map<string, LeaveKind> {
  const covered = new Map<string, LeaveKind>();
  for (const leave of leaves) {
    if (leave.status !== "APPROVED") continue;
    const start = dayDifference(fromDay, leave.startDate) > 0 ? leave.startDate : fromDay;
    const end = dayDifference(leave.endDate, toDay) > 0 ? leave.endDate : toDay;
    for (const day of daysInclusive(start, end)) {
      if (!covered.has(day)) covered.set(day, leave.kind);
    }
  }
  return covered;
}

/** One excluded day and why, positionally aligned in the evidence JSON. */
export interface Exclusions {
  readonly excludedDates: string[];
  readonly excludedReason: ExclusionReason[];
}

/**
 * Merge the three sources of exclusion into the two aligned arrays the
 * evidence CHECK requires, ascending by date, one entry per day.
 *
 * Precedence is calendar, then activity, then leave, and it is fixed rather
 * than "whichever we noticed first" because the reason is read by a human
 * arguing about a lockout. A holiday inside a medical leave reads `HOLIDAY`:
 * the college was shut, which is true of every student that day and needs no
 * medical note to explain.
 */
export function mergeExclusions(input: {
  readonly days: readonly string[];
  readonly cal: CalendarLookup;
  readonly excludeNonWorkingDays: boolean;
  readonly activeDays: ReadonlySet<string>;
  readonly leaveDays: ReadonlyMap<string, LeaveKind>;
}): Exclusions {
  const excludedDates: string[] = [];
  const excludedReason: ExclusionReason[] = [];
  for (const day of [...input.days].sort()) {
    const calendar = calendarExclusionReason(day, input.cal, {
      excludeNonWorkingDays: input.excludeNonWorkingDays,
    });
    const leave = input.leaveDays.get(day);
    const reason: ExclusionReason | null = calendar
      ? calendar
      : input.activeDays.has(day)
        ? "ACTIVE"
        : leave
          ? leaveExclusionReason(leave)
          : null;
    if (reason === null) continue;
    excludedDates.push(day);
    excludedReason.push(reason);
  }
  return { excludedDates, excludedReason };
}

/**
 * Does the calendar cover every day of the evaluation window?
 *
 * An empty or sparse calendar makes every day a working day, which is the
 * counter's harshest possible reading — a college that has not loaded its
 * holidays would restrict students for being away over Pongal. So this is the
 * gate: the sweep escalates nobody while it is false, reports
 * `calendarIncomplete`, and raises an admin review item instead
 * (`docs/OPEN-QUESTIONS.md`). Under-enforcing is the correct failure
 * direction, and it is the only direction that cannot wrong a student.
 */
export function calendarCovers(fromDay: string, toDay: string, cal: CalendarLookup): boolean {
  const days = daysInclusive(fromDay, toDay).slice(1);
  if (days.length === 0) return true;
  return days.every((day) => cal.has(day));
}

/** The campus days in the window with no calendar row, for the report. */
export function uncoveredDays(fromDay: string, toDay: string, cal: CalendarLookup): string[] {
  return daysInclusive(fromDay, toDay)
    .slice(1)
    .filter((day) => !cal.has(day));
}

/**
 * The academic term a day belongs to, for `selfClearedTermKey`.
 *
 * The spec gates self-service clearing on "once per semester" without saying
 * what a semester is. A semester is bounded by `SEMESTER_BREAK` days in the
 * calendar, so the term key is the last break that ENDED on or before this day
 * — "T2026-05-18" means "the term that began after the break ending 18 May
 * 2026". While the calendar has no break rows, the key falls back to the
 * academic year (`AY2026`, June to May), which spans longer than a semester
 * and therefore allows FEWER self-clears. That is the stricter reading, which
 * is the one to ship when the data is missing.
 */
export function termKeyFor(day: string, cal: CalendarLookup): string {
  let latestBreakEnd: string | null = null;
  for (const row of cal.values()) {
    if (row.kind !== "SEMESTER_BREAK") continue;
    if (dayDifference(row.date, day) < 0) continue;
    if (latestBreakEnd === null || dayDifference(latestBreakEnd, row.date) > 0) latestBreakEnd = row.date;
  }
  if (latestBreakEnd !== null) return `T${latestBreakEnd}`;
  return `AY${academicYearOf(day)}`;
}

/**
 * The academic year a day falls in, as its starting calendar year. June
 * onwards belongs to that year; January to May belongs to the previous one,
 * because the academic year at REC runs June to May.
 */
export function academicYearOf(day: string): number {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month >= 6 ? year : year - 1;
}
