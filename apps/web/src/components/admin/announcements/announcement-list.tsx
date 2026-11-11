import Link from "next/link";
import { Archive, CircleCheck, CircleDashed, Clock, TriangleAlert } from "lucide-react";
import { Badge } from "@recx/design";
import type { AdminAnnouncementRow, AnnouncementState } from "@/server/queries/admin-announcements";
import { describeAudience } from "@/lib/admin/announcement-audience";
import { TableFrame, TBODY_ROW, TD, TH, THEAD_ROW, formatDateTime } from "@/components/admin/admin-ui";

const STATE: Record<AnnouncementState, { label: string; tone: "default" | "success" | "info"; Icon: typeof Clock }> = {
  draft: { label: "Draft", tone: "default", Icon: CircleDashed },
  live: { label: "Live", tone: "success", Icon: CircleCheck },
  ended: { label: "Ended", tone: "info", Icon: Clock },
  archived: { label: "Archived", tone: "default", Icon: Archive },
};

export function AnnouncementStateBadge({ state }: { state: AnnouncementState }) {
  const s = STATE[state];
  return (
    <Badge tone={s.tone}>
      <s.Icon className="h-3.5 w-3.5" aria-hidden />
      {s.label}
    </Badge>
  );
}

export function ImportantBadge() {
  return (
    <Badge tone="warning">
      <TriangleAlert className="h-3.5 w-3.5" aria-hidden />
      Important
    </Badge>
  );
}

/** Announcements whose audience the viewer's scope covers. */
export function AnnouncementList({ rows }: { rows: AdminAnnouncementRow[] }) {
  return (
    <TableFrame label="Announcements">
      <table className="w-full text-sm">
        <caption className="sr-only">Announcements for students in your scope</caption>
        <thead>
          <tr className={THEAD_ROW}>
            <th scope="col" className={TH}>
              Title
            </th>
            <th scope="col" className={TH}>
              Audience
            </th>
            <th scope="col" className={TH}>
              State
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Read by your students
            </th>
            <th scope="col" className={TH}>
              Banner until
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id} className={TBODY_ROW}>
              <th scope="row" className={`${TD} text-left font-normal`}>
                <Link href={`/admin/announcements/${a.id}` as never} className="font-medium hover:text-primary hover:underline">
                  {a.title}
                </Link>
                {a.tone === "IMPORTANT" ? (
                  <span className="mt-1 block">
                    <ImportantBadge />
                  </span>
                ) : null}
              </th>
              <td className={TD}>{describeAudience(a.audience)}</td>
              <td className={TD}>
                <AnnouncementStateBadge state={a.state} />
              </td>
              <td className={`${TD} text-right tabular-nums`}>
                {a.state === "draft" ? "—" : `${a.readInScope} of ${a.deliveredInScope}`}
              </td>
              <td className={`${TD} whitespace-nowrap`}>{formatDateTime(a.endsAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}
