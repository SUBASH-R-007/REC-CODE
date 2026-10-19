import { describe, expect, it } from "vitest";
import {
  acceptsWork,
  ATTEMPT_STATUSES,
  bitmapBytes,
  canTransition,
  computeExpiresAt,
  DEFAULT_HEARTBEAT_SLOT_SECONDS,
  DISCONNECTED_AFTER_SECONDS,
  hasExpired,
  isDisconnected,
  isFinished,
  isIdle,
  isSlotSet,
  markSlot,
  maxGapSeconds,
  msRemaining,
  presenceTimeline,
  presentSlots,
  slotOf,
  type AttemptStatus,
  type PresenceBitmap,
} from "../src/attempt-clock";

const at = (iso: string) => new Date(iso);
const START = at("2026-12-01T10:00:00.000Z");
/** The sitting is open far longer than any attempt below, unless stated. */
const CLOSES_LATE = at("2026-12-01T20:00:00.000Z");

describe("expiresAt is server-computed, and the formula is the spec's", () => {
  it("no accommodation: start + duration", () => {
    const { expiresAt, grantedSec, cappedByClose } = computeExpiresAt({
      startedAt: START,
      durationSec: 3600,
      closesAt: CLOSES_LATE,
    });
    expect(expiresAt.toISOString()).toBe("2026-12-01T11:00:00.000Z");
    expect(grantedSec).toBe(3600);
    expect(cappedByClose).toBe(false);
  });

  it("33% extra time on an hour is the standard 20 minutes per hour", () => {
    const { expiresAt, grantedSec } = computeExpiresAt({
      startedAt: START,
      durationSec: 3600,
      closesAt: CLOSES_LATE,
      accommodation: { extraTimePercent: 33 },
    });
    expect(grantedSec).toBe(4788); // 3600 × 1.33
    expect(Math.round((grantedSec - 3600) / 60)).toBe(20);
    expect(expiresAt.toISOString()).toBe("2026-12-01T11:19:48.000Z");
  });

  it("flat extra minutes are added after the percentage", () => {
    const { grantedSec } = computeExpiresAt({
      startedAt: START,
      durationSec: 3600,
      closesAt: CLOSES_LATE,
      accommodation: { extraTimePercent: 50, extraTimeMinutes: 10 },
    });
    expect(grantedSec).toBe(3600 * 1.5 + 600);
  });

  it("both at zero is the same as no accommodation", () => {
    const plain = computeExpiresAt({ startedAt: START, durationSec: 1800, closesAt: CLOSES_LATE });
    const zeroed = computeExpiresAt({
      startedAt: START,
      durationSec: 1800,
      closesAt: CLOSES_LATE,
      accommodation: { extraTimePercent: 0, extraTimeMinutes: 0 },
    });
    expect(zeroed).toEqual(plain);
  });

  it("null accommodation is accepted (most candidates have none)", () => {
    expect(
      computeExpiresAt({ startedAt: START, durationSec: 600, closesAt: CLOSES_LATE, accommodation: null })
        .grantedSec,
    ).toBe(600);
  });

  it("is capped by the sitting's close time, and SAYS it was capped", () => {
    const { expiresAt, grantedSec, cappedByClose } = computeExpiresAt({
      startedAt: START,
      durationSec: 3600,
      closesAt: at("2026-12-01T10:30:00.000Z"),
      accommodation: { extraTimePercent: 100 },
    });
    expect(expiresAt.toISOString()).toBe("2026-12-01T10:30:00.000Z");
    expect(grantedSec).toBe(1800);
    // An accommodation trimmed by the schedule is a mistake someone must
    // fix, not a detail to hide from the candidate who was granted it.
    expect(cappedByClose).toBe(true);
  });

  it("rounds once, so two computations of an odd duration agree", () => {
    const a = computeExpiresAt({ startedAt: START, durationSec: 3607, closesAt: CLOSES_LATE, accommodation: { extraTimePercent: 33 } });
    const b = computeExpiresAt({ startedAt: START, durationSec: 3607, closesAt: CLOSES_LATE, accommodation: { extraTimePercent: 33 } });
    expect(a).toEqual(b);
    expect(Number.isInteger(a.grantedSec)).toBe(true);
  });

  it.each([
    ["a zero duration", 0],
    ["a negative duration", -60],
    ["a fractional duration", 90.5],
  ])("throws on %s rather than guessing a deadline", (_name, durationSec) => {
    expect(() => computeExpiresAt({ startedAt: START, closesAt: CLOSES_LATE, durationSec })).toThrow();
  });

  it.each([
    ["a percentage over 100", { extraTimePercent: 101 }],
    ["a negative percentage", { extraTimePercent: -1 }],
    ["negative extra minutes", { extraTimeMinutes: -5 }],
  ])("throws on %s", (_name, accommodation) => {
    expect(() =>
      computeExpiresAt({ startedAt: START, durationSec: 3600, closesAt: CLOSES_LATE, accommodation }),
    ).toThrow();
  });
});

