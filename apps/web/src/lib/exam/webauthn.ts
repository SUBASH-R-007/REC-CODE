import "server-only";
import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  ASSERTION_REFUSAL_MESSAGES,
  ENROLMENT_REFUSAL_MESSAGES,
  WEBAUTHN_CHALLENGE_TTL_MS,
  canEnrolDevice,
  counterRegressed,
  isActiveDevice,
  type AssertionRefusal,
  type AttestationKind,
  type EnrolmentRefusal,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

/**
 * WebAuthn device binding (Phase 6d).
 *
 * SPEC §5: "A fresh assertion against a server challenge is required to start
 * any REMOTE_MONITORED or LAB_SUPERVISED attempt; max 2 active devices;
 * rebinding is an audited Admin action. Include a supervised single-use
 * loaner-device enrolment so a broken laptop never blocks a student from
 * sitting an exam."
 *
 * And why this rather than a fingerprint:
 *
 *   Do not implement browser fingerprinting as a device-identity mechanism —
 *   unstable, trivially spoofed, and covert tracking is exactly the wrong
 *   posture for a college asking students to trust it. WebAuthn also closes
 *   impersonation (a senior sitting for a junior), which is a more common and
 *   more damaging campus failure than tab-switching.
 *
 * The cryptography is @simplewebauthn/server's. Verifying a COSE signature by
 * hand is not a thing to do in an authentication path, and the parts that are
 * ours — who may enrol, how many devices, what a loaner may do, what a
 * regressed counter means — are in @recx/shared and unit-tested there.
 */

/** The relying party is the app's own origin. */
function relyingParty(): { id: string; origin: string; name: string } {
  const origin = env().APP_URL;
  const { hostname } = new URL(origin);
  return { id: hostname, origin, name: "REC Code" };
}

function challengeToken(): string {
  return randomBytes(32).toString("base64url");
}

async function issueChallenge(args: {
  readonly userId: string;
  readonly purpose: "ENROL" | "ASSERT";
  readonly assessmentId?: string | null;
}): Promise<string> {
  const challenge = challengeToken();
  await db.webAuthnChallenge.create({
    data: {
      userId: args.userId,
      challenge,
      purpose: args.purpose,
      assessmentId: args.assessmentId ?? null,
      expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_MS),
    },
  });
  return challenge;
}

/**
 * Claim a challenge. The conditional UPDATE is the claim: one row, unconsumed
 * and unexpired, and the first caller to get `count === 1` owns it. The
 * `WebAuthnChallenge_single_use` trigger refuses a second claim even from raw
 * SQL, so a replay cannot succeed by racing.
 */
