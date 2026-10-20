import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/exam/[attemptId]/hb — the exam heartbeat's contract (Phase 6b).
 *
 * The thing this suite is really guarding is that a candidate mid-exam is
 * never left with a frozen timer and no explanation. SPEC §5 makes the
 * heartbeat the only authoritative clock the exam surface has ("the client
 * renders msRemaining and never consults local Date.now()"), so a heartbeat
 * that answers with an error status is a candidate watching a dead countdown.
 * Every refusal a candidate can hit therefore comes back 200 with a body
 * they can render.
 */

const ATTEMPT = "att_1";

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  impersonating: false,
  requireActionUser: vi.fn(),
  guard: vi.fn(),
  endAttemptSession: vi.fn(),
  applyHeartbeat: vi.fn(),
  requestIpHash: vi.fn(),
  hashUserAgent: vi.fn(),
  session: null as { id: string } | null,
  cookie: "session-token" as string | undefined,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (h.cookie ? { value: h.cookie } : undefined),
    set: vi.fn(),
  }),
}));
vi.mock("@/lib/auth/guards", () => ({ requireActionUser: h.requireActionUser }));
vi.mock("@/lib/db", () => ({
  db: { session: { findUnique: async () => h.session } },
}));
vi.mock("@/lib/exam/attempt", () => ({
  guardAttempt: h.guard,
  endAttemptSession: h.endAttemptSession,
}));
vi.mock("@/lib/exam/heartbeat", () => ({ applyHeartbeat: h.applyHeartbeat }));
vi.mock("@/lib/ip", () => ({ requestIpHash: h.requestIpHash, hashUserAgent: h.hashUserAgent }));

const { ImpersonationReadOnlyError, UnauthorizedError } = await import("@/lib/errors");
const { POST } = await import("@/app/api/exam/[attemptId]/hb/route");
const { EXAM_HEARTBEAT_INTERVAL_MS, ATTEMPT_REVOKE_REASONS } = await import("@recx/shared");

