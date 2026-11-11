import Link from "next/link";
import { CheckCheck, History } from "lucide-react";
import { Badge, ButtonLink, Card, CardBody, CardHeader, DifficultyBadge, EmptyState } from "@recx/design";
import { REVISION_DAILY_CAP, formatCampusDay } from "@recx/shared";
import type { RevisionQueue } from "@/server/queries/revision";

/**
 * The dashboard's revision card (Phase 12c): what is due today, at most
 * REVISION_DAILY_CAP of it, and the backlog stated rather than hidden.
 *
 * On the dashboard rather than only at /revision because a schedule nobody
 * is reminded of is a schedule nobody keeps, and the dashboard is the page
 * a student actually opens.
 */
export function RevisionCard({ queue, className }: { queue: RevisionQueue; className?: string }) {
  const hidden = Math.max(0, queue.backlog - queue.items.length);
  return (
    <Card className={className}>
      <CardHeader
        title="Revision"
        subtitle={
          queue.backlog > 0
            ? `${queue.backlog} due today${hidden > 0 ? `, ${REVISION_DAILY_CAP} shown` : ""}`
            : queue.nextDueOn
              ? `Next on ${formatCampusDay(queue.nextDueOn)}`
              : undefined
        }
        action={
          queue.backlog > 0 ? (
            <Link href="/revision" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
              All revision
            </Link>
          ) : null
        }
      />
      <CardBody className="pt-3">
        {queue.items.length === 0 ? (
          <EmptyState
            compact
            icon={queue.learned > 0 || queue.scheduled > 0 ? <CheckCheck className="h-5 w-5" /> : <History className="h-5 w-5" />}
            title={queue.scheduled > 0 || queue.learned > 0 ? "Nothing due today" : "Revision starts with your first solve"}
            description={
              queue.scheduled > 0
                ? "Every problem you solve comes back — a day later, then three, then a week."
                : "Solve a problem and it will come back to you here tomorrow."
            }
            action={
              <ButtonLink href="/problems" variant="outline" size="sm">
                Find a problem
              </ButtonLink>
            }
          />
        ) : (
          <ul className="space-y-3">
            {queue.items.map((item) => (
              <li key={item.problemId}>
                <div className="flex items-center justify-between gap-2">
                  <Link
                    href={`/problems/${item.slug}`}
                    className="min-w-0 truncate text-sm font-medium text-text hover:text-primary hover:underline"
                  >
                    {item.title}
                  </Link>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <DifficultyBadge difficulty={item.difficulty} />
                    {item.overdueDays > 0 ? (
                      <Badge tone="warning">{item.overdueDays === 1 ? "1 day late" : `${item.overdueDays} days late`}</Badge>
                    ) : null}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
