import { describe, expect, it, vi } from "vitest";

/**
 * The half of a second factor that holds a secret (Phase 16j).
 *
 * Two things are proved here that the pure suite cannot:
 *
 *   1. **The RFC 6238 test vectors.** They are the reason this
 *      implementation interoperates with an authenticator app somebody
 *      already has, and they need the real HMAC. The SHA-1 vectors are
 *      checked against the published table; a single wrong digit in any of
 *      them would mean every code is wrong, which is the one failure mode
 *      that cannot be noticed from inside.
 *   2. **The encryption at rest.** A tampered tag, a ciphertext moved to
 *      another account's row, a rotated key — each must make the credential
 *      unusable rather than decrypt to something.
 */

const h = vi.hoisted(() => ({
  // A key this test invents, for secrets this test makes. 32 bytes.
  env: { TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") as string | undefined },
}));
vi.mock("@/lib/env", () => ({ env: () => h.env, isProduction: () => false }));

const { decodeSecretBoxKey, openSecret, sealSecret } = await import("@/lib/crypto/secret-box");
const {
  codeAt,
  hashRecoveryCode,
  newRecoveryCodes,
  newSecret,
  openTotpSecret,
  recoveryCodeLookup,
  sealTotpSecret,
  secondFactorConfigured,
  totpContext,
  verifyCode,
} = await import("@/lib/auth/totp");
const { base32Encode, normaliseRecoveryCode, TOTP_SECRET_BYTES } = await import("@recx/shared");

/** The RFC 6238 §B.1 secret, "12345678901234567890" as ASCII. */
const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

describe("RFC 6238 test vectors (SHA-1)", () => {
  /** Appendix B, the SHA-1 rows, truncated to the 6 digits this product uses. */
  it.each([
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_111_111_111, "050471"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
    [20_000_000_000, "353130"],
  ])("at t=%i the code is %s", (seconds, expected) => {
    const counter = Math.floor(seconds / 30);
    expect(codeAt(RFC_SECRET, counter)).toBe(expected);
  });

  it("the vectors really exercise the truncation, not a constant", () => {
    // A sanity control: six different steps, six different codes.
    const codes = [59, 1_111_111_109, 1_111_111_111, 1_234_567_890, 2_000_000_000, 20_000_000_000].map((s) =>
      codeAt(RFC_SECRET, Math.floor(s / 30)),
    );
    expect(new Set(codes).size).toBe(6);
  });

  it("refuses a secret that is not base32", () => {
    expect(codeAt("not base32!", 1)).toBeNull();
    expect(codeAt("", 1)).toBeNull();
  });
});

describe("verifyCode", () => {
  const at = (seconds: number) => codeAt(RFC_SECRET, Math.floor(seconds / 30))!;

  it("accepts the code for now and reports the step it matched", () => {
    const now = 1_111_111_109;
    const result = verifyCode({ secretBase32: RFC_SECRET, typed: at(now), nowSeconds: now, lastCounter: null });
    expect(result).toEqual({ ok: true, counter: Math.floor(now / 30) });
  });

  it("accepts one step either side, so a phone half a minute out still works", () => {
    const now = 1_111_111_109;
    const step = Math.floor(now / 30);
    for (const offset of [-1, 0, 1]) {
      const typed = codeAt(RFC_SECRET, step + offset)!;
      const result = verifyCode({ secretBase32: RFC_SECRET, typed, nowSeconds: now, lastCounter: null });
      expect(result, `offset ${offset}`).toEqual({ ok: true, counter: step + offset });
    }
  });

  it("refuses two steps away", () => {
    const now = 1_111_111_109;
    const step = Math.floor(now / 30);
    for (const offset of [-2, 2, -10, 10]) {
      const typed = codeAt(RFC_SECRET, step + offset)!;
      expect(verifyCode({ secretBase32: RFC_SECRET, typed, nowSeconds: now, lastCounter: null }), `offset ${offset}`)
        .toEqual({ ok: false, problem: "wrong" });
    }
  });

  it("refuses a code that has already been used, and says so", () => {
    // The distinction matters on screen: "wait for the next one" is a
    // different instruction from "that is wrong".
    const now = 1_111_111_109;
    const step = Math.floor(now / 30);
    expect(verifyCode({ secretBase32: RFC_SECRET, typed: at(now), nowSeconds: now, lastCounter: step })).toEqual({
      ok: false,
      problem: "reused",
    });
    // And an OLDER step inside the window is refused too, which is the
    // case a replay would actually use.
    const previous = codeAt(RFC_SECRET, step - 1)!;
    expect(verifyCode({ secretBase32: RFC_SECRET, typed: previous, nowSeconds: now, lastCounter: step })).toEqual({
      ok: false,
      problem: "reused",
    });
  });

  it("still accepts the NEXT step after one has been used", () => {
    const now = 1_111_111_109;
    const step = Math.floor(now / 30);
    const next = codeAt(RFC_SECRET, step + 1)!;
    expect(verifyCode({ secretBase32: RFC_SECRET, typed: next, nowSeconds: now, lastCounter: step })).toEqual({
      ok: true,
      counter: step + 1,
    });
  });

  it("refuses a badly shaped code before it computes anything", () => {
    for (const typed of ["", "12345", "1234567", "abcdef", null, 123_456]) {
      expect(verifyCode({ secretBase32: RFC_SECRET, typed, nowSeconds: 0, lastCounter: null }), String(typed)).toEqual({
        ok: false,
        problem: "format",
      });
    }
  });

  it("reports an unreadable secret rather than a wrong code", () => {
    expect(verifyCode({ secretBase32: "not base32!", typed: "000000", nowSeconds: 0, lastCounter: null })).toEqual({
      ok: false,
      problem: "unreadable",
    });
  });
});

describe("the secret at rest", () => {
  it("is sealed and opened for the account it belongs to", async () => {
    const secret = newSecret();
    const sealed = await sealTotpSecret({ userId: "user_a", secretBase32: secret });
    expect(sealed).not.toContain(secret);
    expect(await openTotpSecret({ userId: "user_a", sealed })).toBe(secret);
  });

  it("is a different ciphertext every time, so two admins with one secret cannot be spotted", async () => {
    const secret = newSecret();
    const first = await sealTotpSecret({ userId: "user_a", secretBase32: secret });
    const second = await sealTotpSecret({ userId: "user_a", secretBase32: secret });
    expect(first).not.toBe(second);
    expect(await openTotpSecret({ userId: "user_a", sealed: second })).toBe(secret);
  });

  it("cannot be opened for another account", async () => {
    // The associated data binds a ciphertext to its row: a column value
    // copied from one account to another fails rather than handing over
    // somebody else's second factor.
    const sealed = await sealTotpSecret({ userId: "user_a", secretBase32: newSecret() });
    expect(await openTotpSecret({ userId: "user_b", sealed })).toBeNull();
  });

  it("cannot be opened after the key changes", async () => {
    const sealed = await sealTotpSecret({ userId: "user_a", secretBase32: newSecret() });
    const original = h.env.TOTP_ENCRYPTION_KEY;
    h.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    expect(await openTotpSecret({ userId: "user_a", sealed })).toBeNull();
    h.env.TOTP_ENCRYPTION_KEY = original;
  });

  it("refuses a tampered tag or body", async () => {
    const sealed = await sealTotpSecret({ userId: "user_a", secretBase32: newSecret() });
    const parts = sealed.split(".");
    const flip = (value: string) => {
      const bytes = Buffer.from(value, "base64url");
      bytes[0] = bytes[0]! ^ 0x01;
      return bytes.toString("base64url");
    };
    for (const index of [1, 2, 3]) {
      const broken = [...parts];
      broken[index] = flip(parts[index]!);
      expect(await openTotpSecret({ userId: "user_a", sealed: broken.join(".") }), `part ${index}`).toBeNull();
    }
  });

  it("refuses a value that is not one of these at all", async () => {
    for (const bad of ["", "v1", "v1.a.b", "v2.a.b.c", "plain text", "a.b.c.d"]) {
      expect(await openTotpSecret({ userId: "user_a", sealed: bad }), bad).toBeNull();
    }
  });

  it("names the account in the associated data", () => {
    expect(totpContext("user_a")).toBe("totp:user_a");
    expect(totpContext("user_b")).not.toBe(totpContext("user_a"));
  });

  it("mints a 160-bit secret", () => {
    const secret = newSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret).toHaveLength(Math.ceil((TOTP_SECRET_BYTES * 8) / 5));
    // And a different one each time.
    expect(new Set([newSecret(), newSecret(), newSecret()]).size).toBe(3);
  });
});

