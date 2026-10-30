import type { Metadata } from "next";
import { Card, EmptyState, ButtonLink } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { listCatalog, listCatalogCompanies } from "@/server/queries/problems";
import { companyTagLabel } from "@/server/queries/interviews";
import {
  CATALOG_PAGE_SIZE,
  CATALOG_PATH,
  CATALOG_RESULTS_ID,
  describeFilters,
  emptyStateCopy,
  hasActiveFilters,
  parseCatalogFilters,
  type CatalogFilters,
  type RawSearchParams,
} from "@/components/problems/catalog-filters";
import { CatalogFilterForm } from "@/components/problems/catalog-filter-form";
import { CatalogPagination } from "@/components/problems/catalog-pagination";
import { CatalogTable } from "@/components/problems/catalog-table";

export const metadata: Metadata = { title: "Problems" };

type Props = { searchParams: Promise<RawSearchParams> };

export default async function ProblemsPage({ searchParams }: Props) {
  const user = await requireUser();
  const parsed = parseCatalogFilters(await searchParams);

  const companies = await listCatalogCompanies();
  const company = parsed.company ? companies.find((c) => c.slug === parsed.company) : undefined;
  // An unknown or uncurated company slug is ignored, not an error.
  const filters: CatalogFilters = { ...parsed, company: company?.slug ?? null };

  const result = await listCatalog(user.id, { ...filters, companyId: company?.id ?? null });
  /**
   * SPEC §11 requires placement-cell curation to be "explicitly labelled
   * as curated". A curated company track is somebody's best guess at what
   * a company asks; an EXPERIENCE one is a count of what students actually
   * reported in the archive. A student choosing what to revise the night
   * before a drive is entitled to know which one they are looking at.
   */
  const provenance = company ? await companyTagLabel(company.slug) : null;
  const shown: CatalogFilters = { ...filters, page: result.page };
  const labels = { companyName: company?.name ?? null };

  const first = (result.page - 1) * CATALOG_PAGE_SIZE + 1;
  const last = first + result.rows.length - 1;
  const summary =
    result.total === 0
      ? "No problems found"
      : result.pageCount > 1
        ? `Showing ${first}–${last} of ${result.total} problems`
        : `${result.total} ${result.total === 1 ? "problem" : "problems"}`;
  const empty = emptyStateCopy(filters, labels);

  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">Problems</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Originally authored practice problems. Solve them in the browser and get judged instantly.
      </p>

      <CatalogFilterForm filters={filters} companies={companies} />

      {provenance ? (
        <p className="mt-4 rounded-xl border border-border bg-background p-3 text-sm text-text-secondary">
          <span className="font-medium text-text">{company?.name}: </span>
          {provenance.notice}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id={CATALOG_RESULTS_ID}
          tabIndex={-1}
          className="scroll-mt-20 font-display text-base font-semibold tracking-tight"
        >
          Results
        </h2>
        {/* Announced after a filter change (same element, new text); silent on first load. */}
        <p role="status" className="text-sm text-text-secondary">
          {summary}
        </p>
      </div>

      <Card className="mt-3 overflow-hidden">
        {result.rows.length === 0 ? (
          <EmptyState
            title={empty.title}
            description={empty.description}
            action={
              hasActiveFilters(filters) ? (
                <ButtonLink href={CATALOG_PATH} variant="outline">
                  Show all problems
                </ButtonLink>
              ) : undefined
            }
          />
        ) : (
          <CatalogTable
            rows={result.rows}
            caption={`${hasActiveFilters(filters) ? `Published ${describeFilters(filters, labels)}` : "Published problems"}, page ${result.page} of ${result.pageCount}`}
          />
        )}
      </Card>

      <CatalogPagination filters={shown} page={result.page} pageCount={result.pageCount} />
    </div>
  );
}
