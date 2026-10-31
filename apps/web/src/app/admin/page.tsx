import type { Metadata } from "next";
import Link from "next/link";
import { Accessibility, CalendarClock, CircleAlert, FileUp, Megaphone, Trophy, UserX, UsersRound } from "lucide-react";
import { ButtonLink, Card, CardHeader, EmptyState, StatCard } from "@recx/design";
import { requireAdminScopePage } from "@/lib/auth/scope";
import { formatCohort } from "@/lib/admin/cohort";
import { getAdminOverview } from "@/server/queries/admin-overview";
import { AdminPageHeader, IST_DATE } from "@/components/admin/admin-ui";

export const metadata: Metadata = { title: "Admin overview" };

const n = (v: number) => v.toLocaleString("en-IN");

/**
 * The admin home: the viewer's students at a glance (counts from the
 * maintained read models, never the XP ledger), the cohorts with the most
 * students and what needs attention. Everything is limited to the viewer's
 * AdminScope; an admin with no scope sees an explanation instead.
 */
export default async function AdminOverviewPage() {
  const { user, scope } = await requireAdminScopePage();
  const now = new Date();
  const data = await getAdminOverview(scope, user, now);

  if (data.emptyScope) {
    return (
      <>
        <AdminPageHeader title="Admin overview" />
        <Card>
          <EmptyState
            icon={<UserX className="h-6 w-6" />}
            title="No students are assigned to you yet"
            description="A super-admin grants each administrator a department and/or batch. Until then student pages stay empty. Problem authoring and the judge pages still work."
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <AdminPageHeader
        title="Admin overview"
        description={`Your students this campus week (from ${IST_DATE.format(data.weekStart)}). Counts include active and soft-restricted accounts.`}
        actions={
          <>
            <ButtonLink href="/admin/students" variant="outline">
              Find a student
            </ButtonLink>
            <ButtonLink href="/admin/reports">Open reports</ButtonLink>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Students" icon={<UsersRound className="h-4 w-4" aria-hidden />} value={<span className="tabular-nums">{n(data.students)}</span>} />
        <StatCard
          label="Active this week"
          icon={<CalendarClock className="h-4 w-4" aria-hidden />}
          value={<span className="tabular-nums">{n(data.activeThisWeek)}</span>}
          hint={data.students > 0 ? `${Math.round((100 * data.activeThisWeek) / data.students)}% of your students` : undefined}
        />
        <StatCard
          label="Problems solved this week"
          icon={<Trophy className="h-4 w-4" aria-hidden />}
          value={<span className="tabular-nums">{n(data.solvesThisWeek)}</span>}
        />
        <StatCard
          label="Not solved anything yet"
          icon={<CircleAlert className="h-4 w-4" aria-hidden />}
          value={<span className="tabular-nums">{n(data.zeroSolve)}</span>}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Largest cohorts" subtitle="Batch, department and section, by number of students." />
          {data.topCohorts.length === 0 ? (
            <EmptyState compact title="No students yet" description="Students appear after the next roster import." />
          ) : (
            <ul className="divide-y divide-border px-5 pb-4 pt-3">
              {data.topCohorts.map((c) => (
                <li key={`${c.batchYear}|${c.departmentCode}|${c.section}`} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  {c.key ? (
                    <Link href={`/admin/reports?cohort=${encodeURIComponent(c.key)}` as never} className="font-medium hover:text-primary hover:underline">
                      {formatCohort(c)}
                    </Link>
                  ) : (
                    <span className="font-medium">{formatCohort(c)}</span>
                  )}
                  <span className="tabular-nums text-text-secondary">{n(c.students)} students</span>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-border px-5 py-3 text-sm">
            <Link href="/admin/cohorts" className="font-medium text-primary hover:underline">
              All cohorts
            </Link>
          </p>
        </Card>

        <Card>
          <CardHeader title="Needs attention" />
          <ul className="space-y-3 px-5 pb-5 pt-4 text-sm">
            <li className="flex items-start gap-3">
              <UserX className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
              <span>
                <Link href="/admin/students?inactive=14" className="font-medium hover:text-primary hover:underline">
                  {n(data.inactive14Days)} {data.inactive14Days === 1 ? "student has" : "students have"} not been active for 14 days
                </Link>
              </span>
            </li>
            <li className="flex items-start gap-3">
              <Accessibility className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
              <span>
                <Link href="/admin/accommodations?status=REQUESTED" className="font-medium hover:text-primary hover:underline">
                  {n(data.pendingAccommodations)} accommodation {data.pendingAccommodations === 1 ? "request awaits" : "requests await"} a super-admin
                </Link>
              </span>
            </li>
            <li className="flex items-start gap-3">
              <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
              <span>
                <Link href="/admin/announcements" className="font-medium hover:text-primary hover:underline">
                  {n(data.liveAnnouncements)} live {data.liveAnnouncements === 1 ? "announcement" : "announcements"} for your students
                </Link>
              </span>
            </li>
            <li className="flex items-start gap-3">
              <FileUp className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
              <span>
                {data.lastImport ? (
                  <Link
                    href={`/admin/students/import/${data.lastImport.id}` as never}
                    className="font-medium hover:text-primary hover:underline"
                  >
                    Your last roster import: {data.lastImport.fileName} ({data.lastImport.status.toLowerCase()},{" "}
                    {IST_DATE.format(data.lastImport.createdAt)})
                  </Link>
                ) : (
                  <Link href="/admin/students/import" className="font-medium hover:text-primary hover:underline">
                    You have not imported a roster yet
                  </Link>
                )}
              </span>
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
