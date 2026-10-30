import type { Metadata } from "next";
import Link from "next/link";
import { CalendarClock, CheckCheck, RotateCcw } from "lucide-react";
import { Badge, ButtonLink, Card, CardBody, CardHeader, DifficultyBadge, EmptyState } from "@recx/design";
import { REVISION_DAILY_CAP, REVISION_EMPTY, REVISION_INTERVALS, XP_RULES, formatCampusDay } from "@recx/shared";
import { requireUser } from "@/lib/auth/guards";
import { loadRevisionQueue } from "@/server/queries/revision";

export const metadata: Metadata = { title: "Revision" };

/**
 * `/revision` — the problems coming back to you today.
 *
 * SPEC §11: the documented failure mode of sheet prep is solving 300
 * problems once and retaining none. This page is the answer to that, and
 * it is built around one number: three. A queue with no ceiling becomes a
 * debt the student stops opening, so at most three cards are shown however
 * long the backlog is — and the backlog is stated rather than hidden,
 * because a page that quietly drops work is a page nobody trusts twice.
 *
 * Every card says why it is here in a sentence. "Due today, on the 7-day
 * step" is a thing a student can argue with; a number out of an algorithm
 * they cannot see is not.
 */
export default async function RevisionPage() {
  const user = await requireUser();
  const queue = await loadRevisionQueue(user.id);
  const hidden = Math.max(0, queue.backlog - queue.items.length);
  const nothingAtAll = queue.backlog === 0 && queue.scheduled === 0 && queue.learned === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Revision</h1>
        <p className="mt-1 max-w-3xl text-sm text-text-secondary">
          Problems you have already solved, coming back on a spaced schedule — after a day, then{" "}
          {REVISION_INTERVALS.slice(1, -1).join(", ")} and {REVISION_INTERVALS[REVISION_INTERVALS.length - 1]} days.
          Solving a due one pays {Math.round(XP_RULES.revisionMultiplier * 100)}% of the first solve and moves it to the
          next step; getting it wrong moves it back one and keeps it here. Clear the last step and it is done.
        </p>
      </div>

      {queue.items.length > 0 ? (
        <>
          <ol className="space-y-3">
            {queue.items.map((item) => (
              <li key={item.problemId}>
                <Card>
                  <CardBody className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-medium text-muted">{item.displayCode}</span>
                        <Link
                          href={`/problems/${item.slug}`}
                          className="font-display text-base font-semibold hover:underline"
                        >
                          {item.title}
                        </Link>
                        <DifficultyBadge difficulty={item.difficulty} />
                        {item.overdueDays > 0 ? (
                          <Badge tone="warning">
                            <CalendarClock className="h-3 w-3" aria-hidden />
                            {item.overdueDays === 1 ? "1 day late" : `${item.overdueDays} days late`}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-sm text-text-secondary">{item.reason}</p>
                    </div>
                    <ButtonLink href={`/problems/${item.slug}`} className="min-h-11 shrink-0">
                      <RotateCcw className="h-4 w-4" aria-hidden />
                      Solve it again
                    </ButtonLink>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ol>
          {hidden > 0 ? (
            <p className="text-sm text-text-secondary">
              {hidden === 1 ? "One more is" : `${hidden} more are`} past their date. You are shown{" "}
              {REVISION_DAILY_CAP} a day on purpose — the rest keep their place in the queue and the most overdue comes
              first.
            </p>
          ) : null}
        </>
      ) : (
        <EmptyState
          icon={<CheckCheck className="h-6 w-6" />}
          title={nothingAtAll ? "Nothing here yet" : "Nothing due today"}
          description={nothingAtAll ? REVISION_EMPTY.noCards : REVISION_EMPTY.nothingDue}
        />
      )}

      <Card>
        <CardHeader title="Where everything stands" />
        <CardBody>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
            <div>
              <dt className="inline font-medium">Due today </dt>
              <dd className="inline">{queue.backlog}</dd>
            </div>
            <div>
              <dt className="inline font-medium">Waiting </dt>
              <dd className="inline">
                {queue.scheduled}
                {queue.nextDueOn ? `, next on ${formatCampusDay(queue.nextDueOn)}` : ""}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">Done with </dt>
              <dd className="inline">{queue.learned}</dd>
            </div>
          </dl>
        </CardBody>
      </Card>
    </div>
  );
}
