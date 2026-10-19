import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The role × capability matrix at runtime, with the REAL guards, for the
 * whole app. Every caller (each of the five roles, signed out, and a
 * SUPER_ADMIN impersonating a student) calls every bound server action,
 * route handler and /admin or /super page:
 *
 *   - a caller without the capability gets exactly the Forbidden result
 *     (Unauthorized when signed out; a redirect to its own home, or to
 *     /login, for a page) and nothing past the guard runs: no database
 *     access, no Redis, no audit row, no judge or email enqueue;
 *   - a caller with it gets past the guard (the empty input then fails
 *     validation or reaches the database stub, which throws);
 *   - an impersonating SUPER_ADMIN gets the read-only refusal from every
 *     action and mutating route, and sees pages as the student it views as.
 *
 * Which roles hold what comes from lib/auth/capabilities.ts; that each
 * guard admits exactly those roles in the source is the static half
 * (capabilities.test.ts).
 */

const h = vi.hoisted(() => {
  const log: string[] = [];
  const state: { user: Record<string, unknown> | null; mode: "throw" | "hang" } = { user: null, mode: "throw" };
  // "hang" mode (an allowed caller rendering a page): every database or Redis
  // call returns a promise that never settles, so a page that starts several
  // queries at once leaves no unhandled rejection behind.
  const pending: unknown = new Proxy(function pending() {}, {
    get: (_target, prop) => (prop === "then" ? undefined : pending),
    apply: () => new Promise(() => undefined),
  });
  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        log.push(`db:${String(prop)}`);
        if (state.mode === "hang") return pending;
        throw new Error(`database touched: db.${String(prop)}`);
      },
    },
  );
  const redis = () => {
    log.push("redis");
    if (state.mode === "hang") return pending;
    throw new Error("redis touched");
  };
  return { log, state, db, redis, audit: vi.fn(), enqueueJudge: vi.fn(), enqueueEmail: vi.fn() };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/redis", () => ({ redis: h.redis, newSubscriber: h.redis }));
vi.mock("@/lib/audit", () => ({ audit: h.audit, auditMany: h.audit }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null, hashIp: () => "x" }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: h.enqueueJudge }));
vi.mock("@/lib/outbox", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/outbox")>()),
  enqueueEmail: h.enqueueEmail,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), unstable_cache: (fn: unknown) => fn }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => h.state.user,
  currentSessionId: async () => "session_1",
  destroySession: vi.fn(),
  destroyAllSessions: vi.fn(),
}));
vi.mock("@/lib/auth/guards", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth/guards")>();
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      h.log.push(`guard:${name}`);
      return fn(...args);
    };
  return {
    ...actual,
    requireUser: wrap("requireUser", actual.requireUser),
    requirePageRole: wrap("requirePageRole", actual.requirePageRole),
    requireSuperAdminPage: wrap("requireSuperAdminPage", actual.requireSuperAdminPage),
    requireActionUser: wrap("requireActionUser", actual.requireActionUser),
    requireActionRole: wrap("requireActionRole", actual.requireActionRole),
    requireSuperAdmin: wrap("requireSuperAdmin", actual.requireSuperAdmin),
    requireImpersonator: wrap("requireImpersonator", actual.requireImpersonator),
  };
});

const {
  CAPABILITIES,
  IMPERSONATOR_ACTIONS,
  PUBLIC_ACTIONS,
  ROLES,
  SUPER_ADMIN_SUPPORTING_ACTIONS,
  SUPER_ADMIN_SUPPORTING_PAGES,
  roleHas,
} = await import("@/lib/auth/capabilities");
const { ForbiddenError, UnauthorizedError, IMPERSONATION_READ_ONLY_MESSAGE } = await import("@/lib/errors");
const { homeForRole } = await import("@/lib/auth/guards");
const FORBIDDEN = new ForbiddenError().message;
const UNAUTHORIZED = new UnauthorizedError().message;

const { actionModules } = await import("./support/action-modules");
const modules = new Map(actionModules());
const SRC = path.resolve(__dirname, "../src");

type ActionResultLike = { ok: boolean; error?: string };

async function loadAction(ref: string): Promise<(...args: unknown[]) => Promise<ActionResultLike>> {
  const [file, name] = ref.split("#") as [string, string];
  const loader = modules.get(file);
  if (!loader) throw new Error(`no module for ${ref}`);
  const fn = (await loader())[name];
  if (typeof fn !== "function") throw new Error(`${ref} is not exported`);
  return fn as (...args: unknown[]) => Promise<ActionResultLike>;
}

