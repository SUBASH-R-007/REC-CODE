import type { CohortFilter } from "@/server/queries/placement-cohort";

/**
 * The cohort filter, read from the URL (Phase 9e).
 *
 * Pure and total: anything it cannot read becomes "no filter" rather than an
 * error. A dashboard that 400'd on a stale bookmark would be a dashboard
 * people stop bookmarking.
 *
 * "—" is the value the filter uses for a null department or section, because
 * those are real groups and dropping them would make the filter's counts
 * disagree with the cohort size. It maps back to an explicit null, so the
 * query filters FOR the group rather than ignoring the choice.
 */

export const NO_GROUP = "—";

const one = (value: string | string[] | undefined): string | null => {
  const text = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed.length > 0 && trimmed.length <= 32 ? trimmed : null;
};

export function parseCohortFilter(params: Record<string, string | string[] | undefined>): CohortFilter {
  const dept = one(params.dept);
  const batch = one(params.batch);
  const section = one(params.section);
  const year = batch === null ? null : Number.parseInt(batch, 10);
  return {
    departmentCode: dept === NO_GROUP ? null : dept,
    // A batch is four digits or it is not a batch. `parseInt("2027junk")`
    // would otherwise silently become 2027.
    batchYear: year !== null && /^\d{4}$/.test(batch ?? "") && Number.isFinite(year) ? year : null,
    section: section === NO_GROUP ? null : section,
  };
}

/** The filter as words, for a page heading and an export's own record. */
export function describeCohort(filter: CohortFilter): string {
  const parts = [
    filter.departmentCode ? filter.departmentCode : null,
    filter.batchYear ? `batch ${filter.batchYear}` : null,
    filter.section ? `section ${filter.section}` : null,
  ].filter(Boolean);
  return parts.length === 0 ? "the whole college" : parts.join(", ");
}

/**
 * How many students the unfiltered cohort holds, from the filter's own
 * options.
 *
 * Every option carries its count and every student falls in exactly one
 * department group (including the "no department recorded" group), so the
 * departments sum to the cohort. Derived rather than passed separately
 * because the first version of these pages passed whatever each page happened
 * to have — a section count on one, a run total on another — and the filter
 * read "All (1)" on a page showing six students.
 */
export function cohortSize(options: { readonly departments: readonly { readonly count: number }[] }): number {
  return options.departments.reduce((sum, option) => sum + option.count, 0);
}
