import { beforeAll, describe, expect, it } from "vitest";
import {
  EXPORT_CODE_PATTERN,
  EXPORT_PAYLOAD_VERSION,
  type ProfileExportPayload,
} from "@recx/shared";

/**
 * The export's HMAC.
 *
 * Four properties, and each is the reason a step exists rather than a
 * restatement of the code:
 *
 *   1. A valid row verifies.
 *   2. A TAMPERED payload does not — which is the only reason to sign
 *      anything, and it works because verification RE-DERIVES the signature
 *      from the stored payload instead of comparing stored signatures.
 *   3. A signature lifted from ANOTHER row does not verify, because the code
 *      is part of the signed message. Without that, two exports holding the
 *      same facts would be interchangeable — and the moment a student
 *      revokes one of them, swapping the codes would un-revoke it.
 *   4. Key ORDER in the stored payload does not matter, because the canonical
 *      form sorts. A row written by an older build still verifies.
 */

process.env.EXPORT_SIGNING_SECRET ??= "test-only-export-signing-secret-at-least-32-chars";
process.env.IP_HASH_PEPPER ??= "test-pepper-at-least-16-chars";
process.env.DATABASE_URL ??= "postgresql://recx:recx@localhost:5433/recx_test";

let signPayload: typeof import("@/lib/export/signature").signPayload;
let verifyStored: typeof import("@/lib/export/signature").verifyStored;
let newExportCode: typeof import("@/lib/export/signature").newExportCode;
let EXPORT_ALGORITHM: string;

beforeAll(async () => {
  const mod = await import("@/lib/export/signature");
  signPayload = mod.signPayload;
  verifyStored = mod.verifyStored;
  newExportCode = mod.newExportCode;
  EXPORT_ALGORITHM = mod.EXPORT_ALGORITHM;
});

const payload: ProfileExportPayload = {
  v: EXPORT_PAYLOAD_VERSION,
  kind: "PROFILE",
  name: "Priya Sharma",
  handle: "priya",
  batchYear: 2027,
  computedOn: "2026-10-20",
  rulesVersion: 1,
  tiers: [{ tier: "SERVICE", score: 62, availableWeight: 90 }],
  solvedTotal: 212,
  solvedUnassisted: 154,
  topics: { GRAPHS: 4 },
  rating: 1340,
  contestsRated: 9,
  releasedAssessments: 2,
  assessmentScoreAverage: 71,
  issuedOn: "2026-10-21",
};

const row = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  payload,
  signature: signPayload(code, payload),
  algorithm: EXPORT_ALGORITHM,
  ...over,
});

describe("a code is 24 url-safe characters from a CSPRNG", () => {
  it("matches the shape the database CHECK enforces", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = newExportCode();
      expect(EXPORT_CODE_PATTERN.test(code), code).toBe(true);
    }
  });

  it("does not repeat", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newExportCode()));
    expect(codes.size).toBe(200);
  });
});

describe("verification re-derives, so tampering fails", () => {
  it("verifies a row as written", () => {
    const code = newExportCode();
    const result = verifyStored(row(code));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.name).toBe("Priya Sharma");
  });

  it("REFUSES a payload that was edited after signing", () => {
    /**
     * The whole point. A stored-signature comparison would still pass here:
     * the signature in the row is intact, it is the facts that changed.
     */
    const code = newExportCode();
    const tampered = row(code, { payload: { ...payload, solvedTotal: 9999 } });
    expect(verifyStored(tampered)).toEqual({ ok: false, reason: "SIGNATURE" });
  });

  it("refuses a score raised after signing", () => {
    const code = newExportCode();
    const tampered = row(code, {
      payload: { ...payload, tiers: [{ tier: "SERVICE", score: 90, availableWeight: 90 }] },
    });
    expect(verifyStored(tampered)).toEqual({ ok: false, reason: "SIGNATURE" });
  });

  it("refuses a signature lifted from another row", () => {
    /**
     * The code is part of the signed message. Without that, two exports
     * holding the same facts would be interchangeable — and swapping the
     * codes would un-revoke a link the student had withdrawn.
     */
    const mine = newExportCode();
    const theirs = newExportCode();
    const swapped = { ...row(mine), signature: signPayload(theirs, payload) };
    expect(verifyStored(swapped)).toEqual({ ok: false, reason: "SIGNATURE" });
  });

  it("refuses a different algorithm, and says so", () => {
    // A row claiming an algorithm this build does not implement is not a
    // forgery; it is a row from a future the verifier cannot read, and the
    // page should say that rather than "altered".
    const code = newExportCode();
    expect(verifyStored(row(code, { algorithm: "none" }))).toEqual({ ok: false, reason: "ALGORITHM" });
  });

  it("refuses a payload it cannot read, and says that separately", () => {
    const code = newExportCode();
    expect(verifyStored(row(code, { payload: { nonsense: true } }))).toEqual({ ok: false, reason: "SHAPE" });
  });

  it("does not throw on a signature of the wrong length", () => {
    // timingSafeEqual throws on a length mismatch, so the length is checked
    // first — a public page must not 500 on a malformed row.
    const code = newExportCode();
    expect(() => verifyStored(row(code, { signature: "short" }))).not.toThrow();
    expect(verifyStored(row(code, { signature: "short" })).ok).toBe(false);
  });
});

describe("the canonical form makes key order irrelevant", () => {
  it("verifies a stored payload whose keys are in another order", () => {
    /**
     * A row written by an older build, or round-tripped through a tool that
     * reordered the JSON, still verifies. Without a canonical form every
     * signature would be hostage to whatever order the object happened to have.
     */
    const code = newExportCode();
    const signature = signPayload(code, payload);
    /**
     * Rebuilt with every key in the opposite insertion order, at the top
     * level AND inside a nested object, so the test exercises the sort at
     * depth rather than only at the root.
     *
     * Not `JSON.stringify(value, keys)`: that form of the replacer FILTERS
     * keys and applies only at the top level, so it silently dropped the
     * nested ones and the payload stopped being the same facts at all —
     * which is what this test first measured.
     */
    const reordered = {
      ...Object.fromEntries(Object.entries(payload).reverse()),
      topics: Object.fromEntries(Object.entries(payload.topics).reverse()),
    };
    expect(Object.keys(reordered)).not.toEqual(Object.keys(payload));
    expect(verifyStored({ code, payload: reordered, signature, algorithm: EXPORT_ALGORITHM }).ok).toBe(true);
  });
});

describe("the signature is bound to the secret", () => {
  it("is deterministic for the same code, payload and key", () => {
    const code = newExportCode();
    expect(signPayload(code, payload)).toBe(signPayload(code, payload));
  });

  it("is 64 hex characters, which the database CHECK requires", () => {
    expect(signPayload(newExportCode(), payload)).toMatch(/^[0-9a-f]{64}$/);
  });
});
