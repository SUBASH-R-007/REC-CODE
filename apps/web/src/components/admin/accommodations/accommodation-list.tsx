import Link from "next/link";
import { Ban, CircleCheck, CircleDashed, CircleX, Replace, Undo2 } from "lucide-react";
import type { AccommodationStatus } from "@recx/db";
import { Badge } from "@recx/design";
import { accommodationTermsSummary } from "@recx/shared";
import type { AccommodationListRow } from "@/server/queries/admin-accommodations";
import { formatCohort } from "@/lib/admin/cohort";
import { TableFrame, TBODY_ROW, TD, TH, THEAD_ROW, formatDate } from "@/components/admin/admin-ui";

export const ACCOMMODATION_STATUS: Record<
  AccommodationStatus,
  { label: string; tone: "default" | "success" | "warning" | "danger" | "info"; Icon: typeof CircleCheck }
> = {
  REQUESTED: { label: "Requested", tone: "warning", Icon: CircleDashed },
  APPROVED: { label: "Approved", tone: "success", Icon: CircleCheck },
  REJECTED: { label: "Rejected", tone: "danger", Icon: CircleX },
  WITHDRAWN: { label: "Withdrawn", tone: "default", Icon: Undo2 },
  REVOKED: { label: "Revoked", tone: "danger", Icon: Ban },
  SUPERSEDED: { label: "Replaced", tone: "info", Icon: Replace },
};

export function AccommodationStatusBadge({ status }: { status: AccommodationStatus }) {
  const s = ACCOMMODATION_STATUS[status];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="h-3.5 w-3.5" aria-hidden />
      {s.label}
    </Badge>
  );
}

/**
 * Accommodations of the viewer's students. Deliberately without the kinds
 * (a disability label) and the reason: only status, validity and the
 * timing/display terms. The detail page shows the rest.
 */
export function AccommodationList({ rows, now }: { rows: AccommodationListRow[]; now: Date }) {
  return (
    <TableFrame label="Accommodations">
      <table className="w-full text-sm">
        <caption className="sr-only">Accommodations of students in your scope</caption>
        <thead>
          <tr className={THEAD_ROW}>
            <th scope="col" className={TH}>
              Student
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
            <th scope="col" className={TH}>
              Terms
            </th>
            <th scope="col" className={TH}>
              Valid until
            </th>
            <th scope="col" className={TH}>
              Requested
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} className={TBODY_ROW}>
              <th scope="row" className={`${TD} text-left font-normal`}>
                <Link href={`/admin/accommodations/${a.id}` as never} className="font-medium hover:text-primary hover:underline">
                  {a.student.firstName} {a.student.lastName}
                </Link>
                <span className="block font-mono text-xs text-text-secondary">{a.student.collegeId}</span>
                <span className="block text-xs text-text-secondary">{formatCohort(a.student)}</span>
              </th>
              <td className={TD}>
                <AccommodationStatusBadge status={a.status} />
                {a.status === "APPROVED" && a.validUntil <= now ? (
                  <span className="mt-1 block text-xs text-text-secondary">Validity has ended</span>
                ) : null}
              </td>
              <td className={`${TD} text-xs`}>{accommodationTermsSummary(a)}</td>
              <td className={`${TD} whitespace-nowrap`}>{formatDate(a.validUntil)}</td>
              <td className={`${TD} whitespace-nowrap`}>{formatDate(a.requestedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}