const importModule = (rel: string) => import(/* @vite-ignore */ path.join(SRC, rel)) as Promise<Record<string, unknown>>;

type Caller = (typeof ROLES)[number] | "SIGNED_OUT";
const CALLERS: readonly Caller[] = [...ROLES, "SIGNED_OUT"];

function userWithRole(role: string, impersonating = false): Record<string, unknown> {
  const base = {
    id: `user_${role.toLowerCase()}`,
    role,
    status: "ACTIVE",
    firstName: "Test",
    lastName: role,
    email: "",
    collegeId: `ROLL-${role}`,
  };
  if (!impersonating) return base;
  return {
    ...base,
    id: "student_target",
    role: "STUDENT",
    impersonation: {
      id: "imp_1",
      sessionId: "session_1",
      reason: "checking what the student sees",
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      impersonator: { id: "user_super_admin", firstName: "Test", lastName: "SUPER_ADMIN", role: "SUPER_ADMIN" },
    },
  };
}

function signIn(caller: Caller | "IMPERSONATING"): void {
  if (caller === "SIGNED_OUT") h.state.user = null;
  else if (caller === "IMPERSONATING") h.state.user = userWithRole("SUPER_ADMIN", true);
  else h.state.user = userWithRole(caller);
}

/** Everything past the guard that a refused call must not reach. */
function sideEffects(): string[] {
  return [
    ...h.log.filter((l) => !l.startsWith("guard:")),
    ...(h.audit.mock.calls.length ? ["audit"] : []),
    ...(h.enqueueJudge.mock.calls.length ? ["enqueueJudge"] : []),
    ...(h.enqueueEmail.mock.calls.length ? ["enqueueEmail"] : []),
  ];
}

/** The redirect target of a Next redirect error, or null. */
function redirectTarget(error: unknown): string | null {
  const digest = (error as { digest?: unknown } | null)?.digest;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) return null;
  return digest.split(";")[2] ?? null;
}

async function settle(run: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
}

/** Run a page render for a moment: settled ({value} / {error}) or still waiting on the hanging stub ({pending}). */
async function renderBriefly(run: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown; pending?: true }> {
  return Promise.race([
    settle(run),
    new Promise<{ pending: true }>((resolve) => setTimeout(() => resolve({ pending: true }), 100)),
  ]);
}

const actionRows: Array<{ ref: string; owner: string; roles: readonly string[] }> = [
  ...CAPABILITIES.flatMap((c) => c.actions.map((ref) => ({ ref: ref as string, owner: c.key as string, roles: c.roles }))),
  ...SUPER_ADMIN_SUPPORTING_ACTIONS.map((ref) => ({ ref: ref as string, owner: "supporting", roles: ["SUPER_ADMIN"] })),
];

/** How to call each bound route handler: a same-origin request and its context. */
const ROUTE_CALLS: Record<string, () => [Request, ...unknown[]]> = {
  "app/api/admin/problems/import/route.ts#POST": () => [sameOrigin("/api/admin/problems/import", "not a zip")],
  "app/api/drafts/route.ts#POST": () => [sameOrigin("/api/drafts", "{}")],
  "app/api/activity/route.ts#POST": () => [sameOrigin("/api/activity", "{}")],
  "app/api/exam/[attemptId]/hb/route.ts#POST": () => [
    new Request("http://localhost:3100/api/exam/att_1/hb", {
      method: "POST",
      headers: { host: "localhost:3100", origin: "http://localhost:3100", "content-type": "application/json" },
      body: JSON.stringify({ clientSeq: 0 }),
    }),
    { params: Promise.resolve({ attemptId: "att_1" }) },
  ],
  "app/super/data/exports/[id]/route.ts#GET": () => [
    new Request("http://localhost:3100/super/data/exports/op_1", { headers: { host: "localhost:3100" } }),
    { params: Promise.resolve({ id: "op_1" }) },
  ],
};

function sameOrigin(pathname: string, body: string): Request {
  return new Request(`http://localhost:3100${pathname}`, {
    method: "POST",
    headers: { host: "localhost:3100", origin: "http://localhost:3100", "content-type": "text/plain" },
    body,
  });
}

