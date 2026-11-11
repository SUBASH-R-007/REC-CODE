"use client";

import { useEffect, useState } from "react";
import { formatClock } from "./model";

/**
 * The contest clock.
 *
 * The END is server-rendered as an absolute instant and the countdown is
 * derived from it, so a student with a wrong system clock sees a wrong
 * countdown but never a wrong deadline — and nothing here is authoritative:
 * whether a submission counts is decided server-side against the contest
 * window (lib/contests/attempt.ts). Phase 6's assessment clock goes further
 * and re-syncs against the server; a contest does not need that, because a
 * late submission is simply not scored.
 *
 * It announces politely at the two points that matter rather than every
 * second, which would make a screen reader unusable.
 */
export function ArenaClock({ endsAtIso }: { endsAtIso: string }) {
  const endsAt = new Date(endsAtIso).getTime();
  const [remaining, setRemaining] = useState(() => endsAt - Date.now());

  useEffect(() => {
    const tick = () => setRemaining(endsAt - Date.now());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [endsAt]);

  const over = remaining <= 0;
  const lastFiveMinutes = !over && remaining <= 5 * 60_000;

  return (
    <div className="flex items-center gap-3">
      <span
        className={
          lastFiveMinutes
            ? "font-mono text-lg font-semibold tabular-nums text-danger"
            : "font-mono text-lg font-semibold tabular-nums text-text"
        }
      >
        <span className="sr-only">Time remaining: </span>
        {formatClock(remaining)}
      </span>
      {/* Only the states worth interrupting for. */}
      <span aria-live="polite" className="sr-only">
        {over ? "The contest has ended." : lastFiveMinutes ? "Five minutes remaining." : ""}
      </span>
    </div>
  );
}
