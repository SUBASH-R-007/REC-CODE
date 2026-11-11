/**
 * A second factor for privileged accounts: the arithmetic (Phase 16j).
 *
 * `docs/ROADMAP.md` §3.1 is the entry this closes, and it states the shape:
 * *"`SUPER_ADMIN` and `ADMIN` only, TOTP first, recovery codes recorded in
 * the audit log by the fact of their use and never by value. Students keep a
 * password, because 5,000 students with TOTP is a help-desk programme, not a
 * security improvement."* A single password stands in front of
 * impersonation, the roster import commit, result release, the placement
 * export, the AI provider settings and the judge node controls; every one of
 * those is audited, which is how a department finds out afterwards.
 *
 * This module is the half with no I/O and no secrets in it: base32, the time
 * step, the truncation, the `otpauth://` URI and the code formats. The HMAC
 * and everything that touches a stored secret are in
 * `apps/web/src/lib/auth/totp.ts`, because this file is also imported by the
 * browser bundle through `@recx/shared` and must not pull `node:crypto` in.
 *
 * **RFC 6238 with SHA-1, 6 digits, 30 seconds.** Not a preference: it is
 * what every authenticator application implements, and a deployment whose
 * second factor only works in one app is a deployment that will not use a
 * second factor. The weakness of SHA-1 as a hash is not reachable through
 * HMAC over a 160-bit secret in a 30-second window.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * How many 30-second steps either side of now are accepted.
 *
 * One, so a phone whose clock is half a minute out still works and a code
 * is valid for at most 90 seconds. Authenticator apps show a countdown, so
 * a person who starts typing at 28 seconds is the case this is for.
 */
export const TOTP_WINDOW_STEPS = 1;

/** 160 bits, which is the secret size SHA-1 HMAC is defined for. */
export const TOTP_SECRET_BYTES = 20;

/** The algorithm named in the `otpauth://` URI, and the only one accepted. */
export const TOTP_ALGORITHM = "SHA1";

/** How long an enrolment may sit unconfirmed before it is worthless. */
export const TOTP_ENROLMENT_MINUTES = 15;

/** How long a half-finished sign-in may wait for a code. */
export const SECOND_FACTOR_CHALLENGE_MINUTES = 5;

/** How many codes one challenge may be given before it is dead. */
export const SECOND_FACTOR_MAX_ATTEMPTS = 5;

export const RECOVERY_CODE_COUNT = 10;
/** Bytes per recovery code: 80 bits, which is far past guessable at 5 tries. */
export const RECOVERY_CODE_BYTES = 10;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, no padding — what every authenticator app expects. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The inverse, forgiving about how a person typed it: lower case, spaces,
 * hyphens and `=` padding are all accepted, because the alternative is an
 * admin who cannot enrol and has no idea why.
 */
export function base32Decode(text: string): Uint8Array | null {
  const cleaned = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (cleaned.length === 0) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  // Leftover bits must be zero padding; anything else is not a base32 string
  // of whole bytes, and accepting it would silently decode to the wrong key.
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) return null;
  return new Uint8Array(out);
}

/** The 30-second step a moment falls in. */
export function totpCounter(nowSeconds: number): number {
  return Math.floor(nowSeconds / TOTP_PERIOD_SECONDS);
}

/** Every step accepted for a moment, nearest first. */
export function totpWindow(nowSeconds: number, steps = TOTP_WINDOW_STEPS): number[] {
  const centre = totpCounter(nowSeconds);
  const out = [centre];
  for (let offset = 1; offset <= steps; offset += 1) out.push(centre - offset, centre + offset);
  return out;
}

/**
 * RFC 4226 dynamic truncation: the low four bits of the last byte choose
 * where in the digest to read four bytes from, the top bit is masked off,
 * and the remainder modulo 10^digits is the code.
 */