describe("secret-box, on its own terms", () => {
  const KEY = Buffer.alloc(32, 3).toString("base64");

  it("accepts a key as base64, base64url or hex", () => {
    const raw = Buffer.alloc(32, 5);
    for (const encoding of ["base64", "base64url", "hex"] as const) {
      const decoded = decodeSecretBoxKey(raw.toString(encoding));
      expect(decoded, encoding).not.toBeNull();
      expect(decoded!.equals(raw), encoding).toBe(true);
    }
  });

  it("refuses a key of the wrong length", () => {
    for (const bytes of [16, 24, 31, 33, 64]) {
      expect(decodeSecretBoxKey(Buffer.alloc(bytes, 1).toString("base64")), String(bytes)).toBeNull();
    }
    expect(decodeSecretBoxKey("")).toBeNull();
    expect(decodeSecretBoxKey("not a key")).toBeNull();
  });

  it("throws on a bad key format rather than answering null", () => {
    // A deployment fault must not look like a bad credential: null means
    // "this credential is unusable", and a short key means "this
    // deployment is misconfigured", and the two want different answers.
    expect(() => sealSecret({ key: "too short", plaintext: "x", context: "c" })).toThrow(/32 bytes/);
    expect(() => openSecret({ key: "too short", sealed: "v1.a.b.c", context: "c" })).toThrow(/32 bytes/);
  });

  it("refuses a ciphertext whose context does not match", () => {
    const sealed = sealSecret({ key: KEY, plaintext: "the secret", context: "totp:a" });
    expect(openSecret({ key: KEY, sealed, context: "totp:a" })).toBe("the secret");
    expect(openSecret({ key: KEY, sealed, context: "totp:b" })).toBeNull();
    expect(openSecret({ key: KEY, sealed, context: "" })).toBeNull();
  });

  it("round-trips text with characters a naive encoding would break", () => {
    for (const plaintext of ["", "MZXW6YTBOI", "a.b.c.d", "आईपी", "line\nbreak", "·".repeat(100)]) {
      const sealed = sealSecret({ key: KEY, plaintext, context: "c" });
      expect(openSecret({ key: KEY, sealed, context: "c" }), JSON.stringify(plaintext)).toBe(plaintext);
    }
  });
});

