import type { Metadata } from "next";
import { Badge, EmptyState } from "@recx/design";
import { LEAVE_KIND_LABEL, formatCampusTime } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { myLeaveRequests } from "@/server/queries/calendar";
import { CancelLeaveButton, LeaveForm } from "@/components/account/leave-form";

export const metadata: Metadata = { title: "Excused days" };

/**
 * `/account/leave` — a student's own excused absences (Phase 8a).
 *
 * Reachable at 375px and intended to be: this is the page somebody opens on
 * the phone they have in a hospital bed, which is the exact circumstance the
 * feature exists for.
 *
 * From Phase 8e this page is part of the route out of an inactivity
 * restriction, so it must stay reachable to a restricted account. A route out
 * that is itself behind the restriction is not a route out.
 */
export default async function AccountLeavePage() {
  const user = await requireUser();
  const leaves = await myLeaveRequests(user.id);

  const tone = (status: string) =>
    status === "APPROVED" ? "success" : status === "REJECTED" ? "warning" : status === "CANCELLED" ? "default" : "info";
  const say = (status: string) =>
    status === "APPROVED"
      ? "excused"
      : status === "REJECTED"
        ? "not excused"
        : status === "CANCELLED"
          ? "called off"
          : "waiting for a decision";

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Days you were away</h1>
        <p className="max-w-2xl text-sm text-text-secondary">
          If you were ill, bereaved, at a university exam, on a placement drive or away for the college, those days
          should not be counted as time you simply did not practise. Tell us about them here and the placement cell
          will excuse them.
        </p>
        <p className="max-w-2xl text-sm">
          <strong>Asking is not the same as being excused.</strong> A request only counts once somebody approves it, so
          keep practising if you can — and if you cannot, that is exactly what this form is for.
        </p>
      </header>

      <section className="space-y-4 rounded-xl border border-border p-5">
        <h2 className="font-display text-lg font-semibold">Ask for days to be excused</h2>
        <LeaveForm />
      </section>

      <section className="space-y-4">
        <h2 className="font-display text-lg font-semibold">What you have asked for</h2>
        {leaves.length === 0 ? (
          <EmptyState
            title="Nothing yet"
            description="When you ask for days to be excused, they appear here with the decision."
          />
        ) : (
          <ul className="space-y-4">
            {leaves.map((leave) => (
              <li key={leave.id} className="space-y-2 rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-baseline gap-2 text-sm">
                  {/* Words, not colour alone. */}
                  <Badge tone={tone(leave.status)}>{say(leave.status)}</Badge>
                  <strong>{LEAVE_KIND_LABEL[leave.kind]}</strong>
                  <span className="text-text-secondary">
                    {leave.startDate} to {leave.endDate}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm">{leave.reason}</p>
                {leave.decisionNote ? (
                  <p className="rounded-md bg-surface p-3 text-sm">
                    <span className="font-medium">What they said: </span>
                    {leave.decisionNote}
                  </p>
                ) : null}
                <p className="text-xs text-muted">Asked {formatCampusTime(leave.createdAt)}</p>
                {leave.status === "REQUESTED" || leave.status === "APPROVED" ? (
                  <CancelLeaveButton leaveId={leave.id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2 border-t border-border pt-5 text-sm text-text-secondary">
        <h2 className="font-display text-base font-semibold text-text">If a request is refused</h2>
        <p className="max-w-2xl">
          The note above says why, and it is usually something you can put right — a certificate that was not attached,
          or dates that did not match. You can ask again. If you think the decision is wrong, the placement cell will
          look at it again; nothing here is final and nothing here is automatic.
        </p>
      </section>
    </div>
  );
}