export function codeFromHmac(digest: Uint8Array, digits = TOTP_DIGITS): string {
  if (digest.length < 20) throw new Error("totp: a SHA-1 HMAC digest is 20 bytes");
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The counter as the 8-byte big-endian block the HMAC is taken over. */
export function counterBlock(counter: number): Uint8Array {
  const block = new Uint8Array(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) {
    block[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return block;
}

/** Six digits, however they were typed (spaces and hyphens included). */
export function normaliseTotpCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

export interface OtpauthInput {
  /** The product, as the authenticator app will list it. */
  readonly issuer: string;
  /** Who this is, so an admin with two accounts can tell them apart. */
  readonly account: string;
  readonly secretBase32: string;
}

/**
 * The `otpauth://` URI an authenticator app reads.
 *
 * Every parameter is spelled out rather than left to a default: apps
 * disagree about what the defaults are, and a disagreement here shows up as
 * codes that are always wrong.
 */
export function otpauthUri(input: OtpauthInput): string {
  const label = `${input.issuer}:${input.account}`;
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/**
 * The secret in groups of four, for an admin typing it in by hand.
 *
 * There is no QR code, deliberately — `docs/OPEN-QUESTIONS.md` has the
 * reasoning: a QR encoder is Reed-Solomon and a drawing routine, or a new
 * dependency in the one application that holds `DATABASE_URL`, and this
 * surface is used by a handful of people perhaps twice each.
 */
export function formatSecretForTyping(secretBase32: string): string {
  return (secretBase32.match(/.{1,4}/g) ?? []).join(" ");
}

/** A recovery code as it is shown and typed: five groups of four. */
export function formatRecoveryCode(raw: string): string {
  return (raw.toUpperCase().match(/.{1,4}/g) ?? []).join("-");
}

/** The inverse: what to hash and compare, whatever the spacing. */
export function normaliseRecoveryCode(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z2-7]{16}$/.test(cleaned) ? cleaned : null;
}

/** The roles a second factor can be required of (ROADMAP §3.1). */
export const SECOND_FACTOR_ROLES = Object.freeze(["ADMIN", "SUPER_ADMIN"] as const);
export type SecondFactorRole = (typeof SECOND_FACTOR_ROLES)[number];

/**
 * Is a second factor required of this role?
 *
 * Two inputs, and the distinction matters. `required` is the super-admin's
 * switch, and it decides whether an account that has NOT enrolled is made
 * to. Whether an account that HAS enrolled is asked for a code is not a
 * setting at all — it always is, and switching the policy off does not
 * weaken an account that already has a second factor.
 */
export function secondFactorRequiredOf(role: string, required: boolean): boolean {
  return required && (SECOND_FACTOR_ROLES as readonly string[]).includes(role);
}

/** The platform setting a super-admin writes. */
export const SECOND_FACTOR_SETTING_KEY = "security.secondFactor.requiredForAdmins";

export const TOTP_MESSAGES = Object.freeze({
  codeFormat: "Enter the six digits from your authenticator app.",
  codeWrong: "That code is not right. Check your authenticator app and try the next one.",
  codeReused:
    "That code has already been used. Wait for your authenticator app to show the next one.",
  challengeExpired: "That took too long. Sign in again.",
  tooManyAttempts: "Too many codes were tried. Sign in again.",
  recoveryWrong: "That recovery code is not right, or it has already been used.",
  enrolmentExpired: "The setup timed out. Start again to get a new secret.",
  enrolmentMismatch:
    "That code does not match the secret on this page. Check that your authenticator app has the right entry, and that your phone's clock is set automatically.",
  alreadyEnrolled: "This account already has an authenticator app set up.",
  notEnrolled: "This account has no authenticator app set up.",
  lastRecoveryCode:
    "That was your last recovery code. Generate a new set now — without one, losing your phone means asking a super-admin.",
});

/** What the pages are called, in one place. */
export const SECOND_FACTOR_PATHS = Object.freeze({
  /** Where a half-finished sign-in waits for a code. */
  verify: "/second-factor",
  /** Where an admin who must enrol is sent, and where enrolment happens. */
  enrol: "/account/two-factor",
});