const routeRows = CAPABILITIES.flatMap((c) => (c.routes ?? []).map((route) => ({ route: route as string, owner: c.key as string, roles: c.roles })));

const pageRoles = new Map<string, readonly string[]>();
for (const c of CAPABILITIES) for (const page of c.pages ?? []) pageRoles.set(page, c.roles);
for (const page of SUPER_ADMIN_SUPPORTING_PAGES) pageRoles.set(page, ["SUPER_ADMIN"]);
const pageRows = [...pageRoles].sort(([a], [b]) => a.localeCompare(b));
const PAGE_PROPS = () => ({
  params: Promise.resolve({ id: "row_1", importId: "row_1" }),
  searchParams: Promise.resolve({}),
});

async function routeResponse(route: string): Promise<{ status: number | null; body: string; error?: unknown }> {
  const [file, method] = route.split("#") as [string, string];
  const handler = (await importModule(file))[method] as (...args: unknown[]) => Promise<Response>;
  const make = ROUTE_CALLS[route];
  if (!make) throw new Error(`no request recipe for ${route}`);
  const outcome = await settle(() => handler(...make()));
  if (outcome.error) return { status: null, body: "", error: outcome.error };
  const response = outcome.value as Response;
  return { status: response.status, body: await response.text() };
}

beforeEach(() => {
  h.log.length = 0;
  h.state.mode = "throw";
  h.audit.mockClear();
  h.enqueueJudge.mockClear();
  h.enqueueEmail.mockClear();
  // An allowed role may reach the database stub, which runAction logs as an unexpected error.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // A page past its guard may log that Redis (the stub) is unavailable.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("role × capability matrix: server actions (real guards)", () => {
  it("covers every bound action", () => {
    expect(actionRows.length).toBeGreaterThan(90);
    expect(new Set(actionRows.map((r) => r.ref)).size).toBe(actionRows.length);
  });

  for (const caller of CALLERS) {
    describe(caller, () => {
      it.each(actionRows.map((r) => [r.ref, r] as const))("%s", async (_ref, row) => {
        signIn(caller);
        const action = await loadAction(row.ref);
        const result = await action({});
        expect(h.log[0], `${row.ref}: the guard runs first`).toMatch(/^guard:/);
        if (caller === "SIGNED_OUT") {
          expect(result).toEqual({ ok: false, error: UNAUTHORIZED });
          expect(sideEffects(), `${row.ref} went past the guard while signed out`).toEqual([]);
        } else if (!roleHas(caller, row.owner as never) && !(row.owner === "supporting" && caller === "SUPER_ADMIN")) {
          expect(result).toEqual({ ok: false, error: FORBIDDEN });
          expect(sideEffects(), `${row.ref} went past the guard for ${caller}`).toEqual([]);
        } else {
          expect(result.ok === false ? result.error : "", `${row.ref} refused ${caller}`).not.toBe(FORBIDDEN);
          expect(result.ok === false ? result.error : "", `${row.ref} refused ${caller}`).not.toBe(UNAUTHORIZED);
          expect(h.audit, `${row.ref}: an empty input must not be audited`).not.toHaveBeenCalled();
        }
      });
    });
  }

  describe("an impersonating SUPER_ADMIN is read-only everywhere", () => {
    it.each(actionRows.map((r) => [r.ref] as const))("%s", async (ref) => {
      signIn("IMPERSONATING");
      const action = await loadAction(ref);
      const result = await action({});
      expect(result).toEqual({ ok: false, error: IMPERSONATION_READ_ONLY_MESSAGE });
      expect(sideEffects()).toEqual([]);
    });
  });

  describe("the actions outside every capability", () => {
    it.each(CALLERS.map((c) => [c] as const))("sign-out works for %s", async (caller) => {
      expect([...PUBLIC_ACTIONS]).toEqual(["auth#logout"]);
      signIn(caller);
      const logout = await loadAction("auth#logout");
      const outcome = await settle(() => logout());
      expect(redirectTarget(outcome.error)).toBe("/login");
      expect(h.log.filter((l) => l.startsWith("db:"))).toEqual([]);
    });

    it.each(CALLERS.map((c) => [c] as const))("ending an impersonation is refused for %s (not impersonating)", async (caller) => {
      for (const ref of IMPERSONATOR_ACTIONS) {
        signIn(caller);
        h.log.length = 0;
        const end = await loadAction(ref);
        const outcome = await settle(() => end());
        expect(outcome.error).toBeInstanceOf(caller === "SIGNED_OUT" ? UnauthorizedError : ForbiddenError);
        expect(sideEffects(), ref).toEqual([]);
      }
    });

    it("ending an impersonation passes the guard while impersonating", async () => {
      for (const ref of IMPERSONATOR_ACTIONS) {
        signIn("IMPERSONATING");
        const end = await loadAction(ref);
        const outcome = await settle(() => end());
        expect(h.log[0]).toBe("guard:requireImpersonator");
        expect(outcome.error).not.toBeInstanceOf(ForbiddenError);
        expect(outcome.error).not.toBeInstanceOf(UnauthorizedError);
      }
    });
  });
});

