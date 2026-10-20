import { HEATMAP_STEPS, heatmapLevel } from "@recx/shared";

/**
 * The 365-day activity heatmap as data: Monday-first week columns, a level
 * per day from heatmapLevel() (problems solved that day), and a text label
 * for every cell. Lightness, never hue: level n is
 * color-mix(in srgb, var(--primary) HEATMAP_STEPS[n-1]%, var(--surface)).
 * Days are campus days ("yyyy-MM-dd", Asia/Kolkata). Pure.
 */

export const HEATMAP_DAYS = 365;

export type HeatmapLevel = ReturnType<typeof heatmapLevel>;

export interface ActivityInput {
  /** Campus day, "yyyy-MM-dd". */
  date: string;
  solved: number;
  submissions: number;
}

export interface HeatmapCell extends ActivityInput {
  level: HeatmapLevel;
  label: string;
}

export interface HeatmapWeek {
  /** Monday … Sunday; null outside the 365-day window (a spacer, not a day). */
  cells: Array<HeatmapCell | null>;
  /** Short month name when this column starts a month, e.g. "Mar". */
  monthLabel: string | null;
}

export interface HeatmapModel {
  weeks: HeatmapWeek[];
  start: string;
  end: string;
  totalSolved: number;
  totalSubmissions: number;
  activeDays: number;
}

const DATE_LONG = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const MONTH_SHORT = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const MONTH_LONG = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

export function addDays(day: string, n: number): string {
  const d = asDate(day);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(day: string): number {
  return (asDate(day).getUTCDay() + 6) % 7;
}

/** "12 March 2026". */
export function formatDayLong(day: string): string {
  return DATE_LONG.format(asDate(day));
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "12 March 2026: 4 problems solved" (+ ", 9 submissions" when there were any). */
export function heatmapCellLabel(day: string, solved: number, submissions: number): string {
  const solvedText = solved > 0 ? `${plural(solved, "problem", "problems")} solved` : "no problems solved";
  const submissionsText = submissions > 0 ? `, ${plural(submissions, "submission", "submissions")}` : "";
  return `${formatDayLong(day)}: ${solvedText}${submissionsText}`;
}

/** The fill of a level (null for level 0, which is drawn as an outline instead). */
export function heatmapFill(level: HeatmapLevel): string | null {
  if (level === 0) return null;
  return `color-mix(in srgb, var(--primary) ${HEATMAP_STEPS[level - 1]}%, var(--surface))`;
}

/** CSS custom properties --hm-1 … --hm-5, set once on the heatmap container. */
export function heatmapCssVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  HEATMAP_STEPS.forEach((_, i) => {
    vars[`--hm-${i + 1}`] = heatmapFill((i + 1) as HeatmapLevel) ?? "";
  });
  return vars;
}

/**
 * The text legend, derived from heatmapLevel() itself so it can never drift:
 * "No problems", "1 problem", "2 problems", "3–4 problems", …, "8 or more".
 */
export function heatmapLegend(probeLimit = 100): Array<{ level: HeatmapLevel; label: string }> {
  const ranges = new Map<HeatmapLevel, { min: number; max: number }>();
  for (let n = 0; n <= probeLimit; n++) {
    const level = heatmapLevel(n);
    const range = ranges.get(level);
    if (range) range.max = n;
    else ranges.set(level, { min: n, max: n });
  }
  return [...ranges.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, { min, max }]) => {
      if (level === 0) return { level, label: "None" };
      if (max === probeLimit) return { level, label: `${min} or more` };
      return { level, label: min === max ? String(min) : `${min}–${max}` };
    });
}

/** Lay out the 365 days ending `today` as Monday-first week columns. */
export function buildHeatmap(days: readonly ActivityInput[], today: string): HeatmapModel {
  const start = addDays(today, -(HEATMAP_DAYS - 1));
  const byDay = new Map(days.map((d) => [d.date, d]));
  const gridStart = addDays(start, -weekdayIndex(start));
  const gridEnd = addDays(today, 6 - weekdayIndex(today));

  const weeks: HeatmapWeek[] = [];
  let totalSolved = 0;
  let totalSubmissions = 0;
  let activeDays = 0;

  for (let weekStart = gridStart; weekStart <= gridEnd; weekStart = addDays(weekStart, 7)) {
    const cells: Array<HeatmapCell | null> = [];
    let monthLabel: string | null = null;
    for (let i = 0; i < 7; i++) {
      const day = addDays(weekStart, i);
      if (day < start || day > today) {
        cells.push(null);
        continue;
      }
      const input = byDay.get(day);
      const solved = Math.max(0, input?.solved ?? 0);
      const submissions = Math.max(0, input?.submissions ?? 0);
      totalSolved += solved;
      totalSubmissions += submissions;
      if (solved > 0 || submissions > 0) activeDays += 1;
      cells.push({ date: day, solved, submissions, level: heatmapLevel(solved), label: heatmapCellLabel(day, solved, submissions) });
      if (day.endsWith("-01")) monthLabel = MONTH_SHORT.format(asDate(day));
    }
    weeks.push({ cells, monthLabel });
  }

  // Label the first column with its month unless a month starts within the next two columns.
  const first = weeks[0];
  const firstDay = first?.cells.find((c) => c !== null);
  if (first && firstDay && !first.monthLabel && !weeks.slice(1, 3).some((w) => w.monthLabel)) {
    first.monthLabel = MONTH_SHORT.format(asDate(firstDay.date));
  }

  return { weeks, start, end: today, totalSolved, totalSubmissions, activeDays };
}

export interface MonthSummary {
  key: string;
  label: string;
  activeDays: number;
  solved: number;
  submissions: number;
}

/** The same data as text: one row per calendar month in the window, oldest first. */
export function summariseByMonth(model: HeatmapModel): MonthSummary[] {
  const months = new Map<string, MonthSummary>();
  for (const week of model.weeks) {
    for (const cell of week.cells) {
      if (!cell) continue;
      const key = cell.date.slice(0, 7);
      let month = months.get(key);
      if (!month) {
        month = { key, label: MONTH_LONG.format(asDate(`${key}-01`)), activeDays: 0, solved: 0, submissions: 0 };
        months.set(key, month);
      }
      month.solved += cell.solved;
      month.submissions += cell.submissions;
      if (cell.solved > 0 || cell.submissions > 0) month.activeDays += 1;
    }
  }
  return [...months.values()];
}
