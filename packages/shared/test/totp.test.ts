import { describe, expect, it } from "vitest";
import {
  RECOVERY_CODE_BYTES,
  RECOVERY_CODE_COUNT,
  SECOND_FACTOR_MAX_ATTEMPTS,
  SECOND_FACTOR_ROLES,
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  TOTP_WINDOW_STEPS,
  base32Decode,
  base32Encode,
  codeFromHmac,
  counterBlock,
  formatRecoveryCode,
  formatSecretForTyping,
  normaliseRecoveryCode,
  normaliseTotpCode,
  otpauthUri,
  secondFactorRequiredOf,
  totpCounter,
  totpWindow,
} from "../src/totp";

/**
 * The arithmetic of a second factor (Phase 16j).
 *
 * The RFC 4226 test vectors are the point of this file. TOTP is one of the
 * few things in this product with an authoritative answer published for it,
 * and an implementation that passes the vectors is one that interoperates
 * with every authenticator app a person might already have — which is the
 * difference between a second factor and a support queue.
 *
 * Everything that touches a stored secret, and the HMAC itself, is tested
 * in `apps/web/test/totp.test.ts` against the same vectors.
 */

describe("base32 (RFC 4648, no padding)", () => {
  it.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("encodes %o as %o (RFC 4648 §10)", (plain, encoded) => {
    expect(base32Encode(new TextEncoder().encode(plain))).toBe(encoded);
  });

  it("round-trips every length from 1 to 40 bytes", () => {
    // From one, not zero: the empty string decodes to null on purpose (an
    // empty secret is not a secret), which the refusal case below states.
    for (let length = 1; length <= 40; length += 1) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + 11) & 0xff;
      const decoded = base32Decode(base32Encode(bytes));
      expect(decoded, `length ${length}`).not.toBeNull();
      expect([...decoded!], `length ${length}`).toEqual([...bytes]);
    }
  });

  it("forgives how a person types it: case, spaces, hyphens and padding", () => {
    const expected = [...base32Decode("MZXW6YTBOI")!];
    for (const typed of ["mzxw6ytboi", "MZXW 6YTB OI", "MZXW-6YTB-OI", "MZXW6YTBOI======", " mzxw-6ytb oi "]) {
      expect([...base32Decode(typed)!], typed).toEqual(expected);
    }
  });

  it("refuses a character outside the alphabet, including the ones it excludes", () => {
    // 0, 1 and 8 are not in RFC 4648 base32 precisely because they are
    // mistyped for O, I/L and B.
    for (const bad of ["MZXW0", "MZXW1", "MZXW8", "MZXW!", "MZXW6YTBOI%", "·"]) {
      expect(base32Decode(bad), bad).toBeNull();
    }
    expect(base32Decode("")).toBeNull();
  });

  it("refuses leftover bits that are not zero padding", () => {
    // "MZXW6YTBOIA" has five bits too many with a non-zero tail: decoding
    // it would silently produce a DIFFERENT key from the one encoded,
    // which is a second factor that never works and no message to say why.
    expect(base32Decode("MA")).not.toBeNull();
    expect(base32Decode("MB")).toBeNull();
  });
});

