import type { Metadata } from "next";
import Link from "next/link";
import { Badge, ButtonLink, EmptyState } from "@recx/design";
import { requirePageRole } from "@/lib/auth/guards";
import { formatCampusDateTime } from "@/lib/help/copy";
import { listAssessments } from "@/server/queries/admin-assessments";

export const metadata: Metadata = { title: "Assessments" };

const TD = "px-3 py-2";

const MODE_SHORT: Record<string, string> = {
  ADVISORY: "Advisory",
  REMOTE_MONITORED: "Remote",
  KIOSK_SEB: "Kiosk (SEB)",
  LAB_SUPERVISED: "Lab",
};

function statusTone(status: string): "default" | "info" | "success" | "warning" {
  if (status === "OPEN") return "success";
  if (status === "PUBLISHED") return "info";
  if (status === "DRAFT") return "warning";
  return "default";
}

/**
 * Every assessment, drafts included (Phase 12a).
 *
 * The engine that runs a sitting — the readiness check, the telemetry, the
 * invigilation page, the integrity queue — has existed since Phase 6, and
 * until now nothing could create the thing it runs.
 */
export default async function AdminAssessmentsPage() {
  await requirePageRole("ADMIN", "SUPER_ADMIN");
  const assessments = await listAssessments();

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-text">Assessments</h1>
          <p className="mt-1 text-sm text-text-secondary">
            A test a cohort sits, under a proctor mode chosen when it is created. Every assessment is proctored; a
            contest or a practice problem is the place for a sitting nobody watches.
          </p>
        </div>
        <ButtonLink href="/admin/assessments/new">New assessment</ButtonLink>
      </div>

      {assessments.length === 0 ? (
        <EmptyState
          title="No assessments yet"
          description="Create one, add its questions at their frozen revisions, schedule a hall if it is lab-supervised, then publish it."
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-elevated text-xs uppercase tracking-wide text-text-secondary">
              <tr>
                <th className={TD}>Assessment</th>
                <th className={TD}>Status</th>
                <th className={TD}>Watched</th>
                <th className={TD}>Opens</th>
                <th className={TD}>Questions</th>
                <th className={TD}>Halls</th>
                <th className={TD}>Sittings</th>
              </tr>
            </thead>
            <tbody>
              {assessments.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0">
                  <td className={TD}>
                    <Link href={`/admin/assessments/${a.id}`} className="font-medium text-primary hover:underline">
                      {a.title}
                    </Link>
                    <div className="text-xs text-muted">{a.slug}</div>
                  </td>
                  <td className={TD}>
                    <Badge tone={statusTone(a.status)}>{a.status}</Badge>
                  </td>
                  <td className={TD}>
                    {MODE_SHORT[a.proctorMode] ?? a.proctorMode}
                    {a.affectsPlacementEligibility ? (
                      <div className="text-xs text-muted">counts for placement</div>
                    ) : null}
                  </td>
                  <td className={TD}>{formatCampusDateTime(a.opensAt)}</td>
                  <td className={`${TD} tabular-nums`}>{a.questions}</td>
                  <td className={`${TD} tabular-nums`}>{a.halls}</td>
                  <td className={`${TD} tabular-nums`}>{a.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
