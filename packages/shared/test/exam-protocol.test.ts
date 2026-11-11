import { describe, expect, it } from "vitest";
import {
  ATTEMPT_AT_MS_GRACE_MS,
  ATTEMPT_AUTO_SUBMIT_BATCH,
  ATTEMPT_AUTO_SUBMIT_INTERVAL_MS,
  ATTEMPT_REVOKE_MESSAGES,
  ATTEMPT_REVOKE_REASONS,
  ATTEMPT_TOKEN_BYTES,
  EXAM_CLOCK_DRIFT_TOLERANCE_MS,
  EXAM_CLOCK_RESYNC_INTERVAL_MS,
  EXAM_HEARTBEAT_INTERVAL_MS,
  attemptCookiePath,
  checkSequence,
  clampAtMs,
  clockDrift,
  elapsedMs,
  examHeartbeatRequestSchema,
  examHeartbeatResponseSchema,
} from "../src/exam-protocol";

const at = (iso: string) => new Date(iso);

describe("cadence constants", () => {
  it("beats every 10s and re-syncs every 30s (SPEC §5)", () => {
    expect(EXAM_HEARTBEAT_INTERVAL_MS).toBe(10_000);
    expect(EXAM_CLOCK_RESYNC_INTERVAL_MS).toBe(30_000);
    expect(EXAM_CLOCK_DRIFT_TOLERANCE_MS).toBe(5_000);
  });

  it("sweeps for expiry every 15s", () => {
    expect(ATTEMPT_AUTO_SUBMIT_INTERVAL_MS).toBe(15_000);
  });

  it("re-syncs less often than it beats, so a re-sync never replaces a beat", () => {
    expect(EXAM_CLOCK_RESYNC_INTERVAL_MS % EXAM_HEARTBEAT_INTERVAL_MS).toBe(0);
    expect(EXAM_CLOCK_RESYNC_INTERVAL_MS).toBeGreaterThan(EXAM_HEARTBEAT_INTERVAL_MS);
  });

  it("sweeps more often than the 45s disconnection rule, so an expiry is never missed by a sweep", () => {
    expect(ATTEMPT_AUTO_SUBMIT_INTERVAL_MS).toBeLessThan(45_000);
  });

  it("uses a 32-byte token and a bounded sweep batch", () => {
    expect(ATTEMPT_TOKEN_BYTES).toBe(32);
    expect(ATTEMPT_AUTO_SUBMIT_BATCH).toBeGreaterThan(0);
    expect(ATTEMPT_AUTO_SUBMIT_BATCH).toBeLessThanOrEqual(1_000);
  });
});

describe("attemptCookiePath", () => {
  it("scopes the cookie to the one attempt", () => {
    expect(attemptCookiePath("att_1")).toBe("/api/exam/att_1");
  });

  it("gives two attempts two paths, so a second tab cannot read this token", () => {
    expect(attemptCookiePath("att_1")).not.toBe(attemptCookiePath("att_2"));
  });
});

describe("revoke reasons", () => {
  it("has a sentence for every reason", () => {
    for (const reason of ATTEMPT_REVOKE_REASONS) {
      expect(ATTEMPT_REVOKE_MESSAGES[reason].length).toBeGreaterThan(10);
    }
    expect(Object.keys(ATTEMPT_REVOKE_MESSAGES)).toHaveLength(ATTEMPT_REVOKE_REASONS.length);
  });

  it("has no reason for a disconnection — a dropped connection is never a revocation", () => {
    expect(ATTEMPT_REVOKE_REASONS).not.toContain("disconnected");
    expect(ATTEMPT_REVOKE_REASONS).not.toContain("network");
  });

  it("accuses nobody: no message calls the candidate a cheat", () => {
    for (const reason of ATTEMPT_REVOKE_REASONS) {
      const message = ATTEMPT_REVOKE_MESSAGES[reason].toLowerCase();
      expect(message).not.toMatch(/cheat|malpractice|caught|violation|guilty/);
    }
  });
});