async function claimChallenge(args: {
  readonly userId: string;
  readonly challenge: string;
  readonly purpose: "ENROL" | "ASSERT";
}): Promise<boolean> {
  const claimed = await db.webAuthnChallenge.updateMany({
    where: {
      userId: args.userId,
      challenge: args.challenge,
      purpose: args.purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { consumedAt: new Date() },
  });
  return claimed.count === 1;
}

/**
 * Record which device signed a spent challenge. That row is what the
 * attempt-start path reads as proof of a fresh assertion, so it is written
 * only after the signature has verified.
 */
async function recordAssertingDevice(args: {
  readonly userId: string;
  readonly challenge: string;
  readonly deviceId: string;
}): Promise<void> {
  await db.webAuthnChallenge.updateMany({
    where: { userId: args.userId, challenge: args.challenge, purpose: "ASSERT" },
    data: { deviceRegistrationId: args.deviceId },
  });
}

/**
 * The device that asserted for this assessment, if the assertion is still
 * fresh. Null means "assert again", which is the only thing a caller can do
 * about a missing, stale or wrong-assessment one.
 *
 * Reading a consumed row rather than a signed cookie: there is no value to
 * forge, and the single-use trigger already guarantees the row was spent
 * exactly once.
 */
export async function freshAssertionFor(args: {
  readonly userId: string;
  readonly assessmentId: string;
}): Promise<{ deviceId: string; isLoaner: boolean } | null> {
  const row = await db.webAuthnChallenge.findFirst({
    where: {
      userId: args.userId,
      assessmentId: args.assessmentId,
      purpose: "ASSERT",
      consumedAt: { gt: new Date(Date.now() - WEBAUTHN_CHALLENGE_TTL_MS) },
      deviceRegistrationId: { not: null },
    },
    orderBy: { consumedAt: "desc" },
    select: { deviceRegistrationId: true },
  });
  if (!row?.deviceRegistrationId) return null;
  const device = await db.deviceRegistration.findUnique({
    where: { id: row.deviceRegistrationId },
    select: { id: true, isLoaner: true, revokedAt: true, loanConsumedAt: true },
  });
  // Revoked or spent between the assertion and the start: assert again.
  if (!device || !isActiveDevice({ ...device, label: "" })) return null;
  return { deviceId: device.id, isLoaner: device.isLoaner };
}

// ── Enrolment ────────────────────────────────────────────────────────────

export type EnrolOptionsResult =
  | { readonly ok: true; readonly options: PublicKeyCredentialCreationOptionsJSON }
  | { readonly ok: false; readonly refusal: EnrolmentRefusal; readonly message: string };

/**
 * Options for a supervised enrolment.
 *
 * `residentKey: "required"` and `userVerification: "preferred"` are the
 * spec's settings. A resident (discoverable) key means the authenticator
 * itself holds the credential, so a candidate at a lab machine can assert
 * without the machine knowing anything about them beforehand — which is what
 * makes a shared lab workable.
 */
export async function enrolmentOptions(args: {
  readonly userId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly asLoaner: boolean;
}): Promise<EnrolOptionsResult> {
  const existing = await db.deviceRegistration.findMany({
    where: { userId: args.userId },
    select: { id: true, label: true, revokedAt: true, isLoaner: true, loanConsumedAt: true, credentialId: true },
  });
  const allowed = canEnrolDevice(existing, args.asLoaner);
  if (!allowed.ok) {
    return { ok: false, refusal: allowed.refusal, message: ENROLMENT_REFUSAL_MESSAGES[allowed.refusal] };
  }

  const rp = relyingParty();
  const challenge = await issueChallenge({ userId: args.userId, purpose: "ENROL" });
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: args.handle,
    userDisplayName: args.displayName,
    challenge,
    attestationType: "none",
    // The student's own active devices, so the authenticator refuses to
    // register the same key twice rather than creating a confusing duplicate.
    excludeCredentials: existing
      .filter(isActiveDevice)
      .map((device) => ({ id: device.credentialId, transports: undefined })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "preferred",
    },
  });
  return { ok: true, options };
}

export type EnrolResult =
  | { readonly ok: true; readonly deviceId: string; readonly label: string }
  | { readonly ok: false; readonly refusal: EnrolmentRefusal | "verification_failed"; readonly message: string };

const ATTESTATION_OF: Readonly<Record<string, AttestationKind>> = Object.freeze({
  none: "NONE",
  self: "SELF",
  basic: "BASIC",
  basic_full: "BASIC",
  attca: "ATTCA",
  anonca: "ANONCA",
});

/**
 * Verify an enrolment and record the device.
 *
 * `supervisorId` is not optional and is not the student: SPEC §5 says
 * "supervised in-lab enrolment", and a student who can enrol their own device
 * can enrol a friend's — which is exactly the impersonation WebAuthn is here
 * to close. The route is behind a staff guard and this records who stood
 * there.
 */
