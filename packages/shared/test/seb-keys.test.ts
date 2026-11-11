import { describe, expect, it } from "vitest";
import { normaliseSebKey, parseSebKey, sebSettingKey } from "../src/seb";

/**
 * Reading a key an administrator typed (Phase 12z).
 *
 * The cost of getting this wrong is asymmetric and worth stating: a key
 * accepted with a typo refuses every candidate in the hall at nine in the
 * morning, with a message about Safe Exam Browser that tells nobody the
 * key is wrong. A key refused for a stray space sends somebody back to a
 * window they already had open. So: strict about what a key IS, forgiving
 * about how it was copied.
 */

const DIGEST = "a".repeat(64);

describe("a key as it is typed", () => {
  it("takes the digest SEB shows", () => {
    expect(parseSebKey(DIGEST)).toEqual({ ok: true, key: DIGEST });
  });

  it("forgives the way a copy-paste arrives", () => {
    expect(parseSebKey(`  ${DIGEST.toUpperCase()}  `)).toEqual({ ok: true, key: DIGEST });
    expect(parseSebKey(`${DIGEST.slice(0, 32)} ${DIGEST.slice(32)}`)).toEqual({ ok: true, key: DIGEST });
  });

  it("reads an empty box as 'not set' rather than as a key", () => {
    expect(parseSebKey("")).toEqual({ ok: true, key: null });
    expect(parseSebKey("   ")).toEqual({ ok: true, key: null });
    expect(parseSebKey(null)).toEqual({ ok: true, key: null });
    expect(parseSebKey(undefined)).toEqual({ ok: true, key: null });
  });

  it("refuses something that is not a digest at all", () => {
    // Each of these is a real way to get it wrong: the whole config file
    // pasted in, a truncated copy, and a key with one letter outside hex.
    expect(parseSebKey("<?xml version=\"1.0\"?>")).toEqual({ ok: false });
    expect(parseSebKey("abc123")).toEqual({ ok: false });
    expect(parseSebKey(`${DIGEST.slice(0, 63)}z`)).toEqual({ ok: false });
  });

  it("normalises without deciding whether it is valid", () => {
    expect(normaliseSebKey("  AB cd  ")).toBe("abcd");
  });
});

describe("where a pair is stored", () => {
  it("is the college by default and a hall by id", () => {
    expect(sebSettingKey(null)).toBe("seb");
    expect(sebSettingKey("sess_1")).toBe("seb:sess_1");
  });
});
