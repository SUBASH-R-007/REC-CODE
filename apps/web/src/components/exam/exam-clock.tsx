"use client";

import { useEffect, useRef, useState } from "react";
import {
  announcementText,
  clockLabel,
  dueAnnouncement,
  formatClock,
  interpolateRemaining,
  timerTone,
  type TimerAnnouncementSecond,
} from "@recx/shared";

/**
 * The exam clock (Phase 6c).
 *
 * SPEC §5: "HH:MM:SS in tabular-nums at 18px; text-warning pill in the last
 * 5 minutes, text-danger in the last 60 seconds; aria-live='assertive'
 * announcements at exactly 10:00, 5:00, 1:00 and 0:10 and at no other time —
 * a chatty live region makes a screen reader unusable. Never role='timer'
 * with a per-second region."
 *
 * Two structural decisions follow from that last sentence:
 *
 *   1. The digits are in an `aria-hidden` element. They change every second,
 *      and a screen reader must not be told. The accessible reading of the
 *      clock is a separate, `aria-hidden={false}` label that is NOT a live
 *      region — a user can read it on demand by navigating to it.
 *   2. The live region contains ONLY an announcement, and only for the
 *      moment it is due. It is empty the rest of the time, which is why
 *      nothing is announced at any other second.
 *
 * The number itself is the server's. `msRemaining` comes from the heartbeat;
 * between beats the local clock may only subtract (`interpolateRemaining`),
 * so a machine whose clock is wrong or jumps cannot grant its owner time.
 */
export function ExamClock({
  serverMsRemaining,
  receivedAtMs,
  onExpired,
}: {
  /** The last `msRemaining` the heartbeat reported. */
  readonly serverMsRemaining: number;
  /** `performance.now()`-style reading of when that arrived. */
  readonly receivedAtMs: number;
  readonly onExpired?: () => void;
}) {
  const [left, setLeft] = useState(() =>
    interpolateRemaining({ serverMsRemaining, atMs: receivedAtMs, nowMs: receivedAtMs }),
  );
  const [announcement, setAnnouncement] = useState<string>("");
  const previous = useRef(left);
  const expiredFired = useRef(false);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const now = interpolateRemaining({
        serverMsRemaining,
        atMs: receivedAtMs,
        nowMs: typeof performance !== "undefined" ? performance.now() : Date.now(),
      });
      setLeft(now);

      // The whole announcement policy, in one call. Null on almost every
      // tick; the region is cleared so the same text announces again if the
      // same threshold is ever crossed twice (after a granted extension).
      const due: TimerAnnouncementSecond | null = dueAnnouncement(previous.current, now);
      previous.current = now;
      if (due !== null) setAnnouncement(announcementText(due));

      if (now === 0 && !expiredFired.current) {
        expiredFired.current = true;
        onExpired?.();
      }
      frame = window.setTimeout(tick, 250);
    };
    frame = window.setTimeout(tick, 250);
    return () => window.clearTimeout(frame);
  }, [serverMsRemaining, receivedAtMs, onExpired]);

  // A fresh heartbeat re-arms the expiry callback: an invigilator may have
  // granted time, and the attempt is live again.
  useEffect(() => {
    if (serverMsRemaining > 0) expiredFired.current = false;
  }, [serverMsRemaining]);

  const tone = timerTone(left);
  const toneClass =
    tone === "danger"
      ? "text-danger border-danger/40 bg-danger-subtle"
      : tone === "warning"
        ? "text-warning border-warning/40 bg-warning-subtle"
        : "text-text border-border bg-elevated";

  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex items-center rounded-full border px-3 py-1 font-mono text-[18px] leading-none tabular-nums ${toneClass}`}
        // The digits change every second. A screen reader is told at the four
        // moments below instead, via the live region.
        aria-hidden
      >
        {formatClock(left)}
      </span>
      {/*
        The accessible reading of the clock: navigable on demand, and NOT a
        live region, so it is never read out unprompted.
      */}
      <span className="sr-only">{clockLabel(left)}</span>
      {/*
        Assertive, and empty except at 10:00, 5:00, 1:00 and 0:10. The
        emptiness is the feature.
      */}
      <span role="status" aria-live="assertive" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
