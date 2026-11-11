import type { Metadata } from "next";
import Link from "next/link";
import { Bookmark } from "lucide-react";
import { z } from "zod";
import { ButtonLink, Card, DifficultyBadge, EmptyState, SolveStatus, type SolveState } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { BookmarkButton } from "@/components/problems/bookmark-button";
import { absoluteTime, relativeTime } from "@/components/problems/relative-time";

export const metadata: Metadata = { title: "Bookmarks" };

const PAGE_SIZE = 50;

/** `?after=<problem id>`: the last row of the previous page. */
const afterSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

type SearchParams = Promise<{ after?: string | string[] }>;

/**
 * The viewer's bookmarked problems (published ones only), newest first, 50
 * per page. Toggling lives on the BookmarkButton (owned by the catalog);
 * un-bookmarking here keeps the row until the next visit, so a mis-click can
 * be undone in place.
 */
export default async function BookmarksPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireUser();
  const rawAfter = (await searchParams).after;
  const after = afterSchema.safeParse(Array.isArray(rawAfter) ? rawAfter[0] : rawAfter);

  const cursor = after.success
    ? await db.bookmark.findUnique({
        where: { userId_problemId: { userId: user.id, problemId: after.data } },
        select: { problemId: true },
      })
    : null;

  const rows = await db.bookmark.findMany({
    where: { userId: user.id, problem: { status: "PUBLISHED", liveVersionId: { not: null } } },
    orderBy: [{ createdAt: "desc" }, { problemId: "desc" }],
    take: PAGE_SIZE + 1,
    ...(cursor ? { cursor: { userId_problemId: { userId: user.id, problemId: cursor.problemId } }, skip: 1 } : {}),
    select: {
      createdAt: true,
      problem: {
        select: {
          id: true,
          slug: true,
          displayCode: true,
          title: true,
          difficulty: true,
          statuses: { where: { userId: user.id }, select: { status: true } },
        },
      },
    },
  });
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  const now = new Date();

  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">Bookmarks</h1>
      <p className="mt-1 text-sm text-text-secondary">
        Problems you saved for later. Use a row&apos;s bookmark button to remove it.
      </p>

      <h2 className="sr-only">Saved problems</h2>
      {page.length === 0 ? (
        <EmptyState
          icon={<Bookmark className="h-6 w-6" />}
          title={cursor ? "No more bookmarks" : "No bookmarks yet"}
          description="Bookmark a problem from the problem list or the workspace and it will wait for you here."
          action={
            <ButtonLink href={cursor ? "/bookmarks" : "/problems"} variant="outline">
              {cursor ? "Back to the newest" : "Browse problems"}
            </ButtonLink>
          }
        />
      ) : (
        <Card className="mt-6 overflow-hidden">
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Bookmarked problems (scrolls sideways)">
            <table className="w-full text-sm">
              <caption className="sr-only">Your bookmarked problems, most recently saved first</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-secondary">
                  <th scope="col" className="w-28 px-5 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Problem
                  </th>
                  <th scope="col" className="px-3 py-3 font-medium">
                    Difficulty
                  </th>
                  <th scope="col" className="hidden px-3 py-3 font-medium sm:table-cell">
                    Saved
                  </th>
                  <th scope="col" className="w-16 px-5 py-3 font-medium">
                    <span className="sr-only">Bookmark</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.map(({ problem, createdAt }) => {
                  const state = problem.statuses[0]?.status;
                  const solve: SolveState = state === "SOLVED" ? "solved" : state === "ATTEMPTED" ? "attempted" : null;
                  return (
                    <tr key={problem.id} className="border-t border-border first:border-t-0">
                      <td className="px-5 py-2">
                        {solve ? <SolveStatus status={solve} /> : <span className="sr-only">Not attempted</span>}
                      </td>
                      <td className="px-3 py-2">
                        <span className="mr-2 font-mono text-xs text-text-secondary">{problem.displayCode}</span>
                        <Link
                          href={`/problems/${problem.slug}`}
                          className="font-medium text-text hover:text-primary hover:underline"
                        >
                          {problem.title}
                        </Link>
                      </td>
                      <td className="px-3 py-2">
                        <DifficultyBadge difficulty={problem.difficulty} />
                      </td>
                      <td className="hidden px-3 py-2 whitespace-nowrap text-text-secondary sm:table-cell">
                        <time dateTime={createdAt.toISOString()} title={absoluteTime(createdAt)}>
                          {relativeTime(createdAt, now)}
                        </time>
                      </td>
                      <td className="px-5 py-1 text-right">
                        <BookmarkButton problemId={problem.id} bookmarked label={problem.title} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {page.length > 0 && (hasMore || cursor) && (
        <nav aria-label="Bookmark pages" className="mt-4 flex flex-wrap justify-between gap-3">
          {cursor ? (
            <ButtonLink href="/bookmarks" variant="ghost">
              Newest
            </ButtonLink>
          ) : (
            <span />
          )}
          {hasMore && last && (
            <ButtonLink href={`/bookmarks?after=${encodeURIComponent(last.problem.id)}`} variant="outline">
              More bookmarks
            </ButtonLink>
          )}
        </nav>
      )}
    </div>
  );
}
