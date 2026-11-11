import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@recx/design";
import { formatCampusDay } from "@recx/shared";
import { requirePlacementPage } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { AT_RISK_RULE, atRiskList, cohortOptions, latestRunDay } from "@/server/queries/placement-cohort";
import { CohortFilter } from "@/components/placement/cohort-filter";
import { MentorRouting } from "@/components/placement/mentor-routing";
import { cohortSize, describeCohort, parseCohortFilter } from "@/lib/placement/filter";

export const metadata: Metadata = { title: "Students worth a conversation" };

/**
 * `/placement-cell/at-risk` — the worklist (Phase 9e).
 *
 * Ordered by DAYS QUIET, longest first, and never by score. Two reasons, and
 * the second is the one that matters: a list ordered by readiness is a
 * ranking of students by readiness, which SPEC §5 forbids outright; and days
 * of silence is what an at-risk list is actually about, so it is also the
 * more useful order.
 *
 * The page is called "worth a conversation" rather than "at risk" on purpose.
 * The phrase "at risk" is the placement cell's internal rule for routing, not
 * a label to hang on a person somebody is about to talk to, and a surface
 * that normalises it is a surface where it ends up in an email.
 *
 * Being on this list has NO effect on the student: not their account, not
 * their leaderboard place, not anything a recruiter sees. The page says so,
 * because the first thing a new officer will assume is the opposite.
 */
export default async function AtRiskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePlacementPage();
  const computedOn = await latestRunDay();
  const filter = parseCohortFilter(await searchParams);

  if (!computedOn) {
    return (
      <EmptyState
        title="No readiness run has finished yet"
        description="The list is built from the nightly run, which also supplies the last-active date it orders by."
      />
    );
  }

  const [options, list, mentors] = await Promise.all([
    cohortOptions(computedOn),
    atRiskList(computedOn, filter),
    // Who may be asked. The database refuses a STUDENT or a
    // PLACEMENT_OFFICER as mentor of record, so the choices here are exactly
    // the roles it accepts.
    db.user.findMany({
      where: { role: { in: ["TA_MENTOR", "ADMIN", "SUPER_ADMIN"] }, status: "ACTIVE" },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      take: 200,
    }),
  ]);

  const mentorOptions = mentors.map((mentor) => ({
    id: mentor.id,
    name: `${mentor.firstName} ${mentor.lastName}`.trim(),
  }));

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-2xl font-bold tracking-tight">Students worth a conversation</h1>
        <p className="max-w-3xl text-sm">{AT_RISK_RULE}</p>
        <p className="text-xs text-muted">
          Longest silent first, from the run of {formatCampusDay(computedOn)}, over {describeCohort(filter)}. The order
          is days quiet, never readiness.
        </p>
      </header>

      <CohortFilter basePath="/placement-cell/at-risk" current={filter} options={options} total={cohortSize(options)} />

      {list.rows.length === 0 ? (
        <EmptyState
          title="Nobody in this cohort"
          description="Nothing has gone quiet for long enough to be worth interrupting anybody over."
        />
      ) : (
        <>
          <p className="text-sm text-text-secondary">
            {list.shown === list.total
              ? `${list.total} student${list.total === 1 ? "" : "s"}.`
              : `Showing the ${list.shown} longest silent of ${list.total}. Narrow the cohort above to work through the rest — a worklist nobody can finish is a worklist nobody starts.`}
          </p>

          <ul className="space-y-4">
            {list.rows.map((row) => (
              <li key={row.userId} className="space-y-3 rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 className="font-display text-base font-semibold">
                    <Link href={`/placement-cell/students/${row.userId}`} className="text-primary underline">
                      {row.name}
                    </Link>
                  </h2>
                  <p className="text-sm text-text-secondary">
                    {row.collegeId}
                    {row.departmentCode ? ` · ${row.departmentCode}` : ""}
                    {row.section ? ` · Section ${row.section}` : ""}
                  </p>
                </div>

                <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt className="text-text-secondary">Last active</dt>
                    <dd>
                      {row.lastActiveOn
                        ? `${formatCampusDay(row.lastActiveOn)} (${row.quietDays} day${row.quietDays === 1 ? "" : "s"} ago)`
                        : "Never recorded"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-text-secondary">Service coverage</dt>
                    {/*
                      Both figures, always. A raw 38 compared against the
                      rule's 40 would mark a student as behind because of a
                      component nobody has built.
                    */}
                    <dd>
                      {row.serviceScore === null
                        ? "Nothing measurable yet"
                        : `${row.serviceScore} out of ${row.serviceAvailableWeight} measurable (${row.serviceNormalised}%)`}
                    </dd>
                  </div>
                </dl>

                <p className="text-sm text-text-secondary">{row.reason}</p>

                <MentorRouting
                  menteeId={row.userId}
                  name={row.name}
                  mentors={mentorOptions}
                  current={
                    row.mentor
                      ? {
                          assignmentId: row.mentor.assignmentId,
                          name: row.mentor.name,
                          since: formatCampusDay(row.mentor.since),
                        }
                      : null
                  }
                />
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
