import Link from "next/link";
import { CalendarCheck, ListChecks, SquareTerminal } from "lucide-react";
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  DifficultyBadge,
  EmptyState,
  ProgressBar,
  SolveStatus,
  VerdictBadge,
} from "@recx/design";
import type { DailyCandidate } from "@/components/dashboard/model";
import { planHref } from "@/components/plans/kinds";
import { absoluteTime, relativeTime } from "@/components/problems/relative-time";
import type { EnrolledPlan, RecentSubmission } from "@/server/queries/dashboard";

/** Today's daily challenge: 2x XP on a first solve today. */
export function DailyChallengeCard({ daily }: { daily: DailyCandidate | null }) {
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <CalendarCheck className="h-4 w-4 text-primary" aria-hidden />
            Today&apos;s daily challenge
          </span>
        }
        subtitle="Double XP on a first solve today"
      />
      <CardBody className="flex flex-1 flex-col pt-4">
        {daily ? (
          <>
            <p className="font-mono text-xs text-text-secondary">{daily.problem.displayCode}</p>
            <Link
              href={`/problems/${daily.problem.slug}`}
              className="mt-0.5 font-display text-lg font-semibold tracking-tight text-text hover:text-primary hover:underline"
            >
              {daily.problem.title}
            </Link>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <DifficultyBadge difficulty={daily.problem.difficulty} />
              {daily.solved && <SolveStatus status="solved" />}
            </div>
            <p className="mt-3 text-sm text-text-secondary">
              {daily.solved
                ? "You have solved this one. A new challenge arrives at midnight (IST)."
                : `${daily.xp} XP for a first solve before midnight (IST).`}
            </p>
            {!daily.solved && (
              <div className="mt-auto pt-4">
                <ButtonLink href={`/problems/${daily.problem.slug}`} variant="secondary">
                  Solve the challenge<span className="sr-only">: {daily.problem.title}</span>
                </ButtonLink>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-text-secondary">
            There is no daily challenge today. Any problem you solve still counts towards your weekly goal and streak.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

/** The viewer's last five practice submissions, verdicts via VerdictBadge. */
export function RecentSubmissionsCard({
  rows,
  now,
  className,
}: {
  rows: RecentSubmission[];
  now: Date;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader title="Recent submissions" subtitle="Your last five practice submissions" />
      <CardBody className="pt-3">
        {rows.length === 0 ? (
          <EmptyState
            compact
            icon={<SquareTerminal className="h-5 w-5" />}
            title="No submissions yet"
            description="Every submission you make is listed here with its verdict."
            action={
              <ButtonLink href="/problems" variant="outline" size="sm">
                Browse problems
              </ButtonLink>
            }
          />
        ) : (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Recent submissions (scrolls sideways)">
            <table className="w-full text-sm">
              <caption className="sr-only">Your last {rows.length} practice submissions, newest first</caption>
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-text-secondary">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Verdict
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Problem
                  </th>
                  <th scope="col" className="hidden py-2 pr-3 font-medium sm:table-cell">
                    Language
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    When
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-2.5 pr-3">
                      <VerdictBadge
                        verdict={row.display}
                        size="sm"
                        {...(row.display === "PARTIAL" ? { passed: row.passed, total: row.total } : {})}
                      />
                    </td>
                    <td className="max-w-56 py-2.5 pr-3">
                      {row.problem.published ? (
                        <Link
                          href={`/problems/${row.problem.slug}`}
                          className="block truncate font-medium text-text hover:text-primary hover:underline"
                        >
                          {row.problem.title}
                        </Link>
                      ) : (
                        <span className="block truncate text-text-secondary">{row.problem.title}</span>
                      )}
                    </td>
                    <td className="hidden py-2.5 pr-3 whitespace-nowrap text-text-secondary sm:table-cell">
                      {row.languageLabel}
                    </td>
                    <td className="py-2.5 whitespace-nowrap text-text-secondary">
                      <time dateTime={row.createdAt.toISOString()} title={absoluteTime(row.createdAt)}>
                        {relativeTime(row.createdAt, now)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Enrolled study plans with progress (itemsDone is maintained from solves). */
export function StudyPlansCard({ plans }: { plans: EnrolledPlan[] }) {
  return (
    <Card>
      <CardHeader
        title="Your study plans"
        action={
          plans.length > 0 ? (
            <Link href="/sheets" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
              All sheets
            </Link>
          ) : null
        }
      />
      <CardBody className="pt-3">
        {plans.length === 0 ? (
          <EmptyState
            compact
            icon={<ListChecks className="h-5 w-5" />}
            title="No plan yet"
            description="Enroll in a sheet or a learning track for a guided path through placement topics."
            action={
              <ButtonLink href="/sheets" variant="outline" size="sm">
                Browse sheets
              </ButtonLink>
            }
          />
        ) : (
          <ul className="space-y-4">
            {plans.map((plan) => (
              <li key={`${plan.kind}-${plan.slug}`}>
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={planHref(plan.kind, plan.slug) as never}
                    className="min-w-0 truncate text-sm font-medium text-text hover:text-primary hover:underline"
                  >
                    {plan.title}
                  </Link>
                  {plan.completed ? (
                    <Badge tone="success">Completed</Badge>
                  ) : (
                    <span className="shrink-0 text-xs text-text-secondary">{plan.kind === "SHEET" ? "Sheet" : "Track"}</span>
                  )}
                </div>
                <ProgressBar
                  className="mt-2"
                  size="sm"
                  tone={plan.completed ? "success" : "primary"}
                  value={plan.itemsDone}
                  max={plan.itemsTotal}
                  label={`${plan.title}: ${plan.itemsDone} of ${plan.itemsTotal} solved`}
                />
                <p className="mt-1 text-xs text-text-secondary">
                  {plan.itemsDone} of {plan.itemsTotal} solved
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
