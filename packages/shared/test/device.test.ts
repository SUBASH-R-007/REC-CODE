import { describe, expect, it } from "vitest";
import { PROCTOR_MODES } from "../src/assessment";
import {
  ASSERTION_REFUSALS,
  ASSERTION_REFUSAL_MESSAGES,
  DEVICE_BOUND_PROCTOR_MODES,
  ENROLMENT_REFUSALS,
  ENROLMENT_REFUSAL_MESSAGES,
  MAX_ACTIVE_DEVICES,
  WEBAUTHN_CHALLENGE_TTL_MS,
  canEnrolDevice,
  counterRegressed,
  isActiveDevice,
  requiresDeviceAssertion,
  type DeviceView,
} from "../src/device";

const device = (over: Partial<DeviceView> = {}): DeviceView => ({
  id: "d1",
  label: "laptop",
  revokedAt: null,
  isLoaner: false,
  loanConsumedAt: null,
  ...over,
});

describe("the policy constants", () => {
  it("allows two devices, as the spec fixes", () => {
    expect(MAX_ACTIVE_DEVICES).toBe(2);
  });

  it("keeps a challenge usable for minutes, not hours", () => {
    expect(WEBAUTHN_CHALLENGE_TTL_MS).toBeGreaterThanOrEqual(60_000);
    expect(WEBAUTHN_CHALLENGE_TTL_MS).toBeLessThanOrEqual(10 * 60_000);
  });
});

describe("requiresDeviceAssertion", () => {
  it("requires a device for the two modes the spec names", () => {
    expect(requiresDeviceAssertion("REMOTE_MONITORED")).toBe(true);
    expect(requiresDeviceAssertion("LAB_SUPERVISED")).toBe(true);
  });

  it("does not require one for NONE or ADVISORY", () => {
    expect(requiresDeviceAssertion("NONE")).toBe(false);
    expect(requiresDeviceAssertion("ADVISORY")).toBe(false);
  });

  it("does not require one inside a kiosk build", () => {
    // Deliberate, and the spec's own list: requiring a security key inside a
    // kiosk that may not expose WebAuthn would lock candidates out of the
    // exam the kiosk was supposed to make safe.
    expect(requiresDeviceAssertion("KIOSK_SEB")).toBe(false);
    expect(DEVICE_BOUND_PROCTOR_MODES).not.toContain("KIOSK_SEB");
  });

  it("decides for every proctor mode, so a new one cannot be silently unbound", () => {
    for (const mode of PROCTOR_MODES) {
      expect(typeof requiresDeviceAssertion(mode)).toBe("boolean");
    }
    expect(DEVICE_BOUND_PROCTOR_MODES.every((mode) => PROCTOR_MODES.includes(mode))).toBe(true);
  });
});

describe("isActiveDevice", () => {
  it("counts an unrevoked device", () => {
    expect(isActiveDevice(device())).toBe(true);
  });

  it("does not count a revoked one", () => {
    expect(isActiveDevice(device({ revokedAt: new Date() }))).toBe(false);
  });

  it("counts an unspent loaner and not a spent one", () => {
    expect(isActiveDevice(device({ isLoaner: true }))).toBe(true);
    expect(isActiveDevice(device({ isLoaner: true, loanConsumedAt: new Date() }))).toBe(false);
  });

  it("ignores a consumption date on a non-loaner, which the database refuses anyway", () => {
    expect(isActiveDevice(device({ loanConsumedAt: new Date() }))).toBe(true);
  });
});

describe("canEnrolDevice", () => {
  it("allows a first and a second device", () => {
    expect(canEnrolDevice([], false)).toEqual({ ok: true });
    expect(canEnrolDevice([device()], false)).toEqual({ ok: true });
  });

  it("refuses a third", () => {
    const result = canEnrolDevice([device({ id: "a" }), device({ id: "b" })], false);
    expect(result).toEqual({ ok: false, refusal: "too_many_devices" });
  });

  it("allows a third once one is revoked", () => {
    expect(canEnrolDevice([device({ id: "a", revokedAt: new Date() }), device({ id: "b" })], false)).toEqual({
      ok: true,
    });
  });

  it("issues a loaner to a student who already has two devices", () => {
    // The exact situation the loaner exists for. Counting it against the
    // limit would mean a broken laptop stops a student sitting their exam,
    // and no amount of integrity is worth that.
    const full = [device({ id: "a" }), device({ id: "b" })];
    expect(canEnrolDevice(full, true)).toEqual({ ok: true });
  });

  it("does not let an unspent loaner block an own-device enrolment", () => {
    // A loaner is not one of the student's own, so it does not consume a slot.
    expect(canEnrolDevice([device({ id: "a" }), device({ id: "loan", isLoaner: true })], false)).toEqual({ ok: true });
  });

  it("still refuses a third own device when a loaner is also active", () => {
    const devices = [device({ id: "a" }), device({ id: "b" }), device({ id: "loan", isLoaner: true })];
    expect(canEnrolDevice(devices, false)).toEqual({ ok: false, refusal: "too_many_devices" });
  });
});

describe("counterRegressed", () => {
  it("accepts a counter that rose", () => {
    expect(counterRegressed(5, 6)).toBe(false);
  });

  it("refuses one that stayed the same or fell, which may mean a cloned credential", () => {
    expect(counterRegressed(5, 5)).toBe(true);
    expect(counterRegressed(5, 4)).toBe(true);
  });

  it("accepts an authenticator that always reports zero", () => {
    // Most platform authenticators (Touch ID, Windows Hello) do. Treating
    // always-zero as a regression would refuse every one of them on campus.
    expect(counterRegressed(0, 0)).toBe(false);
  });

  it("refuses a counter that falls back to zero after having risen", () => {
    expect(counterRegressed(10, 0)).toBe(true);
  });
});

describe("the messages", () => {
  it("has one for every refusal", () => {
    for (const refusal of ENROLMENT_REFUSALS) {
      expect(ENROLMENT_REFUSAL_MESSAGES[refusal].length).toBeGreaterThan(20);
    }
    for (const refusal of ASSERTION_REFUSALS) {
      expect(ASSERTION_REFUSAL_MESSAGES[refusal].length).toBeGreaterThan(10);
    }
    expect(Object.keys(ENROLMENT_REFUSAL_MESSAGES)).toHaveLength(ENROLMENT_REFUSALS.length);
    expect(Object.keys(ASSERTION_REFUSAL_MESSAGES)).toHaveLength(ASSERTION_REFUSALS.length);
  });

  it("tells a candidate with no device that a loaner exists", () => {
    // Otherwise the honest answer to "my laptop died" looks like "you cannot
    // sit the exam".
    expect(ASSERTION_REFUSAL_MESSAGES.no_device).toContain("loaner");
    expect(ASSERTION_REFUSAL_MESSAGES.device_revoked).toContain("loaner");
    expect(ASSERTION_REFUSAL_MESSAGES.loaner_spent).toContain("another");
  });

  it("accuses nobody, including for a regressed counter", () => {
    // A regressed counter CAN mean a copied credential, and can also mean a
    // firmware reset. The message says what to do, not what was done.
    for (const refusal of ASSERTION_REFUSALS) {
      expect(ASSERTION_REFUSAL_MESSAGES[refusal].toLowerCase()).not.toMatch(/cheat|malpractice|stole|fraud/);
    }
    expect(ASSERTION_REFUSAL_MESSAGES.counter_regressed).toContain("needs re-enrolling");
  });

  it("says enrolment is in person, which is what closes impersonation", () => {
    expect(ENROLMENT_REFUSAL_MESSAGES.not_supervised).toContain("in person");
  });
});
