import Link from "next/link";
import { DifficultyBadge, SolveStatus } from "@recx/design";
import { BookmarkButton } from "@/components/problems/bookmark-button";
import { ProblemKindChip } from "@/components/problems/kind-chip";
import { TopicChips } from "@/components/problems/topic-chips";
import { acceptancePercent } from "@/components/problems/catalog-filters";
import type { CatalogRow } from "@/server/queries/problems";

/**
 * One page of the catalogue (at most CATALOG_PAGE_SIZE rows, so no
 * virtualisation is needed). Server-rendered; the bookmark toggle is the
 * only client island. Narrow screens drop the code, topic and acceptance
 * columns and show the solve status under the title instead, so the table
 * reflows to 320 px.
 *
 * The kind chip (Phase 12p) sits beside the title rather than in a column
 * of its own, so it survives that reflow: on a phone the thing a student
 * most needs to know about a row is that it is not an ordinary program.
 */
export function CatalogTable({ rows, caption }: { rows: readonly CatalogRow[]; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="hidden w-32 px-5 py-3 font-medium sm:table-cell">
              Status
            </th>
            <th scope="col" className="hidden px-3 py-3 font-medium sm:table-cell">
              Code
            </th>
            <th scope="col" className="px-4 py-3 font-medium sm:px-3">
              Title
            </th>
            <th scope="col" className="hidden px-3 py-3 font-medium lg:table-cell">
              Topics
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              Difficulty
            </th>
            <th scope="col" className="hidden px-3 py-3 text-right font-medium md:table-cell">
              Acceptance
            </th>
            <th scope="col" className="w-14 px-3 py-3 font-medium">
              <span className="sr-only">Bookmark</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const acceptance = acceptancePercent(p.accepted, p.submissions);
            return (
              <tr
                key={p.id}
                className="border-t border-border transition-colors first:border-t-0 hover:bg-primary-subtle/40"
              >
                <td className="hidden px-5 py-2 sm:table-cell">
                  {p.solve ? <SolveStatus status={p.solve} /> : <span className="sr-only">Not attempted</span>}
                </td>
                <td className="hidden px-3 py-2 font-mono text-xs whitespace-nowrap text-text-secondary sm:table-cell">
                  {p.displayCode}
                </td>
                <td className="px-4 py-2 sm:px-3">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      href={`/problems/${p.slug}`}
                      className="inline-flex min-h-8 items-center font-medium text-text hover:text-primary hover:underline focus-visible:text-primary"
                    >
                      {p.title}
                    </Link>
                    <ProblemKindChip kind={p.kind} />
                  </span>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 sm:hidden">
                    <span className="font-mono text-xs text-text-secondary">{p.displayCode}</span>
                    <SolveStatus status={p.solve} className="text-xs" />
                  </div>
                </td>
                <td className="hidden px-3 py-2 lg:table-cell">
                  <TopicChips topics={p.topics} />
                </td>
                <td className="px-3 py-2">
                  <DifficultyBadge difficulty={p.difficulty} />
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums text-text-secondary md:table-cell">
                  {acceptance ?? (
                    <>
                      <span aria-hidden>—</span>
                      <span className="sr-only">No submissions yet</span>
                    </>
                  )}
                </td>
                <td className="px-3 py-1">
                  <BookmarkButton problemId={p.id} bookmarked={p.bookmarked} label={p.title} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
