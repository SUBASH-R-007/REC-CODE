import { describe, expect, it } from "vitest";
import { TOPICS } from "../src/topics";
import {
  EXPORT_CODE_PATTERN,
  EXPORT_DEFAULT_DAYS,
  EXPORT_PAYLOAD_VERSION,
  FORBIDDEN_PAYLOAD_KEYS,
  MAX_LIVE_EXPORTS,
  VERIFY_COPY,
  canonicalise,
  canonicalisePayload,
  forbiddenKeysIn,
  isExportCode,
  profileExportPayloadSchema,
  topicsTouched,
  type ProfileExportPayload,
} from "../src/export-payload";

/**
 * The signed export's payload.
 *
 * A verification page is a PUBLIC page: anybody with the link reads it, and
 * the student cannot take it back from whoever has already seen it. So the
 * test for every field is not "would a recruiter misuse this" but "is this
 * safe on the open web" — and the canonical form is what makes the signature
 * mean anything at all.
 */

const payload: ProfileExportPayload = {
  v: EXPORT_PAYLOAD_VERSION,
  kind: "PROFILE",
  name: "Priya Sharma",
  handle: "priya",
  batchYear: 2027,
  computedOn: "2026-10-20",
  rulesVersion: 1,
  tiers: [
    { tier: "SERVICE", score: 62, availableWeight: 90 },
    { tier: "PRODUCT", score: 41, availableWeight: 90 },
    { tier: "TOP", score: null, availableWeight: 0 },
  ],
  solvedTotal: 212,
  solvedUnassisted: 154,
  topics: Object.fromEntries(TOPICS.map((topic, i) => [topic, i === 0 ? 0 : 3])),
  rating: 1340,
  contestsRated: 9,
  releasedAssessments: 2,
  assessmentScoreAverage: 71,
  issuedOn: "2026-10-21",
};

