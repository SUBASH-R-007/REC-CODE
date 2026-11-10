import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  RECOVERY_CODE_BYTES,
  RECOVERY_CODE_COUNT,
  TOTP_SECRET_BYTES,
  base32Encode,
  base32Decode,
  codeFromHmac,
  counterBlock,
  formatRecoveryCode,
  normaliseRecoveryCode,
  normaliseTotpCode,
  totpWindow,
} from "@recx/shared";
import { env } from "@/lib/env";

/**
 * A second factor for privileged accounts: the half that holds a secret
 * (Phase 16j).
 *
 * The arithmetic — base32, the time step, RFC 4226 truncation, the
 * `otpauth://` URI — is `@recx/shared`'s `totp.ts`, which has the reasoning
 * for the parameters and is importable by the browser. This file is the
 * HMAC, the encryption at rest, and the recovery codes.
 *
 * **Nothing here logs or returns a secret.** `newSecret()` hands a base32
 * string to exactly one caller (the enrolment action, which shows it once
 * and seals it), `verifyCode()` takes a sealed secret and answers with the
 * time step that matched, and the recovery codes are returned once at
 * generation and stored as sha256. A reader of an audit row learns that a
 * second factor was set up or used, never which secret or which code.
 */

/** sha256, hex — the same shape as every other one-way value here. */
export function hashRecoveryCode(normalised: string): string {
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

/** Is a second factor usable on this deployment at all? */
export function secondFactorConfigured(): boolean {
  return Boolean(env().TOTP_ENCRYPTION_KEY);
}

function encryptionKey(): string {
  const key = env().TOTP_ENCRYPTION_KEY;
  if (!key) {
    // Reachable only by a caller that skipped `secondFactorConfigured()`;
    // throwing names the deployment fault rather than silently refusing a
    // correct code.
    throw new Error("totp: TOTP_ENCRYPTION_KEY is not set, so no second factor can be read or written");
  }
  return key;
}

/** The associated data a sealed secret is bound to: this account's row. */
export function totpContext(userId: string): string {
  return `totp:${userId}`;
}

/** A fresh 160-bit secret, base32, for one enrolment. */
export function newSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/** Seal a secret for storage. */
export async function sealTotpSecret(input: { userId: string; secretBase32: string }): Promise<string> {
  const { sealSecret } = await import("@/lib/crypto/secret-box");
  return sealSecret({
    key: encryptionKey(),
    plaintext: input.secretBase32,
    context: totpContext(input.userId),
  });
}

/** Open one, or null if it cannot be read (a rotated key, a tampered row). */
export async function openTotpSecret(input: { userId: string; sealed: string }): Promise<string | null> {
  const { openSecret } = await import("@/lib/crypto/secret-box");
  return openSecret({ key: encryptionKey(), sealed: input.sealed, context: totpContext(input.userId) });
}

/** The code a given secret produces for a given 30-second step. */
export function codeAt(secretBase32: string, counter: number): string | null {
  const key = base32Decode(secretBase32);
  if (!key || key.length === 0) return null;
  const digest = createHmac("sha1", Buffer.from(key)).update(Buffer.from(counterBlock(counter))).digest();
  return codeFromHmac(new Uint8Array(digest));
}

export type CodeProblem = "format" | "unreadable" | "wrong" | "reused";

/**
 * Check a typed code against a secret.
 *
 * The answer on success is the time STEP that matched, not just `true`,
 * because the caller must store it: a code is good for one use, and the
 * monotonic `lastCounter` (enforced by a trigger) is what makes that true
 * even when two requests race.
 *
 * `lastCounter` is compared here as well as in the database so that the
 * ordinary case gives the person the right sentence — "that code has
 * already been used, wait for the next one" rather than a failure.
 */
export function verifyCode(input: {
  secretBase32: string;
  typed: unknown;
  nowSeconds: number;
  lastCounter: number | null;
}): { ok: true; counter: number } | { ok: false; problem: CodeProblem } {
  const code = normaliseTotpCode(input.typed);
  if (!code) return { ok: false, problem: "format" };
  if (!base32Decode(input.secretBase32)) return { ok: false, problem: "unreadable" };

  for (const counter of totpWindow(input.nowSeconds)) {
    const expected = codeAt(input.secretBase32, counter);
    if (expected === null) return { ok: false, problem: "unreadable" };
    // Constant time, so a wrong code does not leak how much of it was right.
    if (!timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(code, "utf8"))) continue;
    if (input.lastCounter !== null && counter <= input.lastCounter) return { ok: false, problem: "reused" };
    return { ok: true, counter };
  }
  return { ok: false, problem: "wrong" };
}

/**
 * A fresh set of recovery codes: the strings to show once, and the hashes to
 * store.
 *
 * 80 bits each, base32 so there is no 0/O or 1/l to mistype, in groups of
 * four. Ten of them, which is `RECOVERY_CODE_COUNT`.
 */
export function newRecoveryCodes(): { shown: string[]; hashes: string[] } {
  const shown: string[] = [];
  const hashes: string[] = [];
  for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
    const raw = base32Encode(randomBytes(RECOVERY_CODE_BYTES));
    const normalised = normaliseRecoveryCode(raw);
    if (!normalised) {
      // 10 bytes is exactly 16 base32 characters, so this cannot happen;
      // the check is here rather than a comment because a change to
      // RECOVERY_CODE_BYTES that broke the format would otherwise ship a
      // set of codes the verifier refuses.
      throw new Error("totp: a generated recovery code does not match the format the verifier accepts");
    }
    shown.push(formatRecoveryCode(normalised));
    hashes.push(hashRecoveryCode(normalised));
  }
  return { shown, hashes };
}

/** The hash to look a typed recovery code up by, or null if it is not one. */
export function recoveryCodeLookup(typed: unknown): string | null {
  const normalised = normaliseRecoveryCode(typed);
  return normalised === null ? null : hashRecoveryCode(normalised);
}

/** sha256 of a challenge token, like a session's. */
export function hashChallengeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A challenge token: 256 bits, the cookie's only copy. */
export function newChallengeToken(): string {
  return randomBytes(32).toString("base64url");
}
