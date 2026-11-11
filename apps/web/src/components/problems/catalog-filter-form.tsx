import Form from "next/form";
import { TriangleAlert } from "lucide-react";
import { TOPICS, TOPIC_LABEL } from "@recx/shared";
import { Button, ButtonLink, DifficultyBadge, Label, Select, Input } from "@recx/design";
import {
  CATALOG_DIFFICULTIES,
  CATALOG_PATH,
  CATALOG_SORTS,
  CATALOG_SORT_LABEL,
  CATALOG_STATUSES,
  CATALOG_STATUS_LABEL,
  SEARCH_MAX_LENGTH,
  SEARCH_MIN_LENGTH,
  hasActiveFilters,
  searchTooShort,
  type CatalogFilters,
} from "@/components/problems/catalog-filters";
import type { CatalogCompany } from "@/server/queries/problems";

/**
 * The catalogue's filter bar: a plain GET form, so it works with JavaScript
 * off (full page load) and, with it on, next/form turns the submit into a
 * client-side navigation that keeps focus on the Apply button. Filters apply
 * on Apply / Enter only — never on change, which would navigate under a
 * keyboard user arrowing through a select (WCAG 3.2.2).
 */
export function CatalogFilterForm({
  filters,
  companies,
}: {
  filters: CatalogFilters;
  companies: readonly CatalogCompany[];
}) {
  const tooShort = searchTooShort(filters.q);
  const clearable = hasActiveFilters(filters) || filters.sort !== "code";

  return (
    <Form
      action={CATALOG_PATH}
      role="search"
      aria-label="Filter problems"
      className="mt-6 rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <div className="sm:col-span-2 lg:col-span-1">
          <Label htmlFor="catalog-q">Search titles</Label>
          <Input
            id="catalog-q"
            type="search"
            name="q"
            defaultValue={filters.q}
            maxLength={SEARCH_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="catalog-q-hint"
            className="h-11"
          />
          {tooShort ? (
            <p id="catalog-q-hint" className="mt-1 flex items-center gap-1 text-xs text-warning">
              <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0" />
              Search needs a word of at least {SEARCH_MIN_LENGTH} characters, so all titles are shown.
            </p>
          ) : (
            <p id="catalog-q-hint" className="mt-1 text-xs text-muted">
              Words of {SEARCH_MIN_LENGTH} or more characters, in any order.
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="catalog-topic">Topic</Label>
          <Select id="catalog-topic" name="topic" defaultValue={filters.topic ?? ""} className="h-11">
            <option value="">All topics</option>
            {TOPICS.map((topic) => (
              <option key={topic} value={topic}>
                {TOPIC_LABEL[topic]}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="catalog-status">Status</Label>
          <Select id="catalog-status" name="status" defaultValue={filters.status} className="h-11">
            {CATALOG_STATUSES.map((status) => (
              <option key={status} value={status}>
                {CATALOG_STATUS_LABEL[status]}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="catalog-sort">Sort by</Label>
          <Select id="catalog-sort" name="sort" defaultValue={filters.sort} className="h-11">
            {CATALOG_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {CATALOG_SORT_LABEL[sort]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-4">
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-text">Difficulty</legend>
          <div className="flex flex-wrap gap-2">
            {CATALOG_DIFFICULTIES.map((difficulty) => (
              <label
                key={difficulty}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-border-strong bg-surface px-3 transition-colors hover:bg-primary-subtle has-[:checked]:border-primary has-[:checked]:bg-primary-subtle"
              >
                <input
                  type="checkbox"
                  name="difficulty"
                  value={difficulty}
                  defaultChecked={filters.difficulties.includes(difficulty)}
                  className="h-4 w-4 accent-primary"
                />
                <DifficultyBadge difficulty={difficulty} />
              </label>
            ))}
          </div>
        </fieldset>

        {companies.length > 0 ? (
          <div className="min-w-48">
            <Label htmlFor="catalog-company">Company</Label>
            <Select
              id="catalog-company"
              name="company"
              defaultValue={filters.company ?? ""}
              aria-describedby="catalog-company-note"
              className="h-11"
            >
              <option value="">All companies</option>
              {companies.map((company) => (
                <option key={company.id} value={company.slug}>
                  {company.name}
                </option>
              ))}
            </Select>
            <p id="catalog-company-note" className="mt-1 text-xs text-muted">
              Curated by the placement cell
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <Button type="submit" className="h-11">
            Apply filters
          </Button>
          {clearable ? (
            <ButtonLink href={CATALOG_PATH} variant="ghost" className="h-11">
              Clear filters
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </Form>
  );
}
