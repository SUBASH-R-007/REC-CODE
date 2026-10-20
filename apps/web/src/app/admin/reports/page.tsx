import type { Metadata } from "next";
import Link from "next/link";
import { ChartColumnBig } from "lucide-react";
import { ButtonLink, Card, EmptyState } from "@recx/design";
import { describeScope, isEmptyScope, requireAdminScopePage } from "@/lib/auth/scope";
import { formatCohort, parseCohortParam } from "@/lib/admin/cohort";
import { getCohortReport } from "@/server/queries/admin-reports";
import { AdminPageHeader, TableFrame, TBODY_ROW, TD, TH, THEAD_ROW } from "@/components/admin/admin-ui";
import { BarTable } from "@/components/admin/reports/bar-table";
import { ReportSection } from "@/components/admin/reports/report-section";

export const metadata: Metadata = { title: "Reports" };

type SearchParams = Promise<{ cohort?: string | string[] }>;

const weekLabel = (monday: string) =>
  new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${monday}T00:00:00Z`));

/**
 * Cohort reports over the viewer's scope (active and soft-restricted
 * students only), from the maintained read models — never the XP ledger.
 * Every figure is also a table. There is no export here: a PII export is a
 * super-admin operation that needs a second approver.
 */
export default async function AdminReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const { scope } = await requireAdminScopePage();
  const requested = parseCohortParam((await searchParams).cohort);
  const report = await getCohortReport(scope, { cohort: requested, weeks: 8 });
  const title = report.cohort ? `Report: ${formatCohort(report.cohort)}` : "Reports";

  if (isEmptyScope(scope)) {
    return (
      <>
        <AdminPageHeader title="Reports" />
        <Card>
          <EmptyState
            icon={<ChartColumnBig className="h-6 w-6" />}
            title="No students are assigned to you"
            description="A super-admin grants each administrator a department and/or batch."
          />
        </Card>
      </>
    );
  }

  const totalSolved = report.difficulty.easy + report.difficulty.medium + report.difficulty.hard;

  return (
    <>
      <AdminPageHeader
        title={title}
        description={
          report.cohort
            ? "One cohort, active and soft-restricted students only."
            : `Every cohort in your scope (${describeScope(scope)}), active and soft-restricted students only.`
        }
        actions={
          report.cohort ? (
            <ButtonLink href="/admin/reports" variant="outline">
              Whole scope
            </ButtonLink>
          ) : undefined
        }
      />
      {requested && !report.cohort ? (
        <p role="status" className="mb-4 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text-secondary">
          That cohort is outside your scope, so the report shows your whole scope instead.
        </p>
      ) : null}

      <div className="space-y-6">
        <ReportSection title="Cohorts" subtitle="Students, activity in the last 7 days and solves.">
          <TableFrame label="Cohort summary">
            <table className="w-full text-sm">
              <caption className="sr-only">Cohort summary</caption>
              <thead>
                <tr className={THEAD_ROW}>
                  <th scope="col" className={TH}>
                    Cohort
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    Students
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    Active (7 days)
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    No solves yet
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    Median solved
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    Solved with hints
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.summary.map((r) => (
                  <tr key={`${r.batchYear}|${r.departmentCode}|${r.section}`} className={TBODY_ROW}>
                    <th scope="row" className={`${TD} whitespace-nowrap text-left font-normal`}>
                      {r.key && !report.cohort ? (
                        <Link href={`/admin/reports?cohort=${encodeURIComponent(r.key)}` as never} className="font-medium hover:text-primary hover:underline">
                          {formatCohort(r)}
                        </Link>
                      ) : (
                        formatCohort(r)
                      )}
                    </th>
                    <td className={`${TD} text-right tabular-nums`}>{r.students}</td>
                    <td className={`${TD} text-right tabular-nums`}>{r.active7}</td>
                    <td className={`${TD} text-right tabular-nums`}>{r.zeroSolve}</td>
                    <td className={`${TD} text-right tabular-nums`}>{r.medianSolved}</td>
                    <td className={`${TD} text-right tabular-nums`}>
                      {r.solved > 0 ? `${Math.round((100 * r.assisted) / r.solved)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        </ReportSection>

        <div className="grid gap-6 lg:grid-cols-2">
          <ReportSection title="Active students per week" subtitle="Students with any activity in each campus week (Monday first).">
            <BarTable
              caption="Active students per week"
              labelHeader="Week of"
              valueHeader="Students"
              rows={report.weeklyActive.map((p) => ({ label: weekLabel(p.week.monday), value: p.value }))}
            />
          </ReportSection>
          <ReportSection title="Problems solved per week" subtitle="First solves in each campus week.">
            <BarTable
              caption="Problems solved per week"
              labelHeader="Week of"
              valueHeader="Solves"
              rows={report.weeklySolves.map((p) => ({ label: weekLabel(p.week.monday), value: p.value }))}
            />
          </ReportSection>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <ReportSection title="Solves by difficulty" subtitle={`${totalSolved.toLocaleString("en-IN")} problems solved in all.`}>
            <BarTable
              caption="Solves by difficulty"
              labelHeader="Difficulty"
              valueHeader="Solves"
              rows={[
                { label: "Easy", value: report.difficulty.easy },
                { label: "Medium", value: report.difficulty.medium },
                { label: "Hard", value: report.difficulty.hard },
              ]}
            />
          </ReportSection>
          <ReportSection title="Current streaks" subtitle="Consecutive campus days with activity.">
            <BarTable
              caption="Students by current streak"
              labelHeader="Streak"
              valueHeader="Students"
              rows={report.streaks.map((s) => ({ label: s.bucket, value: s.students }))}
            />
          </ReportSection>
        </div>

        <ReportSection title="Topic coverage" subtitle="First solves per topic; hint-assisted solves are counted separately.">
          <BarTable
            caption="Topic coverage"
            labelHeader="Topic"
            valueHeader="Solves"
            rows={report.topics.map((t) => ({
              label: t.label,
              value: t.solved,
              note: `${t.students} ${t.students === 1 ? "student" : "students"} · ${t.assisted} with hints`,
            }))}
          />
        </ReportSection>

        <div className="grid gap-6 lg:grid-cols-2">
          <ReportSection title="Hardest problems" subtitle="At least 5 students tried; the lowest share solved first.">
            {report.hardest.length === 0 ? (
              <EmptyState compact title="Not enough attempts yet" description="A problem appears once 5 students have tried it." />
            ) : (
              <BarTable
                caption="Hardest problems by share solved"
                labelHeader="Problem"
                valueHeader="Solved"
                format={(v) => `${v}%`}
                rows={report.hardest.map((h) => ({
                  label: h.displayCode,
                  value: Math.round((100 * h.solvers) / h.attempters),
                  note: `${h.title} · ${h.solvers} of ${h.attempters}`,
                }))}
              />
            )}
          </ReportSection>
          <ReportSection title="Sheets and tracks" subtitle="Enrolments of your students and their average progress.">
            {report.plans.length === 0 ? (
              <EmptyState compact title="No enrolments yet" />
            ) : (
              <BarTable
                caption="Average progress per sheet or track"
                labelHeader="Plan"
                valueHeader="Average done"
                format={(v) => `${v}%`}
                rows={report.plans.map((p) => ({
                  label: p.title,
                  value: p.averagePercent,
                  note: `${p.enrolled} enrolled · ${p.completed} completed`,
                }))}
              />
            )}
          </ReportSection>
        </div>
      </div>
    </>
  );
}
