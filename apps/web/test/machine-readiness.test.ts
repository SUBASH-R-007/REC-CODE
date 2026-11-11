import { describe, expect, it } from "vitest";
import {
  BATTERY_WARN_LEVEL,
  CLOCK_SKEW_LIMIT_MS,
  CLOCK_SKEW_WARN_MS,
  clockSkew,
  describeSkew,
  powerState,
} from "@/lib/exam/machine-readiness";

/**
 * The two machine checks (Phase 15b).
 *
 * Both exist to stop a candidate discovering something twenty minutes
 * into a paper that could have been said in ten seconds beforehand. The
 * clock one is the sharper of the two: past the attestation's tolerance a
 * KIOSK_RECX sitting does not degrade, it refuses, and the message the
 * candidate sees is about a signature.
 */

const SERVER = "Sat, 07 Nov 2026 10:00:00 GMT";
const SERVER_MS = Date.parse(SERVER);

describe("how wrong this machine's clock is", () => {
  it("says nothing when there is no header to read", () => {
    // A proxy that strips `Date` is not a candidate's problem, and a
    // readiness check that complained about it would be teaching them to
    // click past warnings.
    for (const value of [null, undefined, "", "not a date"]) {
      expect(clockSkew(value, SERVER_MS)).toEqual({ kind: "unknown" });
    }
  });

  it("is fine when the clocks agree", () => {
    expect(clockSkew(SERVER, SERVER_MS)).toEqual({ kind: "fine", offsetMs: 0 });
    expect(clockSkew(SERVER, SERVER_MS + 2_000).kind).toBe("fine");
  });

  it("warns before it breaks, in both directions", () => {
    expect(clockSkew(SERVER, SERVER_MS + CLOCK_SKEW_WARN_MS).kind).toBe("drifting");
    expect(clockSkew(SERVER, SERVER_MS - CLOCK_SKEW_WARN_MS).kind).toBe("drifting");
    // Just inside the warning threshold is still fine.
    expect(clockSkew(SERVER, SERVER_MS + CLOCK_SKEW_WARN_MS - 1).kind).toBe("fine");
  });

  it("calls it broken at the tolerance the server actually enforces", () => {
    /**
     * Not a round number of our own choosing: the same constant the
     * attestation uses. A readiness check that passed a clock the server
     * then refused would be worse than no check.
     */
    expect(clockSkew(SERVER, SERVER_MS + CLOCK_SKEW_LIMIT_MS).kind).toBe("broken");
    expect(clockSkew(SERVER, SERVER_MS - CLOCK_SKEW_LIMIT_MS).kind).toBe("broken");
    expect(clockSkew(SERVER, SERVER_MS + CLOCK_SKEW_LIMIT_MS - 1).kind).toBe("drifting");
  });

  it("keeps the sign, because fast and slow are different problems", () => {
    const fast = clockSkew(SERVER, SERVER_MS + 600_000);
    const slow = clockSkew(SERVER, SERVER_MS - 600_000);
    if (fast.kind === "unknown" || slow.kind === "unknown") throw new Error("expected a reading");
    expect(fast.offsetMs).toBeGreaterThan(0);
    expect(slow.offsetMs).toBeLessThan(0);
  });
});

describe("saying it the way a person would", () => {
  it("uses seconds, minutes and hours as they become the natural unit", () => {
    expect(describeSkew(35_000)).toBe("35 seconds fast");
    expect(describeSkew(-35_000)).toBe("35 seconds slow");
    expect(describeSkew(240_000)).toBe("4 minutes fast");
    expect(describeSkew(-7_200_000)).toBe("2 hours slow");
  });

  it("gets the singular right", () => {
    expect(describeSkew(90_000)).toBe("2 minutes fast");
    expect(describeSkew(-3_600_000)).toBe("1 hour slow");
  });
});

describe("the power", () => {
  it("says nothing at all where the browser will not say", () => {
    // Firefox removed the Battery Status API and Safari never had it.
    expect(powerState(null)).toEqual({ kind: "unknown" });
    expect(powerState({ charging: false, level: Number.NaN })).toEqual({ kind: "unknown" });
  });

  it("is content when the machine is plugged in, however low it is", () => {
    expect(powerState({ charging: true, level: 0.03 })).toEqual({ kind: "plugged_in" });
  });

  it("warns only when a battery would not see out a long paper", () => {
    expect(powerState({ charging: false, level: 0.8 })).toEqual({ kind: "on_battery", percent: 80 });
    expect(powerState({ charging: false, level: BATTERY_WARN_LEVEL }).kind).toBe("on_battery");
    expect(powerState({ charging: false, level: BATTERY_WARN_LEVEL - 0.01 }).kind).toBe("low_battery");
  });

  it("reports a whole percentage and never one outside the scale", () => {
    expect(powerState({ charging: false, level: 0.666 })).toMatchObject({ percent: 67 });
    expect(powerState({ charging: false, level: 2 })).toMatchObject({ percent: 100 });
    expect(powerState({ charging: false, level: -1 })).toMatchObject({ percent: 0 });
  });
});