describe("recovery codes", () => {
  it("mints ten, each in the format the verifier accepts, with their hashes", () => {
    const { shown, hashes } = newRecoveryCodes();
    expect(shown).toHaveLength(10);
    expect(hashes).toHaveLength(10);
    expect(new Set(shown).size).toBe(10);
    expect(new Set(hashes).size).toBe(10);
    for (const code of shown) {
      expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
      // The code as shown must look up to the hash as stored, or the codes
      // are decorative.
      expect(hashes).toContain(hashRecoveryCode(normaliseRecoveryCode(code)!));
    }
  });

  it("stores only a sha256, which the shown code cannot be read out of", () => {
    const { shown, hashes } = newRecoveryCodes();
    for (const hash of hashes) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      for (const code of shown) expect(hash).not.toContain(code.replace(/-/g, ""));
    }
  });

  it("looks a typed code up however it was typed, and refuses a malformed one", () => {
    const { shown, hashes } = newRecoveryCodes();
    const code = shown[0]!;
    for (const typed of [code, code.toLowerCase(), code.replace(/-/g, " "), code.replace(/-/g, "")]) {
      expect(recoveryCodeLookup(typed), typed).toBe(hashes[0]);
    }
    for (const bad of ["", "short", "MZXW-6YTB-OIMZ", null, 7]) {
      expect(recoveryCodeLookup(bad), String(bad)).toBeNull();
    }
  });

  it("is a different set every time", () => {
    const first = newRecoveryCodes().shown;
    const second = newRecoveryCodes().shown;
    expect(first.some((code) => second.includes(code))).toBe(false);
  });
});

describe("whether a second factor is available at all", () => {
  it("follows the encryption key", () => {
    expect(secondFactorConfigured()).toBe(true);
    const original = h.env.TOTP_ENCRYPTION_KEY;
    h.env.TOTP_ENCRYPTION_KEY = undefined;
    expect(secondFactorConfigured()).toBe(false);
    h.env.TOTP_ENCRYPTION_KEY = original;
  });

  it("throws rather than silently refusing a correct code when the key is missing", async () => {
    const original = h.env.TOTP_ENCRYPTION_KEY;
    h.env.TOTP_ENCRYPTION_KEY = undefined;
    await expect(sealTotpSecret({ userId: "user_a", secretBase32: "MZXW6YTBOI" })).rejects.toThrow(
      /TOTP_ENCRYPTION_KEY/,
    );
    h.env.TOTP_ENCRYPTION_KEY = original;
  });
});
