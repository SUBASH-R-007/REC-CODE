import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * startImpersonation / endImpersonation with their collaborators stubbed:
 * the start rules (flag on, reason 20–500, not yourself, not a
 * SUPER_ADMIN, an active target), the SECURITY audit with an ISO expiry,
 * the 15-minute box, the redirect home, and ending as the impersonator.
 */

const h = vi.hoisted(() => ({
  actor: { id: "super_1", role: "SUPER_ADMIN" },
  target: { id: "student_1", role: "STUDENT", status: "ACTIVE", collegeId: "2116231001001" } as Record<string, unknown> | null,
  flag: true,
  begin: vi.fn(),
  close: vi.fn(),
  audit: vi.fn(),
  redirect: vi.fn((url: string) => {
    const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
    error.digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  }),
}));

vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/lib/auth/guards", () => ({
  homeForRole: (role: string) => (role === "STUDENT" ? "/dashboard" : "/admin"),
  requireSuperAdmin: async () => h.actor,
  requireImpersonator: async () => ({
    actorId: "super_1",
    impersonation: { id: "imp_9", impersonator: { id: "super_1" } },
  }),
}));
vi.mock("@/lib/auth/impersonation", () => ({ beginImpersonation: h.begin, closeImpersonation: h.close }));
vi.mock("@/lib/auth/session", () => ({ currentSessionId: async () => "session_1" }));
vi.mock("@/lib/flags", () => ({ isFeatureEnabled: async () => h.flag }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: async () => h.target } } }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => "iphash" }));

const { startImpersonation, endImpersonation } = await import("@/server/actions/super-impersonate");
const { IMPERSONATION_MAX_MS } = await import("@recx/shared");

const REASON = "Student reports a blank dashboard after sign-in";

beforeEach(() => {
  vi.clearAllMocks();
  h.flag = true;
  h.target = { id: "student_1", role: "STUDENT", status: "ACTIVE", collegeId: "2116231001001" };
  h.begin.mockImplementation(async (i: { now: Date }) => ({ id: "imp_9", expiresAt: new Date(i.now.getTime() + IMPERSONATION_MAX_MS) }));
});

describe("startImpersonation", () => {
  it("starts a 15-minute read-only view, audits SECURITY and redirects to the target's home", async () => {
    await expect(startImpersonation({ targetUserId: "student_1", reason: REASON })).rejects.toThrow("NEXT_REDIRECT");
    expect(h.begin).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session_1", impersonatorId: "super_1", targetUserId: "student_1", reason: REASON }),
    );
    const entry = h.audit.mock.calls[0]![0] as { action: string; sensitivity: string; metadata: { expiresAt: unknown } };
    expect(entry.action).toBe("impersonation.started");
    expect(entry.sensitivity).toBe("SECURITY");
    expect(typeof entry.metadata.expiresAt).toBe("string");
    expect(h.redirect).toHaveBeenCalledWith("/dashboard");
  });

  it.each([
    ["a short reason", { targetUserId: "student_1", reason: "too short" }],
    ["yourself", { targetUserId: "super_1", reason: REASON }],
  ])("refuses %s", async (_label, input) => {
    const result = await startImpersonation(input);
    expect(result.ok).toBe(false);
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it.each([
    ["a SUPER_ADMIN target", { role: "SUPER_ADMIN", status: "ACTIVE" }],
    ["a DISABLED target", { role: "STUDENT", status: "DISABLED" }],
    ["an ARCHIVED target", { role: "STUDENT", status: "ARCHIVED" }],
  ])("refuses %s", async (_label, fields) => {
    h.target = { ...h.target!, ...fields };
    const result = await startImpersonation({ targetUserId: "student_1", reason: REASON });
    expect(result.ok).toBe(false);
    expect(h.begin).not.toHaveBeenCalled();
  });

  it("refuses while the impersonation flag is off", async () => {
    h.flag = false;
    const result = await startImpersonation({ targetUserId: "student_1", reason: REASON });
    expect(result).toEqual({ ok: false, error: "Impersonation is switched off (Super-admin → Flags)." });
  });

  it("allows a soft-restricted target", async () => {
    h.target = { ...h.target!, status: "SOFT_RESTRICTED" };
    await expect(startImpersonation({ targetUserId: "student_1", reason: REASON })).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("endImpersonation", () => {
  it("closes as ENDED, attributed to the super-admin, and returns to /super/impersonate", async () => {
    await expect(endImpersonation()).rejects.toThrow("NEXT_REDIRECT");
    expect(h.close).toHaveBeenCalledWith(expect.objectContaining({ impersonationId: "imp_9", reason: "ENDED", actorId: "super_1" }));
    expect(h.redirect).toHaveBeenCalledWith("/super/impersonate");
  });
});
