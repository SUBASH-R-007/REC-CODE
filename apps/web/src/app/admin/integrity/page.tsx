import type { Metadata } from "next";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { EmptyState } from "@recx/design";
import { formatCampusTime } from "@recx/shared";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { listReviewQueue } from "@/server/queries/admin-integrity";
import { AdminPageHeader } from "@/components/admin/admin-ui";

export const metadata: Metadata = { title: "Integrity review" };
export const dynamic = "force-dynamic";

/**
 * `/admin/integrity` — the review queue (Phase 6e).
 *
 * Worst first, which is what the severity points are FOR: SPEC §5 calls them
 * "severity points, used only to order the review queue". A LOW-band flag
 * appears only when it is in the mandatory 10% sample, because the rest are
 * bulk-cleared and a queue listing every LOW flag is a queue nobody finishes.
 *
 * The deadline column is the point of the screen. Every row that passes 72
 * hours publishes itself as CLEARED, and that is by design — SPEC §5 puts
 * "the cost of slow review on the institution, not on the student's placement
 * timeline". An overdue row is a staffing problem, not a student's problem.
 */
export default async function IntegrityQueuePage() {
  await requireAdminScopePage();
  const queue = await listReviewQueue();

  return (
    <div>
      <AdminPageHeader
        title="Integrity review"
        description="Sittings withheld from the public leaderboard pending a human decision. Nothing here is a finding: a flag means something unusual was recorded and somebody has to read it. Anything unreviewed after 72 hours publishes itself as cleared."
      />

      {queue.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<ShieldCheck className="h-6 w-6" aria-hidden />}
            title="Nothing waiting"
            description="No sitting is currently withheld. Low-band flags are bulk-cleared with a random sample, and those appear here when sampled."
          />
        </div>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {queue.map((row) => (
            <li key={row.flagId} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-surface p-4">
              <span
                className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
                  row.band === "HIGH"
                    ? "border-danger/40 bg-danger-subtle text-danger"
                    : row.band === "MEDIUM"
                      ? "border-warning/40 bg-warning-subtle text-warning"
                      : "border-border text-text-secondary"
                }`}
              >
                {row.band}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">{row.studentName}</p>
                <p className="mt-0.5 text-xs text-text-secondary">
                  {row.collegeId} · {row.assessmentTitle}
                </p>
              </div>
              {row.inSample ? (
                <span className="rounded-full border border-info/40 bg-info-subtle px-2 py-0.5 text-xs text-info">
                  Random sample
                </span>
              ) : null}
              <span className="text-xs text-text-secondary tabular-nums">
                {row.reviewsRecorded} of {Math.max(1, row.reviewersRequired)} reviewed
              </span>
              <span className={`text-xs tabular-nums ${row.overdue ? "text-danger" : "text-text-secondary"}`}>
                {row.overdue ? "Past the 72-hour deadline" : `Decide by ${formatCampusTime(row.reviewDeadline)}`}
              </span>
              <Link
                href={`/admin/integrity/${row.flagId}`}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Review
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
