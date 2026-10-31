/**
 * The exam timer (Phase 6c). Pure: formatting, the announcement schedule and
 * the pill's tone. No ambient clock — every function takes the milliseconds
 * the SERVER last reported (SPEC §5: "the client renders msRemaining and
 * never consults local Date.now() for anything authoritative").
 *
 * SPEC §5 on the timer itself:
 *
 *   Timer: HH:MM:SS in tabular-nums at 18px; text-warning pill in the last 5
 *   minutes, text-danger in the last 60 seconds; aria-live="assertive"
 *   announcements at exactly 10:00, 5:00, 1:00 and 0:10 and at no other
 *   time — a chatty live region makes a screen reader unusable. Never
 *   role="timer" with a per-second region.
 *
 * "At no other time" is the hard part, and it is why this is a module with
 * tests rather than a `useEffect` with a comparison: a timer that announces
 * every second, or twice at the same threshold, makes the exam unusable for
 * exactly the candidates who most need the announcement.
 */

/** The four moments, in seconds remaining. Descending, and closed. */
export const TIMER_ANNOUNCEMENT_SECONDS = [600, 300, 60, 10] as const;
export type TimerAnnouncementSecond = (typeof TIMER_ANNOUNCEMENT_SECONDS)[number];

/** The last 5 minutes turn the pill amber. */
export const TIMER_WARNING_SECONDS = 300;
/** The last 60 seconds turn it red. */
export const TIMER_DANGER_SECONDS = 60;

export type TimerTone = "normal" | "warning" | "danger";

/**
 * The pill's tone. Boundaries are inclusive — at exactly 5:00 the candidate
 * is "in the last 5 minutes", which is when the warning is useful rather
 * than one second late.
 */
export function timerTone(msRemaining: number): TimerTone {
  const seconds = Math.max(0, Math.ceil(msRemaining / 1000));
  if (seconds <= TIMER_DANGER_SECONDS) return "danger";
  if (seconds <= TIMER_WARNING_SECONDS) return "warning";
  return "normal";
}

/**
 * HH:MM:SS, always three parts and always two digits each, so the glyphs
 * never reflow in a tabular-nums cell. Rounded UP: while any part of the
 * final second remains the candidate still has time, and a timer that reads
 * 0:00:00 with work still accepted is a timer nobody trusts.
 */
export function formatClock(msRemaining: number): string {
  const total = Math.max(0, Math.ceil(msRemaining / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** What the live region says. Spoken aloud, so it is a sentence, not a clock. */
export function announcementText(seconds: TimerAnnouncementSecond): string {
  switch (seconds) {
    case 600:
      return "10 minutes remaining.";
    case 300:
      return "5 minutes remaining.";
    case 60:
      return "1 minute remaining.";
    case 10:
      return "10 seconds remaining.";
  }
}

/**
 * Which announcement this tick owes, given the previous reading and the
 * current one. Null on almost every tick — that is the point.
 *
 * A threshold is crossed when the clock was above it and is now at or below
 * it. Two cases the obvious implementation gets wrong:
 *
 *   - a tab the OS froze comes back having passed 10:00 AND 5:00. Announcing
 *     both would read out stale information before the true one; only the
 *     most urgent threshold crossed is announced, because that is the one
 *     that is still true.
 *   - the clock going UP (a heartbeat granting time, or an invigilator's
 *     extension) must announce nothing and must re-arm, so that crossing
 *     5:00 again later does announce. Nothing here holds state, so re-arming
 *     is automatic: the caller passes the previous reading, not a flag.
 */
export function dueAnnouncement(
  prevMsRemaining: number,
  msRemaining: number,
): TimerAnnouncementSecond | null {
  if (!Number.isFinite(prevMsRemaining) || !Number.isFinite(msRemaining)) return null;
  if (msRemaining >= prevMsRemaining) return null;
  const prevSec = prevMsRemaining / 1000;
  const nowSec = msRemaining / 1000;
  // Ascending through the thresholds would find 10 first; descending finds
  // the largest, so this walks the list backwards to land on the most
  // urgent one crossed.
  for (let i = TIMER_ANNOUNCEMENT_SECONDS.length - 1; i >= 0; i--) {
    const threshold = TIMER_ANNOUNCEMENT_SECONDS[i]!;
    if (nowSec <= threshold && prevSec > threshold) return threshold;
  }
  return null;
}

/**
 * The timer's own accessible name. Read once when the region is created, so
 * it carries the units a bare "01:58:40" does not.
 */
export function clockLabel(msRemaining: number): string {
  const total = Math.max(0, Math.ceil(msRemaining / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  // Seconds are named only when they are the whole story, so a screen reader
  // is not read a changing third component every time the label is refreshed.
  if (parts.length === 0) parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
  return `Time remaining: ${parts.join(" ")}`;
}

/**
 * Interpolate between heartbeats. The server reported `serverMsRemaining` at
 * `atMs` (a local performance/Date reading taken when the response arrived);
 * `nowMs` is the same local source now.
 *
 * This is the ONE place a local clock is allowed near the exam clock, and it
 * is still not authoritative: every heartbeat replaces the result, and the
 * local delta can only ever subtract. A local clock that jumps backwards
 * (an NTP step, a laptop resuming) cannot add time, because the elapsed
 * delta is floored at zero.
 */
export function interpolateRemaining(args: {
  readonly serverMsRemaining: number;
  readonly atMs: number;
  readonly nowMs: number;
}): number {
  const elapsed = Math.max(0, args.nowMs - args.atMs);
  return Math.max(0, args.serverMsRemaining - elapsed);
}
