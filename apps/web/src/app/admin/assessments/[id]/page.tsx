import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, ButtonLink, Card, CardHeader, EmptyState } from "@recx/design";
import { requirePageRole } from "@/lib/auth/guards";
import { formatCampusDateTime } from "@/lib/help/copy";
import { getAssessmentDetail } from "@/server/queries/admin-assessments";
import {
  AddQuestionForm,
  RemoveQuestionButton,
  ScheduleHallForm,
  StatusButtons,
} from "@/components/admin/assessments/assessment-forms";

export const metadata: Metadata = { title: "Assessment" };

const TD = "px-3 py-2";

const MODE_LABEL: Record<string, string> = {
  ADVISORY: "Advisory — watched and recorded, sat anywhere",
  REMOTE_MONITORED: "Remote monitored — a registered device",
  KIOSK_SEB: "Kiosk (Safe Exam Browser), verified per request",
  LAB_SUPERVISED: "Lab supervised — a college hall, on the hall's network",
};

/**
 * One assessment: its terms, its questions, its halls, and the one button
 * that moves it along (Phase 12a). While it is a DRAFT everything here is
 * editable; after that the database refuses, and so does this page.
 */
export default async function AdminAssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageRole("ADMIN", "SUPER_ADMIN");
  const { id } = await params;
  const assessment = await getAssessmentDetail(id);
  if (!assessment) notFound();

  const draft = assessment.status === "DRAFT";
  const needsAllowlist = assessment.proctorMode === "LAB_SUPERVISED";
  const nextPosition = (assessment.problems.at(-1)?.position ?? 0) + 1;

  return (
    <div className="max-w-4xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-text">{assessment.title}</h1>
          <p className="mt-1 text-sm text-text-secondary">
            {assessment.slug} · {MODE_LABEL[assessment.proctorMode] ?? assessment.proctorMode}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={assessment.status === "OPEN" ? "success" : assessment.status === "DRAFT" ? "warning" : "info"}>
            {assessment.status}
          </Badge>
          <ButtonLink href="/admin/assessments" variant="outline">
            Back
          </ButtonLink>
        </div>
      </div>

      <Card className="mb-6 p-5">
        <CardHeader title="Terms" />
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Window</dt>
            <dd>
              {formatCampusDateTime(assessment.opensAt)} → {formatCampusDateTime(assessment.closesAt)}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Clock</dt>
            <dd>{Math.round(assessment.durationSec / 60)} minutes</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Attempts</dt>
            <dd>{assessment.maxAttempts}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Focus warnings</dt>
            <dd>
              {assessment.maxFocusWarnings}, then{" "}
              {assessment.onLimit === "AUTOSUBMIT" ? "submit what they have" : "flag it for a reviewer"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Placement</dt>
            <dd>{assessment.affectsPlacementEligibility ? "May count towards eligibility" : "Does not count"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-text-secondary">Audience</dt>
            <dd>
              {[assessment.audienceBatchYear, assessment.audienceDepartmentCode, assessment.audienceSection]
                .filter(Boolean)
                .join(" · ") || "Everybody"}
            </dd>
          </div>
        </dl>
        <div className="mt-5 border-t border-border pt-5">
          <StatusButtons assessmentId={assessment.id} status={assessment.status} />
        </div>
      </Card>

      <Card className="mb-6 p-5">
        <CardHeader title={`Questions (${assessment.problems.length})`} />
        <p className="mt-1 text-xs text-text-secondary">
          Each is pinned at the problem&rsquo;s live frozen revision, by id. A later revision of the problem does not
          change what this assessment asks.
        </p>
        {assessment.problems.length === 0 ? (
          <div className="mt-4">
            <EmptyState title="No questions yet" description="An empty paper cannot be published." />
          </div>
        ) : (
          <div className="mt-4 overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-elevated text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className={TD}>#</th>
                  <th className={TD}>Problem</th>
                  <th className={TD}>Revision</th>
                  <th className={TD}>Points</th>
                  {draft ? <th className={TD} /> : null}
                </tr>
              </thead>
              <tbody>
                {assessment.problems.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className={`${TD} tabular-nums`}>{p.position}</td>
                    <td className={TD}>
                      <Link href={`/problems/${p.slug}`} className="text-primary hover:underline">
                        {p.displayCode} {p.title}
                      </Link>
                    </td>
                    <td className={`${TD} tabular-nums`}>r{p.revision}</td>
                    <td className={`${TD} tabular-nums`}>{p.points}</td>
                    {draft ? (
                      <td className={TD}>
                        <RemoveQuestionButton assessmentProblemId={p.id} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {draft ? (
          <div className="mt-5 border-t border-border pt-5">
            <AddQuestionForm assessmentId={assessment.id} nextPosition={nextPosition} />
          </div>
        ) : null}
      </Card>

      <Card className="p-5">
        <CardHeader title={`Halls (${assessment.sessions.length})`} />
        <p className="mt-1 text-xs text-text-secondary">
          {needsAllowlist
            ? "A lab-supervised sitting is seated in a hall, and the hall's network allowlist is what enforces it: a machine that leaves is refused on its next heartbeat."
            : "A hall is optional for this mode. Scheduling one still gives the invigilation page somebody to watch."}
        </p>
        {assessment.sessions.length > 0 ? (
          <div className="mt-4 overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-elevated text-xs uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className={TD}>Hall</th>
                  <th className={TD}>Window</th>
                  <th className={TD}>Seats</th>
                  <th className={TD}>Networks</th>
                  <th className={TD}>Seated</th>
                </tr>
              </thead>
              <tbody>
                {assessment.sessions.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0">
                    <td className={TD}>
                      <Link href={`/admin/invigilate/${s.id}`} className="text-primary hover:underline">
                        {s.label}
                      </Link>
                      {s.room ? <div className="text-xs text-muted">{s.room}</div> : null}
                    </td>
                    <td className={TD}>
                      {formatCampusDateTime(s.startsAt)} → {formatCampusDateTime(s.endsAt)}
                    </td>
                    <td className={`${TD} tabular-nums`}>{s.capacity}</td>
                    <td className={`${TD} font-mono text-xs`}>{s.allowedCidrs.join(", ") || "any"}</td>
                    <td className={`${TD} tabular-nums`}>{s.seated}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {assessment.status === "CLOSED" || assessment.status === "ARCHIVED" ? null : (
          <div className="mt-5 border-t border-border pt-5">
            <ScheduleHallForm assessmentId={assessment.id} needsAllowlist={needsAllowlist} />
          </div>
        )}
      </Card>
    </div>
  );
}
