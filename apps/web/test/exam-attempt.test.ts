import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The attempt guard and the heartbeat applier (Phase 6b).
 *
 * Two rules from SPEC §0 and §5 are the point of this suite, and both are
 * easy to break by accident while adding a signal:
 *
 *   - "DISCONNECTED is never a flag. Resume on the same token with the same
 *     frozen paper, deadline unchanged." A reconnection must cost the
 *     candidate nothing.
 *   - No signal auto-penalises. Everything the heartbeat notices is written
 *     as a SERVER-sourced event for a human to read; nothing it writes
 *     touches integrityScore, and nothing it writes can void a sitting.
 *
 * Plus the lazy expiry check, which is what makes killing the scheduler
 * useless as a way to buy time.
 */

const ATTEMPT = "att_1";
const USER = "user_1";

// The token lives inside the hoisted block: vi.hoisted() runs before any
// top-level const, so a factory closing over an outer constant would read it
// uninitialised.
const h = vi.hoisted(() => ({
  token: "raw-attempt-token",
  attempt: null as Record<string, unknown> | null,
  session: null as { id: string } | null,
  findUnique: vi.fn(),
  sessionFind: vi.fn(),
  updateMany: vi.fn(),
  createMany: vi.fn(),
  autoSubmitExpired: vi.fn(),
  audit: vi.fn(),
  presented: "raw-attempt-token" as string | null,
  clearAttemptCookie: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    assessmentAttempt: { findUnique: h.findUnique, updateMany: h.updateMany },
    session: { findUnique: h.sessionFind },
    proctorEvent: { createMany: h.createMany },
  },
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@recx/db/attempt", () => ({ autoSubmitExpired: h.autoSubmitExpired }));
vi.mock("@/lib/exam/attempt-token", async () => {
  const { createHash } = await import("node:crypto");
  return {
    presentedAttemptToken: async () => h.presented,
    attemptTokenMatches: (presented: string | null, storedHash: string) =>
      presented !== null && createHash("sha256").update(presented).digest("hex") === storedHash,
    clearAttemptCookie: h.clearAttemptCookie,
  };
});

const { createHash } = await import("node:crypto");
const { guardAttempt, endAttemptSession } = await import("@/lib/exam/attempt");
const { applyHeartbeat } = await import("@/lib/exam/heartbeat");
const { DEFAULT_HEARTBEAT_SLOT_SECONDS, isSlotSet, slotOf } = await import("@recx/shared");

const TOKEN_HASH = createHash("sha256").update(h.token).digest("hex");
const STARTED = new Date("2026-10-19T10:00:00.000Z");

/** A live sitting, 60 minutes long, 10 minutes in. */
function attemptRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ATTEMPT,
    userId: USER,
    status: "IN_PROGRESS",
    startedAt: STARTED,
    expiresAt: new Date(STARTED.getTime() + 3_600_000),
    pausedMs: 0,
    tokenHash: TOKEN_HASH,
    lockSessionId: "sess_1",
    layout: {},
    heartbeatBitmap: null,
    heartbeatSlotSeconds: DEFAULT_HEARTBEAT_SLOT_SECONDS,
    lastHeartbeatAt: null,
    lastClientSeq: null,
    maxHeartbeatGapSeconds: 0,
    ipHashLast: null,
    uaHash: null,
    version: 7,
    integrityScore: 100,
    ...over,
  };
}

const request = () => new Request(`http://localhost:3100/api/exam/${ATTEMPT}/hb`, { method: "POST" });

const guard = (over: { sessionId?: string | null; userId?: string } = {}) =>
  guardAttempt({
    request: request(),
    attemptId: ATTEMPT,
    userId: over.userId ?? USER,
    sessionId: over.sessionId === undefined ? "sess_1" : over.sessionId,
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.presented = h.token;
  h.attempt = attemptRow();
  h.findUnique.mockImplementation(async () => h.attempt);
  h.sessionFind.mockImplementation(async () => h.session);
  h.session = { id: "sess_1" };
  h.updateMany.mockResolvedValue({ count: 1 });
  h.createMany.mockResolvedValue({ count: 1 });
  h.autoSubmitExpired.mockResolvedValue([]);
  vi.useFakeTimers();
  // Ten minutes into the sitting.
  vi.setSystemTime(new Date(STARTED.getTime() + 600_000));
});

