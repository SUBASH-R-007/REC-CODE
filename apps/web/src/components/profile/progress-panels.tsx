import Link from "next/link";
import { DifficultyBadge, ProgressBar, formatDuration, percent, pluralize } from "@recx/design";
import type { Difficulty } from "@recx/db";
import type { LanguageShare, SolvedSummary, TimeToSolveRow } from "@/server/queries/profile";
import { MIN_COHORT_FOR_MEDIAN } from "@/server/queries/profile";

const DIFFICULTIES: readonly Difficulty[] = ["EASY", "MEDIUM", "HARD"];
const DIFFICULTY_WORD: Record<Difficulty, string> = { EASY: "Easy", MEDIUM: "Medium", HARD: "Hard" };

/** Solved problems by difficulty, each against what is published. */
export function SolvedByDifficulty({ solved }: { solved: SolvedSummary }) {
  return (
    <div>
      <p className="font-display text-3xl font-bold tracking-tight tabular-nums">
        {solved.total}
        <span className="ml-2 text-sm font-medium text-text-secondary">
          {pluralize(solved.total, "problem")} solved
        </span>
      </p>
      <ul className="mt-4 space-y-3">
        {DIFFICULTIES.map((d) => {
          const count = solved.byDifficulty[d];
          const published = solved.published[d];
          return (
            <li key={d}>
              <div className="flex items-center justify-between gap-2 text-sm">
                <DifficultyBadge difficulty={d} />
                <span className="tabular-nums text-text-secondary">
                  <span className="font-semibold text-text">{count}</span>
                  {/* Solves of since-retired problems can exceed what is published now. */}
                  {published >= count ? ` of ${published}` : " solved"}
                </span>
              </div>
              <ProgressBar
                className="mt-1.5"
                size="sm"
                value={count}
                max={Math.max(published, count, 1)}
                label={
                  published >= count
                    ? `${DIFFICULTY_WORD[d]} problems solved: ${count} of ${published}`
                    : `${DIFFICULTY_WORD[d]} problems solved: ${count}`
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Languages used for first solves, most used first. */
export function LanguageSplit({ languages }: { languages: readonly LanguageShare[] }) {
  const total = languages.reduce((sum, l) => sum + l.count, 0);
  if (total === 0) {
    return <p className="text-sm text-text-secondary">Your languages appear here after your first accepted solution.</p>;
  }
  return (
    <ul className="space-y-3">
      {languages.map((l) => (
        <li key={l.key}>
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="font-medium text-text">{l.label}</span>
            <span className="tabular-nums text-text-secondary">
              {l.count} {pluralize(l.count, "solve")} · {percent(l.count, total)}%
            </span>
          </div>
          <ProgressBar
            className="mt-1.5"
            size="sm"
            value={l.count}
            max={total}
            label={`${l.label}: ${l.count} of ${total} solves`}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * The honest mirror: solves after a tier-3 hint or the editorial count as
 * solved but are kept apart from unassisted ones (they pay 40 % XP and do
 * not feed readiness).
 */
export function AssistedSplit({ assisted, unassisted }: { assisted: number; unassisted: number }) {
  const total = assisted + unassisted;
  if (total === 0) {
    return <p className="text-sm text-text-secondary">Nothing solved yet — this fills in with your first accepted solution.</p>;
  }
  return (
    <div>
      <dl className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border p-3">
          <dt className="text-xs text-text-secondary">On your own</dt>
          <dd className="font-display text-2xl font-bold tabular-nums">
            {unassisted}
            <span className="ml-1.5 text-xs font-medium text-muted">{percent(unassisted, total)}%</span>
          </dd>
        </div>
        <div className="rounded-xl border border-dashed border-border-strong p-3">
          <dt className="text-xs text-text-secondary">After a hint 3 or the editorial</dt>
          <dd className="font-display text-2xl font-bold tabular-nums">
            {assisted}
            <span className="ml-1.5 text-xs font-medium text-muted">{percent(assisted, total)}%</span>
          </dd>
        </div>
      </dl>
      <ProgressBar
        className="mt-3"
        size="sm"
        value={unassisted}
        max={total}
        label={`Solved on your own: ${unassisted} of ${total}`}
      />
      <p className="mt-2 text-xs text-text-secondary">
        Assisted solves still count as solved. They earn 40% XP and are left out of your unassisted skill radar.
      </p>
    </div>
  );
}

export function formatSolveTime(seconds: number): string {
  if (seconds < 60) return "under a minute";
  return formatDuration(Math.round(seconds / 60));
}

/** Your active time to a first accepted solution against the median of everyone who solved it. */
export function TimeToSolveTable({ rows }: { rows: readonly TimeToSolveRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-text-secondary">
        Solve a problem in the workspace and your time to solve appears here, next to the class median.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[30rem] text-sm">
        <caption className="sr-only">Your time to solve compared with the median of all solvers</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">Problem</th>
            <th scope="col" className="py-2 pr-3 font-medium">Difficulty</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">You</th>
            <th scope="col" className="py-2 text-right font-medium">Median</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.title}-${i}`} className="border-b border-border last:border-b-0">
              <th scope="row" className="py-2 pr-3 text-left font-normal">
                {row.href ? (
                  <Link href={row.href as never} className="font-medium text-text hover:text-primary hover:underline">
                    {row.title}
                  </Link>
                ) : (
                  <span className="font-medium">{row.title}</span>
                )}
                {row.assisted ? <span className="ml-2 text-xs text-muted">(assisted)</span> : null}
              </th>
              <td className="py-2 pr-3">
                <DifficultyBadge difficulty={row.difficulty} />
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatSolveTime(row.yourSeconds)}</td>
              <td className="py-2 text-right tabular-nums text-text-secondary">
                {row.medianSeconds === null
                  ? `Fewer than ${MIN_COHORT_FOR_MEDIAN} solvers`
                  : `${formatSolveTime(row.medianSeconds)} (${row.solvers} ${pluralize(row.solvers, "solver")})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
