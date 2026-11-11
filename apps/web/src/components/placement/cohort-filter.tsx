import Link from "next/link";
import type { CohortOption } from "@/server/queries/placement-cohort";

/**
 * The cohort filter (Phase 9e).
 *
 * Plain links, no JavaScript: the filter is three choices and a URL, so it
 * works signed in on a slow connection, it is bookmarkable, and the back
 * button does what a reader expects. A select-and-submit would need client
 * code to do less.
 *
 * Every option carries its own count, which is what makes the filter honest:
 * "CSE (812)" tells an officer the chart they are about to read is over 812
 * students, before they read it.
 */
export function CohortFilter({
  basePath,
  current,
  options,
  total,
}: {
  basePath: string;
  current: { departmentCode?: string | null; batchYear?: number | null; section?: string | null };
  options: {
    readonly departments: readonly CohortOption[];
    readonly batches: readonly CohortOption[];
    readonly sections: readonly CohortOption[];
  };
  total: number;
}) {
  const href = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = {
      dept: current.departmentCode ?? undefined,
      batch: current.batchYear ? String(current.batchYear) : undefined,
      section: current.section ?? undefined,
      ...patch,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value);
    }
    const query = params.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  const row = (
    label: string,
    key: "dept" | "batch" | "section",
    selected: string | null,
    rows: readonly CohortOption[],
  ) => (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{label}</span>
      <Link
        href={href({ [key]: undefined }) as never}
        aria-current={selected === null ? "true" : undefined}
        className={selected === null ? "text-sm font-semibold underline" : "text-sm text-primary underline"}
      >
        All ({total})
      </Link>
      {rows.map((option) => (
        <Link
          key={option.value}
          href={href({ [key]: option.value }) as never}
          aria-current={selected === option.value ? "true" : undefined}
          className={
            selected === option.value ? "text-sm font-semibold underline" : "text-sm text-primary underline"
          }
        >
          {option.value} ({option.count})
        </Link>
      ))}
    </div>
  );

  return (
    <nav aria-label="Cohort filter" className="space-y-2 rounded-xl border border-border p-4">
      {row("Department", "dept", current.departmentCode ?? null, options.departments)}
      {row("Batch", "batch", current.batchYear ? String(current.batchYear) : null, options.batches)}
      {row("Section", "section", current.section ?? null, options.sections)}
    </nav>
  );
}
