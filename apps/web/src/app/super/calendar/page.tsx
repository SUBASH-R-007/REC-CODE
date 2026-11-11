import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@recx/design";
import {
  CALENDAR_DAY_KIND_LABEL,
  LEAVE_KIND_LABEL,
  campusDay,
  formatCampusTime,
} from "@recx/shared";
import { requireSuperAdminPage } from "@/lib/auth/guards";
import { calendarMonth, decidedLeaveRequests, pendingLeaveRequests } from "@/server/queries/super-calendar";
import { CalendarDayForm } from "@/components/super/calendar-day-form";
import { LeaveDecision } from "@/components/super/leave-decision";
import { PageHeader } from "@/components/super/ui";

export const metadata: Metadata = { title: "Academic calendar · Super-admin" };

/**
 * `/super/calendar` — the academic calendar and the leave decision queue
 * (Phase 8a).
 *
 * The page leads with how much of the month is unentered, because that number
 * is the one with a consequence: while the calendar does not cover an
 * evaluation window, the inactivity sweep escalates nobody at all. An
 * administrator who does not know that reads an empty queue as "nothing to
 * do" when it actually means "the engine is holding everybody back".
 */
export default async function SuperCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  await requireSuperAdminPage();
  const { month: requested } = await searchParams;
  const today = campusDay(new Date());
  const month = /^\d{4}-\d{2}$/.test(requested ?? "") ? requested! : today.slice(0, 7);

  const [grid, pending, decided] = await Promise.all([
    calendarMonth(month, today),
    pendingLeaveRequests(),
    decidedLeaveRequests(20),
  ]);

  const shift = (by: number) => {
    const at = new Date(`${month}-01T00:00:00.000Z`);
    at.setUTCMonth(at.getUTCMonth() + by);
    return at.toISOString().slice(0, 7);
  };
  const missing = grid.days.filter((day) => day.missing).length;
  const monthName = new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Academic calendar"
        description={
          <>
            Which days the college is open, and which absences are excused. Both decide whether a student&apos;s time
            away counts against them, so both are written down rather than assumed — and a day already past is never
            edited, because a decision already taken cites it.
          </>
        }
      />

      <Card>
        <CardHeader
          title={monthName}
          action={
            <nav className="flex items-center gap-2 text-sm" aria-label="Change month">
              <Link href={`/super/calendar?month=${shift(-1)}`} className="rounded-md border border-border px-3 py-1.5 hover:bg-surface">
                ← Previous
              </Link>
              <Link href={`/super/calendar?month=${today.slice(0, 7)}`} className="rounded-md border border-border px-3 py-1.5 hover:bg-surface">
                This month
              </Link>
              <Link href={`/super/calendar?month=${shift(1)}`} className="rounded-md border border-border px-3 py-1.5 hover:bg-surface">
                Next →
              </Link>
            </nav>
          }
        />
        <CardBody className="space-y-4">
          {missing > 0 ? (
            <p role="status" className="rounded-md border border-warning/40 bg-warning-subtle p-3 text-sm">
              <strong>
                {missing} of {grid.days.length} days this month have no entry.
              </strong>{" "}
              Until a month is entered, the inactivity sweep treats every unentered day as a working day — and because
              that is the harshest possible reading, it refuses to escalate anybody while the calendar is incomplete and
              raises an administrative item instead. Nobody is wrongly restricted by an empty calendar; nobody is
              reached by the policy either.
            </p>
          ) : (
            <p role="status" className="rounded-md border border-success/40 bg-success-subtle p-3 text-sm">
              Every day this month is entered.
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse text-sm">
              <caption className="sr-only">Every day of {monthName}, its kind and whether the college works</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-3">Date</th>
                  <th scope="col" className="py-2 pr-3">Kind</th>
                  <th scope="col" className="py-2 pr-3">Working</th>
                  <th scope="col" className="py-2">Name</th>
                </tr>
              </thead>
              <tbody>
                {grid.days.map((day) => (
                  <tr key={day.date} className="border-b border-border last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {day.date}
                      {day.date === today ? <span className="ml-2 text-xs text-primary">today</span> : null}
                    </td>
                    <td className="py-2 pr-3">
                      {day.missing ? (
                        <Badge tone="warning">not entered</Badge>
                      ) : (
                        CALENDAR_DAY_KIND_LABEL[day.kind]
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {/* In words, never colour alone. */}
                      {day.missing ? <span className="text-muted">—</span> : day.isWorkingDay ? "Yes" : "No"}
                    </td>
                    <td className="py-2">
                      {day.label ?? <span className="text-muted">—</span>}
                      {day.isPast && !day.missing ? (
                        <span className="ml-2 text-xs text-muted">(past — frozen)</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Enter days" />
        <CardBody>
          <CalendarDayForm defaultMonth={month} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Leave waiting for a decision"
          action={<span className="text-sm text-text-secondary">{pending.length} waiting</span>}
        />
        <CardBody className="space-y-5">
          {pending.length === 0 ? (
            <EmptyState title="Nothing waiting" description="No student has an undecided leave request." />
          ) : (
            <>
              <p className="text-sm text-text-secondary">
                Oldest first. A leave decided late excuses nothing that has already been counted, so these are worth
                clearing the day they arrive. You cannot decide a request you raised yourself.
              </p>
              <ul className="space-y-5">
                {pending.map((leave) => (
                  <li key={leave.id} className="space-y-3 rounded-xl border border-border p-4">
                    <div className="flex flex-wrap items-baseline gap-2 text-sm">
                      <strong>{leave.student.name}</strong>
                      <span className="font-mono text-xs text-muted">{leave.student.collegeId}</span>
                      <Badge tone="info">{LEAVE_KIND_LABEL[leave.kind]}</Badge>
                      <span className="text-text-secondary">
                        {leave.startDate} to {leave.endDate}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm">{leave.reason}</p>
                    <p className="text-xs text-muted">Asked {formatCampusTime(leave.createdAt)}</p>
                    <LeaveDecision leaveId={leave.id} student={leave.student.name} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recently decided" />
        <CardBody>
          {decided.length === 0 ? (
            <EmptyState title="Nothing decided yet" description="Decisions appear here once leave has been approved or refused." />
          ) : (
            <ul className="space-y-3 text-sm">
              {decided.map((leave) => (
                <li key={leave.id} className="flex flex-wrap items-baseline gap-2 border-b border-border pb-3 last:border-0">
                  <Badge
                    tone={leave.status === "APPROVED" ? "success" : leave.status === "REJECTED" ? "warning" : "default"}
                  >
                    {leave.status.toLowerCase()}
                  </Badge>
                  <strong>{leave.student.name}</strong>
                  <span className="text-text-secondary">
                    {LEAVE_KIND_LABEL[leave.kind]}, {leave.startDate} to {leave.endDate}
                  </span>
                  {leave.decisionNote ? (
                    <span className="w-full text-xs text-text-secondary">&ldquo;{leave.decisionNote}&rdquo;</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
