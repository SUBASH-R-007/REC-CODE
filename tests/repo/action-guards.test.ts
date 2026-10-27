import { describe, expect, it } from "vitest";
import {
  analyzeActionSource,
  awaitedCall,
  createGuardRoleResolver,
  exportedFunctionText,
  exportedFunctionTexts,
  firstGuardCallIn,
  firstStatementGuard,
  guardBeforeDb,
  guardCallOf,
  stringArrayConstants,
} from "./support/action-guards";
import { findFiles, readRepoFile } from "./support/repo";
import ts from "typescript";

/**
 * Every server action is guarded, and the guard comes FIRST. That is what
 * makes RBAC server-side and what makes read-only impersonation hold: every
 * action guard goes through requireActionUser(), which refuses to mutate
 * while a super-admin views as someone else (lib/auth/guards.ts).
 *
 *   - every exported function of apps/web/src/server/actions/*.ts is async
 *     and is `return runAction(async () => { await <guard>(…); … })`;
 *   - the only exceptions: auth#logout (sign-out must always work) and
 *     super-impersonate#endImpersonation, which must start with
 *     requireImpersonator();
 *   - a composite guard (requireAdminScopeAction) itself starts with a base
 *     action guard;
 *   - every non-judge mutating route handler under app/api calls an action
 *     guard, and every app/super route calls requireSuperAdmin() before it
 *     touches the database;
 *   - every page and layout under app/admin/** starts with a page guard that
 *     admits exactly ADMIN and SUPER_ADMIN, and under app/super/** one that
 *     admits SUPER_ADMIN only, before any database access. The roles are
 *     read from the guard modules' source, not assumed.
 *
 * Which capability each guarded export belongs to is checked by
 * apps/web/test/capabilities.test.ts (same analyzer).
 */

const ACTIONS_DIR = "apps/web/src/server/actions";
const BASE_GUARDS = new Set(["requireActionUser", "requireActionRole", "requireSuperAdmin"]);
/**
 * Composite guards and the file that defines each. Each is checked below to
 * start with a base guard, which is what makes delegating to one safe: the
 * impersonation refusal and the signed-in check live in the base, so a
 * composite that forgot them would fail that check rather than this list.
 */
const COMPOSITE_GUARDS: Record<string, string> = {
  requireAdminScopeAction: "apps/web/src/lib/auth/scope.ts",
  // Phase 9d. The placement cell and the mentor of record.
  requirePlacementAction: "apps/web/src/lib/auth/guards.ts",
  requireMentorAction: "apps/web/src/lib/auth/guards.ts",
};
const ACTION_GUARDS = new Set([...BASE_GUARDS, ...Object.keys(COMPOSITE_GUARDS)]);
/** exportName → the guard its unwrapped first statement must await (null = none required). */
const UNWRAPPED_ALLOWLIST: Record<string, string | null> = {
  "auth#logout": null,
  "super-impersonate#endImpersonation": "requireImpersonator",
};
/** Route handlers that authenticate another way, or have nothing to authenticate (see each entry). */
const ROUTE_EXEMPT_PREFIXES = [
  "apps/web/src/app/api/judge/",
  "apps/web/src/app/api/auth/login/",
  /**
   * Field vitals (Phase 10d). It authenticates nothing because there is
   * nothing to attribute: the body is three fields, the metric and route
   * must each be one of a closed list, the value is bucketed before it is
   * stored and the key holds no identity. Its protection is a rate limit per
   * hashed address and the fact that the caller cannot name the key.
   * `apps/web/test/vitals.test.ts` asserts all of that.
   */
  "apps/web/src/app/api/vitals/",
  /**
   * Phase 11a: forgot-password and reset-password. There is no actor to
   * authenticate — one is asked for by somebody who cannot sign in, and the
   * other IS the credential. What stands in for a guard is the same-origin
   * check, the body cap, a rate limit on the hashed identifier and the
   * hashed address, and an answer that is identical whether or not the
   * account exists (apps/web/test/password-reset.test.ts).
   */
  "apps/web/src/app/api/auth/forgot-password/",
  "apps/web/src/app/api/auth/reset-password/",
];

const actionFiles = findFiles({ under: [ACTIONS_DIR], extensions: [".ts"] }).filter(
  (rel) => !rel.slice(ACTIONS_DIR.length + 1).includes("/"),
);

