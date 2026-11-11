import { ACCOMMODATION_LIMITS, accommodatedDurationSec } from "./accommodation";

/**
 * The assessment clock and the heartbeat bitmap (Phase 6b). Pure: no I/O, no
 * ambient clock — `now` is always passed in.
 *
 * Two things live here because the spec is specific about both, and both are
 * the kind of arithmetic that is wrong in production if it is not tested in
 * isolation:
 *
 *   1. `expiresAt`, computed SERVER-SIDE ONLY and never accepted from a
 *      client (SPEC §5). A contest clock could be advisory, because a late
 *      contest submission simply does not score; an assessment clock cannot,
 *      because the attempt ends.
 *   2. The heartbeat presence bitmap. "A row per heartbeat is 3.6M rows for
 *      one college-wide sitting. The bitmap answers 'was this candidate
 *      connected at minute 47?' in 90 bytes, renders directly as a presence
 *      timeline, and makes maxHeartbeatGapSeconds server-computed. Keep the
 *      bit arithmetic in a small, pure, unit-tested module."
 */

/** Default slot width. 180 minutes = 720 slots = 90 bytes. */
export const DEFAULT_HEARTBEAT_SLOT_SECONDS = 15;

/** A missed run of this many seconds marks the candidate DISCONNECTED. */
export const DISCONNECTED_AFTER_SECONDS = 45;

/** No heartbeat for this long reads as idle on the invigilator dashboard. */
export const IDLE_AFTER_SECONDS = 120;

// ── The clock ────────────────────────────────────────────────────────────

/** The accommodation fields that move a deadline. All optional. */
export interface ClockAccommodation {
  /** 0–100. 33 ≈ the standard 20 minutes per hour. */
  readonly extraTimePercent?: number;
  /** Flat minutes added after the percentage. */
  readonly extraTimeMinutes?: number;
}

export interface ExpiryInput {
  readonly startedAt: Date;
  /** The assessment's own clock, before accommodations. */
  readonly durationSec: number;
  /** The sitting cannot run past this, whatever the accommodation. */
  readonly closesAt: Date;
  readonly accommodation?: ClockAccommodation | null;
}

export interface Expiry {
  readonly expiresAt: Date;
  /** Seconds actually granted, after the accommodation and the cap. */
  readonly grantedSec: number;
  /** True when `closesAt` cut the accommodation short — staff must see this. */
  readonly cappedByClose: boolean;
}

/**
 * `expiresAt = min(startedAt + durationSec × (1 + extraTimePercent/100)
 *                   + extraTimeMinutes, assessment.closesAt)`
 *
 * The cap is reported rather than silently applied: an accommodation trimmed
 * by the sitting's own close time is a scheduling mistake someone has to fix,
 * not a detail to hide from the candidate who was granted extra time.
 *
 * Throws on nonsense rather than guessing — a wrong deadline is worse than a
 * refused start, and the caller is one transaction that can abort cleanly.
 */
export function computeExpiresAt(input: ExpiryInput): Expiry {
  const { startedAt, durationSec, closesAt } = input;
  if (!Number.isFinite(startedAt.getTime())) throw new Error("startedAt is not a date");
  if (!Number.isFinite(closesAt.getTime())) throw new Error("closesAt is not a date");
  if (!Number.isInteger(durationSec) || durationSec <= 0) {
    throw new Error("durationSec must be a positive whole number of seconds");
  }

  const percent = input.accommodation?.extraTimePercent ?? 0;
  const minutes = input.accommodation?.extraTimeMinutes ?? 0;
  // The same bounds the Accommodation CHECKs enforce. Refused rather than
  // clamped: a deadline computed from terms the database would have rejected
  // is a deadline nobody can explain afterwards.
  if (!Number.isFinite(percent) || percent < 0 || percent > ACCOMMODATION_LIMITS.extraTimePercent.max) {
    throw new Error(`extraTimePercent must be between 0 and ${ACCOMMODATION_LIMITS.extraTimePercent.max}`);
  }
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > ACCOMMODATION_LIMITS.extraTimeMinutes.max) {
    throw new Error(`extraTimeMinutes must be between 0 and ${ACCOMMODATION_LIMITS.extraTimeMinutes.max}`);
  }

  // Delegated, NOT re-derived. Phase 4 already ships this formula to the
  // accommodation screens; computing it a second way here would put the
  // deadline a second away from the extra time the student was told they
  // had, on exactly the odd durations nobody tests by hand.
  const wanted = accommodatedDurationSec(durationSec, {
    extraTimePercent: percent,
    extraTimeMinutes: minutes,
  });
  const wantedAt = startedAt.getTime() + wanted * 1000;
  const cappedByClose = wantedAt > closesAt.getTime();
  const expiresAt = new Date(Math.min(wantedAt, closesAt.getTime()));
  return {
    expiresAt,
    grantedSec: Math.max(0, Math.round((expiresAt.getTime() - startedAt.getTime()) / 1000)),
    cappedByClose,
  };
}