const NOW = new Date("2026-10-19T10:00:00.000Z");

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3100/api/exam/${ATTEMPT}/hb`, {
    method: "POST",
    headers: { host: "localhost:3100", "content-type": "application/json", "user-agent": "vitest", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ attemptId: ATTEMPT }) };
const post = (body: unknown, headers?: Record<string, string>) => POST(request(body, headers), params);

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "user_1" };
  h.impersonating = false;
  h.requireActionUser.mockImplementation(async () => {
    if (h.impersonating) throw new ImpersonationReadOnlyError();
    if (!h.user) throw new UnauthorizedError();
    return h.user;
  });
  h.session = { id: "sess_1" };
  h.cookie = "session-token";
  h.requestIpHash.mockResolvedValue("ip-hash");
  h.hashUserAgent.mockReturnValue("ua-hash");
  h.guard.mockResolvedValue({
    ok: true,
    attempt: { id: ATTEMPT, status: "IN_PROGRESS" },
    status: "IN_PROGRESS",
    msRemaining: 1_200_000,
    now: NOW,
    sessionNotice: null,
    sessionId: "sess_1",
  });
  h.applyHeartbeat.mockResolvedValue({
    status: "IN_PROGRESS",
    msRemaining: 1_200_000,
    serverNow: NOW,
    nextHeartbeatMs: EXAM_HEARTBEAT_INTERVAL_MS,
    derived: [],
  });
});

describe("POST /api/exam/[attemptId]/hb", () => {
  it("answers with the server's clock and the server's remaining time", async () => {
    const response = await post({ clientSeq: 3 });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      serverNow: NOW.toISOString(),
      msRemaining: 1_200_000,
      status: "IN_PROGRESS",
      pendingInvigilatorMessages: [],
      revokeReason: null,
      nextHeartbeatMs: EXAM_HEARTBEAT_INTERVAL_MS,
    });
  });

  it("passes the hashed network and browser to the applier, never the raw values", async () => {
    await post({ clientSeq: 1 });
    expect(h.applyHeartbeat).toHaveBeenCalledWith(expect.anything(), { clientSeq: 1 }, {
      ipHash: "ip-hash",
      uaHash: "ua-hash",
    });
    expect(h.hashUserAgent).toHaveBeenCalledWith("vitest");
  });

  it("tells the guard which session the beat arrived on", async () => {
    await post({ clientSeq: 1 });
    expect(h.guard).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: ATTEMPT, userId: "user_1", sessionId: "sess_1" }),
    );
  });

  it("reports a null session id when there is no session cookie", async () => {
    h.cookie = undefined;
    await post({ clientSeq: 1 });
    expect(h.guard).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }));
  });

  it("carries the invigilator message channel in the contract from the first beat", async () => {
    // Phase 6e fills it. The field exists now so the exam client never has to
    // change shape later.
    const body = (await (await post({ clientSeq: 1 })).json()) as Record<string, unknown>;
    expect(body).toHaveProperty("pendingInvigilatorMessages");
    expect(body.pendingInvigilatorMessages).toEqual([]);
  });

  it("passes the client's own clock through for drift logging", async () => {
    await post({ clientSeq: 1, clientNowMs: 1_700_000_000_000 });
    expect(h.applyHeartbeat).toHaveBeenCalledWith(
      expect.anything(),
      { clientSeq: 1, clientNowMs: 1_700_000_000_000 },
      expect.anything(),
    );
  });

  // ── Refusals a candidate can hit ───────────────────────────────────────

  it.each(ATTEMPT_REVOKE_REASONS)("answers 200 with revokeReason %s rather than an error status", async (reason) => {
    h.guard.mockResolvedValue({
      ok: false,
      reason,
      message: "…",
      attempt: { id: ATTEMPT, status: "AUTO_SUBMITTED" },
      now: NOW,
    });
    const response = await post({ clientSeq: 9 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.revokeReason).toBe(reason);
    expect(body.msRemaining).toBe(0);
    expect(h.applyHeartbeat).not.toHaveBeenCalled();
  });

  it("reports the attempt's real status with the refusal, so the client shows the right screen", async () => {
    h.guard.mockResolvedValue({
      ok: false,
      reason: "expired",
      message: "…",
      attempt: { id: ATTEMPT, status: "AUTO_SUBMITTED" },
      now: NOW,
    });
    const body = (await (await post({ clientSeq: 9 })).json()) as Record<string, unknown>;
    expect(body.status).toBe("AUTO_SUBMITTED");
  });

  it("clears the attempt cookie on a refusal, so a finished sitting stops carrying a credential", async () => {
    h.guard.mockResolvedValue({ ok: false, reason: "expired", message: "…", attempt: null, now: NOW });
    await post({ clientSeq: 9 });
    expect(h.endAttemptSession).toHaveBeenCalledWith(ATTEMPT, "expired");
  });

  it("still answers when the guard knows nothing about the attempt", async () => {
    h.guard.mockResolvedValue({ ok: false, reason: "bad_token", message: "…", attempt: null, now: NOW });
    const body = (await (await post({ clientSeq: 9 })).json()) as Record<string, unknown>;
    expect(body.status).toBe("NOT_STARTED");
    expect(body.revokeReason).toBe("bad_token");
  });

  // ── Not a candidate mid-exam ───────────────────────────────────────────

  it("refuses an unauthenticated beat with 401", async () => {
    h.user = null;
    const response = await post({ clientSeq: 1 });
    expect(response.status).toBe(401);
    expect(h.guard).not.toHaveBeenCalled();
  });

  it("refuses a beat from an impersonated session", async () => {
    // There is nothing sensible for a super-admin viewing as a student to
    // beat at, and a heartbeat would write to that student's sitting.
    h.impersonating = true;
    const response = await post({ clientSeq: 1 });
    expect(response.status).toBe(403);
    expect(h.guard).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const response = await POST(request("not json at all"), params);
    expect(response.status).toBe(400);
    expect(h.guard).not.toHaveBeenCalled();
  });

  it("refuses a beat with no sequence number", async () => {
    expect((await post({})).status).toBe(400);
  });

  it("refuses a beat that tries to supply its own deadline", async () => {
    // The strict schema is the server's answer to a client that would like
    // more time: there is no field to ask with.
    expect((await post({ clientSeq: 1, msRemaining: 9_999_999 })).status).toBe(400);
    expect((await post({ clientSeq: 1, expiresAt: "2099-01-01T00:00:00Z" })).status).toBe(400);
    expect(h.applyHeartbeat).not.toHaveBeenCalled();
  });

  it("refuses a negative sequence number", async () => {
    expect((await post({ clientSeq: -1 })).status).toBe(400);
  });
});
