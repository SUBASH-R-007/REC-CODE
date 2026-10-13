import Link from "next/link";
import { ExternalLink, ListChecks, Lock } from "lucide-react";
import type { StudyPlanKind } from "@recx/db";
import { ButtonLink, Card, CardHeader, DifficultyBadge, EmptyState } from "@recx/design";
import type { AdminPlanDetail, AdminPlanRow, PickableProblem } from "@/server/queries/admin-plans";
import { PLAN_KINDS, planHref } from "@/components/plans/kinds";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { ADMIN_PLAN_PATH, PlanIndex, PlanStateBadges } from "@/components/admin/plans/plan-index";
import { ItemPicker } from "@/components/admin/plans/item-picker";
import { PlanMetaForm } from "@/components/admin/plans/plan-meta-form";
import { PlanStatusPanel } from "@/components/admin/plans/plan-status-panel";
import { SectionEditor } from "@/components/admin/plans/section-editor";

/**
 * The three plan screens shared by /admin/sheets and /admin/tracks (the
 * route fixes the kind). Each page.tsx runs its own guard and fetches; these
 * only render.
 */

export function PlanIndexView({ kind, plans }: { kind: StudyPlanKind; plans: AdminPlanRow[] }) {
  const cfg = PLAN_KINDS[kind];
  return (
    <>
      <AdminPageHeader
        title={cfg.title}
        description={`College-wide ${cfg.noun}s students see at ${cfg.basePath}. Enrolment figures count only your students.`}
        actions={<ButtonLink href={`${ADMIN_PLAN_PATH[kind]}/new`}>New {cfg.noun}</ButtonLink>}
      />
      <Card className="overflow-hidden">
        {plans.length === 0 ? (
          <EmptyState
            icon={<ListChecks className="h-6 w-6" />}
            title={`No ${cfg.noun}s yet`}
            description={`Create a ${cfg.noun}, add sections and published problems, then publish it.`}
          />
        ) : (
          <div className="pb-4 pt-3">
            <PlanIndex kind={kind} plans={plans} noun={cfg.noun} />
          </div>
        )}
      </Card>
    </>
  );
}

export function PlanNewView({ kind }: { kind: StudyPlanKind }) {
  const cfg = PLAN_KINDS[kind];
  return (
    <>
      <AdminPageHeader
        title={`New ${cfg.noun}`}
        back={{ href: ADMIN_PLAN_PATH[kind], label: cfg.title }}
        description={`A new ${cfg.noun} starts unpublished. Add sections and problems, then publish it.`}
      />
      <Card className="p-5">
        <PlanMetaForm mode="create" kind={kind} noun={cfg.noun} />
      </Card>
    </>
  );
}

export function PlanEditView({ plan, problems }: { plan: AdminPlanDetail; problems: PickableProblem[] }) {
  const cfg = PLAN_KINDS[plan.kind];
  const locked = plan.seedManaged;
  return (
    <>
      <AdminPageHeader
        title={plan.title}
        back={{ href: ADMIN_PLAN_PATH[plan.kind], label: cfg.title }}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <PlanStateBadges published={plan.published} seedManaged={plan.seedManaged} />
            <span className="tabular-nums">
              {plan.itemsTotal} {plan.itemsTotal === 1 ? "problem" : "problems"} · {plan.enrolledInScope} of your students enrolled ·{" "}
              {plan.completedInScope} completed
            </span>
            {plan.published ? (
              <Link
                href={planHref(plan.kind, plan.slug) as never}
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                View as a student
              </Link>
            ) : null}
          </span>
        }
        actions={
          <PlanStatusPanel
            planId={plan.id}
            published={plan.published}
            seedManaged={plan.seedManaged}
            itemsTotal={plan.itemsTotal}
            noun={cfg.noun}
          />
        }
      />
      {locked ? (
        <p role="note" className="mb-6 flex items-start gap-2 rounded-xl border border-info/30 bg-info-subtle px-4 py-3 text-sm text-info">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          The seed keeps this {cfg.noun} in step with the published problems, so it is read-only here. Detach it from the seed to edit
          it yourself.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Card>
            <CardHeader title="Sections and problems" subtitle="Students see the sections in this order." />
            <div className="px-5 pb-5 pt-4">
              <SectionEditor
                planId={plan.id}
                disabled={locked}
                sections={plan.sections}
              />
            </div>
          </Card>
        </div>
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Add problems" />
            <div className="px-5 pb-5 pt-4">
              <ItemPicker planId={plan.id} disabled={locked} sections={plan.sections.map((s) => ({ id: s.id, title: s.title }))} />
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer font-medium text-text-secondary">
                  Published problems ({problems.length})
                </summary>
                <ul className="scroll-thin mt-2 max-h-72 space-y-1 overflow-y-auto pr-1" tabIndex={0} aria-label="Published problems">
                  {problems.map((p) => (
                    <li key={p.displayCode} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate">
                        <span className="font-mono text-xs">{p.displayCode}</span> {p.title}
                      </span>
                      <DifficultyBadge difficulty={p.difficulty} />
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          </Card>
          <Card>
            <CardHeader title="Details" />
            <div className="px-5 pb-5 pt-4">
              <PlanMetaForm
                mode="edit"
                kind={plan.kind}
                planId={plan.id}
                noun={cfg.noun}
                disabled={locked}
                initial={{
                  slug: plan.slug,
                  title: plan.title,
                  description: plan.description,
                  sortOrder: String(plan.sortOrder),
                }}
              />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
