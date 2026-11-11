import { EXAM_BROWSER_SKEW_TOLERANCE_MS } from "@recx/shared/exam-browser";

/**
 * Two things about the candidate's machine that are worth knowing BEFORE
 * the clock starts, and are useless afterwards (Phase 15b).
 *
 * Both are read in the browser and shown to the candidate. Neither is sent
 * anywhere, neither is recorded, and neither is a proctoring signal: a
 * laptop at 11% is not evidence of anything, and a clock set wrong is a
 * machine to fix rather than a person to suspect. `docs/PROCTORING.md` §3
 * governs what is recorded; this is the readiness check doing its actual
 * job, which is making sure a candidate does not discover a problem
 * twenty minutes into a paper.
 *
 * Pure, because the awkward cases here are arithmetic and the interesting
 * ones are the boundaries.
 */

/**
 * How far out a clock may be before the exam browser's attestation starts
 * refusing requests. The server tolerates this much either way
 * (`EXAM_BROWSER_SKEW_TOLERANCE_MS`), so a candidate past it does not get
 * a degraded sitting -- they get no sitting at all, with a message about a
 * signature that reads like a fault in the software.
 */
export const CLOCK_SKEW_LIMIT_MS = EXAM_BROWSER_SKEW_TOLERANCE_MS;

/**
 * Warn earlier than it breaks. A clock drifting towards the limit during a
 * three-hour paper is a sitting that fails in the middle, and the middle
 * is the worst possible time to find out.
 */
export const CLOCK_SKEW_WARN_MS = 30_000;

export type ClockSkew =
  | { readonly kind: "unknown" }
  | { readonly kind: "fine"; readonly offsetMs: number }
  | { readonly kind: "drifting"; readonly offsetMs: number }
  | { readonly kind: "broken"; readonly offsetMs: number };

/**
 * How wrong this machine's clock is, from the `Date` header of a response
 * the readiness check already makes.
 *
 * No new endpoint and no new round trip: the network check HEADs this very
 * page, and every HTTP response carries the server's clock. The header has
 * one-second resolution and the round trip adds its own few hundred
 * milliseconds, which is why the thresholds are tens of seconds and not
 * tenths.
 *
 * `unknown` when there is no usable header, and `unknown` is not a
 * failure: a proxy that strips `Date` is not a candidate's problem.
 */
export function clockSkew(serverDate: string | null | undefined, clientNowMs: number): ClockSkew {
  if (!serverDate) return { kind: "unknown" };
  const serverMs = Date.parse(serverDate);
  if (!Number.isFinite(serverMs)) return { kind: "unknown" };

  // Positive means this machine is AHEAD of the server.
  const offsetMs = clientNowMs - serverMs;
  const size = Math.abs(offsetMs);
  if (size >= CLOCK_SKEW_LIMIT_MS) return { kind: "broken", offsetMs };
  if (size >= CLOCK_SKEW_WARN_MS) return { kind: "drifting", offsetMs };
  return { kind: "fine", offsetMs };
}

/** "4 minutes fast" / "35 seconds slow". Said the way a person would say it. */
export function describeSkew(offsetMs: number): string {
  const seconds = Math.round(Math.abs(offsetMs) / 1000);
  const direction = offsetMs >= 0 ? "fast" : "slow";
  if (seconds < 90) return `${seconds} seconds ${direction}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ${direction}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ${direction}`;
}

/**
 * Below this, on battery, a candidate is told to plug in.
 *
 * Chosen against the longest paper rather than as a round number: a
 * three-hour sitting on a laptop that is already down to a quarter is a
 * sitting that ends early, and the fix costs nothing if it is mentioned
 * before the clock starts.
 */
export const BATTERY_WARN_LEVEL = 0.4;

export type PowerState =
  | { readonly kind: "unknown" }
  | { readonly kind: "plugged_in" }
  | { readonly kind: "on_battery"; readonly percent: number }
  | { readonly kind: "low_battery"; readonly percent: number };

/**
 * What to say about the power, from whatever the browser will admit to.
 *
 * `unknown` wherever the Battery Status API is absent -- Firefox removed
 * it, Safari never had it -- and that is deliberately silent rather than a
 * warning about not knowing. A readiness check that cried about every
 * unknowable thing would be one candidates learn to click past, and the
 * check right below this one is the one they must not click past.
 */
export function powerState(battery: { charging: boolean; level: number } | null): PowerState {
  if (!battery || !Number.isFinite(battery.level)) return { kind: "unknown" };
  const percent = Math.max(0, Math.min(100, Math.round(battery.level * 100)));
  if (battery.charging) return { kind: "plugged_in" };
  return battery.level < BATTERY_WARN_LEVEL ? { kind: "low_battery", percent } : { kind: "on_battery", percent };
}
