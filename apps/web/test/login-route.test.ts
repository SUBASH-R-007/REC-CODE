import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/auth/login — the zero-JavaScript sign-in form's target — with
 * the real route handler and the real signIn() (src/lib/auth/sign-in.ts),
 * the real session module and the real homeForRole(). Faked: the database,
 * the audit log, the rate limiter, Argon2id, the client IP and Next's
 * request-scoped headers()/cookies().
 */

interface FakeUser {
  id: string;
  role: "STUDENT" | "ADMIN";
  status: "ACTIVE" | "SOFT_RESTRICTED" | "SUSPENDED";
  passwordHash: string | null;
}

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const jar = new Map<string, string>();
  return {
    calls,
    jar,
    users: [] as FakeUser[],
    findError: null as Error | null,
    limited: false,
    cookieSets: [] as { name: string; value: string; options: Record<string, unknown> }[],
    audits: [] as Record<string, unknown>[],
    verified: [] as string[],
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    user: {
      findFirst: vi.fn(async ({ where }: { where: { email?: { in: string[] }; collegeId?: { in: string[] } } }) => {
        h.calls.push("user.findFirst");
        if (h.findError) throw h.findError;
        const wanted = where.email?.in ?? where.collegeId?.in ?? [];
        return h.users.find((u) => wanted.includes(u.id)) ?? null;
      }),
      update: vi.fn(async () => {
        h.calls.push("user.update");
        return {};
      }),
    },
    session: {
      // destroySession() looks for a live impersonation on the old session first (none here).
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => {
        h.calls.push("session.create");
        return {};
      }),
      deleteMany: vi.fn(async () => {
        h.calls.push("session.deleteMany");
        return { count: 1 };
      }),
    },
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (entry: Record<string, unknown>) => {
    h.audits.push(entry);
  }),
}));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => "ip-hash" }));
vi.mock("@/lib/auth/password", () => ({
  dummyPasswordHash: async () => "DECOY",
  verifyPassword: vi.fn(async (password: string, hash: string) => {
    h.verified.push(hash);
    return hash === "HASH" && password === "right password";
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  LOGIN_RATE_LIMITS: { account: { limit: 5, windowMs: 900_000 }, ip: { limit: 20, windowMs: 900_000 } },
  hitRateLimit: vi.fn(async (key: string) => {
    h.calls.push(`hit ${key.split(":").slice(0, 2).join(":")}`);
    return h.limited ? { allowed: false, retryAfterMs: 125_000, key } : { allowed: true, retryAfterMs: 0, key };
  }),
  releaseRateLimit: vi.fn(async () => undefined),
  resetRateLimit: vi.fn(async () => undefined),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest" }),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      h.calls.push(`cookie.set ${name}`);
      h.cookieSets.push({ name, value, options });
      h.jar.set(name, value);
    },
    delete: (name: string) => {
      h.calls.push(`cookie.delete ${name}`);
      h.jar.delete(name);
    },
  }),
}));

const { POST } = await import("@/app/api/auth/login/route");
const { verifyPassword } = await import("@/lib/auth/password");

const ORIGIN = "http://localhost:3000";

function post(body: string | null, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: {
      host: "localhost:3000",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body,
  });
}
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}
const identifierCookie = (response: Response) => setCookies(response).find((c) => c.startsWith("recx_login_id="));

beforeEach(() => {
  h.calls.length = 0;
  h.jar.clear();
  h.users = [
    { id: "2116231001001", role: "STUDENT", status: "ACTIVE", passwordHash: "HASH" },
    { id: "RECADMIN01", role: "ADMIN", status: "ACTIVE", passwordHash: "HASH" },
    { id: "2116231009999", role: "STUDENT", status: "SUSPENDED", passwordHash: "HASH" },
    { id: "2116231008888", role: "STUDENT", status: "ACTIVE", passwordHash: null },
  ];
  h.findError = null;
  h.limited = false;
  h.cookieSets.length = 0;
  h.audits.length = 0;
  h.verified.length = 0;
  vi.clearAllMocks();
});

