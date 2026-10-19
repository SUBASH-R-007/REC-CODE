import "server-only";

import { campusDay, daysInclusive, type CalendarDayKind, type LeaveKind, type LeaveStatus } from "@recx/shared";
import { db } from "@/lib/db";
import { dayToDate } from "@/server/queries/calendar";

/**
 * Reading the academic calendar and the leave queue, for `/super/calendar`
 * (Phase 8a).
 *
 * `super-`-prefixed because these reads are a super-admin's: the leave rows
 * carry other people's medical reasons in their own words, which is about as
 * sensitive as anything in this database. The prefix is what keeps them out
 * of the student-exposure scan, and keeping them out by NAME rather than by a
 * listed exception means a student query added to this file is caught.
 */

/** A @db.Date comes back as a UTC-midnight Date; this is its campus day. */
function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface CalendarMonth {
  readonly month: string;
  readonly days: Array<{
    readonly date: string;
    readonly kind: CalendarDayKind;
    readonly isWorkingDay: boolean;
    readonly label: string | null;
    /** True for a day the calendar has no row for — not the same as regular. */
    readonly missing: boolean;
    readonly isPast: boolean;
  }>;
  readonly entered: number;
}

/**
 * One month, every day of it, with the days nobody has entered marked as
 * such.
 *
 * A grid that silently rendered a missing day as REGULAR would hide the one
 * thing a super-admin opens this page to see: how much of the term is still
 * unentered, which is exactly what stops the sweep escalating anybody.
 */
export async function calendarMonth(month: string, today = campusDay(new Date())): Promise<CalendarMonth> {
  const first = `${month}-01`;
  const next = new Date(`${first}T00:00:00.000Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const last = new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10);

  const rows = await db.calendarDay.findMany({
    where: { date: { gte: dayToDate(first), lte: dayToDate(last) } },
    orderBy: { date: "asc" },
    select: { date: true, kind: true, isWorkingDay: true, label: true },
  });
  const byDay = new Map(rows.map((row) => [dayOf(row.date), row]));

  return {
    month,
    entered: rows.length,
    days: daysInclusive(first, last).map((date) => {
      const row = byDay.get(date);
      return {
        date,
        kind: row?.kind ?? "REGULAR",
        isWorkingDay: row?.isWorkingDay ?? true,
        label: row?.label ?? null,
        missing: row === undefined,
        isPast: date < today,
      };
    }),
  };
}

export interface LeaveListRow {
  readonly id: string;
  readonly kind: LeaveKind;
  readonly status: LeaveStatus;
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
  readonly decisionNote: string | null;
  readonly createdAt: Date;
  readonly student: { readonly id: string; readonly name: string; readonly collegeId: string };
}

const LEAVE_SELECT = {
  id: true,
  kind: true,
  status: true,
  startDate: true,
  endDate: true,
  reason: true,
  decisionNote: true,
  createdAt: true,
  user: { select: { id: true, firstName: true, lastName: true, collegeId: true } },
} as const;

interface LeaveSelected {
  id: string;
  kind: LeaveKind;
  status: LeaveStatus;
  startDate: Date;
  endDate: Date;
  reason: string;
  decisionNote: string | null;
  createdAt: Date;
  user: { id: string; firstName: string; lastName: string; collegeId: string };
}

function toLeaveRow(row: LeaveSelected): LeaveListRow {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    startDate: dayOf(row.startDate),
    endDate: dayOf(row.endDate),
    reason: row.reason,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt,
    student: {
      id: row.user.id,
      name: `${row.user.firstName} ${row.user.lastName}`.trim(),
      collegeId: row.user.collegeId,
    },
  };
}

export const LEAVE_PAGE_SIZE = 50;

/** The decision queue: oldest request first, because a leave decided late excuses nothing. */
export async function pendingLeaveRequests(limit = LEAVE_PAGE_SIZE): Promise<LeaveListRow[]> {
  const rows = await db.leaveException.findMany({
    where: { status: "REQUESTED" },
    orderBy: [{ createdAt: "asc" }],
    take: limit,
    select: LEAVE_SELECT,
  });
  return rows.map(toLeaveRow);
}

/** Recently decided leaves, so a decision can be read back. */
export async function decidedLeaveRequests(limit = LEAVE_PAGE_SIZE): Promise<LeaveListRow[]> {
  const rows = await db.leaveException.findMany({
    where: { status: { in: ["APPROVED", "REJECTED", "CANCELLED"] } },
    orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
    take: limit,
    select: LEAVE_SELECT,
  });
  return rows.map(toLeaveRow);
}
