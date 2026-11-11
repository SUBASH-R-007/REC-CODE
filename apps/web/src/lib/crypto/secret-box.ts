import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Authenticated encryption for the few secrets this platform stores on
 * behalf of a person rather than hashes of (Phase 16j).
 *
 * There is exactly one of those so far: a TOTP secret. Everything else that
 * proves identity here is stored as a hash — passwords (argon2), session
 * tokens, password-reset links, recovery codes — because the server never
 * needs the original. A TOTP secret is different in kind: the server has to
 * compute the same HMAC the phone computes, so it must hold the key itself.
 *
 * **Why not plaintext.** `docs/SECURITY.md` §9 treats a database dump as a
 * thing that can happen — the backup documentation in `docs/RUNBOOK.md`
 * §2.13 exists because dumps are taken on purpose. A plaintext TOTP column
 * would make every second factor in that dump a working second factor, which
 * would mean the backup was now a credential store. The key lives in the
 * environment (a Docker secret in production), so a dump on its own is not
 * enough.
 *
 * **What this is not.** It is not a key-management system and does not
 * pretend to be: one key, no rotation ceremony, no envelope. Rotating it
 * invalidates every stored secret, and the honest consequence — every admin
 * re-enrols — is written down in `docs/RUNBOOK.md` §2.22 rather than papered
 * over with a scheme nobody would operate correctly.
 *
 * AES-256-GCM, a fresh 96-bit nonce per message, and the associated data
 * binds a ciphertext to the row it belongs to — so a cipher text moved from
 * one account to another fails to decrypt rather than decrypting to somebody
 * else's secret.
 */

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** `v1.<nonce>.<tag>.<ciphertext>`, each part base64url. */
const PREFIX = "v1";

export class SecretBoxError extends Error {}

/**
 * The key, decoded and checked.
 *
 * Accepts base64, base64url or hex, because an operator generating 32 bytes
 * will reach for whichever their shell makes easy, and refusing the wrong
 * encoding at boot with a clear sentence is better than accepting a short
 * key quietly.
 */
export function decodeSecretBoxKey(value: string): Buffer | null {
  const trimmed = value.trim();
  for (const encoding of ["base64url", "base64", "hex"] as const) {
    try {
      const decoded = Buffer.from(trimmed, encoding);
      if (decoded.length === KEY_BYTES) return decoded;
    } catch {
      // try the next encoding
    }
  }
  return null;
}

function keyOrThrow(key: string): Buffer {
  const decoded = decodeSecretBoxKey(key);
  if (!decoded) throw new SecretBoxError("secret-box: the key must decode to 32 bytes (base64, base64url or hex)");
  return decoded;
}

/**
 * Encrypt a short string.
 *
 * `context` is the associated data: pass something that identifies the place
 * this value is stored, such as `totp:<userId>`. It is authenticated but not
 * encrypted, and a mismatch on decryption is a failure rather than a
 * different plaintext.
 */
export function sealSecret(input: { key: string; plaintext: string; context: string }): string {
  const key = keyOrThrow(input.key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  cipher.setAAD(Buffer.from(input.context, "utf8"));
  const body = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, nonce.toString("base64url"), tag.toString("base64url"), body.toString("base64url")].join(".");
}

/**
 * Decrypt one, or return null.
 *
 * Null rather than a throw for every way a value can be wrong — a tampered
 * tag, a truncated column, a ciphertext from another row, a key that has
 * been rotated — because every caller's answer to all of those is the same:
 * treat this credential as unusable. A wrong KEY FORMAT does throw, because
 * that is a deployment fault and must not look like a bad credential.
 */
export function openSecret(input: { key: string; sealed: string; context: string }): string | null {
  const key = keyOrThrow(input.key);
  const parts = input.sealed.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const nonce = Buffer.from(parts[1]!, "base64url");
    const tag = Buffer.from(parts[2]!, "base64url");
    const body = Buffer.from(parts[3]!, "base64url");
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAAD(Buffer.from(input.context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // GCM's final() throws on a bad tag, which is the case this exists for.
    return null;
  }
}

/** Constant-time comparison of two hex digests of the same length. */
export function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
