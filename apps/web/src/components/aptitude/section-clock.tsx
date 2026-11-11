"use client";

import { useEffect, useRef, useState } from "react";
import { MOCK_CLOCK_LIMITS, announceAtSeconds, dueSectionAnnouncement } from "@recx/shared";

/**
 * The section clock (Phase 7e).
 *
 * It renders what the SERVER says and never `Date.now()` for anything
 * authoritative: `GET /api/aptitude/attempts/[id]/clock` every five seconds,
 * with the local tick only interpolating between answers. A section deadline
 * ENDS something, so an advisory clock is not an option.
 *
 * It announces at exactly four moments — 10:00, 5:00, 1:00 and 0:10, and only
 * those below the section's own limit — and at no other time. Never
 * `role="timer"` with a per-second live region: that makes a screen reader
 * unusable for the length of a 25-minute section, which is the opposite of
 * an accommodation.
 *
 * A tab the OS froze past several thresholds announces only the MOST urgent
 * one. Reading out a stale "ten minutes remaining" is worse than silence.
 */

function face(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1_000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function spoken(seconds: number): string {
  if (seconds >= 60) {
    const m = seconds / 60;
    return `${m} ${m === 1 ? "minute" : "minutes"} remaining in this section`;
  }
  return `${seconds} seconds remaining in this section`;
}

export function SectionClock({
  attemptId,
  initialMs,
  sectionLimitSec,
  onExpired,
}: {
  attemptId: string;
  initialMs: number;
  sectionLimitSec: number;
  onExpired: () => void;
}) {
  const [ms, setMs] = useState(initialMs);
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef(initialMs);
  const expired = useRef(false);

  // The authoritative read.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/aptitude/attempts/${attemptId}/clock`, { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { msRemainingInSection: number; sectionClosed: boolean };
        if (cancelled) return;
        setMs(body.msRemainingInSection);
        if (body.sectionClosed && !expired.current) {
          expired.current = true;
          onExpired();
        }
      } catch {
        // A failed read leaves the last server value on screen and the local
        // tick carrying on. There is no proctoring decision riding on it.
      }
    };
    void poll();
    const id = setInterval(poll, MOCK_CLOCK_LIMITS.pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [attemptId, onExpired]);

  // The local tick only INTERPOLATES, and can only subtract.
  useEffect(() => {
    const id = setInterval(() => setMs((current) => Math.max(0, current - 1_000)), 1_000);
    return () => clearInterval(id);
  }, []);

  // The four moments, and no others.
  useEffect(() => {
    const due = dueSectionAnnouncement(previous.current, ms, sectionLimitSec);
    previous.current = ms;
    if (due !== null) setAnnouncement(spoken(due));
  }, [ms, sectionLimitSec]);

  useEffect(() => {
    if (ms > 0 || expired.current) return;
    expired.current = true;
    onExpired();
  }, [ms, onExpired]);

  const urgent = ms <= 60_000;

  return (
    <div className="flex items-baseline gap-2">
      {/* The digits are hidden from assistive technology: a screen reader
          reading a changing clock every second is unusable. The live region
          below carries the four announcements instead. */}
      <span
        aria-hidden="true"
        className={`font-mono text-2xl font-semibold tabular-nums ${urgent ? "text-warning" : ""}`}
      >
        {face(ms)}
      </span>
      <span className="text-xs text-muted">left in this section</span>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <span className="sr-only">
        This section announces the time remaining at{" "}
        {announceAtSeconds(sectionLimitSec)
          .map((seconds) => (seconds >= 60 ? `${seconds / 60} minutes` : `${seconds} seconds`))
          .join(", ")}
        .
      </span>
    </div>
  );
}