/**
 * Milliseconds left, as the heartbeat reports them. Paused time extends the
 * deadline, so a granted break does not eat the candidate's clock.
 * Never negative: zero means the attempt is over.
 */
export function msRemaining(args: {
  readonly expiresAt: Date;
  readonly pausedMs: number;
  readonly now: Date;
}): number {
  const left = args.expiresAt.getTime() + Math.max(0, args.pausedMs) - args.now.getTime();
  return Math.max(0, left);
}

/** Has the clock run out? The only automatic action in the phase hangs off this. */
export function hasExpired(args: { expiresAt: Date; pausedMs: number; now: Date }): boolean {
  return msRemaining(args) === 0;
}

// ── The presence bitmap ──────────────────────────────────────────────────

/**
 * The presence bitmap.
 *
 * Named, because TypeScript 5.7 made Uint8Array generic over its buffer
 * (`Uint8Array<ArrayBuffer>` vs `Uint8Array<ArrayBufferLike>`), and a
 * function that may return its own argument widens to ArrayBufferLike — which
 * is then not assignable to a variable inferred from `new Uint8Array(n)`.
 * One alias used by every signature here keeps callers and tests in step.
 */
export type PresenceBitmap = Uint8Array<ArrayBufferLike>;

/** Bytes needed to cover `durationSec` at `slotSeconds`. */
export function bitmapBytes(durationSec: number, slotSeconds = DEFAULT_HEARTBEAT_SLOT_SECONDS): number {
  if (!Number.isInteger(slotSeconds) || slotSeconds <= 0) throw new Error("slotSeconds must be a positive integer");
  return Math.ceil(Math.ceil(durationSec / slotSeconds) / 8);
}

/** The slot a moment falls in, counted from the attempt's start. */
export function slotOf(
  startedAt: Date,
  at: Date,
  slotSeconds = DEFAULT_HEARTBEAT_SLOT_SECONDS,
): number {
  const elapsed = Math.floor((at.getTime() - startedAt.getTime()) / 1000);
  return Math.floor(Math.max(0, elapsed) / slotSeconds);
}

/** Is that slot marked present? Out of range reads as absent. */
export function isSlotSet(bitmap: PresenceBitmap, slot: number): boolean {
  if (slot < 0) return false;
  const byte = slot >> 3;
  if (byte >= bitmap.length) return false;
  // Most significant bit first, so a hex dump reads left to right in time.
  return (bitmap[byte]! & (0b1000_0000 >> (slot & 7))) !== 0;
}

/**
 * Mark a slot present. Returns a NEW bitmap, grown if the slot is past the
 * end — an attempt that runs long (paused and resumed) must not silently
 * drop its later heartbeats.
 */
export function markSlot(bitmap: PresenceBitmap, slot: number): PresenceBitmap {
  if (slot < 0) return bitmap;
  const byte = slot >> 3;
  const out = byte < bitmap.length ? new Uint8Array(bitmap) : new Uint8Array(byte + 1);
  if (byte >= bitmap.length) out.set(bitmap);
  out[byte] = out[byte]! | (0b1000_0000 >> (slot & 7));
  return out;
}

/** How many slots are marked present. */
export function presentSlots(bitmap: PresenceBitmap): number {
  let n = 0;
  for (const byte of bitmap) {
    let b = byte;
    while (b !== 0) {
      n += b & 1;
      b >>= 1;
    }
  }
  return n;
}

