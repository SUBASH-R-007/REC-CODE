import { useId } from "react";
import { cn, pluralize } from "@recx/design";
import {
  buildHeatmap,
  formatDayLong,
  heatmapCssVars,
  heatmapLegend,
  summariseByMonth,
  type ActivityInput,
  type HeatmapLevel,
} from "@/components/profile/heatmap-model";

/** Literal classes (Tailwind scans for them); the colours are the --hm-n vars from HEATMAP_STEPS. */
const LEVEL_CLASS: Record<HeatmapLevel, string> = {
  0: "border border-border-strong bg-surface",
  1: "bg-[var(--hm-1)]",
  2: "bg-[var(--hm-2)]",
  3: "bg-[var(--hm-3)]",
  4: "bg-[var(--hm-4)]",
  5: "bg-[var(--hm-5)]",
};

const CELL = "block size-[11px] rounded-[3px] sm:size-3";
const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""] as const;

/**
 * 365-day activity heatmap. One hue, five lightness steps — readable in
 * grayscale and under every colour-vision deficiency. Zero-activity days
 * are outlined. Every cell has a text label ("12 March 2026: 4 problems
 * solved"), the legend is text, and the same data is offered as a monthly
 * table. Server-rendered: no client JS.
 */
export function ActivityHeatmap({
  activity,
  today,
  subject = "you",
}: {
  activity: readonly ActivityInput[];
  today: string;
  /** "you" on your own profile, else the student's display name. */
  subject?: string;
}) {
  const id = useId();
  const model = buildHeatmap(activity, today);
  const legend = heatmapLegend();
  const months = summariseByMonth(model);
  const summary = `${model.totalSolved} ${pluralize(model.totalSolved, "problem")} solved and ${model.activeDays} active ${pluralize(model.activeDays, "day")} between ${formatDayLong(model.start)} and ${formatDayLong(model.end)}.`;

  return (
    <figure aria-labelledby={`${id}-caption`} style={heatmapCssVars() as React.CSSProperties}>
      <figcaption id={`${id}-caption`} className="text-sm text-text-secondary">
        {summary}
      </figcaption>

      <div className="mt-3 flex gap-2">
        <div aria-hidden className="flex shrink-0 flex-col gap-[3px] pt-[19px] text-[10px] leading-[11px] text-muted sm:leading-3">
          {WEEKDAY_LABELS.map((label, i) => (
            <span key={i} className="h-[11px] sm:h-3">
              {label}
            </span>
          ))}
        </div>
        {/* row-reverse: the scroll origin is the right edge, so the latest weeks are in view on narrow screens. */}
        <div
          role="group"
          aria-label={`Daily activity${subject === "you" ? "" : ` of ${subject}`}, one cell per day, oldest first`}
          tabIndex={0}
          className="scroll-thin flex min-w-0 flex-1 flex-row-reverse overflow-x-auto pb-2"
        >
          <div className="flex gap-[3px]">
            {model.weeks.map((week, w) => (
              <div key={w} className="flex flex-col gap-[3px]">
                <span aria-hidden className="relative h-4 text-[10px] leading-4 text-muted">
                  {week.monthLabel ? <span className="absolute left-0 top-0 whitespace-nowrap">{week.monthLabel}</span> : null}
                </span>
                {week.cells.map((cell, d) =>
                  cell ? (
                    <span
                      key={cell.date}
                      role="img"
                      aria-label={cell.label}
                      title={cell.label}
                      className={cn(CELL, LEVEL_CLASS[cell.level])}
                    />
                  ) : (
                    <span key={`pad-${d}`} aria-hidden className={CELL} />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-text-secondary">
        <span>Problems solved per day:</span>
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1.5" aria-label="Legend">
          {legend.map((item) => (
            <li key={item.level} className="flex items-center gap-1.5">
              <span aria-hidden className={cn(CELL, LEVEL_CLASS[item.level])} />
              {item.label}
            </li>
          ))}
        </ul>
      </div>

      <details className="mt-3 text-sm">
        <summary className="inline-flex min-h-10 cursor-pointer items-center font-medium text-text underline decoration-primary decoration-2 underline-offset-4 hover:decoration-text">
          Show this activity as a table
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[22rem] text-sm">
            <caption className="sr-only">Activity per month, last 365 days</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">Month</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Active days</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Problems solved</th>
                <th scope="col" className="py-2 text-right font-medium">Submissions</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.key} className="border-b border-border last:border-b-0">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal">{m.label}</th>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{m.activeDays}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{m.solved}</td>
                  <td className="py-1.5 text-right tabular-nums">{m.submissions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
