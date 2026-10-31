import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  EXPORT_CODE_LENGTH,
  EXPORT_CODE_PATTERN,
  canonicalisePayload,
  profileExportPayloadSchema,
  type ProfileExportPayload,
} from "@recx/shared";
import { env } from "@/lib/env";

/**
 * The signed export's HMAC (Phase 9f).
 *
 * Deliberately the only file in the repo that touches `EXPORT_SIGNING_SECRET`,
 * and deliberately separate from `packages/shared` — which keeps no
 * `node:crypto` import, so the payload and its canonical form stay usable
 * from anywhere while the key material has exactly one home.
 *
 * `EXPORT_SIGNING_SECRET` is its own secret rather than a reuse of anything
 * else the server holds. The reasoning, since this platform has no single
 * "app secret" to reuse: a verify key is the one secret that is exercised by
 * strangers on a public route, so it is the one most likely to be found
 * wrong — and a key that could also mint a session, read an IP pepper or
 * sign an internal token would turn that into an account compromise. Here,
 * the worst a leaked verify key can do is let somebody forge a statement
 * about their own practice record.
 *
 * Verification RE-DERIVES the signature from the stored payload rather than
 * comparing stored signatures. That is the whole point: if the payload in the
 * row were ever altered, a stored-signature comparison would still pass and a
 * re-derivation fails.
 */

const ALGORITHM = "HMAC-SHA256";

/**
 * The signing key.
 *
 * Read through `env()` so a missing or short key fails at the first use with
 * the same message every other misconfiguration gives, rather than silently
 * producing signatures nobody can verify after a rotation.
 */
function secret(): string {
  return env().EXPORT_SIGNING_SECRET;
}

/** A fresh public code: 24 url-safe characters from a CSPRNG. */
export function newExportCode(): string {
  // 18 bytes is exactly 24 base64 characters with no padding, so there is no
  // slicing and therefore no silently-shortened code.
  const code = randomBytes(18).toString("base64url");
  /**
   * The PATTERN rather than the `isExportCode` type guard: that guard is
   * `value is string`, and narrowing a value which is already a string makes
   * the negative branch `never`, so the check does not compile. The guard is
   * for untrusted input (a route param); this is a self-check on our own
   * output.
   */
  if (!EXPORT_CODE_PATTERN.test(code)) {
    throw new Error(`Generated an export code of the wrong shape (${code.length} chars, want ${EXPORT_CODE_LENGTH}).`);
  }
  return code;
}

/**
 * The signature over a payload, bound to its code.
 *
 * The CODE is part of the signed message, not just the payload. Without it, a
 * signature lifted from one row would verify against another row holding the
 * same facts — which matters the moment a student issues two exports, revokes
 * one, and somebody swaps the codes.
 */
export function signPayload(code: string, payload: ProfileExportPayload): string {
  return createHmac("sha256", secret()).update(`${ALGORITHM}\n${code}\n${canonicalisePayload(payload)}`).digest("hex");
}

export type VerifyResult =
  | { readonly ok: true; readonly payload: ProfileExportPayload }
  /** The stored row does not match its signature, or cannot be read as a payload. */
  | { readonly ok: false; readonly reason: "SIGNATURE" | "SHAPE" | "ALGORITHM" };

/**
 * Re-derive and compare, in constant time.
 *
 * Returns a reason rather than a boolean so the verify page can tell "this
 * link was altered" from "this row predates a schema change", and say the
 * right thing instead of the alarming thing.
 */
export function verifyStored(row: {
  readonly code: string;
  readonly payload: unknown;
  readonly signature: string;
  readonly algorithm: string;
}): VerifyResult {
  if (row.algorithm !== ALGORITHM) return { ok: false, reason: "ALGORITHM" };

  const parsed = profileExportPayloadSchema.safeParse(row.payload);
  if (!parsed.success) return { ok: false, reason: "SHAPE" };

  const expected = signPayload(row.code, parsed.data);
  // Both are hex of the same length by construction, but a length mismatch
  // would make timingSafeEqual throw, so it is checked first.
  if (expected.length !== row.signature.length) return { ok: false, reason: "SIGNATURE" };
  const same = timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(row.signature, "utf8"));
  return same ? { ok: true, payload: parsed.data } : { ok: false, reason: "SIGNATURE" };
}

export const EXPORT_ALGORITHM = ALGORITHM;
