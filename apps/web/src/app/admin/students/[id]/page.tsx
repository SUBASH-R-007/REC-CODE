import type { Metadata } from "next";
import Link from "next/link";
import { Accessibility, Info, ShieldAlert, UserRound } from "lucide-react";
import { Badge, ButtonLink, Card, CardHeader, EmptyState, VerdictBadge } from "@recx/design";
import { requireAdminScopePage, requireScopedStudentPage } from "@/lib/auth/scope";
import { formatCohort } from "@/lib/admin/cohort";
import { displayFor } from "@/lib/judge/view";
import { getStudentDetail } from "@/server/queries/admin-students";
import { PLAN_KINDS } from "@/components/plans/kinds";
import {
  AccountStatusBadge,
  AdminPageHeader,
  TableFrame,
  TBODY_ROW,
  TD,
  TH,
  THEAD_ROW,
  formatDate,
  formatDateTime,
} from "@/components/admin/admin-ui";
import { SignOutEverywhereButton } from "@/components/admin/students/sign-out-button";

export const metadata: Metadata = { title: "Student" };

type Params = Promise<{ id: string }>;

/**
 * One in-scope student, for staff: identity (managed in REC Learning),
 * account status (changed only by a super-admin), progress, the last 20
 * submissions as metadata (never source), enrolments and whether an
 * accommodation is on file (never its kinds). A student outside the
 * viewer's scope is a 404, exactly like a missing id.
 */
export default async function AdminStudentPage({ params }: { params: Params }) {
  const { user, scope } = await requireAdminScopePage();
  const { id } = await params;
  const student = await requireScopedStudentPage(scope, id);
  const detail = await getStudentDetail(student);
  const name = `${student.firstName} ${student.lastName}`;
  const stats = detail.stats;

  return (
    <>
      <AdminPageHeader
        title={name}
        back={{ href: "/admin/students", label: "All students" }}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono">{student.collegeId}</span>
            <span aria-hidden>·</span>
            <span>{formatCohort(student)}</span>
            <AccountStatusBadge status={student.status} />
          </span>
        }
        actions={<SignOutEverywhereButton userId={student.scopedId} name={name} />}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title="Identity" subtitle="Managed in REC Learning; changes arrive by roster import." />
          <dl className="grid gap-3 px-5 pb-5 pt-4 text-sm">
            <div>
              <dt className="text-text-secondary">Email</dt>
              <dd className="break-all">{student.email}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">LMS user id</dt>
              <dd className="font-mono">{student.lmsUserId ?? "Not linked yet"}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Last active</dt>
              <dd>{formatDateTime(student.lastActiveAt)}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Signed-in sessions</dt>
              <dd className="tabular-nums">{detail.activeSessions}</dd>
            </div>
          </dl>
          <div className="border-t border-border px-5 py-4 text-sm">
            <p className="flex items-start gap-2 text-text-secondary">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Account status changes are made by a super-admin.
            </p>
            {user.role === "SUPER_ADMIN" ? (
              <Link
                href={`/super/users?q=${encodeURIComponent(student.collegeId)}` as never}
                className="mt-2 inline-flex items-center gap-1.5 font-medium text-primary hover:underline"
              >
                <ShieldAlert className="h-4 w-4" aria-hidden />
                Open in the super-admin console
              </Link>
            ) : null}
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Progress" />
          {stats ? (
            <dl className="grid grid-cols-2 gap-3 px-5 pb-5 pt-4 text-sm sm:grid-cols-4">
              {(
                [
                  ["Solved", stats.solvedTotal],
                  ["Easy / Medium / Hard", `${stats.solvedEasy} / ${stats.solvedMedium} / ${stats.solvedHard}`],
                  ["Solved with hints", stats.assistedSolves],
                  ["Submissions", stats.submissions],
                  ["Accepted", stats.accepted],
                  ["Current streak", `${stats.currentStreak} days`],
                  ["Longest streak", `${stats.longestStreak} days`],
                  ["XP", stats.xpTotal.toLocaleString("en-IN")],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded-xl border border-border bg-background px-3 py-2.5">
                  <dt className="text-xs text-text-secondary">{label}</dt>
                  <dd className="mt-0.5 font-display text-lg font-bold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <EmptyState compact icon={<UserRound className="h-5 w-5" />} title="No activity yet" description="This student has not submitted anything." />
          )}
          <div className="flex flex-wrap gap-2 border-t border-border px-5 py-4 text-sm">
            <Badge tone={detail.accommodationOnFile ? "info" : "default"}>
              <Accessibility className="h-3.5 w-3.5" aria-hidden />
              Accommodation on file: {detail.accommodationOnFile ? "yes" : "no"}
            </Badge>
            {detail.accommodationRequested ? <Badge tone="warning">Accommodation request pending</Badge> : null}
            {detail.judgeOverrideActive ? <Badge tone="accent">Judge cap override active</Badge> : null}
            <ButtonLink href={`/admin/accommodations/new?student=${encodeURIComponent(student.scopedId)}`} variant="ghost" size="sm">
              {detail.accommodationOnFile ? "Request a change to the accommodation" : "Request an accommodation"}
            </ButtonLink>
          </div>
        </Card>
      </div>

      <Card className="mt-6 overflow-hidden">
        <CardHeader title="Recent submissions" subtitle="The last 20, as metadata only. Source code is not shown here." />
        <div className="pb-4 pt-3">
          {detail.submissions.length === 0 ? (
            <EmptyState compact title="No submissions yet" />
          ) : (
            <TableFrame label="Recent submissions">
              <table className="w-full text-sm">
                <caption className="sr-only">The student&apos;s last 20 submissions</caption>
                <thead>
                  <tr className={THEAD_ROW}>
                    <th scope="col" className={TH}>
                      When
                    </th>
                    <th scope="col" className={TH}>
                      Problem
                    </th>
                    <th scope="col" className={TH}>
                      Result
                    </th>
                    <th scope="col" className={TH}>
                      Language
                    </th>
                    <th scope="col" className={TH}>
                      Kind
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {detail.submissions.map((s) => (
                    <tr key={s.id} className={TBODY_ROW}>
                      <td className={`${TD} whitespace-nowrap`}>{formatDateTime(s.createdAt)}</td>
                      <td className={TD}>
                        <span className="block font-mono text-xs">{s.problemCode}</span>
                        <span className="block max-w-56 truncate text-xs text-text-secondary">{s.problemTitle}</span>
                      </td>
                      <td className={TD}>
                        <VerdictBadge verdict={displayFor(s.status, s.verdict)} size="sm" />
                      </td>
                      <td className={`${TD} font-mono text-xs`}>{s.language}</td>
                      <td className={`${TD} text-xs`}>{s.origin.toLowerCase().replace("_", " ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Sheets and tracks" />
        {detail.enrollments.length === 0 ? (
          <EmptyState compact title="Not enrolled in any sheet or track" />
        ) : (
          <ul className="divide-y divide-border px-5 pb-3 pt-2 text-sm">
            {detail.enrollments.map((e) => (
              <li key={`${e.planTitle}-${e.enrolledAt.toISOString()}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span>
                  {e.planTitle} <span className="text-text-secondary">({PLAN_KINDS[e.kind].noun})</span>
                </span>
                <span className="tabular-nums text-text-secondary">
                  {e.itemsDone} of {e.itemsTotal} solved
                  {e.completedAt ? ` · completed ${formatDate(e.completedAt)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
