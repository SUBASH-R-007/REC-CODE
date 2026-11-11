import { campusDay, isoWeekKey } from "@recx/shared";

/**
 * Campus weeks (Asia/Kolkata, Monday first) for the admin overview and
 * reports. Pure.
 */

const DAY_MS = 86_400_000;

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday ("yyyy-MM-dd") of the campus week containing `at`. */
export function campusMonday(at: Date): string {
  const day = campusDay(at);
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // Sun = 0
  return shiftDay(day, -((weekday + 6) % 7));
}

/** Monday 00:00 IST of the campus week containing `at`, as an instant. */
export function campusWeekStart(at: Date): Date {
  return new Date(`${campusMonday(at)}T00:00:00+05:30`);
}

export interface CampusWeek {
  /** "yyyy-MM-dd" of its Monday. */
  monday: string;
  /** ISO week key, as XpBucket.periodKey stores it ("2026-W41"). */
  key: string;
}

/** The last `n` campus weeks ending with the current one, oldest first. */
export function lastCampusWeeks(at: Date, n: number): CampusWeek[] {
  const thisMonday = campusMonday(at);
  const weeks: CampusWeek[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const monday = shiftDay(thisMonday, -7 * i);
    // Noon IST of that Monday is unambiguously inside the campus week.
    weeks.push({ monday, key: isoWeekKey(new Date(`${monday}T12:00:00+05:30`)) });
  }
  return weeks;
}