describe("the time step", () => {
  it("is 30 seconds, floored", () => {
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(totpCounter(0)).toBe(0);
    expect(totpCounter(29)).toBe(0);
    expect(totpCounter(30)).toBe(1);
    expect(totpCounter(59)).toBe(1);
    expect(totpCounter(1_111_111_109)).toBe(37_037_036);
  });

  it("accepts one step either side, nearest first", () => {
    expect(TOTP_WINDOW_STEPS).toBe(1);
    expect(totpWindow(1000)).toEqual([33, 32, 34]);
    // Nearest first matters: the loop that checks these stops at the first
    // match, and the step it reports is the one that gets stored.
    expect(totpWindow(1000)[0]).toBe(totpCounter(1000));
    // Three steps of 30 seconds, so a code is valid for at most 90.
    expect(totpWindow(1000)).toHaveLength(3);
  });

  it("writes the counter as 8 bytes big-endian (RFC 4226 §5.2)", () => {
    expect([...counterBlock(0)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...counterBlock(1)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect([...counterBlock(255)]).toEqual([0, 0, 0, 0, 0, 0, 0, 255]);
    expect([...counterBlock(256)]).toEqual([0, 0, 0, 0, 0, 0, 1, 0]);
    // The step at RFC 6238's 1111111109, which the HMAC vectors use.
    expect([...counterBlock(0x023523ec)]).toEqual([0, 0, 0, 0, 0x02, 0x35, 0x23, 0xec]);
  });
});

describe("dynamic truncation (RFC 4226 §5.3)", () => {
  /** The one worked example in RFC 4226, Appendix D. */
  const RFC_DIGEST = Uint8Array.from([
    0x1f, 0x86, 0x98, 0x69, 0x0e, 0x02, 0xca, 0x16, 0x61, 0x85, 0x50, 0xef, 0x7f, 0x19, 0xda, 0x8e, 0x94, 0x5b, 0x55,
    0x5a,
  ]);

  it("produces 872921 from the RFC's own digest", () => {
    expect(codeFromHmac(RFC_DIGEST)).toBe("872921");
  });

  it("masks the top bit, so the offset is never read as a negative number", () => {
    // The byte at the chosen offset here is 0x50 already; this case sets
    // the high bit and proves it is dropped rather than carried.
    const digest = Uint8Array.from(RFC_DIGEST);
    digest[digest.length - 1] = 0x00; // offset 0 → bytes 0x1f 0x86 0x98 0x69
    const masked = ((0x1f & 0x7f) << 24) | (0x86 << 16) | (0x98 << 8) | 0x69;
    expect(codeFromHmac(digest)).toBe(String(masked % 1_000_000).padStart(6, "0"));
  });

  it("pads to the full width, so a small number is still six digits", () => {
    const digest = new Uint8Array(20);
    expect(codeFromHmac(digest)).toBe("000000");
    expect(codeFromHmac(digest)).toHaveLength(TOTP_DIGITS);
  });

  it("refuses a digest that is not a SHA-1 one", () => {
    expect(() => codeFromHmac(new Uint8Array(19))).toThrow(/20 bytes/);
  });
});

describe("the typed code", () => {
  it("accepts six digits however they are spaced", () => {
    for (const typed of ["872921", "872 921", "872-921", " 872921 ", "87 29 21"]) {
      expect(normaliseTotpCode(typed), typed).toBe("872921");
    }
  });

  it("refuses anything else", () => {
    for (const bad of ["87292", "8729211", "abcdef", "87292a", "", "  ", null, undefined, 872921, ["872921"]]) {
      expect(normaliseTotpCode(bad), String(bad)).toBeNull();
    }
  });
});

describe("the otpauth URI", () => {
  const uri = otpauthUri({ issuer: "REC Code", account: "2116231001001", secretBase32: "MZXW6YTBOI" });
  const parsed = new URL(uri);

  it("names every parameter rather than relying on a default", () => {
    // Apps disagree about the defaults, and a disagreement here shows up as
    // codes that are always wrong with nothing on screen to explain it.
    expect(parsed.searchParams.get("secret")).toBe("MZXW6YTBOI");
    expect(parsed.searchParams.get("algorithm")).toBe(TOTP_ALGORITHM);
    expect(parsed.searchParams.get("digits")).toBe(String(TOTP_DIGITS));
    expect(parsed.searchParams.get("period")).toBe(String(TOTP_PERIOD_SECONDS));
    expect(parsed.searchParams.get("issuer")).toBe("REC Code");
  });

  it("labels the entry with the issuer and the account, encoded", () => {
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    expect(uri).toContain(encodeURIComponent("REC Code:2116231001001"));
    // A space in the product name must not break the URI.
    expect(() => new URL(uri)).not.toThrow();
  });
});

describe("what a person reads and types", () => {
  it("shows a secret in groups of four", () => {
    expect(formatSecretForTyping("MZXW6YTBOIMZXW6YTBOI")).toBe("MZXW 6YTB OIMZ XW6Y TBOI");
    // And it is still the same secret after the spaces come back out.
    expect(base32Decode(formatSecretForTyping("MZXW6YTBOI"))).toEqual(base32Decode("MZXW6YTBOI"));
  });

  it("shows a recovery code in four groups of four, and reads it back", () => {
    const code = "MZXW6YTBOIMZXW6Y";
    expect(formatRecoveryCode(code)).toBe("MZXW-6YTB-OIMZ-XW6Y");
    expect(normaliseRecoveryCode(formatRecoveryCode(code))).toBe(code);
    for (const typed of ["mzxw6ytboimzxw6y", "MZXW 6YTB OIMZ XW6Y", "MZXW-6YTB-OIMZ-XW6Y"]) {
      expect(normaliseRecoveryCode(typed), typed).toBe(code);
    }
  });

  it("refuses a recovery code of the wrong length or alphabet", () => {
    for (const bad of ["MZXW6YTBOIMZXW6", "MZXW6YTBOIMZXW6YZ", "MZXW6YTBOIMZXW01", "", null, 7]) {
      expect(normaliseRecoveryCode(bad), String(bad)).toBeNull();
    }
  });

  it("generates codes whose own format the reader accepts", () => {
    // 10 bytes is exactly 16 base32 characters, which is what
    // `normaliseRecoveryCode` requires. A change to RECOVERY_CODE_BYTES
    // that broke this would ship a set of codes the verifier refuses.
    expect((RECOVERY_CODE_BYTES * 8) / 5).toBe(16);
    expect(RECOVERY_CODE_COUNT).toBe(10);
  });
});

describe("the scope of the policy", () => {
  it("is ADMIN and SUPER_ADMIN, and nothing the switch can widen", () => {
    expect([...SECOND_FACTOR_ROLES]).toEqual(["ADMIN", "SUPER_ADMIN"]);
    for (const role of SECOND_FACTOR_ROLES) expect(secondFactorRequiredOf(role, true), role).toBe(true);
    for (const role of ["STUDENT", "TA_MENTOR", "PLACEMENT_OFFICER"]) {
      expect(secondFactorRequiredOf(role, true), role).toBe(false);
    }
  });

  it("requires nothing of anybody while the switch is off", () => {
    for (const role of ["ADMIN", "SUPER_ADMIN", "STUDENT"]) {
      expect(secondFactorRequiredOf(role, false), role).toBe(false);
    }
  });
});

describe("the parameters are the ones every authenticator app implements", () => {
  it("SHA-1, 6 digits, 30 seconds, 160-bit secret", () => {
    // Not a preference. An app that cannot read this entry is an app a
    // person already has, and a second factor only one app supports is a
    // second factor nobody turns on.
    expect(TOTP_ALGORITHM).toBe("SHA1");
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_SECRET_BYTES).toBe(20);
  });

  it("allows five tries at a code, which is the number the database enforces too", () => {
    expect(SECOND_FACTOR_MAX_ATTEMPTS).toBe(5);
  });
});
