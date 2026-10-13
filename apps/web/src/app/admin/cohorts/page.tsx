import type { Metadata } from "next";
import Link from "next/link";
import { Layers } from "lucide-react";
import { Card, EmptyState } from "@recx/design";
import { describeScope, requireAdminScopePage } from "@/lib/auth/scope";
import { formatCohort } from "@/lib/admin/cohort";
import { listCohorts } from "@/server/queries/admin-cohorts";
import { AdminPageHeader, TableFrame, TBODY_ROW, TD, TH, THEAD_ROW } from "@/components/admin/admin-ui";

export const metadata: Metadata = { title: "Cohorts" };

function studentsHref(c: { batchYear: number | null; departmentCode: string | null; section: string | null }): string {
  const p = new URLSearchParams();
  if (c.batchYear !== null) p.set("batch", String(c.batchYear));
  if (c.departmentCode !== null) p.set("dept", c.departmentCode);
  p.set("section", c.section ?? "-");
  return `/admin/students?${p.toString()}`;
}

/**
 * Cohorts in the viewer's scope: batch, department and section as REC
 * Learning records them (there is no Cohort model). Each links to its
 * students and its report.
 */
export default async function AdminCohortsPage() {
  const { scope } = await requireAdminScopePage();
  const cohorts = await listCohorts(scope);

  return (
    <>
      <AdminPageHeader
        title="Cohorts"
        description={`Batch, department and section come from REC Learning. Scope: ${describeScope(scope)}.`}
      />
      <Card className="overflow-hidden">
        {cohorts.length === 0 ? (
          <EmptyState
            icon={<Layers className="h-6 w-6" />}
            title="No cohorts yet"
            description="Cohorts appear once students in your scope are imported."
          />
        ) : (
          <div className="pb-4 pt-3">
            <TableFrame label="Cohorts">
              <table className="w-full text-sm">
                <caption className="sr-only">Cohorts in your scope</caption>
                <thead>
                  <tr className={THEAD_ROW}>
                    <th scope="col" className={TH}>
                      Cohort
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      Current students
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      Active in 7 days
                    </th>
                    <th scope="col" className={`${TH} text-right`}>
                      All accounts
                    </th>
                    <th scope="col" className={TH}>
                      <span className="sr-only">Links</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cohorts.map((c) => (
                    <tr key={`${c.batchYear}|${c.departmentCode}|${c.section}`} className={TBODY_ROW}>
                      <th scope="row" className={`${TD} text-left font-medium`}>
                        {formatCohort(c)}
                      </th>
                      <td className={`${TD} text-right tabular-nums`}>{c.current}</td>
                      <td className={`${TD} text-right tabular-nums`}>
                        {c.activeLast7Days}
                        {c.current > 0 ? (
                          <span className="text-text-secondary"> ({Math.round((100 * c.activeLast7Days) / c.current)}%)</span>
                        ) : null}
                      </td>
                      <td className={`${TD} text-right tabular-nums`}>{c.total}</td>
                      <td className={`${TD} whitespace-nowrap text-right`}>
                        <Link href={studentsHref(c) as never} className="font-medium text-primary hover:underline">
                          Students<span className="sr-only"> in {formatCohort(c)}</span>
                        </Link>
                        {c.key ? (
                          <>
                            <span aria-hidden className="px-1.5 text-muted">
                              ·
                            </span>
                            <Link
                              href={`/admin/reports?cohort=${encodeURIComponent(c.key)}` as never}
                              className="font-medium text-primary hover:underline"
                            >
                              Report<span className="sr-only"> for {formatCohort(c)}</span>
                            </Link>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          </div>
        )}
      </Card>
    </>
  );
}