// ── The guard ────────────────────────────────────────────────────────────

describe("guardAttempt", () => {
  it("admits the owner with a valid token and reports the server's remaining time", async () => {
    const result = await guard();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.msRemaining).toBe(3_000_000);
    expect(result.status).toBe("IN_PROGRESS");
    expect(result.sessionNotice).toBeNull();
  });

  it("refuses an attempt that belongs to somebody else", async () => {
    const result = await guard({ userId: "someone_else" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad_token");
    // Deliberately indistinguishable from a bad token: a candidate who could
    // tell the two apart could enumerate other people's attempt ids.
    expect(result.attempt).toBeNull();
  });

  it("refuses an attempt that does not exist, with the same reason", async () => {
    h.attempt = null;
    const result = await guard();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("bad_token");
  });

  it("refuses a request with no token", async () => {
    h.presented = null;
    const result = await guard();
    expect(result.ok ? null : result.reason).toBe("bad_token");
  });

  it("refuses a request with the wrong token", async () => {
    h.presented = "some-other-token";
    const result = await guard();
    expect(result.ok ? null : result.reason).toBe("bad_token");
  });

  it.each([
    ["SUBMITTED", "submitted"],
    ["AUTO_SUBMITTED", "expired"],
    ["EXPIRED", "expired"],
    ["TERMINATED", "terminated"],
    ["VOIDED", "submitted"],
  ])("refuses a %s sitting with reason %s", async (status, reason) => {
    h.attempt = attemptRow({ status });
    const result = await guard();
    expect(result.ok ? null : result.reason).toBe(reason);
  });

  it("refuses a sitting that has not been started", async () => {
    h.attempt = attemptRow({ status: "NOT_STARTED" });
    const result = await guard();
    expect(result.ok).toBe(false);
  });

  it("admits a DISCONNECTED sitting — the candidate's wifi dropped, not their exam", async () => {
    h.attempt = attemptRow({ status: "DISCONNECTED" });
    const result = await guard();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("DISCONNECTED");
  });

  // ── The lazy expiry check ──────────────────────────────────────────────

  it("auto-submits an overdue sitting itself when the sweeper has not got there", async () => {
    h.attempt = attemptRow({ expiresAt: new Date(STARTED.getTime() + 300_000) });
    h.autoSubmitExpired.mockResolvedValue([
      {
        id: ATTEMPT,
        userId: USER,
        assessmentId: "a1",
        previousStatus: "IN_PROGRESS",
        expiresAt: new Date(STARTED.getTime() + 300_000),
        pausedMs: 0,
        lateMs: 300_000,
      },
    ]);
    const result = await guard();
    expect(h.autoSubmitExpired).toHaveBeenCalledWith(expect.anything(), { limit: 1, attemptId: ATTEMPT });
    expect(result.ok ? null : result.reason).toBe("expired");
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "assessment.attempt.auto_submitted", targetUserId: USER }),
    );
  });

  it("records that the lazy guard did it, so a lagging sweeper is visible in the audit log", async () => {
    h.attempt = attemptRow({ expiresAt: new Date(STARTED.getTime() + 300_000) });
    h.autoSubmitExpired.mockResolvedValue([
      {
        id: ATTEMPT,
        userId: USER,
        assessmentId: "a1",
        previousStatus: "IN_PROGRESS",
        expiresAt: STARTED,
        pausedMs: 0,
        lateMs: 1_234,
      },
    ]);
    await guard();
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ by: "lazy_guard", lateMs: 1_234 }) }),
    );
  });

  it("still refuses when the sweeper won the race", async () => {
    h.attempt = attemptRow({ expiresAt: new Date(STARTED.getTime() + 300_000) });
    h.autoSubmitExpired.mockResolvedValue([]);
    const result = await guard();
    expect(result.ok ? null : result.reason).toBe("expired");
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("extends the deadline by paused time, so a granted break is not refused as expired", async () => {
    h.attempt = attemptRow({
      expiresAt: new Date(STARTED.getTime() + 300_000),
      pausedMs: 600_000,
    });
    const result = await guard();
    expect(result.ok).toBe(true);
    expect(h.autoSubmitExpired).not.toHaveBeenCalled();
  });

  // ── The session lock ───────────────────────────────────────────────────

  it("re-binds the sitting when its original session is gone", async () => {
    h.session = null; // the original session no longer exists
    const result = await guard({ sessionId: "sess_2" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionNotice).toBe("rebind");
  });

  it("notes a concurrent session when the original is still alive", async () => {
    h.session = { id: "sess_1" };
    const result = await guard({ sessionId: "sess_2" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Allowed, because no signal auto-penalises. Recorded, because a second
    // live client on one paper is worth a human's attention.
    expect(result.sessionNotice).toBe("concurrent");
  });

  it("says nothing about the session when the request is on the one that started the sitting", async () => {
    const result = await guard({ sessionId: "sess_1" });
    expect(result.ok && result.sessionNotice).toBeNull();
  });

  it("says nothing about the session when the caller did not resolve one", async () => {
    const result = await guard({ sessionId: null });
    expect(result.ok && result.sessionNotice).toBeNull();
    expect(h.sessionFind).not.toHaveBeenCalled();
  });
});

describe("endAttemptSession", () => {
  it("drops the cookie once the sitting is over", async () => {
    await endAttemptSession(ATTEMPT, "expired");
    expect(h.clearAttemptCookie).toHaveBeenCalledWith(ATTEMPT);
  });

  it("keeps the cookie for a refusal the candidate can recover from", async () => {
    await endAttemptSession(ATTEMPT, "session_revoked");
    await endAttemptSession(ATTEMPT, "outside_allowlist");
    expect(h.clearAttemptCookie).not.toHaveBeenCalled();
  });
});

// ── The heartbeat ────────────────────────────────────────────────────────

describe("applyHeartbeat", () => {
  async function beat(
    over: { attempt?: Record<string, unknown>; body?: Record<string, unknown>; sessionNotice?: string | null } = {},
    context: { ipHash?: string | null; uaHash?: string | null } = {},
  ) {
    const attempt = over.attempt ?? attemptRow();
    const now = new Date();
    const outcome = await applyHeartbeat(
      {
        ok: true,
        attempt: attempt as never,
        status: attempt.status as never,
        msRemaining: 1,
        now,
        sessionNotice: (over.sessionNotice ?? null) as never,
        sessionId: "sess_2",
      },
      { clientSeq: 1, ...over.body } as never,
      { ipHash: context.ipHash ?? null, uaHash: context.uaHash ?? null },
    );
    return { outcome, write: h.updateMany.mock.calls[0]?.[0] as { where: unknown; data: Record<string, unknown> } };
  }

  it("marks the candidate present in the bitmap", async () => {
    const { write } = await beat();
    const bitmap = write.data.heartbeatBitmap as Uint8Array;
    const slot = slotOf(STARTED, new Date(), DEFAULT_HEARTBEAT_SLOT_SECONDS);
    expect(isSlotSet(bitmap, slot)).toBe(true);
  });

  it("writes conditionally on the version it read, so two tabs cannot lose a slot", async () => {
    const { write } = await beat();
    expect(write.where).toEqual({ id: ATTEMPT, version: 7 });
    expect(write.data.version).toEqual({ increment: 1 });
  });

  it("reports the server's remaining time, including paused time", async () => {
    const { outcome } = await beat({
      attempt: attemptRow({ expiresAt: new Date(STARTED.getTime() + 900_000), pausedMs: 60_000 }),
    });
    // 15 minutes of clock + 1 minute of break, 10 minutes in.
    expect(outcome.msRemaining).toBe(360_000);
  });

  it("never reports a negative remaining time", async () => {
    const { outcome } = await beat({ attempt: attemptRow({ expiresAt: STARTED }) });
    expect(outcome.msRemaining).toBe(0);
  });

  it("records nothing when there is nothing to record", async () => {
    const { outcome } = await beat({ attempt: attemptRow({ lastHeartbeatAt: new Date(Date.now() - 10_000) }) });
    expect(outcome.derived).toEqual([]);
    expect(h.createMany).not.toHaveBeenCalled();
  });

  // ── Reconnection ───────────────────────────────────────────────────────

  it("returns a DISCONNECTED sitting to IN_PROGRESS on the first beat back", async () => {
    const { outcome, write } = await beat({
      attempt: attemptRow({ status: "DISCONNECTED", lastHeartbeatAt: new Date(Date.now() - 120_000) }),
    });
    expect(write.data.status).toBe("IN_PROGRESS");
    expect(outcome.status).toBe("IN_PROGRESS");
  });

  it("does not move the deadline on reconnection — the clock never stopped", async () => {
    const { write } = await beat({
      attempt: attemptRow({ status: "DISCONNECTED", lastHeartbeatAt: new Date(Date.now() - 120_000) }),
    });
    expect(write.data).not.toHaveProperty("expiresAt");
    expect(write.data).not.toHaveProperty("pausedMs");
  });

  it("costs the candidate nothing: a reconnection never touches the integrity score", async () => {
    const { write } = await beat({
      attempt: attemptRow({ status: "DISCONNECTED", lastHeartbeatAt: new Date(Date.now() - 600_000) }),
    });
    expect(write.data).not.toHaveProperty("integrityScore");
  });

  // ── What it notices ────────────────────────────────────────────────────

  it("records a presence gap once it exceeds the 45-second rule", async () => {
    const { outcome } = await beat({
      attempt: attemptRow({ lastHeartbeatAt: new Date(Date.now() - 90_000) }),
    });
    expect(outcome.derived).toContain("HEARTBEAT_GAP");
    const [{ data }] = h.createMany.mock.calls[0] as [{ data: Array<Record<string, unknown>> }];
    const gap = data.find((e) => e.kind === "HEARTBEAT_GAP")!;
    expect(gap.source).toBe("SERVER");
    expect(gap.clientSeq).toBeUndefined();
    expect(gap.durationMs).toBe(90_000);
  });

  it("does not record a gap inside the 45-second rule", async () => {
    const { outcome } = await beat({
      attempt: attemptRow({ lastHeartbeatAt: new Date(Date.now() - 44_000) }),
    });
    expect(outcome.derived).not.toContain("HEARTBEAT_GAP");
  });

  it("does not record a gap on the very first beat of a sitting", async () => {
    const { outcome } = await beat({ attempt: attemptRow({ lastHeartbeatAt: null }) });
    expect(outcome.derived).not.toContain("HEARTBEAT_GAP");
  });

  it("records a gap in the client's sequence, with how many numbers it missed", async () => {
    const { outcome } = await beat({
      attempt: attemptRow({ lastClientSeq: 4, lastHeartbeatAt: new Date(Date.now() - 10_000) }),
      body: { clientSeq: 10 },
    });
    expect(outcome.derived).toContain("SEQUENCE_GAP");
    const [{ data }] = h.createMany.mock.calls[0] as [{ data: Array<Record<string, unknown>> }];
    expect((data.find((e) => e.kind === "SEQUENCE_GAP")!.meta as { skipped: number }).skipped).toBe(5);
  });

  it("does not record a sequence gap for consecutive beats", async () => {
    const { outcome } = await beat({
      attempt: attemptRow({ lastClientSeq: 4, lastHeartbeatAt: new Date(Date.now() - 10_000) }),
      body: { clientSeq: 5 },
    });
    expect(outcome.derived).not.toContain("SEQUENCE_GAP");
  });

  it("keeps the sequence high-water mark when a beat arrives out of order", async () => {
    const { write } = await beat({
      attempt: attemptRow({ lastClientSeq: 9, lastHeartbeatAt: new Date(Date.now() - 10_000) }),
      body: { clientSeq: 2 },
    });
    expect(write.data.lastClientSeq).toBe(9);
  });

  it("records a changed network, comparing hashes to hashes", async () => {
    const { outcome, write } = await beat(
      { attempt: attemptRow({ ipHashLast: "old-ip", lastHeartbeatAt: new Date(Date.now() - 10_000) }) },
      { ipHash: "new-ip" },
    );
    expect(outcome.derived).toContain("IP_CHANGED");
    expect(write.data.ipHashLast).toBe("new-ip");
  });

  it("does not record a changed network on the first beat that reports one", async () => {
    const { outcome } = await beat(
      { attempt: attemptRow({ ipHashLast: null, lastHeartbeatAt: new Date(Date.now() - 10_000) }) },
      { ipHash: "first-ip" },
    );
    expect(outcome.derived).not.toContain("IP_CHANGED");
  });

  it("keeps the stored network hash when this request could not determine one", async () => {
    const { write } = await beat(
      { attempt: attemptRow({ ipHashLast: "old-ip", lastHeartbeatAt: new Date(Date.now() - 10_000) }) },
      { ipHash: null },
    );
    expect(write.data.ipHashLast).toBe("old-ip");
  });

  it("records a changed browser", async () => {
    const { outcome } = await beat(
      { attempt: attemptRow({ uaHash: "old-ua", lastHeartbeatAt: new Date(Date.now() - 10_000) }) },
      { uaHash: "new-ua" },
    );
    expect(outcome.derived).toContain("UA_CHANGED");
  });

  it("records a second live session, and does not move the lock", async () => {
    const { outcome, write } = await beat({
      attempt: attemptRow({ lastHeartbeatAt: new Date(Date.now() - 10_000) }),
      sessionNotice: "concurrent",
    });
    expect(outcome.derived).toContain("CONCURRENT_SESSION");
    expect(write.data).not.toHaveProperty("lockSessionId");
  });

  it("moves the lock to this session when the original is gone, and records nothing", async () => {
    const { outcome, write } = await beat({
      attempt: attemptRow({ lastHeartbeatAt: new Date(Date.now() - 10_000) }),
      sessionNotice: "rebind",
    });
    expect(write.data.lockSessionId).toBe("sess_2");
    expect(outcome.derived).toEqual([]);
  });

  // ── The gap figure ─────────────────────────────────────────────────────

  it("computes maxHeartbeatGapSeconds itself, never from the client", async () => {
    // A sitting ten minutes in whose only beat is now: 40 slots of silence
    // at 15 seconds each.
    const { write } = await beat();
    expect(write.data.maxHeartbeatGapSeconds).toBe(600);
  });

  it("never lowers a recorded gap", async () => {
    const { write } = await beat({ attempt: attemptRow({ maxHeartbeatGapSeconds: 9_999 }) });
    expect(write.data.maxHeartbeatGapSeconds).toBe(9_999);
  });

  // ── What it must never do ──────────────────────────────────────────────

  it("never writes a score, a flag or a status a human must decide", async () => {
    const { write } = await beat(
      {
        attempt: attemptRow({ lastHeartbeatAt: new Date(Date.now() - 600_000), lastClientSeq: 1, ipHashLast: "old" }),
        body: { clientSeq: 99 },
        sessionNotice: "concurrent",
      },
      { ipHash: "new", uaHash: "new-ua" },
    );
    for (const forbidden of ["integrityScore", "totalScore", "submittedAt", "blurEventCount", "expiresAt"]) {
      expect(write.data).not.toHaveProperty(forbidden);
    }
    expect(write.data.status).toBeUndefined();
  });

  it("writes no events at all when the conditional update lost its race", async () => {
    h.updateMany.mockResolvedValue({ count: 0 });
    await beat({ attempt: attemptRow({ lastHeartbeatAt: new Date(Date.now() - 600_000) }) });
    expect(h.createMany).not.toHaveBeenCalled();
  });

  it("records every server event as SERVER-sourced with no client sequence", async () => {
    // The CHECK is (source = 'CLIENT') = (clientSeq IS NOT NULL); a
    // server-sourced event carrying a sequence would be refused by Postgres.
    await beat(
      {
        attempt: attemptRow({ lastHeartbeatAt: new Date(Date.now() - 600_000), lastClientSeq: 1, ipHashLast: "old" }),
        body: { clientSeq: 99 },
        sessionNotice: "concurrent",
      },
      { ipHash: "new", uaHash: "new-ua" },
    );
    const [{ data }] = h.createMany.mock.calls[0] as [{ data: Array<Record<string, unknown>> }];
    expect(data.length).toBeGreaterThan(1);
    for (const event of data) {
      expect(event.source).toBe("SERVER");
      expect(event.clientSeq).toBeUndefined();
      expect(event.hash).toBeUndefined();
    }
  });
});