describe("clampAtMs", () => {
  it("passes an honest offset through", () => {
    expect(clampAtMs(12_000, 30_000)).toBe(12_000);
  });

  it("refuses a negative offset — nothing happened before the attempt began", () => {
    expect(clampAtMs(-1, 30_000)).toBe(0);
    expect(clampAtMs(-999_999, 30_000)).toBe(0);
  });

  it("caps an inflated offset at elapsed + 5s", () => {
    expect(clampAtMs(9_999_999, 30_000)).toBe(30_000 + ATTEMPT_AT_MS_GRACE_MS);
  });

  it("allows the grace window, so honest latency is not clamped", () => {
    expect(clampAtMs(31_000, 30_000)).toBe(31_000);
    expect(clampAtMs(35_000, 30_000)).toBe(35_000);
    expect(clampAtMs(35_001, 30_000)).toBe(35_000);
  });

  it("clamps to the grace alone at the very start of an attempt", () => {
    expect(clampAtMs(60_000, 0)).toBe(ATTEMPT_AT_MS_GRACE_MS);
    expect(clampAtMs(0, 0)).toBe(0);
  });

  it("floors a fractional claim rather than storing a non-integer in an Int column", () => {
    expect(clampAtMs(1_500.9, 30_000)).toBe(1_500);
    expect(Number.isInteger(clampAtMs(1_500.9, 30_000.7))).toBe(true);
  });

  it("falls back to the ceiling for a non-finite claim", () => {
    expect(clampAtMs(Number.NaN, 10_000)).toBe(15_000);
    expect(clampAtMs(Number.POSITIVE_INFINITY, 10_000)).toBe(15_000);
  });
});

describe("elapsedMs", () => {
  it("measures the sitting from its start", () => {
    expect(elapsedMs(at("2026-10-19T10:00:00Z"), at("2026-10-19T10:30:00Z"))).toBe(1_800_000);
  });

  it("never goes negative, even if the server clock steps backwards", () => {
    expect(elapsedMs(at("2026-10-19T10:00:00Z"), at("2026-10-19T09:59:00Z"))).toBe(0);
  });
});

describe("checkSequence", () => {
  it("accepts the next number with no gap", () => {
    expect(checkSequence(5, 4)).toEqual({ highWater: 5, skipped: 0, regressed: false });
  });

  it("counts the numbers it never saw", () => {
    expect(checkSequence(10, 4)).toEqual({ highWater: 10, skipped: 5, regressed: false });
  });

  it("reports a repeat as a regression and keeps the high-water mark", () => {
    expect(checkSequence(4, 4)).toEqual({ highWater: 4, skipped: 0, regressed: true });
  });

  it("reports a rewind as a regression without lowering the high-water mark", () => {
    expect(checkSequence(1, 9)).toEqual({ highWater: 9, skipped: 0, regressed: true });
  });

  it("reports no gap for the first client message, whatever number it opens with", () => {
    // No baseline yet, so there is nothing to have skipped. Treating null as
    // -1 would flag every attempt whose client starts counting at 1.
    expect(checkSequence(0, null)).toEqual({ highWater: 0, skipped: 0, regressed: false });
    expect(checkSequence(1, null)).toEqual({ highWater: 1, skipped: 0, regressed: false });
    expect(checkSequence(500, null)).toEqual({ highWater: 500, skipped: 0, regressed: false });
  });

  it("starts reporting gaps from the second message onwards", () => {
    expect(checkSequence(1, 0)).toEqual({ highWater: 1, skipped: 0, regressed: false });
    expect(checkSequence(3, 0)).toEqual({ highWater: 3, skipped: 2, regressed: false });
  });
});

