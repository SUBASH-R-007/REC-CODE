import Link from "next/link";
import { Lock } from "lucide-react";
import type { StudyPlanKind } from "@recx/db";
import { Badge } from "@recx/design";
import type { AdminPlanRow } from "@/server/queries/admin-plans";
import { TableFrame, TBODY_ROW, TD, TH, THEAD_ROW, formatDate } from "@/components/admin/admin-ui";

export const ADMIN_PLAN_PATH: Record<StudyPlanKind, "/admin/sheets" | "/admin/tracks"> = {
  SHEET: "/admin/sheets",
  TRACK: "/admin/tracks",
};

export function PlanStateBadges({ published, seedManaged }: { published: boolean; seedManaged: boolean }) {
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      <Badge tone={published ? "success" : "default"}>{published ? "Published" : "Not published"}</Badge>
      {seedManaged ? (
        <Badge tone="info">
          <Lock className="h-3 w-3" aria-hidden />
          Seed-managed
        </Badge>
      ) : null}
    </span>
  );
}

/** Every plan of one kind with its state and the enrolments of the viewer's students. */
export function PlanIndex({ kind, plans, noun }: { kind: StudyPlanKind; plans: AdminPlanRow[]; noun: string }) {
  return (
    <TableFrame label={`${noun}s`}>
      <table className="w-full text-sm">
        <caption className="sr-only">{`Every ${noun}`}</caption>
        <thead>
          <tr className={THEAD_ROW}>
            <th scope="col" className={TH}>
              Title
            </th>
            <th scope="col" className={TH}>
              State
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Problems
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Your students enrolled
            </th>
            <th scope="col" className={`${TH} text-right`}>
              Completed
            </th>
            <th scope="col" className={TH}>
              Updated
            </th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.id} className={TBODY_ROW}>
              <th scope="row" className={`${TD} text-left font-normal`}>
                <Link href={`${ADMIN_PLAN_PATH[kind]}/${p.id}` as never} className="font-medium hover:text-primary hover:underline">
                  {p.title}
                </Link>
                <span className="block font-mono text-xs text-text-secondary">{p.slug}</span>
              </th>
              <td className={TD}>
                <PlanStateBadges published={p.published} seedManaged={p.seedManaged} />
              </td>
              <td className={`${TD} text-right tabular-nums`}>
                {p.itemsTotal}
                <span className="block text-xs text-text-secondary">
                  {p.sections} {p.sections === 1 ? "section" : "sections"}
                </span>
              </td>
              <td className={`${TD} text-right tabular-nums`}>{p.enrolledInScope}</td>
              <td className={`${TD} text-right tabular-nums`}>{p.completedInScope}</td>
              <td className={`${TD} whitespace-nowrap`}>{formatDate(p.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}
