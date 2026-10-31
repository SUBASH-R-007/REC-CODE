import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@recx/design";
import { CATALOG_RESULTS_ID, catalogHref, pageWindow, type CatalogFilters } from "@/components/problems/catalog-filters";

const ITEM = "inline-flex h-11 min-w-11 items-center justify-center gap-1 rounded-xl px-3 text-sm font-medium";

/**
 * Server-side pagination as plain links (works without JavaScript). Each
 * link targets the results heading, so after a page change the browser —
 * or Next's router — scrolls to and focuses the top of the new page instead
 * of leaving focus at the bottom of the old one. The current page is marked
 * with aria-current; Previous / Next are omitted at the ends rather than
 * rendered as dead controls.
 */
export function CatalogPagination({
  filters,
  page,
  pageCount,
}: {
  filters: CatalogFilters;
  page: number;
  pageCount: number;
}) {
  if (pageCount <= 1) return null;
  const href = (p: number) => catalogHref(filters, { page: p }, CATALOG_RESULTS_ID);

  return (
    <nav aria-label="Pagination" className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
      <p className="text-sm text-text-secondary">
        Page {page} of {pageCount}
      </p>
      <ul className="flex flex-wrap items-center justify-center gap-1">
        {page > 1 ? (
          <li>
            <Link href={href(page - 1)} rel="prev" className={cn(ITEM, "text-text-secondary hover:bg-primary-subtle hover:text-text")}>
              <ChevronLeft aria-hidden className="h-4 w-4" />
              Previous
            </Link>
          </li>
        ) : null}
        {pageWindow(page, pageCount).map((p, i) =>
          p === null ? (
            <li key={`gap-${i}`} aria-hidden className="px-1 text-muted">
              …
            </li>
          ) : (
            <li key={p}>
              <Link
                href={href(p)}
                aria-current={p === page ? "page" : undefined}
                aria-label={`Page ${p}`}
                className={cn(
                  ITEM,
                  p === page
                    ? "bg-primary text-primary-fg"
                    : "text-text-secondary hover:bg-primary-subtle hover:text-text",
                )}
              >
                {p}
              </Link>
            </li>
          ),
        )}
        {page < pageCount ? (
          <li>
            <Link href={href(page + 1)} rel="next" className={cn(ITEM, "text-text-secondary hover:bg-primary-subtle hover:text-text")}>
              Next
              <ChevronRight aria-hidden className="h-4 w-4" />
            </Link>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