describe("POST /api/auth/login — refused before anything is read", () => {
  it("a cross-site post: 303 to /login?error=cross-site, body unread, no database access", async () => {
    const request = post(form({ identifier: "2116231001001", password: "right password" }), { "sec-fetch-site": "cross-site" });
    const response = await POST(request);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?error=cross-site");
    expect(request.bodyUsed).toBe(false);
    expect(h.calls).toEqual([]);
    expect(identifierCookie(response)).toBeUndefined();
  });

  it("an Origin that is not this host (no Fetch Metadata): cross-site", async () => {
    const request = post(form({ identifier: "2116231001001", password: "x" }), {
      "sec-fetch-site": "",
      origin: "https://evil.example",
    });
    const response = await POST(request);
    expect(response.headers.get("location")).toBe("/login?error=cross-site");
    expect(h.calls).toEqual([]);
  });

  it("a body that is not the urlencoded form, or too large, never reaches the database", async () => {
    for (const request of [
      post(JSON.stringify({ identifier: "2116231001001", password: "right password" }), { "content-type": "application/json" }),
      post(form({ identifier: "2116231001001", password: "p".repeat(20_000) })),
      post(form({ identifier: "a", password: "b" }), { "content-length": String(17 * 1024) }),
    ]) {
      const response = await POST(request);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/login?error=identifier-missing");
    }
    expect(h.calls).toEqual([]);
  });
});