describe("analyzer self-test", () => {
  it("finds the guard inside runAction", () => {
    const { useServer, exports } = analyzeActionSource(`"use server";
      export async function ok(input: unknown) {
        return runAction(async () => {
          const actor = await requireSuperAdmin();
          return actor.id;
        }, "ok");
      }`);
    expect(useServer).toBe(true);
    expect(exports).toEqual([expect.objectContaining({ name: "ok", isAsync: true, wrapped: true, runActionName: "ok", firstGuard: "requireSuperAdmin" })]);
  });

  it("flags a guard that is not the first statement", () => {
    const { exports } = analyzeActionSource(`"use server";
      export async function late() {
        return runAction(async () => {
          const parsed = schema.parse({});
          await requireActionUser();
        });
      }`);
    expect(exports[0]!.firstGuard).toBe(null);
  });

  it("flags an action not wrapped in runAction, and non-function exports", () => {
    const { exports } = analyzeActionSource(`"use server";
      export async function bare() { await requireActionUser(); return 1; }
      export const value = 3;
      export function sync() { return 1; }`);
    expect(exports.map((e) => [e.name, e.kind, e.wrapped, e.isAsync])).toEqual([
      ["bare", "function", false, true],
      ["value", "other", false, false],
      ["sync", "function", false, false],
    ]);
    expect(exports[0]!.firstGuard).toBe("requireActionUser");
  });

  it("reads destructured guard results", () => {
    const file = ts.createSourceFile("x.ts", "const { user } = await requireAdminScopeAction();", ts.ScriptTarget.Latest, true);
    expect(awaitedCall(file.statements[0])).toBe("requireAdminScopeAction");
  });

  it("resolves a guard call's role arguments, including spreads of a const array", () => {
    const { exports } = analyzeActionSource(`"use server";
      const STAFF = ["ADMIN", "SUPER_ADMIN"] as const;
      export async function a() { return runAction(async () => { const u = await requireActionRole(...STAFF); }, "a"); }
      export async function b() { return runAction(async () => { await requireActionRole("ADMIN", role); }, "b"); }
      export async function c() { return runAction(async () => { await requireActionUser(); }, "c"); }`);
    expect(exports.map((e) => e.guard)).toEqual([
      { name: "requireActionRole", args: ["ADMIN", "SUPER_ADMIN"] },
      { name: "requireActionRole", args: ["ADMIN", null] },
      { name: "requireActionUser", args: [] },
    ]);
    const file = ts.createSourceFile("x.ts", `const A = ["X"] as const; let B = ["Y"]; const C = ["Z", n];`, ts.ScriptTarget.Latest, true);
    expect([...stringArrayConstants(file)]).toEqual([["A", ["X"]]]);
  });

  it("reads a delegating composite guard (`return g(…)`, not awaited)", () => {
    const file = ts.createSourceFile("x.ts", `return requireActionRole("SUPER_ADMIN");`, ts.ScriptTarget.Latest, true);
    expect(guardCallOf(file.statements[0])).toEqual({ name: "requireActionRole", args: ["SUPER_ADMIN"] });
  });

  it("resolves the roles a guard admits from the guard modules' source", () => {
    const ROLES = ["STUDENT", "ADMIN", "SUPER_ADMIN"];
    const rolesOf = createGuardRoleResolver(ROLES, [
      {
        fileName: "guards.ts",
        source: `
          export async function requireSuperAdmin() { return requireActionRole("SUPER_ADMIN"); }
          export async function requireStaffPage() { const user = await requirePageRole("ADMIN", "SUPER_ADMIN"); return user; }
          export async function requireTwice() { return requireSuperAdmin(); }
          export async function requireForwarding(...roles) { return requireActionRole(...roles); }
          export async function requireNothing() { const x = 1; return x; }`,
      },
    ]);
    expect(rolesOf({ name: "requireSuperAdmin", args: [] })).toEqual(["SUPER_ADMIN"]);
    expect(rolesOf({ name: "requireStaffPage", args: [] })).toEqual(["ADMIN", "SUPER_ADMIN"]);
    expect(rolesOf({ name: "requireTwice", args: [] })).toEqual(["SUPER_ADMIN"]);
    expect(rolesOf({ name: "requireActionUser", args: [] })).toEqual(["ADMIN", "STUDENT", "SUPER_ADMIN"]);
    expect(rolesOf({ name: "requireActionRole", args: ["SUPER_ADMIN", "ADMIN"] })).toEqual(["ADMIN", "SUPER_ADMIN"]);
    // Never guesses: unknown roles, unresolvable arguments, forwarding composites, non-guards.
    expect(rolesOf({ name: "requireActionRole", args: ["ROOT"] })).toBeNull();
    expect(rolesOf({ name: "requireActionRole", args: ["ADMIN", null] })).toBeNull();
    expect(rolesOf({ name: "requireActionRole", args: [] })).toBeNull();
    expect(rolesOf({ name: "requireForwarding", args: [] })).toBeNull();
    expect(rolesOf({ name: "requireNothing", args: [] })).toBeNull();
    expect(rolesOf({ name: "requireUnknown", args: [] })).toBeNull();
    expect(rolesOf(null)).toBeNull();
  });

  it("finds a page's first-statement guard and a route's guard inside try/catch (.tsx too)", () => {
    const page = `import x from "y";
      export const metadata = {};
      export default async function Page({ params }: Props) {
        const { user } = await requireAdminScopePage();
        return <main>{user.id}</main>;
      }`;
    expect(firstStatementGuard(page, "page.tsx", "default")).toEqual({ name: "requireAdminScopePage", args: [] });
    const late = `export default async function Page() { const rows = await db.user.findMany(); await requireSuperAdminPage(); return <p />; }`;
    expect(firstStatementGuard(late, "page.tsx", "default")?.name).toBe("findMany");
    expect(guardBeforeDb(exportedFunctionText(late, "page.tsx", "default")!, "requireSuperAdminPage")).toBe(false);
    const route = `export async function POST(request: Request) {
        if (!isSameOrigin(request)) return json({}, 403);
        try { const actor = await requireActionRole("ADMIN", "SUPER_ADMIN"); } catch (e) { return json({}, 401); }
        await db.problemImport.findFirst({});
      }`;
    expect(firstGuardCallIn(route, "route.ts", "POST", new Set(["requireActionRole"]))).toEqual({
      name: "requireActionRole",
      args: ["ADMIN", "SUPER_ADMIN"],
    });
    expect(firstGuardCallIn(route, "route.ts", "GET", new Set(["requireActionRole"]))).toBeNull();
  });

  it("orders the guard against the first database access", () => {
    expect(guardBeforeDb("async function GET() { await requireSuperAdmin(); await db.user.findMany(); }", "requireSuperAdmin")).toBe(true);
    expect(guardBeforeDb("async function GET() { await db.user.findMany(); await requireSuperAdmin(); }", "requireSuperAdmin")).toBe(false);
    expect(guardBeforeDb("async function GET() { /* requireSuperAdmin( */ await db.user.findMany(); }", "requireSuperAdmin")).toBe(false);
  });
});

