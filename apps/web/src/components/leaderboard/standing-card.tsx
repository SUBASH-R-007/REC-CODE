import Link from "next/link";
import { EyeOff, Medal, Sparkles } from "lucide-react";
import { pluralize } from "@recx/design";
import type { LeaderboardStanding } from "@/server/queries/leaderboard";
import { formatXp } from "@/components/leaderboard/board-list";

/**
 * The viewer's own position on the selected board. An opted-out student
 * still sees it here — privately, and told so in words.
 */
export function StandingCard({
  standing,
  boardName,
  periodLabel,
}: {
  standing: LeaderboardStanding;
  boardName: string;
  periodLabel: string;
}) {
  if (standing.kind === "staff") {
    return (
      <p className="mt-5 rounded-2xl border border-border bg-surface p-4 text-sm text-text-secondary shadow-card">
        Staff accounts are not ranked. This is the board students see.
      </p>
    );
  }

  if (standing.kind === "unranked" || standing.rank === null) {
    return (
      <div className="mt-5 flex items-start gap-3 rounded-2xl border border-border bg-surface p-4 shadow-card">
        <Sparkles aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="text-sm">
          <p className="font-medium text-text">You have no XP on this board for {periodLabel.toLowerCase()} yet.</p>
          <p className="mt-0.5 text-text-secondary">
            Solve a problem to get on the board.{" "}
            <Link href="/problems" className="font-medium text-text underline decoration-primary decoration-2 underline-offset-4 hover:decoration-text">
              Browse problems
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-primary/25 bg-primary-subtle/50 p-4 shadow-card">
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-fg">
          <Medal className="h-5 w-5" />
        </span>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">Your rank</p>
          <p className="font-display text-2xl font-bold tracking-tight tabular-nums">
            #{standing.rank}
            <span className="ml-1.5 text-sm font-medium text-text-secondary">
              of {standing.total} {pluralize(standing.total, "student")}
            </span>
          </p>
        </div>
      </div>
      <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <div>
          <dt className="text-xs text-muted">XP, {periodLabel.toLowerCase()}</dt>
          <dd className="font-semibold tabular-nums">{formatXp(standing.xp)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Problems solved</dt>
          <dd className="font-semibold tabular-nums">{standing.solved}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Next place</dt>
          <dd className="font-semibold">
            {standing.xpToMoveUp === null
              ? "You're at the top"
              : `${formatXp(standing.xpToMoveUp)} XP to move up`}
          </dd>
        </div>
      </dl>
      <p className="w-full text-xs text-text-secondary">{boardName}</p>
      {standing.hidden ? (
        <p className="flex w-full items-start gap-2 text-sm text-text-secondary">
          <EyeOff aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-info" />
          <span>
            You are hidden from your classmates&apos; leaderboards, so only you can see this rank.{" "}
            <Link href="/profile/settings" className="font-medium text-text underline decoration-primary decoration-2 underline-offset-4 hover:decoration-text">
              Change this in settings
            </Link>
          </span>
        </p>
      ) : null}
    </div>
  );
}