describe("role × capability matrix: route handlers (real guards)", () => {
  it("has a request recipe for every bound route", () => {
    expect(routeRows.map((r) => r.route).sort()).toEqual(Object.keys(ROUTE_CALLS).sort());
  });

  for (const caller of CALLERS) {
    describe(caller, () => {
      it.each(routeRows.map((r) => [r.route, r] as const))("%s", async (route, row) => {
        signIn(caller);
        const { status, body, error } = await routeResponse(route);
        if (caller === "SIGNED_OUT" || !row.roles.includes(caller)) {
          const [code, message] = caller === "SIGNED_OUT" ? [401, UNAUTHORIZED] : [403, FORBIDDEN];
          expect(error, `${route} threw for ${caller}`).toBeUndefined();
          expect(status).toBe(code);
          expect(body).toContain(message);
          expect(sideEffects(), `${route} went past the guard for ${caller}`).toEqual([]);
        } else {
          // Past the guard: refused for the empty body, or the database stub threw.
          expect(status === null ? String(error) : String(status), `${route} refused ${caller}`).not.toMatch(/^40[13]$/);
          expect(h.log.some((l) => l.startsWith("guard:")), route).toBe(true);
        }
      });
    });
  }

  describe("an impersonating SUPER_ADMIN is read-only", () => {
    it.each(routeRows.map((r) => [r.route] as const))("%s", async (route) => {
      signIn("IMPERSONATING");
      const { status, body } = await routeResponse(route);
      expect(status).toBe(403);
      expect(body).toContain(IMPERSONATION_READ_ONLY_MESSAGE);
      expect(sideEffects()).toEqual([]);
    });
  });
});

describe("role × capability matrix: /admin and /super pages (real guards)", () => {
  it("covers every bound page", () => {
    expect(pageRows.length).toBeGreaterThan(35);
  });

  for (const caller of CALLERS) {
    describe(caller, () => {
      it.each(pageRows.map(([page, roles]) => [page, roles] as const))("%s", async (page, roles) => {
        signIn(caller);
        const allowed = caller !== "SIGNED_OUT" && roles.includes(caller);
        h.state.mode = allowed ? "hang" : "throw";
        const render = (await importModule(page)).default as (props: object) => Promise<unknown>;
        const outcome = await renderBriefly(() => render(PAGE_PROPS()));
        expect(h.log[0], `${page}: the guard runs first`).toMatch(/^guard:/);
        if (!allowed) {
          const home = caller === "SIGNED_OUT" ? "/login" : homeForRole(caller);
          expect(redirectTarget(outcome.error), `${page} for ${caller}`).toBe(home);
          expect(sideEffects(), `${page} went past the guard for ${caller}`).toEqual([]);
        } else {
          // Past the guard: the page is waiting on the database stub, or finished without sending this caller away.
          const target = redirectTarget(outcome.error);
          expect(target === "/login" || target === homeForRole(caller), `${page} redirected ${caller} to ${target}`).toBe(false);
          expect(outcome.pending || h.log.some((l) => !l.startsWith("guard:")) || "value" in outcome, page).toBe(true);
        }
      });
    });
  }

  describe("an impersonating SUPER_ADMIN sees pages as the student", () => {
    it.each(pageRows.map(([page]) => [page] as const))("%s", async (page) => {
      signIn("IMPERSONATING");
      const render = (await importModule(page)).default as (props: object) => Promise<unknown>;
      const outcome = await settle(() => render(PAGE_PROPS()));
      expect(redirectTarget(outcome.error)).toBe(homeForRole("STUDENT"));
      expect(sideEffects()).toEqual([]);
    });
  });
});