describe("clockDrift", () => {
  const serverNow = at("2026-10-19T10:00:00Z");

  it("reports no drift when the client does not report its clock", () => {
    expect(clockDrift(undefined, serverNow)).toEqual({ driftMs: 0, notable: false });
  });

  it("is positive when the client runs ahead", () => {
    const { driftMs, notable } = clockDrift(serverNow.getTime() + 8_000, serverNow);
    expect(driftMs).toBe(8_000);
    expect(notable).toBe(true);
  });

  it("is negative when the client runs behind", () => {
    const { driftMs, notable } = clockDrift(serverNow.getTime() - 8_000, serverNow);
    expect(driftMs).toBe(-8_000);
    expect(notable).toBe(true);
  });

  it("ignores drift inside the tolerance", () => {
    expect(clockDrift(serverNow.getTime() + 4_999, serverNow).notable).toBe(false);
    expect(clockDrift(serverNow.getTime() - 4_999, serverNow).notable).toBe(false);
  });

  it("treats exactly the tolerance as not notable, and one past it as notable", () => {
    expect(clockDrift(serverNow.getTime() + EXAM_CLOCK_DRIFT_TOLERANCE_MS, serverNow).notable).toBe(false);
    expect(clockDrift(serverNow.getTime() + EXAM_CLOCK_DRIFT_TOLERANCE_MS + 1, serverNow).notable).toBe(true);
  });
});

describe("examHeartbeatRequestSchema", () => {
  it("accepts a minimal beat", () => {
    expect(examHeartbeatRequestSchema.parse({ clientSeq: 0 })).toEqual({ clientSeq: 0 });
  });

  it("accepts the optional clock and visibility hints", () => {
    const parsed = examHeartbeatRequestSchema.parse({ clientSeq: 7, clientNowMs: 1_700_000_000_000, visible: false });
    expect(parsed.visible).toBe(false);
  });

  it("refuses an unknown field, so a client cannot smuggle in a deadline", () => {
    expect(() => examHeartbeatRequestSchema.parse({ clientSeq: 1, msRemaining: 999_999 })).toThrow();
    expect(() => examHeartbeatRequestSchema.parse({ clientSeq: 1, expiresAt: "2099-01-01" })).toThrow();
  });

  it("refuses a negative or fractional sequence number", () => {
    expect(() => examHeartbeatRequestSchema.parse({ clientSeq: -1 })).toThrow();
    expect(() => examHeartbeatRequestSchema.parse({ clientSeq: 1.5 })).toThrow();
  });

  it("refuses a sequence number past an Int column", () => {
    expect(() => examHeartbeatRequestSchema.parse({ clientSeq: 2_147_483_648 })).toThrow();
  });
});

describe("examHeartbeatResponseSchema", () => {
  const ok = {
    serverNow: "2026-10-19T10:00:00.000Z",
    msRemaining: 1_200_000,
    status: "IN_PROGRESS",
    pendingInvigilatorMessages: [],
    revokeReason: null,
    nextHeartbeatMs: EXAM_HEARTBEAT_INTERVAL_MS,
  };

  it("round-trips the shape SPEC §5 names", () => {
    expect(examHeartbeatResponseSchema.parse(ok)).toEqual(ok);
  });

  it("refuses a negative msRemaining — zero means the attempt is over", () => {
    expect(() => examHeartbeatResponseSchema.parse({ ...ok, msRemaining: -1 })).toThrow();
  });

  it("carries an invigilator message with its acknowledgement flag", () => {
    const parsed = examHeartbeatResponseSchema.parse({
      ...ok,
      pendingInvigilatorMessages: [
        { id: "m1", body: "Please raise your hand.", requiresAck: true, sentAt: "2026-10-19T10:00:00.000Z" },
      ],
    });
    expect(parsed.pendingInvigilatorMessages[0]!.requiresAck).toBe(true);
  });

  it("refuses an unknown revoke reason", () => {
    expect(() => examHeartbeatResponseSchema.parse({ ...ok, revokeReason: "disconnected" })).toThrow();
  });

  it("accepts every reason in the closed set", () => {
    for (const reason of ATTEMPT_REVOKE_REASONS) {
      expect(examHeartbeatResponseSchema.parse({ ...ok, revokeReason: reason }).revokeReason).toBe(reason);
    }
  });
});