export async function verifyEnrolment(args: {
  readonly userId: string;
  readonly supervisorId: string;
  readonly response: RegistrationResponseJSON;
  readonly expectedChallenge: string;
  readonly label: string;
  readonly asLoaner: boolean;
}): Promise<EnrolResult> {
  const rp = relyingParty();

  if (!(await claimChallenge({ userId: args.userId, challenge: args.expectedChallenge, purpose: "ENROL" }))) {
    return { ok: false, refusal: "verification_failed", message: ASSERTION_REFUSAL_MESSAGES.challenge_expired };
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: false,
    });
  } catch (cause) {
    console.warn(`[webauthn] enrolment verification failed for ${args.userId}:`, (cause as Error).message);
    return { ok: false, refusal: "verification_failed", message: ASSERTION_REFUSAL_MESSAGES.bad_signature };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, refusal: "verification_failed", message: ASSERTION_REFUSAL_MESSAGES.bad_signature };
  }

  const info = verification.registrationInfo;
  const credentialId = info.credential.id;
  const publicKey = Buffer.from(info.credential.publicKey).toString("base64url");

  // Across every student, not only this one: a credential already registered
  // elsewhere would otherwise create two owners for one key.
  const clash = await db.deviceRegistration.findUnique({ where: { credentialId }, select: { id: true } });
  if (clash) {
    return {
      ok: false,
      refusal: "duplicate_credential",
      message: ENROLMENT_REFUSAL_MESSAGES.duplicate_credential,
    };
  }

  const device = await db.deviceRegistration.create({
    data: {
      userId: args.userId,
      credentialId,
      publicKey,
      aaguid: info.aaguid && /^[0-9a-f]{32}$/.test(info.aaguid.replace(/-/g, "")) ? info.aaguid.replace(/-/g, "") : null,
      label: args.label.trim().slice(0, 80),
      attestationKind: ATTESTATION_OF[info.credentialType ?? "none"] ?? "NONE",
      signCount: info.credential.counter,
      isLoaner: args.asLoaner,
      enrolledBySupervisorId: args.supervisorId,
    },
    select: { id: true, label: true },
  });

  await audit({
    actorId: args.supervisorId,
    action: args.asLoaner ? "device.loaner_enrolled" : "device.enrolled",
    entityType: "DeviceRegistration",
    entityId: device.id,
    targetUserId: args.userId,
    sensitivity: "SECURITY",
    metadata: {
      label: device.label,
      isLoaner: args.asLoaner,
      // Never the credential id or the public key: they identify a device a
      // student carries, and an audit row is read by more people than need
      // them.
      attestation: ATTESTATION_OF[info.credentialType ?? "none"] ?? "NONE",
    },
  });

  return { ok: true, deviceId: device.id, label: device.label };
}

// ── Assertion ────────────────────────────────────────────────────────────

export type AssertOptionsResult =
  | { readonly ok: true; readonly options: PublicKeyCredentialRequestOptionsJSON }
  | { readonly ok: false; readonly refusal: AssertionRefusal; readonly message: string };

export async function assertionOptions(args: {
  readonly userId: string;
  readonly assessmentId: string;
}): Promise<AssertOptionsResult> {
  const devices = await db.deviceRegistration.findMany({
    where: { userId: args.userId },
    select: { id: true, label: true, revokedAt: true, isLoaner: true, loanConsumedAt: true, credentialId: true },
  });
  const active = devices.filter(isActiveDevice);
  if (active.length === 0) {
    const everHad = devices.length > 0;
    const refusal: AssertionRefusal = everHad
      ? devices.some((device) => device.isLoaner && device.loanConsumedAt !== null)
        ? "loaner_spent"
        : "device_revoked"
      : "no_device";
    return { ok: false, refusal, message: ASSERTION_REFUSAL_MESSAGES[refusal] };
  }

  const rp = relyingParty();
  const challenge = await issueChallenge({
    userId: args.userId,
    purpose: "ASSERT",
    assessmentId: args.assessmentId,
  });
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    challenge,
    allowCredentials: active.map((device) => ({ id: device.credentialId })),
    userVerification: "preferred",
  });
  return { ok: true, options };
}

export type AssertResult =
  | { readonly ok: true; readonly deviceId: string; readonly isLoaner: boolean }
  | { readonly ok: false; readonly refusal: AssertionRefusal; readonly message: string };

const refuse = (refusal: AssertionRefusal): AssertResult => ({
  ok: false,
  refusal,
  message: ASSERTION_REFUSAL_MESSAGES[refusal],
});