/**
 * The longest run of consecutive missed slots, in seconds — i.e.
 * `maxHeartbeatGapSeconds`, computed by the server from the bitmap it owns.
 *
 * `slotsElapsed` bounds the search so a half-finished attempt is not counted
 * as having a gap stretching to the end of its bitmap. Trailing zeroes before
 * that bound DO count: a candidate whose connection died at minute 40 of a
 * 60-minute attempt has a 20-minute gap, and that is the point.
 */
export function maxGapSeconds(
  bitmap: PresenceBitmap,
  slotsElapsed: number,
  slotSeconds = DEFAULT_HEARTBEAT_SLOT_SECONDS,
): number {
  let longest = 0;
  let run = 0;
  for (let slot = 0; slot < slotsElapsed; slot++) {
    if (isSlotSet(bitmap, slot)) {
      run = 0;
    } else {
      run++;
      if (run > longest) longest = run;
    }
  }
  return longest * slotSeconds;
}

export interface PresenceRun {
  readonly present: boolean;
  readonly fromSlot: number;
  /** Exclusive. */
  readonly toSlot: number;
}

/**
 * The bitmap as runs, which is what a presence timeline renders from — one
 * element per block of connected or missing time rather than one per slot.
 */
export function presenceTimeline(bitmap: PresenceBitmap, slotsElapsed: number): PresenceRun[] {
  if (slotsElapsed <= 0) return [];
  const runs: PresenceRun[] = [];
  let present = isSlotSet(bitmap, 0);
  let from = 0;
  for (let slot = 1; slot < slotsElapsed; slot++) {
    const here = isSlotSet(bitmap, slot);
    if (here !== present) {
      runs.push({ present, fromSlot: from, toSlot: slot });
      present = here;
      from = slot;
    }
  }
  runs.push({ present, fromSlot: from, toSlot: slotsElapsed });
  return runs;
}

/** Is the candidate disconnected right now, by the 45-second rule? */
export function isDisconnected(lastHeartbeatAt: Date | null, now: Date): boolean {
  if (lastHeartbeatAt === null) return false;
  return now.getTime() - lastHeartbeatAt.getTime() > DISCONNECTED_AFTER_SECONDS * 1000;
}

export function isIdle(lastHeartbeatAt: Date | null, now: Date): boolean {
  if (lastHeartbeatAt === null) return false;
  return now.getTime() - lastHeartbeatAt.getTime() > IDLE_AFTER_SECONDS * 1000;
}

// ── The attempt status machine ───────────────────────────────────────────

export const ATTEMPT_STATUSES = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "DISCONNECTED",
  "SUBMITTED",
  "AUTO_SUBMITTED",
  "EXPIRED",
  "TERMINATED",
  "VOIDED",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/**
 * Legal transitions. VOIDED is reachable only from a finished state, and
 * only ever by a recorded human verdict (§0) — nothing automatic may reach
 * it, which is why no automatic path in this module returns it.
 */
const TRANSITIONS: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = Object.freeze({
  NOT_STARTED: ["IN_PROGRESS"],
  IN_PROGRESS: ["DISCONNECTED", "SUBMITTED", "AUTO_SUBMITTED", "EXPIRED", "TERMINATED"],
  // A reconnection returns to IN_PROGRESS; the clock never stopped.
  DISCONNECTED: ["IN_PROGRESS", "AUTO_SUBMITTED", "EXPIRED", "TERMINATED"],
  SUBMITTED: ["VOIDED"],
  AUTO_SUBMITTED: ["VOIDED"],
  EXPIRED: ["VOIDED"],
  TERMINATED: ["VOIDED"],
  VOIDED: [],
});

export function canTransition(from: AttemptStatus, to: AttemptStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses after which no more work may be submitted. */
export const FINISHED_ATTEMPT_STATUSES: readonly AttemptStatus[] = Object.freeze([
  "SUBMITTED",
  "AUTO_SUBMITTED",
  "EXPIRED",
  "TERMINATED",
  "VOIDED",
]);

export function isFinished(status: AttemptStatus): boolean {
  return FINISHED_ATTEMPT_STATUSES.includes(status);
}

/**
 * Whether an attempt may still accept work. A DISCONNECTED attempt may:
 * the candidate's connection dropped, their clock did not stop, and refusing
 * their work on reconnection would punish a wifi failure.
 */
export function acceptsWork(status: AttemptStatus): boolean {
  return status === "IN_PROGRESS" || status === "DISCONNECTED";
}
