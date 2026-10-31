import Link from "next/link";
import { EyeOff, Trophy } from "lucide-react";
import { Avatar, Badge, cn } from "@recx/design";
import type { BoardRow, BoardSegment } from "@/components/leaderboard/model";

const SEGMENT_LABEL: Record<BoardSegment["label"], string> = {
  top: "Top of the board",
  "around-you": "Around your rank",
};

/** "Priya S." → initials for the decorative avatar (the name itself is the text). */
function avatarParts(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  return { firstName: parts[0] ?? name, lastName: parts.length > 1 ? (parts.at(-1) ?? "") : "" };
}

export function formatXp(xp: number): string {
  return xp.toLocaleString("en-IN");
}

/**
 * The compact board: top 10, then (when the viewer is further down) a gap
 * and the viewer's ±2 neighbourhood. At most ~16 rows — never the full list.
 */
export function BoardList({ segments }: { segments: BoardSegment[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      {segments.map((segment, i) => (
        <div key={segment.label}>
          {i > 0 ? (
            <p className="flex items-center gap-3 border-t border-border bg-background/60 px-4 py-1.5 text-xs font-medium text-muted sm:px-5">
              <span aria-hidden className="tracking-[0.3em]">
                ···
              </span>
              {SEGMENT_LABEL[segment.label]}
            </p>
          ) : null}
          <ol aria-label={SEGMENT_LABEL[segment.label]}>
            {segment.rows.map((row) => (
              <BoardListRow key={`${row.rank}-${row.name}-${row.isViewer ? "you" : "peer"}`} row={row} />
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function BoardListRow({ row }: { row: BoardRow }) {
  const podium = row.rank <= 3 && !row.hiddenFromPeers;
  const { firstName, lastName } = avatarParts(row.name);
  return (
    <li
      aria-current={row.isViewer ? "true" : undefined}
      className={cn(
        "relative flex min-h-14 items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0 sm:px-5",
        row.isViewer && "bg-primary-subtle/70",
      )}
    >
      {row.isViewer ? <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-primary" /> : null}
      <span className="flex w-12 shrink-0 items-center gap-1 font-display text-sm font-bold tabular-nums">
        {podium ? <Trophy aria-hidden className="h-4 w-4 text-accent" /> : null}
        <span className="sr-only">Rank </span>
        {row.rank}
      </span>
      <Avatar firstName={firstName} lastName={lastName} size="sm" className="hidden sm:inline-flex" />
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        {row.profileHref ? (
          <Link
            href={row.profileHref as never}
            className="truncate text-sm font-medium text-text hover:text-primary hover:underline"
          >
            {row.name}
          </Link>
        ) : (
          <span className="truncate text-sm font-medium text-text">{row.name}</span>
        )}
        {row.isViewer ? <YouChip /> : null}
        {row.hiddenFromPeers ? (
          <Badge>
            <EyeOff aria-hidden className="h-3 w-3" />
            Only you see this row
          </Badge>
        ) : null}
      </span>
      <span className="hidden shrink-0 text-sm text-text-secondary sm:inline">
        {row.solved} solved
      </span>
      <span className="shrink-0 text-right text-sm font-semibold tabular-nums">
        {formatXp(row.xp)} <span className="text-xs font-medium text-muted">XP</span>
      </span>
    </li>
  );
}

/** "You" in words, with a border — readable in both themes, never colour alone. */
function YouChip() {
  return (
    <span className="inline-flex items-center rounded-full border border-primary bg-surface px-2 py-0.5 text-xs font-semibold text-text">
      You
    </span>
  );
}