/**
 * Verify a fresh assertion. Returns the device that signed, which the attempt
 * then records in `deviceRegistrationId`.
 *
 * A regressed signature counter is refused rather than recorded. It is the
 * only hint WebAuthn gives that a credential may have been cloned, and the
 * database refuses to store the regression either way — so this has to be a
 * refusal and not a flag. The message says the device needs re-enrolling,
 * because that is what a candidate and an invigilator can act on; it does not
 * accuse anybody of copying a key.
 */
export async function verifyAssertion(args: {
  readonly userId: string;
  readonly response: AuthenticationResponseJSON;
  readonly expectedChallenge: string;
}): Promise<AssertResult> {
  const rp = relyingParty();

  const device = await db.deviceRegistration.findUnique({
    where: { credentialId: args.response.id },
    select: {
      id: true,
      userId: true,
      credentialId: true,
      publicKey: true,
      signCount: true,
      isLoaner: true,
      loanConsumedAt: true,
      revokedAt: true,
      label: true,
    },
  });
  // Not this user's credential, or not one we know. The same refusal for
  // both: a candidate who could tell them apart could probe whether a given
  // key belongs to someone else on campus.
  if (!device || device.userId !== args.userId) return refuse("unknown_credential");
  if (device.revokedAt !== null) return refuse("device_revoked");
  if (device.isLoaner && device.loanConsumedAt !== null) return refuse("loaner_spent");

  if (!(await claimChallenge({ userId: args.userId, challenge: args.expectedChallenge, purpose: "ASSERT" }))) {
    return refuse("challenge_expired");
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: device.credentialId,
        publicKey: new Uint8Array(Buffer.from(device.publicKey, "base64url")),
        counter: device.signCount,
      },
      requireUserVerification: false,
    });
  } catch (cause) {
    console.warn(`[webauthn] assertion failed for ${args.userId}:`, (cause as Error).message);
    return refuse("bad_signature");
  }
  if (!verification.verified) return refuse("bad_signature");

  const presented = verification.authenticationInfo.newCounter;
  if (counterRegressed(device.signCount, presented)) {
    await audit({
      actorId: null,
      action: "device.counter_regressed",
      entityType: "DeviceRegistration",
      entityId: device.id,
      targetUserId: args.userId,
      sensitivity: "SECURITY",
      metadata: { stored: device.signCount, presented, label: device.label },
    });
    return refuse("counter_regressed");
  }

  // Only ever upward; the database refuses a decrease anyway.
  if (presented > device.signCount) {
    await db.deviceRegistration.updateMany({
      where: { id: device.id, signCount: { lt: presented } },
      data: { signCount: presented },
    });
  }

  await recordAssertingDevice({ userId: args.userId, challenge: args.expectedChallenge, deviceId: device.id });
  return { ok: true, deviceId: device.id, isLoaner: device.isLoaner };
}

/**
 * Spend a loaner, once its sitting has started. Separate from the assertion
 * so a candidate who asserts and then fails a later check (the hall network,
 * say) has not burned their loan.
 */
export async function consumeLoaner(deviceId: string): Promise<void> {
  await db.deviceRegistration.updateMany({
    where: { id: deviceId, isLoaner: true, loanConsumedAt: null },
    data: { loanConsumedAt: new Date() },
  });
}

/** Withdraw a registration. An audited staff action (SPEC §5: "rebinding is an audited Admin action"). */
export async function revokeDevice(args: {
  readonly deviceId: string;
  readonly actorId: string;
  readonly reason: string;
}): Promise<boolean> {
  const device = await db.deviceRegistration.findUnique({
    where: { id: args.deviceId },
    select: { userId: true, label: true, revokedAt: true },
  });
  if (!device || device.revokedAt !== null) return false;

  const revoked = await db.deviceRegistration.updateMany({
    where: { id: args.deviceId, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: args.actorId },
  });
  if (revoked.count !== 1) return false;

  await audit({
    actorId: args.actorId,
    action: "device.revoked",
    entityType: "DeviceRegistration",
    entityId: args.deviceId,
    targetUserId: device.userId,
    sensitivity: "SECURITY",
    // A written reason, as every staff action in this system has.
    metadata: { label: device.label, reason: args.reason.slice(0, 500) },
  });
  return true;
}
