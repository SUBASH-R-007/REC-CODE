import { ArrowRight, CalendarCheck, Briefcase, Compass, History, ListChecks, RotateCcw, Target } from "lucide-react";
import { ButtonLink, DifficultyBadge, SolveStatus } from "@recx/design";
import { RECOMMENDER_CTA, RECOMMENDER_EYEBROW, type Recommendation, type RecommenderRule } from "@recx/shared";

const ICON_TILE = "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary";

const ICONS: Readonly<Record<RecommenderRule, typeof History>> = {
  FINISH: History,
  REVISE: RotateCcw,
  DRIVE: Briefcase,
  WEAK_TOPIC: Target,
  PLAN: ListChecks,
  DAILY: CalendarCheck,
  FRESH: Compass,
};

/**
 * The ONE next action, with the reason beside it. Server component: no
 * client JS.
 *
 * SPEC §11 requires a recommender to "always render the reason inline",
 * and the reason is not written here — it arrives on the recommendation,
 * from the rule that produced it (`recommend()` in @recx/shared). That is
 * deliberate: an explanation assembled a second time, in the component,
 * is an explanation that can disagree with the decision.
 */
export function ContinueCard({
  recommendation,
  className,
}: {
  recommendation: Recommendation | null;
  className?: string;
}) {
  if (!recommendation) {
    return (
      <section
        aria-labelledby="continue-heading"
        className={`rounded-2xl border border-border border-l-4 border-l-primary bg-surface p-5 shadow-card sm:p-6 ${className ?? ""}`}
      >
        <h2 id="continue-heading" className="font-display text-base font-semibold tracking-tight">
          Continue
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          No problems are published yet. They appear here the moment the content team publishes them.
        </p>
        <ButtonLink href="/problems" variant="outline" className="mt-4">
          Browse problems
        </ButtonLink>
      </section>
    );
  }

  const { rule, problem, reason } = recommendation;
  const Icon = ICONS[rule];

  return (
    <section
      aria-labelledby="continue-heading"
      className={`rounded-2xl border border-border border-l-4 border-l-primary bg-surface p-5 shadow-card sm:p-6 ${className ?? ""}`}
    >
      <div className="flex items-start gap-4">
        <span aria-hidden className={ICON_TILE}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="continue-heading" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Continue
          </h2>
          <p className="mt-0.5 text-sm font-medium text-text">{RECOMMENDER_EYEBROW[rule]}</p>
          <p className="mt-1.5 font-display text-xl font-bold tracking-tight sm:text-2xl">
            <span className="mr-2 font-mono text-sm font-medium text-text-secondary">{problem.displayCode}</span>
            {problem.title}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <DifficultyBadge difficulty={problem.difficulty} />
            {rule === "FINISH" && <SolveStatus status="attempted" />}
            {rule === "REVISE" && <SolveStatus status="solved" />}
          </div>
          {/* The reason, inline, every time. SPEC §11. */}
          <p className="mt-3 text-sm text-text-secondary">{reason}</p>
          <ButtonLink href={`/problems/${problem.slug}`} size="lg" className="mt-5">
            {RECOMMENDER_CTA[rule]}
            <span className="sr-only">: {problem.title}</span>
            <ArrowRight className="h-4 w-4" aria-hidden />
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
