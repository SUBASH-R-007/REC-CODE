"use client";

import { useEffect, useRef } from "react";
import { Check, Circle, Flag, FlagOff } from "lucide-react";

/**
 * The question palette (Phase 7e).
 *
 * `docs/ACCESSIBILITY.md`: a `role="group"` of buttons with a ROVING
 * TABINDEX and Arrow-key navigation, four states each with a distinct
 * SHAPE plus ICON plus a full `aria-label`, a text-and-icon legend and a
 * counts row. Never colour alone — and the icons are the reason: a student
 * with a colour-vision difference, or on a washed-out phone screen in
 * sunlight, has to be able to tell "answered" from "not answered" at a
 * glance.
 *
 * Arrow keys CLAMP rather than wrap. One extra keypress at the last question
 * must not jump to the first; that is how somebody loses their place in a
 * timed paper.
 */

export type PaletteState = "answered" | "unanswered" | "marked" | "answered-marked" | "locked";

export interface PaletteEntry {
  readonly index: number;
  readonly state: PaletteState;
  readonly reachable: boolean;
}

const APPEARANCE: Record<
  PaletteState,
  { label: string; className: string; icon: typeof Check | null }
> = {
  // Shape: a filled square. Icon: a tick.
  answered: { label: "answered", className: "rounded-md bg-success-subtle text-success border-success/40", icon: Check },
  // Shape: a circle. Icon: an outline.
  unanswered: { label: "not answered", className: "rounded-full bg-surface text-text-secondary border-border", icon: Circle },
  // Shape: a square with a cut corner. Icon: a flag.
  marked: { label: "marked for review", className: "rounded-md rounded-tr-none bg-warning-subtle text-warning border-warning/40", icon: Flag },
  "answered-marked": {
    label: "answered and marked for review",
    className: "rounded-md rounded-tr-none bg-info-subtle text-info border-info/40",
    icon: FlagOff,
  },
  locked: { label: "not reachable in this section", className: "rounded-md bg-elevated text-muted border-border", icon: null },
};

export function MockPalette({
  entries,
  current,
  onGo,
}: {
  entries: readonly PaletteEntry[];
  current: number;
  onGo: (index: number) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    refs.current = refs.current.slice(0, entries.length);
  }, [entries.length]);

  const counts = {
    answered: entries.filter((e) => e.state === "answered" || e.state === "answered-marked").length,
    unanswered: entries.filter((e) => e.state === "unanswered").length,
    marked: entries.filter((e) => e.state === "marked" || e.state === "answered-marked").length,
  };

  const move = (from: number, delta: number) => {
    const reachable = entries.filter((entry) => entry.reachable).map((entry) => entry.index);
    if (reachable.length === 0) return;
    const at = reachable.indexOf(from);
    // Clamp, never wrap.
    const next = reachable[Math.min(Math.max(0, (at === -1 ? 0 : at) + delta), reachable.length - 1)]!;
    onGo(next);
    refs.current[next]?.focus();
  };

  return (
    <div className="space-y-3">
      <div role="group" aria-label="Questions in this section" className="flex flex-wrap gap-1.5">
        {entries.map((entry) => {
          const look = APPEARANCE[entry.state];
          const Icon = look.icon;
          const isCurrent = entry.index === current;
          return (
            <button
              key={entry.index}
              ref={(node) => {
                refs.current[entry.index] = node;
              }}
              type="button"
              // Roving tabindex: one stop for the whole group.
              tabIndex={isCurrent ? 0 : -1}
              aria-current={isCurrent ? "true" : undefined}
              disabled={!entry.reachable}
              onClick={() => onGo(entry.index)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  move(entry.index, 1);
                } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  event.preventDefault();
                  move(entry.index, -1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  move(entry.index, -entries.length);
                } else if (event.key === "End") {
                  event.preventDefault();
                  move(entry.index, entries.length);
                }
              }}
              aria-label={`Question ${entry.index + 1}, ${look.label}`}
              className={`relative flex h-10 w-10 items-center justify-center border text-sm font-medium disabled:cursor-not-allowed ${look.className} ${
                isCurrent ? "ring-2 ring-ring ring-offset-1" : ""
              }`}
            >
              <span>{entry.index + 1}</span>
              {Icon ? <Icon className="absolute right-0.5 top-0.5 h-2.5 w-2.5" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
        <div>
          <dt className="inline">Answered: </dt>
          <dd className="inline font-medium">{counts.answered}</dd>
        </div>
        <div>
          <dt className="inline">Not answered: </dt>
          <dd className="inline font-medium">{counts.unanswered}</dd>
        </div>
        <div>
          <dt className="inline">Marked: </dt>
          <dd className="inline font-medium">{counts.marked}</dd>
        </div>
      </dl>

      {/* A legend in TEXT and icon, because the states are the thing a
          candidate has to read at a glance under time pressure. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {(["answered", "unanswered", "marked", "answered-marked"] as const).map((state) => {
          const look = APPEARANCE[state];
          const Icon = look.icon;
          return (
            <li key={state} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={`flex h-4 w-4 items-center justify-center border ${look.className}`}
              >
                {Icon ? <Icon className="h-2.5 w-2.5" /> : null}
              </span>
              <span>{look.label}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
