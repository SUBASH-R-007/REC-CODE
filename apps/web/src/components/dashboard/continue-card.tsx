import Link from "next/link";
import { ArrowRight, CalendarCheck, Compass, History, ListChecks } from "lucide-react";
import { ButtonLink, DifficultyBadge, SolveStatus, pluralize } from "@recx/design";
import type { ContinueAction } from "@/components/dashboard/model";
import { planHref } from "@/components/plans/kinds";
import { absoluteTime, relativeTime } from "@/components/problems/relative-time";

const ICON_TILE = "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary";

/**
 * The ONE next action. Server component: no client JS. The card is the
 * dashboard's visual anchor (wider column, primary edge), so a student
 * never has to decide what to do first.
 */
export function ContinueCard({ action, now, className }: { action: ContinueAction; now: Date; className?: string }) {
  if (action.kind === "none") {
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

  const { problem } = action;
  let eyebrow: string;
  let reason: React.ReactNode;
  let cta: string;
  let icon: React.ReactNode;

  switch (action.kind) {
    case "attempted":
      eyebrow = "Pick up where you left off";
      icon = <History className="h-5 w-5" aria-hidden />;
      cta = "Continue solving";
      reason = (
        <>
          {action.attempts} {pluralize(action.attempts, "attempt")} so far · last one{" "}
          <time dateTime={action.lastAttemptAt.toISOString()} title={absoluteTime(action.lastAttemptAt)}>
            {relativeTime(action.lastAttemptAt, now)}
          </time>
        </>
      );
      break;
    case "plan":
      eyebrow = `Next in ${action.plan.title}`;
      icon = <ListChecks className="h-5 w-5" aria-hidden />;
      cta = "Start problem";
      reason = (
        <>
          {action.plan.itemsDone} of {action.plan.itemsTotal} solved in this{" "}
          {action.plan.kind === "SHEET" ? "sheet" : "track"} ·{" "}
          <Link
            href={planHref(action.plan.kind, action.plan.slug) as never}
            className="font-medium text-text underline underline-offset-2 hover:text-primary"
          >
            Open the {action.plan.kind === "SHEET" ? "sheet" : "track"}
          </Link>
        </>
      );
      break;
    case "daily":
      eyebrow = "Today's daily challenge";
      icon = <CalendarCheck className="h-5 w-5" aria-hidden />;
      cta = "Solve today's challenge";
      reason = <>Double XP today: {action.xp} XP for a first solve.</>;
      break;
    case "suggested":
      eyebrow = action.firstEver ? "A good first problem" : "Try something new";
      icon = <Compass className="h-5 w-5" aria-hidden />;
      cta = "Start solving";
      reason = action.firstEver
        ? "Solve it in the browser and get your verdict in seconds — your streak starts with your first submission."
        : "You have no unfinished problems. This one is next in line.";
      break;
  }

  return (
    <section
      aria-labelledby="continue-heading"
      className={`rounded-2xl border border-border border-l-4 border-l-primary bg-surface p-5 shadow-card sm:p-6 ${className ?? ""}`}
    >
      <div className="flex items-start gap-4">
        <span aria-hidden className={ICON_TILE}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="continue-heading" className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Continue
          </h2>
          <p className="mt-0.5 text-sm font-medium text-text">{eyebrow}</p>
          <p className="mt-1.5 font-display text-xl font-bold tracking-tight sm:text-2xl">
            <span className="mr-2 font-mono text-sm font-medium text-text-secondary">{problem.displayCode}</span>
            {problem.title}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <DifficultyBadge difficulty={problem.difficulty} />
            {action.kind === "attempted" && <SolveStatus status="attempted" />}
          </div>
          <p className="mt-3 text-sm text-text-secondary">{reason}</p>
          <ButtonLink href={`/problems/${problem.slug}`} size="lg" className="mt-5">
            {cta}
            <span className="sr-only">: {problem.title}</span>
            <ArrowRight className="h-4 w-4" aria-hidden />
          </ButtonLink>
        </div>
      </div>
    </section>
  );
}
