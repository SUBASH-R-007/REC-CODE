"use client";

import { useRef } from "react";
import Link from "next/link";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@recx/design";
import { FULL_ROW_HIDDEN_SELF, FULL_ROW_VIEWER, type FullBoardRow } from "@/components/leaderboard/model";

const ROW_HEIGHT = 52;
const VIEWPORT_HEIGHT = 560;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return `${parts[0]?.charAt(0) ?? ""}${parts.length > 1 ? (parts.at(-1)?.charAt(0) ?? "") : ""}`.toUpperCase();
}

/**
 * Every row of a board, virtualised with @tanstack/react-virtual: only the
 * rows in view (plus a small overscan) are in the DOM, whatever the board's
 * size. The list is a focusable scroll region — arrow keys, Page Up/Down,
 * Home and End scroll it — and each row carries its position in the set
 * (aria-posinset / aria-setsize) so a screen reader hears "14 of 4,812".
 */
export function FullBoard({ rows, label }: { rows: FullBoardRow[]; label: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // Server render (and no-JS) shows the first screenful.
    initialRect: { width: 0, height: VIEWPORT_HEIGHT },
  });
  const viewerIndex = rows.findIndex((r) => (r[5] & FULL_ROW_VIEWER) !== 0);

  function jumpTo(index: number) {
    virtualizer.scrollToIndex(index, { align: index === 0 ? "start" : "center" });
    scrollRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 sm:px-5">
        <p className="mr-auto text-sm text-text-secondary">
          {rows.length.toLocaleString("en-IN")} {rows.length === 1 ? "row" : "rows"}
        </p>
        {viewerIndex >= 0 ? (
          <button
            type="button"
            onClick={() => jumpTo(viewerIndex)}
            className="inline-flex min-h-10 items-center rounded-xl border border-border-strong bg-surface px-3 text-sm font-medium text-text transition-colors hover:bg-primary-subtle"
          >
            Jump to your row
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => jumpTo(0)}
          className="inline-flex min-h-10 items-center rounded-xl border border-border-strong bg-surface px-3 text-sm font-medium text-text transition-colors hover:bg-primary-subtle"
        >
          Back to the top
        </button>
      </div>
      <div
        ref={scrollRef}
        role="region"
        aria-label={`${label}. Use the arrow keys to scroll.`}
        tabIndex={0}
        className="scroll-thin overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ height: `min(70dvh, ${VIEWPORT_HEIGHT}px)` }}
      >
        <ol className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const [rank, name, xp, solved, href, flags] = row;
            const isViewer = (flags & FULL_ROW_VIEWER) !== 0;
            const hiddenSelf = (flags & FULL_ROW_HIDDEN_SELF) !== 0;
            return (
              <li
                key={item.key}
                aria-setsize={rows.length}
                aria-posinset={item.index + 1}
                aria-current={isViewer ? "true" : undefined}
                className={cn(
                  "absolute left-0 top-0 flex w-full items-center gap-3 border-b border-border px-4 sm:px-5",
                  isViewer && "bg-primary-subtle/70",
                )}
                style={{ height: item.size, transform: `translateY(${item.start}px)` }}
              >
                {isViewer ? <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-primary" /> : null}
                <span className="w-14 shrink-0 font-display text-sm font-bold tabular-nums">
                  <span className="sr-only">Rank </span>
                  {rank}
                </span>
                <span
                  aria-hidden
                  className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-xs font-semibold text-text-secondary sm:inline-flex"
                >
                  {initials(name)}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {href ? (
                    <Link href={href as never} prefetch={false} className="truncate text-sm font-medium text-text hover:text-primary hover:underline">
                      {name}
                    </Link>
                  ) : (
                    <span className="truncate text-sm font-medium text-text">{name}</span>
                  )}
                  {isViewer ? (
                    <span className="shrink-0 rounded-full border border-primary bg-surface px-2 py-0.5 text-xs font-semibold text-text">
                      {hiddenSelf ? "You (only you see this row)" : "You"}
                    </span>
                  ) : null}
                </span>
                <span className="hidden shrink-0 text-sm text-text-secondary sm:inline">{solved} solved</span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">
                  {xp.toLocaleString("en-IN")} <span className="text-xs font-medium text-muted">XP</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
