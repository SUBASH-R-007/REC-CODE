/**
 * Campus calendar. Every "day" in REC Code — streaks, the activity heatmap,
 * daily XP caps, daily judge usage, the weekly leaderboard — is an
 * Asia/Kolkata calendar day, whatever the server's own time zone.
 */
export const CAMPUS_TIME_ZONE = "Asia/Kolkata";

/**
 * "10 Oct 2026, 14:05 IST" — the one campus-time formatter.
 *
 * Every date a student or a staff member reads is in campus time, and it is
 * written with the zone named, because an exam window read in the wrong zone
 * is the Phase 5 datetime-local bug all over again (docs/OPEN-QUESTIONS.md).
 * 24-hour, because "2 PM" and "2 AM" are one keystroke apart in a form and
 * one glance apart on a seat slip.
 */
const CAMPUS_FORMAT = new Intl.DateTimeFormat("en-IN", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: CAMPUS_TIME_ZONE,
});

export function formatCampusTime(date: Date | null | undefined): string {
  return date ? `${CAMPUS_FORMAT.format(date)} IST` : "—";
}

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAMPUS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "yyyy-MM-dd" — the campus calendar day containing `at`. */
export function campusDay(at: Date): string {
  return dayFormatter.format(at);
}

/** The campus day as a UTC-midnight Date, for @db.Date columns. */
export function campusDayDate(at: Date): Date {
  return new Date(`${campusDay(at)}T00:00:00.000Z`);
}

/** Whole days from day `a` to day `b` ("yyyy-MM-dd" strings). */
export function dayDifference(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** "yyyy-MM" of the campus day containing `at`. */
export function monthKey(at: Date): string {
  return campusDay(at).slice(0, 7);
}

/**
 * ISO-8601 week of the campus day containing `at`, e.g. "2026-W41". Weeks
 * start on Monday; week 1 is the week with the year's first Thursday.
 */
export function isoWeekKey(at: Date): string {
  const day = new Date(`${campusDay(at)}T00:00:00Z`);
  const weekday = day.getUTCDay() || 7; // Mon = 1 … Sun = 7
  day.setUTCDate(day.getUTCDate() + 4 - weekday); // the Thursday of this week
  const year = day.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export const XP_PERIODS = ["ALL_TIME", "MONTH", "WEEK"] as const;
export type XpPeriod = (typeof XP_PERIODS)[number];

/** The bucket key of each period for a moment in time. */
export function periodKey(period: XpPeriod, at: Date): string {
  if (period === "ALL_TIME") return "all";
  if (period === "MONTH") return monthKey(at);
  return isoWeekKey(at);
}
