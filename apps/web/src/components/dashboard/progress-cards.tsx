import { Check, Flame, Star, Target } from "lucide-react";
import { ProgressBar, ProgressRing, cn, pluralize } from "@recx/design";
import type { LevelView, StreakView, WeekDay, WeeklyGoal } from "@/components/dashboard/model";

const CARD = "rounded-2xl border border-border bg-surface p-5 shadow-card";
const TITLE = "flex items-center gap-2 font-display text-base font-semibold tracking-tight";
const nf = new Intl.NumberFormat("en-IN");

/** Weekly goal: N problems this campus week, from the WEEK XpBucket. */
export function WeeklyGoalCard({ weekly }: { weekly: WeeklyGoal }) {
  return (
    <section aria-labelledby="weekly-goal-heading" className={CARD}>
      <h2 id="weekly-goal-heading" className={TITLE}>
        <Target className="h-4 w-4 text-primary" aria-hidden />
        Weekly goal
      </h2>
      <div className="mt-4 flex items-center gap-4">
        <ProgressRing value={weekly.percent} size={64} strokeWidth={6}>
          <span aria-hidden className="text-sm font-bold tabular-nums">
            {Math.min(weekly.solved, 99)}/{weekly.goal}
          </span>
        </ProgressRing>
        <div className="min-w-0">
          <p className="text-sm font-medium text-text">
            {weekly.met
              ? `Goal met: ${weekly.solved} ${pluralize(weekly.solved, "problem")} solved this week`
              : `${weekly.solved} of ${weekly.goal} problems solved this week`}
          </p>
          <p className="mt-0.5 text-xs text-text-secondary">
            {weekly.met
              ? "Anything more is a bonus. The goal resets on Monday."
              : `${weekly.goal - weekly.solved} to go. The week runs Monday to Sunday (IST).`}
          </p>
        </div>
      </div>
    </section>
  );
}

function dayText(d: WeekDay): string {
  if (d.isFuture) return `${d.long}: still to come`;
  if (d.submissions === 0) return d.isToday ? `${d.long} (today): no submissions yet` : `${d.long}: no activity`;
  const solved = d.solved > 0 ? `, ${d.solved} ${pluralize(d.solved, "problem")} solved` : "";
  return `${d.long}${d.isToday ? " (today)" : ""}: ${d.submissions} ${pluralize(d.submissions, "submission")}${solved}`;
}

/**
 * Streak (effectiveStreak from UserStats) and this week's days. An active
 * day is a filled cell with a tick; today is outlined with a dashed ring;
 * every cell's full meaning is in text for screen readers — never colour
 * alone.
 */
export function StreakCard({ streak, week }: { streak: StreakView; week: WeekDay[] }) {
  return (
    <section aria-labelledby="streak-heading" className={CARD}>
      <h2 id="streak-heading" className={TITLE}>
        <Flame className="h-4 w-4 text-warning" aria-hidden />
        Streak
      </h2>
      <p className="mt-3 font-display text-3xl font-bold tracking-tight tabular-nums">
        {streak.current} <span className="text-base font-semibold text-text-secondary">{pluralize(streak.current, "day")}</span>
      </p>
      <p className="mt-0.5 text-xs text-text-secondary">
        {streak.atRisk
          ? "Submit something today to keep your streak going."
          : streak.activeToday
            ? "Today counts. Come back tomorrow to extend it."
            : streak.current === 0
              ? "A judged submission today starts a new streak."
              : "Keep it going."}{" "}
        Longest: {streak.longest} {pluralize(streak.longest, "day")}.
      </p>
      <ol aria-label="This week" className="mt-4 flex justify-between gap-1">
        {week.map((d) => {
          const active = d.submissions > 0;
          return (
            <li key={d.day} className="flex flex-col items-center gap-1">
              <span
                aria-hidden
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold",
                  active && "bg-primary text-primary-fg",
                  !active && d.isToday && "border-2 border-dashed border-primary text-text",
                  !active && !d.isToday && !d.isFuture && "border border-border-strong text-text-secondary",
                  !active && d.isFuture && "border border-border text-muted",
                )}
              >
                {active ? <Check className="h-4 w-4" strokeWidth={3} /> : d.short.charAt(0)}
              </span>
              <span aria-hidden className={cn("text-[0.65rem]", d.isToday ? "font-semibold text-text" : "text-text-secondary")}>
                {d.short}
              </span>
              <span className="sr-only">{dayText(d)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Level and XP (levelProgress over UserStats.xpTotal — the LMS curve). */
export function LevelCard({ level }: { level: LevelView }) {
  return (
    <section aria-labelledby="level-heading" className={CARD}>
      <h2 id="level-heading" className={TITLE}>
        <Star className="h-4 w-4 text-accent" aria-hidden />
        Level and XP
      </h2>
      <p className="mt-3 font-display text-3xl font-bold tracking-tight">Level {level.level}</p>
      <ProgressBar
        className="mt-3"
        value={level.intoLevel}
        max={level.span}
        label={`Progress to level ${level.level + 1}`}
      />
      <p className="mt-2 text-xs text-text-secondary">
        <span className="font-medium text-text tabular-nums">{nf.format(level.toNext)} XP</span> to level{" "}
        {level.level + 1} · {nf.format(level.xpTotal)} XP in total
      </p>
    </section>
  );
}
