import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Read-only impersonation, swept across EVERY server action: while a
 * SUPER_ADMIN views as a student, each exported action of every file in
 * src/server/actions refuses with the read-only message before it touches
 * the database or the audit log. The only exceptions: auth#logout (signing
 * out must work) and super-impersonate#endImpersonation (the way out). The
 * two mutating cookie-session route handlers refuse with 403 too.
 */

const h = vi.hoisted(() => {
  const touched: string[] = [];
  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        touched.push(String(prop));
        throw new Error(`database touched: db.${String(prop)}`);
      },
    },
  );
  const impersonating = {
    id: "student_1",
    role: "STUDENT",
    status: "ACTIVE",
    firstName: "Asha",
    lastName: "R",
    collegeId: "2116231001001",
    email: "",
    impersonation: {
      id: "imp_1",
      sessionId: "session_1",
      reason: "checking the dashboard the student reported",
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      impersonator: { id: "super_1", firstName: "Super", lastName: "Admin", role: "SUPER_ADMIN" },
    },
  };
  return { touched, db, impersonating, audit: vi.fn() };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, auditMany: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null, hashIp: () => "x" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => h.impersonating,
  currentSessionId: async () => "session_1",
  destroySession: vi.fn(),
  destroyAllSessions: vi.fn(),
}));

const { IMPERSONATION_READ_ONLY_MESSAGE } = await import("@/lib/errors");
const { actionModules } = await import("./support/action-modules");
const ALLOWED_DURING_IMPERSONATION = new Set(["auth#logout", "super-impersonate#endImpersonation"]);

const entries = actionModules();

beforeEach(() => {
  h.touched.length = 0;
  h.audit.mockClear();
});

describe("every server action refuses while impersonating", () => {
  it("finds the action modules (sanity)", () => {
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.map(([name]) => name)).toContain("super-users");
  });

  it.each(entries)("%s", async (file, load) => {
    const mod = await load();
    const refused: string[] = [];
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      const ref = `${file}#${name}`;
      if (ALLOWED_DURING_IMPERSONATION.has(ref)) continue;
      const result = (await (value as (input: unknown) => Promise<unknown>)({})) as { ok?: boolean; error?: string };
      if (!(result && result.ok === false && result.error === IMPERSONATION_READ_ONLY_MESSAGE)) {
        refused.push(`${ref} returned ${JSON.stringify(result)}`);
      }
    }
    expect(refused).toEqual([]);
    expect(h.touched).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("mutating route handlers refuse while impersonating", () => {
  const sameOrigin = (url: string, body: string) =>
    new Request(url, {
      method: "POST",
      headers: { host: "localhost:3100", origin: "http://localhost:3100", "content-type": "text/plain" },
      body,
    });

  it("POST /api/drafts → 403", async () => {
    const { POST } = await import("@/app/api/drafts/route");
    const response = await POST(sameOrigin("http://localhost:3100/api/drafts", "{}"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: IMPERSONATION_READ_ONLY_MESSAGE });
    expect(h.touched).toEqual([]);
  });

  it("POST /api/activity → 403", async () => {
    const { POST } = await import("@/app/api/activity/route");
    const response = await POST(sameOrigin("http://localhost:3100/api/activity", "{}"));
    expect(response.status).toBe(403);
    expect(h.touched).toEqual([]);
  });
});
