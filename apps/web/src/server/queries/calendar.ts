import "server-only";

import type { LeaveKind, LeaveStatus } from "@recx/shared";
import { db } from "@/lib/db";

/**
 * A student's own excused absences (Phase 8a).
 *
 * The staff side of the calendar lives in `super-calendar.ts`, because the
 * student-exposure fence scans every query module that is not `admin-`- or
 * `super-`-prefixed and a staff read sitting here would need an exception
 * rather than a guard. The split is the guard.
 *
 * Phase 8c's counter needs the calendar as a window rather than a month; that
 * reader arrives with the counter that uses it.
 */

/** A @db.Date comes back as a UTC-midnight Date; this is its campus day. */
function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A campus day as the UTC-midnight Date a @db.Date column holds. */
export function dayToDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export interface MyLeaveRow {
  readonly id: string;
  readonly kind: LeaveKind;
  readonly status: LeaveStatus;
  readonly startDate: string;
  readonly endDate: string;
  readonly reason: string;
  readonly decisionNote: string | null;
  readonly createdAt: Date;
}

export const MY_LEAVE_LIMIT = 50;

/**
 * One student's own leaves.
 *
 * `userId` is a where clause, never a trusted parameter: this is reached from
 * `/account/leave`, where the only correct answer is the caller's own rows,
 * and the row carries a medical reason in the student's own words.
 */
export async function myLeaveRequests(userId: string): Promise<MyLeaveRow[]> {
  const rows = await db.leaveException.findMany({
    where: { userId },
    orderBy: [{ startDate: "desc" }],
    take: MY_LEAVE_LIMIT,
    select: {
      id: true,
      kind: true,
      status: true,
      startDate: true,
      endDate: true,
      reason: true,
      decisionNote: true,
      createdAt: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    startDate: dayOf(row.startDate),
    endDate: dayOf(row.endDate),
    reason: row.reason,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt,
  }));
}
