import { HINT_POLICY } from "@recx/shared";

/**
 * Active-time tracking constants, shared by the browser tracker
 * (src/components/help/activity-tracker.tsx) and the server route
 * (src/app/api/activity/route.ts). No server-only imports: this module ships
 * to the client.
 *
 * "Active" means: the tab is visible AND the student pressed a key or used
 * the pointer within the last minute. The browser pings every 30 s; the
 * server accepts at most one ping per 20 s per student and problem, and
 * credits min(claimed, wall-clock seconds since the last accepted ping, 60).
 * A forged client can therefore never accrue time faster than the wall
 * clock, so it cannot unlock a hint tier early by more than real time.
 */
export const ACTIVITY_POLICY = Object.freeze({
  /** Browser: how often a ping is sent while there is time to report. */
  pingIntervalMs: 30_000,
  /** Server: one accepted ping per this interval per student and problem. */
  minPingGapMs: 20_000,
  /** Server: the most one ping can ever credit. */
  maxCreditSeconds: 60,
  /** Browser: no keydown / pointer input for this long = idle, the clock stops. */
  idleAfterMs: 60_000,
  /** Zod bound on the claimed seconds (anything above maxCreditSeconds is capped). */
  maxClaimSeconds: 3_600,
  /** Server: ActivityDay.activeSeconds never exceeds one day. */
  maxDaySeconds: 86_400,
});

export const ACTIVITY_ENDPOINT = "/api/activity";

/**
 * Active-time totals at which the help panels change (hint 2, hint 3, the
 * editorial's time condition), in seconds. The tracker refreshes the page
 * when a ping carries the total across one of them.
 */
export const ACTIVITY_UNLOCK_SECONDS: readonly number[] = Object.freeze([
  HINT_POLICY.tier2.activeMinutes * 60,
  HINT_POLICY.tier3.activeMinutes * 60,
  HINT_POLICY.editorial.activeMinutes * 60,
]);

/** True when moving from `before` to `after` active seconds crosses an unlock threshold. */
export function crossesUnlock(before: number, after: number): boolean {
  return ACTIVITY_UNLOCK_SECONDS.some((t) => before < t && after >= t);
}
