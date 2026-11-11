import Link from "next/link";
import { ListChecks } from "lucide-react";
import type { StudyPlanKind } from "@recx/db";
import { Badge, Card, EmptyState, pluralize } from "@recx/design";
import { listPublishedPlans } from "@/components/plans/data";
import { PLAN_KINDS, planHref } from "@/components/plans/kinds";
import { PlanProgress } from "@/components/plans/plan-progress";

/**
 * /sheets and /learn: the published plans of one kind as cards. The card's
 * title is its only link (stretched over the card), so a screen reader hears
 * one link per plan named by its title. Progress is shown only when the
 * viewer is enrolled.
 */
export async function PlanIndex({ kind, userId }: { kind: StudyPlanKind; userId: string }) {
  const config = PLAN_KINDS[kind];
  const plans = await listPublishedPlans(kind, userId);

  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">{config.title}</h1>
      <p className="mt-1 max-w-2xl text-sm text-text-secondary">{config.intro}</p>

      {plans.length === 0 ? (
        <Card className="mt-6">
          <EmptyState
            icon={<ListChecks className="h-7 w-7" aria-hidden />}
            title={config.emptyTitle}
            description={config.emptyDescription}
          />
        </Card>
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {plans.map((plan) => (
            <li
              key={plan.id}
              className="relative flex flex-col rounded-2xl border border-border bg-surface p-5 shadow-card transition-shadow focus-within:shadow-pop hover:shadow-pop"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-display text-base font-semibold leading-snug tracking-tight">
                  <Link
                    href={planHref(kind, plan.slug)}
                    className="after:absolute after:inset-0 after:rounded-2xl after:content-[''] hover:text-primary"
                  >
                    {plan.title}
                  </Link>
                </h2>
                {plan.enrollment ? (
                  <Badge tone={plan.enrollment.completed ? "success" : "primary"}>
                    {plan.enrollment.completed ? "Completed" : "Enrolled"}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-2 line-clamp-3 text-sm text-text-secondary">{plan.description}</p>
              <p className="mt-3 text-xs text-muted">
                {plan.itemCount} {pluralize(plan.itemCount, "problem")}
                {plan.sectionCount > 1 ? ` · ${plan.sectionCount} sections` : null}
              </p>
              {plan.enrollment ? (
                <PlanProgress
                  className="mt-auto pt-4"
                  size="sm"
                  title={plan.title}
                  done={plan.enrollment.itemsDone}
                  total={plan.enrollment.itemsTotal}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