describe("server actions start with a guard", () => {
  it("finds the action files (sanity)", () => {
    expect(actionFiles.length).toBeGreaterThan(10);
    expect(actionFiles).toContain(`${ACTIONS_DIR}/super-users.ts`);
  });

  it.each(actionFiles)("%s", (rel) => {
    const base = rel.slice(ACTIONS_DIR.length + 1).replace(/\.ts$/, "");
    const { useServer, exports } = analyzeActionSource(readRepoFile(rel), rel);
    expect(useServer, `${rel} must start with "use server"`).toBe(true);
    const problems: string[] = [];
    for (const e of exports) {
      const ref = `${base}#${e.name}`;
      if (e.kind !== "function") {
        problems.push(`${ref} (line ${e.line}): only async functions may be exported from a server-action file`);
        continue;
      }
      if (!e.isAsync) problems.push(`${ref}: not async`);
      if (ref in UNWRAPPED_ALLOWLIST) {
        const required = UNWRAPPED_ALLOWLIST[ref];
        if (required && e.firstGuard !== required) problems.push(`${ref}: must start with ${required}()`);
        continue;
      }
      if (!e.wrapped) problems.push(`${ref}: body must be \`return runAction(async () => { … })\``);
      else if (!e.firstGuard || !ACTION_GUARDS.has(e.firstGuard)) {
        problems.push(`${ref}: the first statement inside runAction must await one of ${[...ACTION_GUARDS].join(", ")} (found ${e.firstGuard ?? "none"})`);
      }
    }
    expect(problems).toEqual([]);
  });

  it.each(Object.entries(COMPOSITE_GUARDS))("composite guard %s starts with a base action guard", (guard, rel) => {
    const text = exportedFunctionTexts(readRepoFile(rel), rel).get(guard);
    expect(text, `${guard} is not exported from ${rel}`).toBeDefined();
    const file = ts.createSourceFile(rel, text!, ts.ScriptTarget.Latest, true);
    const fn = file.statements[0];
    expect(fn && ts.isFunctionDeclaration(fn)).toBe(true);
    const first = (fn as ts.FunctionDeclaration).body?.statements[0];
    expect(BASE_GUARDS.has(awaitedCall(first) ?? "")).toBe(true);
  });
});

