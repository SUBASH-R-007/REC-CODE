import type { ProctorMode } from "./assessment";

/**
 * Device binding policy (Phase 6d). Pure: which modes require a device, how
 * many a student may hold, and what a loaner is allowed to do.
 *
 * SPEC §5:
 *
 *   WebAuthn: supervised in-lab enrolment creates DeviceRegistration
 *   [...] (residentKey: required, userVerification: preferred). A fresh
 *   assertion against a server challenge is required to start any
 *   REMOTE_MONITORED or LAB_SUPERVISED attempt; max 2 active devices;
 *   rebinding is an audited Admin action. Include a supervised single-use
 *   loaner-device enrolment so a broken laptop never blocks a student from
 *   sitting an exam.
 *
 * And the reason it is WebAuthn and not a fingerprint:
 *
 *   Do not implement browser fingerprinting as a device-identity mechanism —
 *   unstable, trivially spoofed, and covert tracking is exactly the wrong
 *   posture for a college asking students to trust it. WebAuthn also closes
 *   impersonation (a senior sitting for a junior), which is a more common and
 *   more damaging campus failure than tab-switching.
 *
 * The loaner path is the part that is easy to leave out and the part a
 * student's day depends on. A policy that cannot issue a laptop to someone
 * whose own has died is a policy that stops a student sitting an exam they
 * are entitled to sit, and no amount of integrity is worth that.
 */

/** A student may hold at most this many active devices (SPEC §5). */
export const MAX_ACTIVE_DEVICES = 2;

/** How long an enrolment or assertion challenge stays usable. */
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60_000;

/**
 * The modes that require a fresh assertion to start a sitting.
 *
 * KIOSK_SEB is NOT here, and that is the spec's list, not an omission: SEB
 * verification is its own check, and requiring a security key inside a kiosk
 * build that may not expose WebAuthn would lock candidates out of an exam the
 * kiosk was supposed to make safe.
 */
export const DEVICE_BOUND_PROCTOR_MODES: readonly ProctorMode[] = Object.freeze([
  "REMOTE_MONITORED",
  "LAB_SUPERVISED",
]);

export function requiresDeviceAssertion(mode: ProctorMode): boolean {
  return DEVICE_BOUND_PROCTOR_MODES.includes(mode);
}

export const ATTESTATION_KINDS = ["NONE", "SELF", "BASIC", "ATTCA", "ANONCA"] as const;
export type AttestationKind = (typeof ATTESTATION_KINDS)[number];

/** A device the student holds. */
export interface DeviceView {
  readonly id: string;
  readonly label: string;
  readonly revokedAt: Date | null;
  /** A supervised single-use loan, not one of the student's own. */
  readonly isLoaner: boolean;
  /** Set once a loaner has served its sitting. */
  readonly loanConsumedAt: Date | null;
}

export function isActiveDevice(device: DeviceView): boolean {
  if (device.revokedAt !== null) return false;
  // A loaner is spent after one sitting. Its row stays — a revocation and a
  // consumption are different facts, and a reviewer may need both.
  if (device.isLoaner && device.loanConsumedAt !== null) return false;
  return true;
}

export const ENROLMENT_REFUSALS = ["too_many_devices", "not_supervised", "duplicate_credential"] as const;
export type EnrolmentRefusal = (typeof ENROLMENT_REFUSALS)[number];

export const ENROLMENT_REFUSAL_MESSAGES: Readonly<Record<EnrolmentRefusal, string>> = Object.freeze({
  too_many_devices: `A student may have at most ${MAX_ACTIVE_DEVICES} registered devices. Revoke one before enrolling another.`,
  not_supervised: "Device enrolment has to be done in person by a supervisor. It cannot be started by the student.",
  duplicate_credential: "That device is already registered — to this student or to another one.",
});

/**
 * May another device be enrolled for this student?
 *
 * A loaner does NOT count against the limit, because the limit exists to stop
 * a student registering a friend's machine as a second "own" device, and a
 * loaner is issued by a supervisor who is standing there. Counting it would
 * mean a student with two devices cannot be issued a loaner when one of them
 * breaks, which is the exact situation the loaner exists for.
 */
export function canEnrolDevice(existing: readonly DeviceView[], asLoaner: boolean): { ok: true } | { ok: false; refusal: EnrolmentRefusal } {
  if (asLoaner) return { ok: true };
  const ownActive = existing.filter((device) => isActiveDevice(device) && !device.isLoaner).length;
  if (ownActive >= MAX_ACTIVE_DEVICES) return { ok: false, refusal: "too_many_devices" };
  return { ok: true };
}

export const ASSERTION_REFUSALS = [
  "no_device",
  "device_revoked",
  "loaner_spent",
  "challenge_expired",
  "unknown_credential",
  "bad_signature",
  "counter_regressed",
] as const;
export type AssertionRefusal = (typeof ASSERTION_REFUSALS)[number];

export const ASSERTION_REFUSAL_MESSAGES: Readonly<Record<AssertionRefusal, string>> = Object.freeze({
  no_device:
    "This assessment needs a registered device. Your department enrols one in person — ask your invigilator, who can also issue a loaner.",
  device_revoked: "That device's registration has been withdrawn. Ask your invigilator to enrol this machine or issue a loaner.",
  loaner_spent: "That loaner device has already been used for a sitting. Ask your invigilator to issue another.",
  challenge_expired: "That took too long. Try again.",
  unknown_credential: "This device is not registered for your account. Ask your invigilator to enrol it or issue a loaner.",
  bad_signature: "This device could not be verified. Ask your invigilator.",
  counter_regressed:
    "This device's security counter went backwards, which can mean the credential has been copied. Ask your invigilator — the device needs re-enrolling.",
});

/**
 * Has the authenticator's signature counter gone backwards?
 *
 * A counter that decreases is the one signal WebAuthn gives that a credential
 * may have been cloned. Many authenticators (including most platform ones)
 * report zero always, and for those there is nothing to compare — treating
 * "always zero" as a regression would refuse every Touch ID and Windows Hello
 * device on campus.
 */
export function counterRegressed(stored: number, presented: number): boolean {
  if (stored === 0 && presented === 0) return false;
  return presented <= stored;
}
