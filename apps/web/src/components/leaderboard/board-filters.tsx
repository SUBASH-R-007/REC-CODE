import Link from "next/link";
import { cn } from "@recx/design";
import {
  PERIOD_OPTIONS,
  boardHref,
  scopeLabel,
  type PeriodValue,
  type ScopeFilter,
} from "@/components/leaderboard/model";

const pill =
  "inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-medium whitespace-nowrap transition-colors";
// Text stays text-colour on the subtle fill: white on --primary misses 4.5:1 in the dark palette.
const pillActive = "border-2 border-primary bg-primary-subtle font-semibold text-text";
const pillIdle = "border-border bg-surface text-text-secondary hover:border-primary/40 hover:text-text";

/**
 * Scope and period selectors: plain links (server-rendered, no client JS),
 * the current choice marked with aria-current and a visible fill.
 */
export function BoardFilters({
  scopes,
  current,
  period,
}: {
  scopes: readonly ScopeFilter[];
  current: ScopeFilter;
  period: PeriodValue;
}) {
  return (
    <div className="mt-5 flex flex-col gap-3">
      {scopes.length > 1 ? (
        <nav aria-label="Leaderboard scope">
          <ul className="flex flex-wrap gap-2">
            {scopes.map((filter) => {
              const active = filter.scope === current.scope;
              const label = scopeLabel(filter);
              return (
                <li key={filter.scope}>
                  <Link
                    href={boardHref(filter, period) as never}
                    aria-current={active ? "page" : undefined}
                    className={cn(pill, active ? pillActive : pillIdle)}
                  >
                    <span>{label.title}</span>
                    <span className={cn("text-xs font-normal", active ? "text-text-secondary" : "text-muted")}>
                      {label.detail}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}

      <nav aria-label="Time period">
        <ul className="flex flex-wrap gap-2">
          {PERIOD_OPTIONS.map((option) => {
            const active = option.value === period;
            return (
              <li key={option.value}>
                <Link
                  href={boardHref(current, option.value) as never}
                  aria-current={active ? "page" : undefined}
                  className={cn(pill, active ? pillActive : pillIdle)}
                >
                  {option.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
