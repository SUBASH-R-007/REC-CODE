import { describe, expect, it } from "vitest";
import { BULK_STATUS_DIRECT_MAX, BULK_STATUS_MAX, PRIVILEGED_APPROVAL_TTL_MS } from "@recx/shared";
import {
  parsePrivilegedPayload,
  payloadDigest,
  privilegedPayloadSchemas,
  userFilterWhere,
} from "@/lib/privileged/payloads";
import {
  DECISION_MESSAGES,
  bulkStatusRoute,
  canApprove,
  canCancel,
  canReject,
  canSelfApprove,
  effectiveStatus,
  type DecidableOperation,
} from "@/lib/privileged/policy";

/** The two-person rule and the request window, as pure functions (the database enforces them again). */

const NOW = new Date("2026-10-10T08:00:00Z");
const SHA = "a".repeat(64);
const op = (fields: Partial<DecidableOperation> = {}): DecidableOperation => ({
  status: "PENDING",
  expiresAt: new Date(NOW.getTime() + PRIVILEGED_APPROVAL_TTL_MS - 1),
  requestedById: "requester",
  payloadSha256: SHA,
  ...fields,
});

describe("decisions", () => {
  it("a second super-admin approves the exact payload", () => {
    expect(canApprove(op(), "other", SHA, NOW, true)).toEqual({ ok: true });
    expect(canApprove(op(), "requester", SHA, NOW, true)).toEqual({ ok: false, reason: DECISION_MESSAGES.ownRequest });
    expect(canApprove(op(), "other", "b".repeat(64), NOW, true)).toEqual({ ok: false, reason: DECISION_MESSAGES.changed });
  });

  it("refuses to approve once the requester is no longer an active super-admin", () => {
    expect(canApprove(op(), "other", SHA, NOW, false)).toEqual({ ok: false, reason: DECISION_MESSAGES.requesterGone });
    // Rejecting stays possible.
    expect(canReject(op(), "other", NOW)).toEqual({ ok: true });
  });

  it("expires at expiresAt (24 h), and decided requests stay decided", () => {
    const expired = op({ expiresAt: NOW });
    expect(effectiveStatus(expired, NOW)).toBe("EXPIRED");
    expect(canApprove(expired, "other", SHA, NOW, true)).toEqual({ ok: false, reason: DECISION_MESSAGES.expired });
    expect(canReject(expired, "other", NOW)).toEqual({ ok: false, reason: DECISION_MESSAGES.expired });
    for (const status of ["APPROVED", "EXECUTING", "EXECUTED", "FAILED", "REJECTED", "CANCELLED", "EXPIRED"] as const) {
      expect(canApprove(op({ status }), "other", SHA, NOW, true).ok).toBe(false);
      expect(canCancel(op({ status }), "requester", NOW).ok).toBe(false);
    }
    // An APPROVED row past expiresAt is still APPROVED: expiry bounds the wait, not the run.
    expect(effectiveStatus(op({ status: "APPROVED", expiresAt: NOW }), NOW)).toBe("APPROVED");
  });

  it("break-glass is for the requester only, only while the flag is on", () => {
    expect(canSelfApprove(op(), "requester", SHA, NOW, true)).toEqual({ ok: true });
    expect(canSelfApprove(op(), "other", SHA, NOW, true)).toEqual({ ok: false, reason: DECISION_MESSAGES.notRequester });
    expect(canSelfApprove(op(), "requester", SHA, NOW, false)).toEqual({ ok: false, reason: DECISION_MESSAGES.breakGlassOff });
    expect(canSelfApprove(op(), "requester", "c".repeat(64), NOW, true).ok).toBe(false);
  });

  it("reject is for another super-admin; cancel for the requester", () => {
    expect(canReject(op(), "other", NOW)).toEqual({ ok: true });
    expect(canReject(op(), "requester", NOW)).toEqual({ ok: false, reason: DECISION_MESSAGES.ownReject });
    expect(canCancel(op(), "requester", NOW)).toEqual({ ok: true });
    expect(canCancel(op(), "other", NOW)).toEqual({ ok: false, reason: DECISION_MESSAGES.notRequester });
  });
});

describe("bulk status routing", () => {
  it.each([
    [1, "direct"],
    [BULK_STATUS_DIRECT_MAX, "direct"],
    [BULK_STATUS_DIRECT_MAX + 1, "privileged"],
    [BULK_STATUS_MAX, "privileged"],
    [BULK_STATUS_MAX + 1, "too-large"],
  ] as const)("%i accounts → %s", (count, route) => {
    expect(bulkStatusRoute(count)).toBe(route);
  });

  it("the BULK_STATUS_CHANGE payload accepts 26–5,000 distinct accounts only", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);
    const schema = privilegedPayloadSchemas.BULK_STATUS_CHANGE;
    expect(schema.safeParse({ userIds: ids(25), toStatus: "DISABLED" }).success).toBe(false);
    expect(schema.safeParse({ userIds: ids(26), toStatus: "DISABLED" }).success).toBe(true);
    expect(schema.safeParse({ userIds: ids(5_000), toStatus: "DISABLED" }).success).toBe(true);
    expect(schema.safeParse({ userIds: ids(5_001), toStatus: "DISABLED" }).success).toBe(false);
    expect(schema.safeParse({ userIds: [...ids(26), "u0"], toStatus: "DISABLED" }).success).toBe(false);
  });
});

describe("payloads", () => {
  it("digests canonical JSON: key order does not matter, content does", () => {
    const a = payloadDigest({ problemId: "p1", problemVersionId: null, languages: ["cpp20"], verdicts: ["WA"] });
    const b = payloadDigest({ verdicts: ["WA"], languages: ["cpp20"], problemVersionId: null, problemId: "p1" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadDigest({ problemId: "p2" })).not.toBe(payloadDigest({ problemId: "p1" }));
  });

  it("are strict: no extra keys, only the minimised PII columns", () => {
    expect(() => parsePrivilegedPayload("PROBLEM_DELETE", { problemId: "p", extra: 1 })).toThrow();
    expect(() =>
      parsePrivilegedPayload("PII_EXPORT", { filter: {}, userIds: ["u1"], columns: ["collegeId", "passwordHash"] }),
    ).toThrow();
    // The account set is part of the approved payload.
    expect(() => parsePrivilegedPayload("PII_EXPORT", { filter: {}, columns: ["collegeId"] })).toThrow();
    expect(() => parsePrivilegedPayload("PII_EXPORT", { filter: {}, userIds: ["u1", "u1"], columns: ["collegeId"] })).toThrow();
    expect(parsePrivilegedPayload("PII_EXPORT", { filter: { batchYear: 2027 }, userIds: ["u1"], columns: ["collegeId"] })).toEqual({
      filter: { batchYear: 2027 },
      userIds: ["u1"],
      columns: ["collegeId"],
    });
  });

  it("turns a user filter into a where-clause", () => {
    expect(userFilterWhere({})).toEqual({});
    expect(userFilterWhere({ roles: ["STUDENT"], statuses: ["ACTIVE"], batchYear: 2027, departmentCode: "CSE" })).toEqual({
      role: { in: ["STUDENT"] },
      status: { in: ["ACTIVE"] },
      batchYear: 2027,
      departmentCode: "CSE",
    });
  });
});