describe("msRemaining and expiry", () => {
  const expiresAt = at("2026-12-01T11:00:00.000Z");

  it("counts down and never goes negative", () => {
    expect(msRemaining({ expiresAt, pausedMs: 0, now: at("2026-12-01T10:59:59.000Z") })).toBe(1000);
    expect(msRemaining({ expiresAt, pausedMs: 0, now: expiresAt })).toBe(0);
    expect(msRemaining({ expiresAt, pausedMs: 0, now: at("2026-12-01T12:00:00.000Z") })).toBe(0);
  });

  it("a granted break extends the deadline rather than eating the clock", () => {
    expect(msRemaining({ expiresAt, pausedMs: 300_000, now: expiresAt })).toBe(300_000);
  });

  it("hasExpired is exactly msRemaining === 0", () => {
    expect(hasExpired({ expiresAt, pausedMs: 0, now: at("2026-12-01T10:59:59.999Z") })).toBe(false);
    expect(hasExpired({ expiresAt, pausedMs: 0, now: expiresAt })).toBe(true);
  });
});

describe("the presence bitmap", () => {
  it("180 minutes at 15-second slots is 90 bytes, as the spec says", () => {
    expect(bitmapBytes(180 * 60)).toBe(90);
    expect(DEFAULT_HEARTBEAT_SLOT_SECONDS).toBe(15);
  });

  it("maps a moment to its slot, clamping before the start", () => {
    expect(slotOf(START, START)).toBe(0);
    expect(slotOf(START, at("2026-12-01T10:00:14.999Z"))).toBe(0);
    expect(slotOf(START, at("2026-12-01T10:00:15.000Z"))).toBe(1);
    expect(slotOf(START, at("2026-12-01T10:01:00.000Z"))).toBe(4);
    expect(slotOf(START, at("2026-12-01T09:59:00.000Z"))).toBe(0);
  });

  it("answers 'was this candidate connected at minute 47?'", () => {
    let map: PresenceBitmap = new Uint8Array(bitmapBytes(180 * 60));
    const slot47 = slotOf(START, at("2026-12-01T10:47:00.000Z"));
    expect(isSlotSet(map, slot47)).toBe(false);
    map = markSlot(map, slot47);
    expect(isSlotSet(map, slot47)).toBe(true);
    expect(map.length).toBe(90);
  });

  it("marks most-significant-bit first, so a dump reads left to right in time", () => {
    const map = markSlot(new Uint8Array(1), 0);
    expect(map[0]).toBe(0b1000_0000);
    expect(markSlot(new Uint8Array(1), 7)[0]).toBe(0b0000_0001);
  });

  it("does not mutate the bitmap it is given", () => {
    const original: PresenceBitmap = new Uint8Array(2);
    const marked = markSlot(original, 3);
    expect(original[0]).toBe(0);
    expect(isSlotSet(marked, 3)).toBe(true);
  });

  it("grows rather than dropping a late heartbeat", () => {
    const map = markSlot(new Uint8Array(1), 20);
    expect(map.length).toBeGreaterThan(1);
    expect(isSlotSet(map, 20)).toBe(true);
  });

  it("ignores a negative slot and reads out of range as absent", () => {
    const map: PresenceBitmap = new Uint8Array(1);
    expect(markSlot(map, -1)).toBe(map);
    expect(isSlotSet(map, -1)).toBe(false);
    expect(isSlotSet(map, 9999)).toBe(false);
  });

  it("counts present slots", () => {
    let map: PresenceBitmap = new Uint8Array(2);
    for (const slot of [0, 1, 5, 9, 15]) map = markSlot(map, slot);
    expect(presentSlots(map)).toBe(5);
  });
});

describe("maxHeartbeatGapSeconds is server-computed from the bitmap", () => {
  it("is zero when every slot is present", () => {
    let map: PresenceBitmap = new Uint8Array(2);
    for (let s = 0; s < 16; s++) map = markSlot(map, s);
    expect(maxGapSeconds(map, 16)).toBe(0);
  });

  it("finds the longest run of missed slots", () => {
    let map: PresenceBitmap = new Uint8Array(2);
    // present at 0,1 then a gap of 4, present at 6, gap of 2, present at 9
    for (const s of [0, 1, 6, 9]) map = markSlot(map, s);
    expect(maxGapSeconds(map, 10)).toBe(4 * 15);
  });

  it("counts a connection that died and never came back", () => {
    let map: PresenceBitmap = new Uint8Array(bitmapBytes(3600));
    // Connected for the first 40 minutes of an hour, then nothing.
    for (let s = 0; s < 160; s++) map = markSlot(map, s);
    const slotsElapsed = 3600 / 15;
    expect(maxGapSeconds(map, slotsElapsed)).toBe(80 * 15); // the last 20 minutes
  });

  it("does not invent a gap past the elapsed time", () => {
    let map: PresenceBitmap = new Uint8Array(bitmapBytes(3600));
    for (let s = 0; s < 10; s++) map = markSlot(map, s);
    // Only 10 slots have elapsed; the rest of the bitmap is future, not a gap.
    expect(maxGapSeconds(map, 10)).toBe(0);
  });

  it("an entirely missing attempt is one long gap", () => {
    expect(maxGapSeconds(new Uint8Array(4), 32)).toBe(32 * 15);
  });
});