describe("route handlers", () => {
  const routes = findFiles({ under: ["apps/web/src/app"], extensions: [".ts"] }).filter((rel) => rel.endsWith("/route.ts"));

  it("finds route handlers (sanity)", () => {
    expect(routes).toContain("apps/web/src/app/api/drafts/route.ts");
  });

  const mutating = routes.filter(
    (rel) =>
      rel.startsWith("apps/web/src/app/api/") &&
      !ROUTE_EXEMPT_PREFIXES.some((p) => rel.startsWith(p)) &&
      /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/.test(readRepoFile(rel)),
  );

  it.each(mutating)("%s calls an action guard", (rel) => {
    const source = readRepoFile(rel);
    const guarded = [...ACTION_GUARDS].some((g) => source.includes(`${g}(`));
    expect(guarded, `${rel} mutates without requireActionUser/requireActionRole/requireSuperAdmin`).toBe(true);
  });

  const superRoutes = routes.filter((rel) => rel.startsWith("apps/web/src/app/super/"));

  it("the /super tree has its export route", () => {
    expect(superRoutes).toContain("apps/web/src/app/super/data/exports/[id]/route.ts");
  });

  it.each(superRoutes)("%s calls requireSuperAdmin() before any database access", (rel) => {
    const functions = exportedFunctionTexts(readRepoFile(rel), rel);
    expect(functions.size).toBeGreaterThan(0);
    for (const [name, text] of functions) {
      expect(guardBeforeDb(text, "requireSuperAdmin"), `${rel}#${name}`).toBe(true);
    }
  });
});

describe("admin and super pages and layouts start with a page guard", () => {
  const GUARD_MODULES = ["apps/web/src/lib/auth/guards.ts", "apps/web/src/lib/auth/scope.ts"];
  const ROLES = ["STUDENT", "TA_MENTOR", "ADMIN", "PLACEMENT_OFFICER", "SUPER_ADMIN"];
  const rolesOf = createGuardRoleResolver(
    ROLES,
    GUARD_MODULES.map((rel) => ({ fileName: rel, source: readRepoFile(rel) })),
  );
  const files = findFiles({ under: ["apps/web/src/app/admin", "apps/web/src/app/super"], extensions: [".tsx"] }).filter((rel) =>
    /\/(page|layout)\.tsx$/.test(rel),
  );

  it("finds the pages and layouts (sanity)", () => {
    expect(files).toContain("apps/web/src/app/admin/layout.tsx");
    expect(files).toContain("apps/web/src/app/super/layout.tsx");
    expect(files.length).toBeGreaterThan(35);
  });

  it.each(files)("%s", (rel) => {
    const source = readRepoFile(rel);
    const guard = firstStatementGuard(source, rel, "default");
    const expected = rel.startsWith("apps/web/src/app/super/") ? ["SUPER_ADMIN"] : ["ADMIN", "SUPER_ADMIN"];
    expect(guard, `${rel}: the default export's first statement must await a page guard`).not.toBeNull();
    expect(rolesOf(guard), `${rel}: ${guard?.name} must admit exactly ${expected.join(" + ")}`).toEqual(expected);
    expect(guardBeforeDb(exportedFunctionText(source, rel, "default")!, guard!.name), `${rel}: guard before db`).toBe(true);
  });
});