describe("POST /api/auth/login — malformed or missing fields", () => {
  it("no identifier: identifier-missing, nothing to carry back", async () => {
    const response = await POST(post(form({ password: "right password" })));
    expect(response.headers.get("location")).toBe("/login?error=identifier-missing");
    expect(identifierCookie(response)).toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it("no password: password-missing, the identifier comes back in the cookie", async () => {
    const response = await POST(post(form({ identifier: " 2116231001001 " })));
    expect(response.headers.get("location")).toBe("/login?error=password-missing");
    expect(identifierCookie(response)).toMatch(/^recx_login_id=2116231001001;/);
    expect(h.calls).toEqual([]);
  });

  it("an over-long identifier or password: the matching -long code", async () => {
    expect((await POST(post(form({ identifier: "x".repeat(255), password: "y" })))).headers.get("location")).toBe(
      "/login?error=identifier-long",
    );
    expect((await POST(post(form({ identifier: "x", password: "y".repeat(1025) })))).headers.get("location")).toBe(
      "/login?error=password-long",
    );
  });
});

describe("POST /api/auth/login — credentials", () => {
  it("a wrong password: one code for every credential failure, identifier in a short /login-only httpOnly cookie, never in the URL", async () => {
    const response = await POST(post(form({ identifier: "2116231001001", password: "wrong" })));
    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toBe("/login?error=credentials");
    expect(location).not.toContain("2116231001001");

    const cookie = identifierCookie(response)!;
    expect(cookie).toBeDefined();
    const attributes = cookie.split(/;\s*/).map((a) => a.toLowerCase());
    expect(attributes[0]).toBe("recx_login_id=2116231001001");
    expect(attributes).toContain("path=/login");
    expect(attributes).toContain("httponly");
    expect(attributes).toContain("samesite=lax");
    expect(attributes).toContain("max-age=60");
    expect(response.headers.get("cache-control")).toBe("no-store");

    // A known account: the failure is audited; no session is created.
    expect(h.audits).toEqual([expect.objectContaining({ action: "auth.login_failed", entityId: "2116231001001" })]);
    expect(h.calls).not.toContain("session.create");
  });

  it("an unknown account: the same answer, after a real Argon2id check against the decoy hash", async () => {
    const response = await POST(post(form({ identifier: "you@rajalakshmi.edu.in", password: "anything" })));
    expect(response.headers.get("location")).toBe("/login?error=credentials");
    expect(h.verified).toEqual(["DECOY"]);
    expect(h.audits).toEqual([]);
  });

  it("an account without a password (LMS sign-in only): still the decoy check, still 'credentials'", async () => {
    const response = await POST(post(form({ identifier: "2116231008888", password: "anything" })));
    expect(response.headers.get("location")).toBe("/login?error=credentials");
    expect(h.verified).toEqual(["DECOY"]);
  });

  it("the identifier cookie carries any characters encoded, and the URL still none of them", async () => {
    const typed = 'a b+c;"<x>@rajalakshmi.edu.in';
    const response = await POST(post(form({ identifier: typed, password: "wrong" })));
    expect(response.headers.get("location")).toBe("/login?error=credentials");
    const value = identifierCookie(response)!.split(";")[0]!.slice("recx_login_id=".length);
    expect(decodeURIComponent(value)).toBe(typed);
    expect(value).not.toMatch(/[;\s"<>]/);
  });

  it("an inactive account is named only to someone who proved the password", async () => {
    expect((await POST(post(form({ identifier: "2116231009999", password: "right password" })))).headers.get("location")).toBe(
      "/login?error=inactive",
    );
    expect((await POST(post(form({ identifier: "2116231009999", password: "wrong" })))).headers.get("location")).toBe(
      "/login?error=credentials",
    );
  });

  it("rate limited: refused before Argon2id, with the wait in whole minutes", async () => {
    h.limited = true;
    const response = await POST(post(form({ identifier: "2116231001001", password: "right password" })));
    expect(response.headers.get("location")).toBe("/login?error=rate-limited&retry=3");
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(h.calls).not.toContain("session.create");
    expect(identifierCookie(response)).toMatch(/^recx_login_id=2116231001001;/);
  });
});

describe("POST /api/auth/login — success", () => {
  it("303 to the role's home, a fresh session (the old one dropped first), the identifier cookie cleared", async () => {
    h.jar.set("recx_session", "old-session-token");
    const response = await POST(post(form({ identifier: "2116231001001", password: "right password" })));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard");

    // Rotation: the browser's previous session is deleted before the new one is minted.
    const order = h.calls.filter((c) => c.startsWith("session.") || c.startsWith("cookie."));
    expect(order).toEqual(["session.deleteMany", "cookie.delete recx_session", "session.create", "cookie.set recx_session"]);
    const session = h.cookieSets.find((c) => c.name === "recx_session")!;
    expect(session.value).not.toBe("old-session-token");
    expect(session.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });

    // The database stores only the token's hash.
    const { db } = await import("@/lib/db");
    const created = vi.mocked(db.session.create).mock.calls[0]![0] as unknown as { data: { tokenHash: string } };
    expect(created.data.tokenHash).toBe(createHash("sha256").update(session.value).digest("hex"));

    expect(h.audits).toEqual([expect.objectContaining({ action: "auth.login", actorId: "2116231001001" })]);
    expect(identifierCookie(response)).toMatch(/^recx_login_id=;.*Path=\/login/i);
    expect(identifierCookie(response)).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it("an admin lands on /admin — the home comes from the role, never from the request", async () => {
    const response = await POST(
      post(form({ identifier: "RECADMIN01", password: "right password", next: "https://evil.example/", redirect: "//evil.example" })),
    );
    expect(response.headers.get("location")).toBe("/admin");
  });
});

describe("POST /api/auth/login — unexpected errors", () => {
  it("a database failure: /login?error=unavailable with a support reference, logged with it", async () => {
    h.findError = new Error("connection refused");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(post(form({ identifier: "2116231001001", password: "right password" })));
    const location = response.headers.get("location")!;
    expect(location).toMatch(/^\/login\?error=unavailable&ref=[A-HJKMNP-Z2-9]{6}$/);
    const ref = location.split("ref=")[1]!;
    expect(String(logged.mock.calls[0]?.[0])).toContain(ref);
    expect(identifierCookie(response)).toMatch(/^recx_login_id=2116231001001;/);
    logged.mockRestore();
  });
});
