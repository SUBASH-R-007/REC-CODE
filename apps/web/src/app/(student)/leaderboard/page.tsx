import type { Metadata } from "next";
import Link from "next/link";
import { Trophy } from "lucide-react";
import { EmptyState } from "@recx/design";
import { requireUser } from "@/lib/auth/guards";
import { BoardFilters } from "@/components/leaderboard/board-filters";
import { BoardList } from "@/components/leaderboard/board-list";
import { FullBoard } from "@/components/leaderboard/full-board";
import { StandingCard } from "@/components/leaderboard/standing-card";
import { availableScopes, boardHref, parseBoardQuery, scopeLabel } from "@/components/leaderboard/model";
import { getLeaderboard } from "@/server/queries/leaderboard";

export const metadata: Metadata = { title: "Leaderboard" };

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const cohort = { batchYear: user.batchYear, departmentCode: user.departmentCode, section: user.section };
  const query = parseBoardQuery(await searchParams, cohort);
  const view = await getLeaderboard(user, query);

  const scope = scopeLabel(query.filter);
  const boardName = `${scope.title} board · ${scope.detail} · ${query.period.label}`;
  const empty = view.segments.length === 0;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">Leaderboard</h1>
      <p className="mt-1 text-sm text-text-secondary">
        XP earned on REC Code. Only first names and last initials are shown. Equal XP is ranked by who reached it
        first.
      </p>

      <BoardFilters scopes={availableScopes(cohort)} current={query.filter} period={query.period.value} />

      <StandingCard standing={view.standing} boardName={boardName} periodLabel={query.period.label} />

      <section aria-labelledby="board-heading" className="mt-6">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <h2 id="board-heading" className="font-display text-lg font-semibold tracking-tight">
            {query.full ? "Full board" : "Top 10"}
            <span className="ml-2 text-sm font-normal text-text-secondary">{boardName}</span>
          </h2>
          {empty ? null : query.full ? (
            <Link
              href={boardHref(query.filter, query.period.value) as never}
              className="inline-flex min-h-10 items-center text-sm font-medium text-text underline decoration-primary decoration-2 underline-offset-4 hover:decoration-text"
            >
              Back to the top 10
            </Link>
          ) : (
            <Link
              href={boardHref(query.filter, query.period.value, true) as never}
              className="inline-flex min-h-10 items-center text-sm font-medium text-text underline decoration-primary decoration-2 underline-offset-4 hover:decoration-text"
            >
              View full board ({view.standing.total.toLocaleString("en-IN")})
            </Link>
          )}
        </div>

        {empty ? (
          <div className="rounded-2xl border border-border bg-surface shadow-card">
            <EmptyState
              compact
              icon={<Trophy className="h-5 w-5" aria-hidden />}
              title="Nobody is on this board yet"
              description="XP from solving problems shows up here. The first solve puts you on top."
            />
          </div>
        ) : query.full && view.full ? (
          <FullBoard rows={view.full} label={boardName} />
        ) : (
          <BoardList segments={view.segments} />
        )}

        <p className="mt-3 text-xs text-muted">
          {view.source === "snapshot"
            ? "Last week's board was frozen when the week closed (top 200). "
            : null}
          Weeks run Monday to Sunday, India time. Students who hide themselves from leaderboards are not listed.
        </p>
      </section>
    </div>
  );
}