describe("the canonical form is what makes a signature verifiable", () => {
  it("sorts keys at every depth, so the same facts give the same bytes", () => {
    /**
     * An HMAC over `JSON.stringify(payload)` verifies nothing across
     * versions: key order is an implementation detail of whatever built the
     * object, and a refactor that reordered two fields would invalidate every
     * signature ever issued.
     */
    const a = canonicalisePayload({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalisePayload({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("leaves array order alone, because an array's order is data", () => {
    expect(canonicalisePayload([3, 1, 2])).toBe("[3,1,2]");
    // The tiers are an array for exactly this reason.
    expect(canonicalisePayload(payload)).toContain('"SERVICE"');
  });

  it("drops an undefined member of an object and keeps the slot in an array", () => {
    /**
     * Dropping it from an object is right: `{a: 1, b: undefined}` and
     * `{a: 1}` are the same facts. Shortening an array is NOT: its length is
     * part of what was signed, so the hole becomes null rather than
     * disappearing.
     */
    expect(canonicalisePayload({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalisePayload([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("is total: it throws on nothing a stored row could hold", () => {
    // A verifier handed a row it cannot read must say "does not verify" on a
    // public page, not throw.
    for (const value of [null, undefined, NaN, Infinity, () => 1, Symbol("x"), 1n]) {
      expect(() => canonicalisePayload(value)).not.toThrow();
    }
    expect(canonicalise(NaN)).toBeNull();
    expect(canonicalise(() => 1)).toBeNull();
  });

  it("is stable across a round trip through JSON", () => {
    const once = canonicalisePayload(payload);
    expect(canonicalisePayload(JSON.parse(once))).toBe(once);
  });
});

describe("the payload carries nothing a public page must not", () => {
  it("accepts the built payload", () => {
    expect(profileExportPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("has no forbidden key at any depth", () => {
    expect(forbiddenKeysIn(payload)).toEqual([]);
  });

  it("names the fields that must never appear, and finds them when they do", () => {
    // The sweep reads the BUILT object, not its type: a strict schema can
    // still accept a record whose values somebody widened.
    expect(FORBIDDEN_PAYLOAD_KEYS).toContain("email");
    expect(FORBIDDEN_PAYLOAD_KEYS).toContain("collegeId");
    expect(FORBIDDEN_PAYLOAD_KEYS).toContain("section");
    expect(FORBIDDEN_PAYLOAD_KEYS).toContain("integrityScore");
    expect(FORBIDDEN_PAYLOAD_KEYS).toContain("flagCount");

    expect(forbiddenKeysIn({ ...payload, email: "a@b.c" })).toEqual(["email"]);
    expect(forbiddenKeysIn({ a: { b: [{ section: "A" }] } })).toEqual(["section"]);
    expect(forbiddenKeysIn({ deep: { deeper: { collegeId: "x", flagCount: 2 } } })).toEqual([
      "collegeId",
      "flagCount",
    ]);
  });

  it("refuses an undeclared field outright", () => {
    /**
     * `.strict()` all the way down, so a future feature cannot quietly widen
     * what a public link attests to by adding a field to the builder.
     */
    const parsed = profileExportPayloadSchema.safeParse({ ...payload, departmentCode: "CSE" });
    expect(parsed.success).toBe(false);
  });

  it("declares no department and no section in its own shape", () => {
    const keys = Object.keys(profileExportPayloadSchema.shape);
    expect(keys).not.toContain("departmentCode");
    expect(keys).not.toContain("section");
    expect(keys).not.toContain("collegeId");
    expect(keys).not.toContain("email");
    // Batch year IS there: it is what makes "which cohort" answerable, and a
    // year is not an identifier.
    expect(keys).toContain("batchYear");
  });
});

describe("every attested score carries its denominator", () => {
  it("requires availableWeight on every tier", () => {
    const parsed = profileExportPayloadSchema.safeParse({
      ...payload,
      tiers: [{ tier: "TOP", score: 62 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("allows a null score, which is what unmeasurable means", () => {
    // The TOP entry in the fixture: nothing measurable, so no score rather
    // than a zero. A public page saying 0 would read as "not ready".
    expect(payload.tiers.find((t) => t.tier === "TOP")).toEqual({
      tier: "TOP",
      score: null,
      availableWeight: 0,
    });
    expect(profileExportPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it("bounds a score and a weight to 0..100", () => {
    for (const tiers of [
      [{ tier: "TOP" as const, score: 101, availableWeight: 100 }],
      [{ tier: "TOP" as const, score: 50, availableWeight: 101 }],
      [{ tier: "TOP" as const, score: -1, availableWeight: 100 }],
    ]) {
      expect(profileExportPayloadSchema.safeParse({ ...payload, tiers }).success).toBe(false);
    }
  });
});

describe("the public code", () => {
  it("is 24 url-safe characters", () => {
    expect(isExportCode("AbcDef_GhiJkl-MnoPqrStuv")).toBe(true);
    expect(EXPORT_CODE_PATTERN.test("AbcDef_GhiJkl-MnoPqrStuv")).toBe(true);
  });

  it("refuses anything shorter, longer or url-unsafe", () => {
    for (const bad of ["short", "a".repeat(25), `${"a".repeat(23)}/`, `${"a".repeat(23)}+`, "", null, 7]) {
      expect(isExportCode(bad), String(bad).slice(0, 10)).toBe(false);
    }
  });
});

describe("the policy numbers", () => {
  it("expires a link after ninety days", () => {
    /**
     * A recruiter checks a link within days of being sent it, and a readiness
     * figure three months old is no longer the student's. A link that never
     * expired would outlive the facts it attests to.
     */
    expect(EXPORT_DEFAULT_DAYS).toBe(90);
  });

  it("bounds how many live links a student has at once", () => {
    // A link they have forgotten about is a link they cannot withdraw.
    expect(MAX_LIVE_EXPORTS).toBe(5);
  });
});

describe("the verify page's copy", () => {
  it("says the thing that stops a reader over-reading the number", () => {
    expect(VERIFY_COPY.framing).toMatch(/not a prediction/i);
    expect(VERIFY_COPY.framing).toMatch(/does not use it to decide who may sit a drive/i);
  });

  it("states the denominator rule, because the page outlives its context", () => {
    expect(VERIFY_COPY.denominator).toMatch(/not out of 100/);
    expect(VERIFY_COPY.denominator).toMatch(/rather than counted as zero/);
  });

  it("tells a revoked link apart from a missing one and from a forged one", () => {
    const messages = [VERIFY_COPY.valid, VERIFY_COPY.revoked, VERIFY_COPY.expired, VERIFY_COPY.unknown, VERIFY_COPY.tampered];
    expect(new Set(messages).size).toBe(messages.length);
    // A withdrawn link must not read as an error: a recruiter who gets "not
    // found" asks again, and the student's withdrawal is lost.
    expect(VERIFY_COPY.revoked).toMatch(/withdrawn/i);
    expect(VERIFY_COPY.unknown).not.toMatch(/withdrawn/i);
  });

  it("never promises anything about the student's ability", () => {
    const all = Object.values(VERIFY_COPY).join(" ");
    expect(all).not.toMatch(/\b(guarantee|certif|qualified|competent|skilled)\w*\b/i);
  });
});

describe("topicsTouched counts the fourteen honestly", () => {
  it("counts only topics with an unassisted solve", () => {
    // The fixture leaves the first topic at zero.
    expect(topicsTouched(payload)).toBe(TOPICS.length - 1);
  });

  it("is zero for a student who has not started", () => {
    expect(topicsTouched({ topics: {} })).toBe(0);
  });
});
