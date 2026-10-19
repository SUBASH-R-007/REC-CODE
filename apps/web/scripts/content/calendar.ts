import { campusDay, daysInclusive } from "@recx/shared";
import type { CalendarDayKind, Db } from "@recx/db";

/**
 * Seeding an academic calendar (Phase 8a).
 *
 * Not decoration. The inactivity counter in Phase 8c refuses to escalate
 * anybody while the calendar does not cover the evaluation window, so a dev
 * database with no calendar is a dev database where the whole policy engine
 * is a no-op — the sweep runs, holds everybody back and reports
 * `calendarIncomplete`, and nobody developing against it would see a single
 * transition. The seed exists so the engine can be exercised at all.
 *
 * It writes from today onwards only. A past day is immutable by trigger, and
 * a seeder that tried to re-write yesterday would crash on its second run,
 * which is the worst kind of seed bug: green once, red forever after.
 *
 * The shape is a real Indian college term rather than a uniform block,
 * because a counter tested only against uniform days is a counter whose
 * holiday handling has never run: Sundays off, a scattering of holidays, an
 * exam week that is still a working week, a placement week, and a semester
 * break that bounds the term key.
 */

export interface CalendarSeedResult {
  readonly written: number;
  readonly skippedPast: number;
  readonly from: string;
  readonly to: string;
}

/** Days ahead the seeded calendar covers: a term and a bit. */
const HORIZON_DAYS = 150;

interface Marked {
  readonly kind: CalendarDayKind;
  readonly isWorkingDay: boolean;
  readonly label: string;
}

/**
 * Named runs, as offsets in days from the first seeded day, so the seed is
 * the same shape whenever it is run rather than depending on the month it
 * happens to be run in.
 */
const RUNS: ReadonlyArray<{ from: number; to: number } & Marked> = [
  { from: 20, to: 20, kind: "HOLIDAY", isWorkingDay: false, label: "Deepavali" },
  { from: 44, to: 48, kind: "EXAM_WEEK", isWorkingDay: true, label: "CAT-2 week" },
  { from: 70, to: 70, kind: "HOLIDAY", isWorkingDay: false, label: "Institution day" },
  { from: 86, to: 90, kind: "PLACEMENT_WEEK", isWorkingDay: true, label: "On-campus drive week" },
  { from: 104, to: 117, kind: "SEMESTER_BREAK", isWorkingDay: false, label: "Semester break" },
  { from: 130, to: 130, kind: "HOLIDAY", isWorkingDay: false, label: "Pongal" },
];

function markFor(day: string, offset: number): Marked {
  for (const run of RUNS) {
    if (offset >= run.from && offset <= run.to) {
      return { kind: run.kind, isWorkingDay: run.isWorkingDay, label: run.label };
    }
  }
  // Sunday is a non-working REGULAR day: the kind says the term is running,
  // the flag says nobody is in. Those two columns are read separately, and
  // this is the case that proves it.
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  if (weekday === 0) return { kind: "REGULAR", isWorkingDay: false, label: "Sunday" };
  return { kind: "REGULAR", isWorkingDay: true, label: "Working day" };
}

export async function syncSeededCalendar(
  db: Db,
  createdById: string,
  now = new Date(),
): Promise<CalendarSeedResult> {
  const today = campusDay(now);
  const start = new Date(`${today}T00:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + HORIZON_DAYS);
  const days = daysInclusive(today, end.toISOString().slice(0, 10));

  let written = 0;
  for (const [offset, day] of days.entries()) {
    const mark = markFor(day, offset);
    const date = new Date(`${day}T00:00:00.000Z`);
    await db.calendarDay.upsert({
      where: { date },
      create: { date, createdById, ...mark },
      // `createdById` is deliberately not in the update: whoever first
      // entered a day keeps the attribution, and a re-seed is not an edit by
      // a different person.
      update: { kind: mark.kind, isWorkingDay: mark.isWorkingDay, label: mark.label },
    });
    written += 1;
  }

  return {
    written,
    skippedPast: 0,
    from: days[0] ?? today,
    to: days.at(-1) ?? today,
  };
}