describe("presenceTimeline", () => {
  it("collapses slots into runs", () => {
    let map: PresenceBitmap = new Uint8Array(1);
    for (const s of [0, 1, 2, 6, 7]) map = markSlot(map, s);
    expect(presenceTimeline(map, 8)).toEqual([
      { present: true, fromSlot: 0, toSlot: 3 },
      { present: false, fromSlot: 3, toSlot: 6 },
      { present: true, fromSlot: 6, toSlot: 8 },
    ]);
  });

  it("is a single run when nothing changes", () => {
    expect(presenceTimeline(new Uint8Array(1), 8)).toEqual([{ present: false, fromSlot: 0, toSlot: 8 }]);
  });

  it("is empty before anything has elapsed", () => {
    expect(presenceTimeline(new Uint8Array(1), 0)).toEqual([]);
  });
});

describe("disconnected and idle", () => {
  const now = at("2026-12-01T10:10:00.000Z");

  it("45 seconds without a heartbeat is DISCONNECTED", () => {
    expect(DISCONNECTED_AFTER_SECONDS).toBe(45);
    // 50 s since the last beat: over the threshold.
    expect(isDisconnected(at("2026-12-01T10:09:10.000Z"), now)).toBe(true);
    // Exactly 45 s is NOT yet disconnected — the rule is "more than".
    expect(isDisconnected(at("2026-12-01T10:09:15.000Z"), now)).toBe(false);
    // 40 s: comfortably connected.
    expect(isDisconnected(at("2026-12-01T10:09:20.000Z"), now)).toBe(false);
  });

  it("120 seconds reads as idle", () => {
    expect(isIdle(at("2026-12-01T10:07:00.000Z"), now)).toBe(true);
    expect(isIdle(at("2026-12-01T10:09:00.000Z"), now)).toBe(false);
  });

  it("an attempt that has never beaten is neither (it has not started)", () => {
    expect(isDisconnected(null, now)).toBe(false);
    expect(isIdle(null, now)).toBe(false);
  });
});

describe("the attempt status machine", () => {
  it("starts an attempt and finishes it", () => {
    expect(canTransition("NOT_STARTED", "IN_PROGRESS")).toBe(true);
    expect(canTransition("IN_PROGRESS", "SUBMITTED")).toBe(true);
    expect(canTransition("IN_PROGRESS", "AUTO_SUBMITTED")).toBe(true);
  });

  it("a reconnection returns to IN_PROGRESS; the clock never stopped", () => {
    expect(canTransition("IN_PROGRESS", "DISCONNECTED")).toBe(true);
    expect(canTransition("DISCONNECTED", "IN_PROGRESS")).toBe(true);
  });

  it("refuses to restart a finished attempt", () => {
    for (const from of ["SUBMITTED", "AUTO_SUBMITTED", "EXPIRED", "TERMINATED"] as const) {
      expect(canTransition(from, "IN_PROGRESS")).toBe(false);
      expect(canTransition(from, "NOT_STARTED")).toBe(false);
    }
  });

  it("VOIDED is reachable only from a finished state, and is terminal", () => {
    expect(canTransition("IN_PROGRESS", "VOIDED")).toBe(false);
    expect(canTransition("NOT_STARTED", "VOIDED")).toBe(false);
    expect(canTransition("SUBMITTED", "VOIDED")).toBe(true);
    for (const to of ATTEMPT_STATUSES) expect(canTransition("VOIDED", to)).toBe(false);
  });

  it("names every status exactly once", () => {
    expect(new Set(ATTEMPT_STATUSES).size).toBe(ATTEMPT_STATUSES.length);
    expect(ATTEMPT_STATUSES).toHaveLength(8);
  });

  it("knows which statuses are finished", () => {
    expect(ATTEMPT_STATUSES.filter(isFinished)).toEqual([
      "SUBMITTED",
      "AUTO_SUBMITTED",
      "EXPIRED",
      "TERMINATED",
      "VOIDED",
    ]);
  });

  it("accepts work while in progress AND while disconnected", () => {
    // Refusing a reconnected candidate's work would punish a wifi failure.
    expect(acceptsWork("IN_PROGRESS")).toBe(true);
    expect(acceptsWork("DISCONNECTED")).toBe(true);
    expect(ATTEMPT_STATUSES.filter(acceptsWork)).toEqual(["IN_PROGRESS", "DISCONNECTED"]);
  });

  it("every status either accepts work or is finished or is NOT_STARTED", () => {
    for (const s of ATTEMPT_STATUSES as readonly AttemptStatus[]) {
      expect(acceptsWork(s) || isFinished(s) || s === "NOT_STARTED").toBe(true);
    }
  });
});
