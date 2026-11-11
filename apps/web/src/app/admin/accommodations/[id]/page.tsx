import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { Card, CardHeader } from "@recx/design";
import { ACCOMMODATION_KIND_LABELS, PROCTOR_EVENT_LABELS, accommodationTermsSummary } from "@recx/shared";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { formatCohort } from "@/lib/admin/cohort";
import { getAccommodation } from "@/server/queries/admin-accommodations";
import { AdminPageHeader, formatDate, formatDateTime } from "@/components/admin/admin-ui";
import { ACCOMMODATION_STATUS, AccommodationStatusBadge } from "@/components/admin/accommodations/accommodation-list";
import { DecisionPanel } from "@/components/admin/accommodations/decision-panel";

export const metadata: Metadata = { title: "Accommodation" };

type Params = Promise<{ id: string }>;

/**
 * One accommodation, with its kinds and reason — the only admin page that
 * shows them. Approve, reject and revoke are offered to a super-admin only
 * (and refused by the server for anyone else). Out of scope is a 404.
 */
export default async function AccommodationPage({ params }: { params: Params }) {
  const { user, scope } = await requireAdminScopePage();
  const { id } = await params;
  const a = await getAccommodation(scope, id);
  if (!a) notFound();
  const name = `${a.student.firstName} ${a.student.lastName}`;
  const isSuper = user.role === "SUPER_ADMIN";

  return (
    <>
      <AdminPageHeader
        title={`Accommodation: ${name}`}
        back={{ href: "/admin/accommodations", label: "Accommodations" }}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <AccommodationStatusBadge status={a.status} />
            <Link href={`/admin/students/${a.student.id}` as never} className="hover:text-primary hover:underline">
              <span className="font-mono">{a.student.collegeId}</span> · {formatCohort(a.student)}
            </Link>
          </span>
        }
        actions={
          <DecisionPanel id={a.id} status={a.status} isSuperAdmin={isSuper} canWithdraw={isSuper || a.requestedById === user.id} />
        }
      />
      {a.status === "REQUESTED" && !isSuper ? (
        <p role="note" className="mb-4 flex items-start gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-secondary">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Waiting for a super-admin to approve or reject it.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Terms" subtitle={accommodationTermsSummary(a)} />
          <dl className="grid gap-3 px-5 pb-5 pt-4 text-sm">
            <div>
              <dt className="text-text-secondary">Accommodations</dt>
              <dd>{a.kinds.map((k) => ACCOMMODATION_KIND_LABELS[k]).join(", ")}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Extra time</dt>
              <dd className="tabular-nums">
                {a.extraTimePercent}% + {a.extraTimeMinutes} min
              </dd>
            </div>
            <div>
              <dt className="text-text-secondary">Breaks</dt>
              <dd>{a.allowBreaks ? `Allowed, ${a.breakMinutes} min` : "No"}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Display and support</dt>
              <dd>
                Text {a.fontScalePercent}% · {a.highContrast ? "high contrast" : "standard contrast"} ·{" "}
                {a.allowScribe ? "scribe allowed" : "no scribe"}
              </dd>
            </div>
            <div>
              <dt className="text-text-secondary">Signals reviewers discount</dt>
              <dd>{a.exemptSignals.length ? a.exemptSignals.map((s) => PROCTOR_EVENT_LABELS[s]).join(", ") : "None"}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Valid until</dt>
              <dd>{formatDate(a.validUntil)}</dd>
            </div>
          </dl>
        </Card>
        <Card>
          <CardHeader title="Request and decision" subtitle="Staff only. Reviewers and invigilators never see this page." />
          <dl className="grid gap-3 px-5 pb-5 pt-4 text-sm">
            <div>
              <dt className="text-text-secondary">Reason</dt>
              <dd className="whitespace-pre-line">{a.reason}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Requested</dt>
              <dd>
                {a.requestedByName} · {formatDateTime(a.requestedAt)}
              </dd>
            </div>
            {a.decidedAt ? (
              <div>
                <dt className="text-text-secondary">Decided</dt>
                <dd>
                  {a.decidedByName ?? "Unknown account"} · {formatDateTime(a.decidedAt)}
                </dd>
              </div>
            ) : null}
            {a.decisionNote ? (
              <div>
                <dt className="text-text-secondary">Decision note</dt>
                <dd className="whitespace-pre-line">{a.decisionNote}</dd>
              </div>
            ) : null}
            {a.revokedAt ? (
              <div>
                <dt className="text-text-secondary">Revoked</dt>
                <dd>
                  {a.revokedByName ?? "Unknown account"} · {formatDateTime(a.revokedAt)} (the reason is in the audit log)
                </dd>
              </div>
            ) : null}
            {a.supersedes ? (
              <div>
                <dt className="text-text-secondary">Replaces</dt>
                <dd>
                  <Link href={`/admin/accommodations/${a.supersedes.id}` as never} className="font-medium text-primary hover:underline">
                    An earlier accommodation ({ACCOMMODATION_STATUS[a.supersedes.status].label.toLowerCase()})
                  </Link>
                </dd>
              </div>
            ) : null}
            {a.supersededBy ? (
              <div>
                <dt className="text-text-secondary">Replaced by</dt>
                <dd>
                  <Link href={`/admin/accommodations/${a.supersededBy.id}` as never} className="font-medium text-primary hover:underline">
                    A later request ({ACCOMMODATION_STATUS[a.supersededBy.status].label.toLowerCase()})
                  </Link>
                </dd>
              </div>
            ) : null}
          </dl>
        </Card>
      </div>
    </>
  );
}
