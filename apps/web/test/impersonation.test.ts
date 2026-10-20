import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Read-only impersonation through the REAL session and guard modules, with
 * the database and cookies faked: getCurrentUser() follows the session's
 * pointer and returns the target with `impersonation`; every check (the
 * 15-minute box, the impersonator still an ACTIVE SUPER_ADMIN, the flag, the
 * target's status) closes it when it fails (EXPIRED or REVOKED, audited);
 * requireActionUser() refuses while it is live; sign-out closes it
 * (SIGNED_OUT).
 */

const NOW = Date.now();

const h = vi.hoisted(() => {
  const state = {
    cookie: "raw-token" as string | undefined,
    session: null as null | Record<string, unknown>,
    impersonation: null as null | Record<string, unknown>,
    users: new Map<string, Record<string, unknown>>(),
    flags: null as unknown,
    closed: [] as Array<{ id: string; reason: string }>,
    pointerCleared: 0,
    deletedSessions: 0,
  };
  const audit = vi.fn();
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // UPDATE "ImpersonationSession" … WHERE id = $2 AND "endedAt" IS NULL RETURNING …
      const reason = String(values[0]);
      const id = String(values[1]);
      const row = state.impersonation;
      if (!row || row.id !== id || row.endedAt) return [];
      row.endedAt = new Date();
      row.endReason = reason;
      state.closed.push({ id, reason });
      void strings;
      return [{ ...row }];
    },
    session: {
      updateMany: async () => {
        state.pointerCleared++;
        if (state.session) state.session.impersonationId = null;
        return { count: 1 };
      },
    },
  };
  const db = {
    session: {
      findUnique: async ({ select }: { select?: unknown }) =>
        state.session ? (select ? state.session : { ...state.session, user: state.users.get(String(state.session.userId)) }) : null,
      update: async () => ({}),
      updateMany: tx.session.updateMany,
      deleteMany: async () => {
        state.deletedSessions++;
        return { count: 1 };
      },
    },
    impersonationSession: {
      findUnique: async () => (state.impersonation ? { ...state.impersonation } : null),
      findMany: async () => [],
    },
    user: { findUnique: async ({ where }: { where: { id: string } }) => state.users.get(where.id) ?? null },
    platformSetting: { findUnique: async () => (state.flags === null ? null : { value: state.flags }) },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  return { state, db, audit };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (h.state.cookie ? { value: h.state.cookie } : undefined),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));
vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, auditMany: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("@/lib/env", () => ({ isProduction: () => false, env: () => ({}) }));

const { getCurrentUser, destroySession } = await import("@/lib/auth/session");
const { requireActionUser, requireImpersonator, requireSuperAdmin } = await import("@/lib/auth/guards");
const { IMPERSONATION_READ_ONLY_MESSAGE, ImpersonationReadOnlyError } = await import("@/lib/errors");

const SUPER = { id: "super_1", role: "SUPER_ADMIN", status: "ACTIVE", firstName: "Sita", lastName: "Raman", collegeId: "RECADMIN01" };
const STUDENT = { id: "student_1", role: "STUDENT", status: "ACTIVE", firstName: "Asha", lastName: "R", collegeId: "2116231001001" };

function live(fields: Record<string, unknown> = {}) {
  return {
    id: "imp_1",
    impersonatorId: SUPER.id,
    targetUserId: STUDENT.id,
    reason: "Student reports a blank dashboard after sign-in",
    startedAt: new Date(NOW - 60_000),
    expiresAt: new Date(NOW + 14 * 60_000),
    endedAt: null,
    endReason: null,
    ...fields,
  };
}

beforeEach(() => {
  h.audit.mockClear();
  h.state.cookie = "raw-token";
  h.state.users = new Map([
    [SUPER.id, { ...SUPER }],
    [STUDENT.id, { ...STUDENT }],
  ]);
  h.state.session = {
    id: "session_1",
    userId: SUPER.id,
    impersonationId: "imp_1",
    expiresAt: new Date(NOW + 10 * 86_400_000),
    lastSeenAt: new Date(),
  };
  h.state.impersonation = live();
  h.state.flags = null;
  h.state.closed = [];
  h.state.pointerCleared = 0;
  h.state.deletedSessions = 0;
});

describe("getCurrentUser while impersonating", () => {
  it("returns the target with the impersonation context", async () => {
    const user = await getCurrentUser();
    expect(user?.id).toBe(STUDENT.id);
    expect(user?.impersonation).toMatchObject({
      id: "imp_1",
      sessionId: "session_1",
      impersonator: { id: SUPER.id, role: "SUPER_ADMIN" },
    });
    expect(h.state.closed).toEqual([]);
  });

  it("closes an expired impersonation (EXPIRED, audited) and returns the super-admin", async () => {
    h.state.impersonation = live({ expiresAt: new Date(NOW - 1) });
    const user = await getCurrentUser();
    expect(user?.id).toBe(SUPER.id);
    expect(user?.impersonation).toBeUndefined();
    expect(h.state.closed).toEqual([{ id: "imp_1", reason: "EXPIRED" }]);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "impersonation.ended",
        sensitivity: "SECURITY",
        targetUserId: STUDENT.id,
        metadata: expect.objectContaining({ endReason: "EXPIRED" }),
      }),
    );
  });

  it.each([
    ["the flag is off", () => (h.state.flags = { impersonation: false })],
    ["the target was disabled", () => h.state.users.set(STUDENT.id, { ...STUDENT, status: "DISABLED" })],
    ["the target became a super-admin", () => h.state.users.set(STUDENT.id, { ...STUDENT, role: "SUPER_ADMIN" })],
    ["the impersonator lost SUPER_ADMIN", () => h.state.users.set(SUPER.id, { ...SUPER, role: "ADMIN" })],
  ])("revokes when %s", async (_label, arrange) => {
    arrange();
    const user = await getCurrentUser();
    expect(user?.impersonation).toBeUndefined();
    expect(h.state.closed).toEqual([{ id: "imp_1", reason: "REVOKED" }]);
  });

  it("clears a stale pointer to an ended impersonation without auditing", async () => {
    h.state.impersonation = live({ endedAt: new Date(NOW - 1_000), endReason: "ENDED" });
    const user = await getCurrentUser();
    expect(user?.id).toBe(SUPER.id);
    expect(h.state.pointerCleared).toBe(1);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("guards", () => {
  it("requireActionUser refuses every mutation while impersonating", async () => {
    await expect(requireActionUser()).rejects.toBeInstanceOf(ImpersonationReadOnlyError);
    await expect(requireSuperAdmin()).rejects.toThrow(IMPERSONATION_READ_ONLY_MESSAGE);
  });

  it("requireImpersonator returns the super-admin, never the target", async () => {
    const { actorId, impersonation } = await requireImpersonator();
    expect(actorId).toBe(SUPER.id);
    expect(impersonation.id).toBe("imp_1");
  });

  it("requireImpersonator refuses when nobody is being impersonated", async () => {
    h.state.session = { ...h.state.session!, impersonationId: null };
    await expect(requireImpersonator()).rejects.toThrow(/not viewing as another user/);
    await expect(requireActionUser()).resolves.toMatchObject({ id: SUPER.id });
  });
});

describe("sign-out", () => {
  it("closes a live impersonation as SIGNED_OUT before deleting the session", async () => {
    await destroySession();
    expect(h.state.closed).toEqual([{ id: "imp_1", reason: "SIGNED_OUT" }]);
    expect(h.state.deletedSessions).toBe(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "impersonation.ended", actorId: SUPER.id, metadata: expect.objectContaining({ endReason: "SIGNED_OUT" }) }),
    );
  });
});
