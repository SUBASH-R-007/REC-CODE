import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import type { StudyPlanKind } from "@recx/db";
import { Card, DifficultyBadge, EmptyState, SolveStatus, pluralize } from "@recx/design";
import { getPlanDetail } from "@/components/plans/data";
import { EnrollForm } from "@/components/plans/enroll-form";
import { PLAN_KINDS, isPlanSlug, planHref, solvedText } from "@/components/plans/kinds";
import { PlanProgress } from "@/components/plans/plan-progress";

/**
 * /sheets/[slug] and /learn/[slug]: a published plan's sections and items
 * with the viewer's solve state on each, and Enroll / Leave. A plan opened
 * under the other kind's path redirects to its own; anything unpublished or
 * unknown is a 404.
 */
export async function PlanDetailView({ kind, slug, userId }: { kind: StudyPlanKind; slug: string; userId: string }) {
  if (!isPlanSlug(slug)) notFound();
  const plan = await getPlanDetail(slug, userId);
  if (!plan) notFound();
  if (plan.kind !== kind) redirect(planHref(plan.kind, plan.slug));

  const config = PLAN_KINDS[kind];
  const enrolled = plan.enrollment !== null;

  return (
    <div>
      <Link
        href={config.basePath}
        className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-text-secondary hover:text-primary"
      >
        <ChevronLeft aria-hidden className="h-4 w-4" />
        All {config.title.toLowerCase()}
      </Link>

      <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold tracking-tight">{plan.title}</h1>
          <p className="mt-1 text-sm text-muted">
            {plan.itemCount} {pluralize(plan.itemCount, "problem")}
            {plan.sections.length > 1 ? ` in ${plan.sections.length} sections` : null}
          </p>
        </div>
        <EnrollForm planId={plan.id} enrolled={enrolled} noun={config.noun} />
      </div>

      <p className="mt-3 max-w-3xl text-sm whitespace-pre-line text-text-secondary">{plan.description}</p>

      {enrolled ? (
        <Card className="mt-5 max-w-xl p-4">
          <PlanProgress done={plan.solvedCount} total={plan.itemCount} title={plan.title} />
        </Card>
      ) : plan.solvedCount > 0 ? (
        <p className="mt-4 text-sm text-text-secondary">
          You have already solved {plan.solvedCount} of these {plan.itemCount} problems. Enroll to track the rest.
        </p>
      ) : null}

      {plan.itemCount === 0 ? (
        <Card className="mt-6">
          <EmptyState
            title={`This ${config.noun} has no problems yet`}
            description="Problems are added by the placement cell. Check back soon."
          />
        </Card>
      ) : (
        <div className="mt-6 space-y-6">
          {plan.sections
            .filter((section) => section.items.length > 0)
            .map((section) => (
              <section key={section.id} aria-labelledby={`section-${section.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id={`section-${section.id}`} className="font-display text-lg font-semibold tracking-tight">
                    {section.title}
                  </h2>
                  <p className="text-sm text-text-secondary">{solvedText(section.solved, section.items.length)}</p>
                </div>
                <Card className="mt-2 overflow-hidden">
                  <ol className="divide-y divide-border">
                    {section.items.map((item) => (
                      <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:px-5">
                        <span className="w-28 shrink-0">
                          {item.solve ? (
                            <SolveStatus status={item.solve} />
                          ) : (
                            <span className="sr-only">Not attempted</span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          {item.available ? (
                            <Link
                              href={`/problems/${item.problemSlug}`}
                              className="inline-flex min-h-9 items-center font-medium text-text hover:text-primary hover:underline"
                            >
                              {item.title}
                            </Link>
                          ) : (
                            <span className="inline-flex min-h-9 items-center text-text-secondary">
                              {item.title}
                              <span className="ml-2 text-xs text-muted">(no longer available)</span>
                            </span>
                          )}
                          <span className="ml-2 font-mono text-xs text-muted">{item.displayCode}</span>
                        </span>
                        <DifficultyBadge difficulty={item.difficulty} />
                      </li>
                    ))}
                  </ol>
                </Card>
              </section>
            ))}
        </div>
      )}
    </div>
  );
}
