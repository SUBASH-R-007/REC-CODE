import type { Metadata } from "next";
import { Badge, EmptyState } from "@recx/design";
import { RESTRICTION_STAGE_ADMIN_LABEL, canStaffClear, formatCampusTime } from "@recx/shared";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { describeScope, isEmptyScope } from "@/lib/auth/scope-where";
import { openReviewItems } from "@/server/queries/admin-inactivity";
import { ReviewActions } from "@/components/admin/review-actions";

export const metadata: Metadata = { title: "Inactivity review" };

/**
 * `/admin/inactivity` — the students the sweep stopped at and handed to a
 * human (Phase 8d).
 *
 * SPEC §5: "otherwise the job stops at SOFT_RESTRICTED and raises an admin
 * review item." This is the point of the whole design: the maximum the
 * software does on its own is pause somebody and ask a person to look. The
 * page is therefore written for the person looking, not for the audit — it
 * leads with how long since the student was last active, how many days were
 * EXCLUDED, and what to do about it.
 *
 * Fail-closed by scope: an ADMIN with no active grant sees nobody, and is
 * told so rather than shown an empty list that reads like good news.
 */
export default async function AdminInactivityPage() {
  const { scope } = await requireAdminScopePage();
  const items = isEmptyScope(scope) ? [] : await openReviewItems(scope);

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Inactivity review</h1>
        <p className="max-w-3xl text-sm text-text-secondary">
          Students the nightly job has paused, or could not decide about. Nothing here needs you urgently and nothing
          here is a punishment — a pause lifts the moment the student solves one problem, with nobody&apos;s approval.
          What this queue is for is the one case software cannot handle: a person who has stopped for a reason, and
          needs somebody to ask.
        </p>
        <p className="text-sm text-muted">{describeScope(scope)}</p>
      </header>

      {isEmptyScope(scope) ? (
        <EmptyState
          title="You have no student scope"
          description="An administrator needs an active scope grant to see students. Ask a super-admin for one — this page is empty because of your access, not because the queue is."
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="No student in your scope is paused or stuck. If the academic calendar is incomplete the job holds everybody back and raises an item here, so an empty queue with a complete calendar really does mean nothing to do."
        />
      ) : (
        <>
          <p className="text-sm">
            <strong>{items.length}</strong> waiting, oldest first.
          </p>
          <ul className="space-y-6">
            {items.map((item) => (
              <li key={item.userId} className="space-y-4 rounded-xl border border-border p-5">
                <div className="flex flex-wrap items-baseline gap-2 text-sm">
                  <strong className="text-base">{item.name}</strong>
                  <span className="font-mono text-xs text-muted">{item.collegeId}</span>
                  {item.batchYear !== null || item.departmentCode !== null ? (
                    <span className="text-text-secondary">
                      {[item.departmentCode, item.batchYear].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                  {/* In words as well as colour. */}
                  <Badge tone={item.stage === "SOFT_RESTRICTED" || item.stage === "DISABLED" ? "warning" : "info"}>
                    {RESTRICTION_STAGE_ADMIN_LABEL[item.stage]}
                  </Badge>
                </div>

                <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Counted inactive days</dt>
                    <dd className="font-medium">{item.countedInactiveDays}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Days not counted</dt>
                    {/* The number that stops this looking like negligence: the
                        job already discounted holidays, exam weeks, placement
                        weeks, approved leave and days they did work. */}
                    <dd className="font-medium">{item.excludedDays}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Last active</dt>
                    <dd className="font-medium">
                      {item.lastActiveAt ? formatCampusTime(item.lastActiveAt) : "never"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Waiting since</dt>
                    <dd className="font-medium">{formatCampusTime(item.openedAt)}</dd>
                  </div>
                </dl>

                <p className="text-xs text-muted">
                  Decided under policy version {item.policyVersion ?? "—"}, last evaluated{" "}
                  {item.lastEvaluatedAt ? formatCampusTime(item.lastEvaluatedAt) : "—"}.
                </p>

                <ReviewActions userId={item.userId} name={item.name} canClear={canStaffClear(item.stage)} />
              </li>
            ))}
          </ul>
        </>
      )}

      <section className="space-y-2 border-t border-border pt-5 text-sm text-text-secondary">
        <h2 className="font-display text-base font-semibold text-text">What the job will not do</h2>
        <ul className="list-inside list-disc space-y-1">
          <li>It never closes an account on its own unless a super-admin has switched that on, and it is off.</li>
          <li>It never moves more than one rung in a night.</li>
          <li>
            It never touches a student who is sitting an assessment, who has an assessment inside 72 hours, or who is
            waiting on a decision about their integrity.
          </li>
          <li>It escalates nobody at all while the academic calendar does not cover the days it is counting.</li>
        </ul>
      </section>
    </div>
  );
}
