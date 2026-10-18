import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  IMPERSONATOR_ACTIONS,
  PUBLIC_ACTIONS,
  PUBLIC_ROUTES,
  ROLES,
  SELF_SERVICE_CAPABILITIES,
  STAFF_CAPABILITIES,
  SUPER_ADMIN_CAPABILITIES,
  SUPER_ADMIN_CAPABILITY_KEYS,
  SUPER_ADMIN_SUPPORTING_ACTIONS,
  SUPER_ADMIN_SUPPORTING_PAGES,
  can,
  capabilityMatrix,
  capabilityMatrixMarkdown,
  capabilityTier,
  roleHas,
  type ActionRef,
} from "@/lib/auth/capabilities";
import {
  analyzeActionSource,
  createGuardRoleResolver,
  exportedFunctionText,
  exportedFunctionTexts,
  firstGuardCallIn,
  firstStatementGuard,
  guardBeforeDb,
} from "../../../tests/repo/support/action-guards";

/**
 * The role × capability map, proven statically with a real TypeScript
 * parse, for the WHOLE app:
 *
 *   - exactly the spec's twelve SUPER_ADMIN capabilities, each SUPER_ADMIN
 *     only; a later-phase one (`arrives`) names nothing, and fails here as
 *     soon as its models appear in schema.prisma without being wired;
 *   - every export of every "use server" file is in exactly ONE capability
 *     or list (no orphans, no duplicates, no stale refs);
 *   - each action's REAL guard (the first statement of its runAction body),
 *     resolved to the roles it admits from the guard modules' own source,
 *     equals the roles its capability declares — both ways;
 *   - every /admin and /super page, every admin and super route handler and
 *     every mutating API route is bound, and its guard admits exactly its
 *     capability's roles before any database access;
 *   - docs/SECURITY.md carries the matrix the code renders.
 */

const WEB = path.resolve(__dirname, "..");
const SRC = path.join(WEB, "src");
const ACTIONS_DIR = path.join(SRC, "server/actions");
const SCHEMA = readFileSync(path.resolve(WEB, "../../packages/db/prisma/schema.prisma"), "utf8");
const SECURITY_DOC = path.resolve(WEB, "../../docs/SECURITY.md");
const GUARD_MODULES = ["lib/auth/guards.ts", "lib/auth/scope.ts"].map((rel) => ({
  fileName: rel,
  source: readFileSync(path.join(SRC, rel), "utf8"),
}));
const rolesOf = createGuardRoleResolver(ROLES, GUARD_MODULES);
/** Every exported `require*` function of the guard modules (page, action and route guards). */
const GUARD_NAMES = new Set(
  GUARD_MODULES.flatMap(({ source, fileName }) => [...exportedFunctionTexts(source, fileName).keys()]).filter((n) =>
    n.startsWith("require"),
  ),
);
const sorted = (roles: readonly string[]) => [...roles].sort();

function analyzeRef(ref: ActionRef) {
  const [file, name] = ref.split("#") as [string, string];
  const full = path.join(ACTIONS_DIR, `${file}.ts`);
  if (!existsSync(full)) return { ref, missing: `file src/server/actions/${file}.ts does not exist` } as const;
  const analyzed = analyzeActionSource(readFileSync(full, "utf8"), full);
  const fn = analyzed.exports.find((e) => e.name === name && e.kind === "function");
  if (!fn) return { ref, missing: `src/server/actions/${file}.ts does not export ${name}` } as const;
  return { ref, useServer: analyzed.useServer, fn } as const;
}

function modelExists(model: string): boolean {
  return new RegExp(`^model\\s+${model}\\s*\\{`, "m").test(SCHEMA);
}

function walk(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match(entry.name)) out.push(path.relative(SRC, full).split(path.sep).join("/"));
  }
  return out.sort();
}

const superRefs: ActionRef[] = [
  ...SUPER_ADMIN_CAPABILITIES.flatMap((c) => c.actions),
  ...SUPER_ADMIN_SUPPORTING_ACTIONS,
];

/** Every ActionRef that some capability or list names, with its owners and the roles that owner declares. */
const actionOwners = new Map<string, Array<{ owner: string; roles: readonly string[] | null }>>();
function own(ref: string, owner: string, roles: readonly string[] | null) {
  actionOwners.set(ref, [...(actionOwners.get(ref) ?? []), { owner, roles }]);
}
for (const c of CAPABILITIES) for (const ref of c.actions) own(ref, c.key, c.roles);
for (const ref of SUPER_ADMIN_SUPPORTING_ACTIONS) own(ref, "SUPER_ADMIN_SUPPORTING_ACTIONS", ["SUPER_ADMIN"]);
for (const ref of IMPERSONATOR_ACTIONS) own(ref, "IMPERSONATOR_ACTIONS", null);
for (const ref of PUBLIC_ACTIONS) own(ref, "PUBLIC_ACTIONS", null);

/** Every export of every server-action file, as the parser sees it. */
const allExports = readdirSync(ACTIONS_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort()
  .flatMap((name) => {
    const file = name.replace(/\.ts$/, "");
    const analyzed = analyzeActionSource(readFileSync(path.join(ACTIONS_DIR, name), "utf8"), name);
    return analyzed.exports.map((e) => ({ ref: `${file}#${e.name}`, file, useServer: analyzed.useServer, e }));
  });

describe("the twelve SUPER_ADMIN capabilities", () => {
  it("are exactly the twelve keys, in order, each SUPER_ADMIN only", () => {
    expect(SUPER_ADMIN_CAPABILITIES.map((c) => c.key)).toEqual([...SUPER_ADMIN_CAPABILITY_KEYS]);
    expect(SUPER_ADMIN_CAPABILITY_KEYS).toHaveLength(12);
    for (const c of SUPER_ADMIN_CAPABILITIES) expect(c.roles).toEqual(["SUPER_ADMIN"]);
  });

  it("live capabilities name an action or route; later-phase ones name none", () => {
    for (const c of SUPER_ADMIN_CAPABILITIES) {
      if (c.arrives) {
        expect(c.actions, c.key).toEqual([]);
        expect(c.routes ?? [], c.key).toEqual([]);
      } else {
        expect(c.actions.length + (c.routes?.length ?? 0), c.key).toBeGreaterThan(0);
      }
    }
    // ratings.manage was wired in Phase 5 (super-ratings#releaseContestRating),
    // so it is no longer an arriving capability.
    expect(SUPER_ADMIN_CAPABILITIES.filter((c) => c.arrives).map((c) => [c.key, c.arrives?.phase])).toEqual([
      ["integrity.overturn", 6],
      ["calendar.manage", 8],
    ]);
  });

  it.each(SUPER_ADMIN_CAPABILITIES.filter((c) => c.arrives).map((c) => [c.key, c.arrives!] as const))(
    "%s is not wired until its models exist (and must be wired once they do)",
    (key, arrives) => {
      for (const model of arrives.models) {
        expect(modelExists(model), `${model} now exists in schema.prisma: wire ${key} (Phase ${arrives.phase})`).toBe(false);
      }
    },
  );

  it("names each action once", () => {
    expect(new Set(superRefs).size).toBe(superRefs.length);
  });
});

describe("every SUPER_ADMIN ActionRef resolves to a guarded server action", () => {
  const analyzed = superRefs.map(analyzeRef);
  const missing = analyzed.flatMap((a) => ("missing" in a ? [a.missing] : []));

  it("every referenced action exists (lists the missing ones)", () => {
    expect(missing).toEqual([]);
  });

  it.each(analyzed.filter((a) => !("missing" in a)).map((a) => [a.ref, a] as const))("%s", (_ref, a) => {
    if ("missing" in a) return;
    const [, name] = a.ref.split("#");
    expect(a.useServer, `${a.ref}: "use server" file`).toBe(true);
    expect(a.fn.isAsync, `${a.ref}: async`).toBe(true);
    expect(a.fn.wrapped, `${a.ref}: return runAction(async () => { … })`).toBe(true);
    expect(a.fn.runActionName, `${a.ref}: runAction(…, "${name}")`).toBe(name);
    expect(a.fn.firstGuard, `${a.ref}: first statement awaits requireSuperAdmin()`).toBe("requireSuperAdmin");
  });

  it("routes call requireSuperAdmin() before any database access", () => {
    const routes = SUPER_ADMIN_CAPABILITIES.flatMap((c) => c.routes ?? []);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const [file, method] = route.split("#") as [string, string];
      const full = path.join(WEB, "src", file);
      expect(existsSync(full), route).toBe(true);
      const text = exportedFunctionTexts(readFileSync(full, "utf8"), full).get(method);
      expect(text, `${route} exports ${method}`).toBeDefined();
      expect(guardBeforeDb(text!, "requireSuperAdmin"), route).toBe(true);
    }
  });

  it("pages call requireSuperAdminPage()", () => {
    const pages = [...new Set([...SUPER_ADMIN_CAPABILITIES.flatMap((c) => c.pages ?? []), ...SUPER_ADMIN_SUPPORTING_PAGES])];
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const full = path.join(WEB, "src", page);
      expect(existsSync(full), page).toBe(true);
      expect(readFileSync(full, "utf8"), page).toContain("requireSuperAdminPage(");
    }
  });

  it("reverse: every action starting with requireSuperAdmin() is listed", () => {
    const listed = new Set<string>(superRefs);
    const unlisted = allExports
      .filter(({ e, ref }) => e.kind === "function" && e.firstGuard === "requireSuperAdmin" && !listed.has(ref))
      .map(({ ref }) => ref);
    expect(unlisted).toEqual([]);
  });
});

describe("the capability model", () => {
  it("keys are unique across the three tiers", () => {
    const keys = CAPABILITIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(SUPER_ADMIN_CAPABILITIES.length + STAFF_CAPABILITIES.length + SELF_SERVICE_CAPABILITIES.length);
  });

  it("staff capabilities are ADMIN + SUPER_ADMIN; self-service ones are every signed-in role", () => {
    for (const c of STAFF_CAPABILITIES) expect(sorted(c.roles), c.key).toEqual(["ADMIN", "SUPER_ADMIN"]);
    for (const c of SELF_SERVICE_CAPABILITIES) expect(sorted(c.roles), c.key).toEqual(sorted(ROLES));
    expect(STAFF_CAPABILITIES.map((c) => c.key)).toContain("judge.operate");
  });

  it("every live capability is bound to at least one action, route or page", () => {
    for (const c of CAPABILITIES) {
      if (c.arrives) continue;
      expect(c.actions.length + (c.routes?.length ?? 0) + (c.pages?.length ?? 0), c.key).toBeGreaterThan(0);
    }
  });
});

describe("completeness: every server-action export is bound exactly once", () => {
  it("finds the action files (sanity)", () => {
    expect(allExports.length).toBeGreaterThan(90);
    expect(new Set(allExports.map((x) => x.file)).size).toBeGreaterThan(25);
  });

  it("every file is a \"use server\" module exporting only functions", () => {
    const bad = allExports.filter(({ useServer, e }) => !useServer || e.kind !== "function").map(({ ref }) => ref);
    expect(bad).toEqual([]);
  });

  it("no export is an orphan", () => {
    expect(allExports.filter(({ ref }) => !actionOwners.has(ref)).map(({ ref }) => ref)).toEqual([]);
  });

  it("no export is bound twice", () => {
    const twice = [...actionOwners].filter(([, owners]) => owners.length > 1).map(([ref, owners]) => `${ref}: ${owners.map((o) => o.owner).join(", ")}`);
    expect(twice).toEqual([]);
  });

  it("no capability or list names an action that does not exist", () => {
    const exported = new Set(allExports.map(({ ref }) => ref));
    expect([...actionOwners.keys()].filter((ref) => !exported.has(ref))).toEqual([]);
  });

  it("every export of an admin-* or super-* module is bound to something STUDENT does not hold", () => {
    const leaks = allExports
      .filter(({ file }) => /^(admin|super)-/.test(file))
      .flatMap(({ ref }) =>
        (actionOwners.get(ref) ?? []).filter((o) => o.roles === null ? o.owner !== "IMPERSONATOR_ACTIONS" : o.roles.includes("STUDENT")).map((o) => `${ref} (${o.owner})`),
      );
    expect(leaks).toEqual([]);
  });
});

describe("every action's real guard admits exactly its capability's roles", () => {
  const roleBound = allExports.filter(({ ref }) => actionOwners.get(ref)?.[0]?.roles);

  it("covers every role-guarded action (sanity)", () => {
    expect(roleBound.length).toBe(allExports.length - IMPERSONATOR_ACTIONS.length - PUBLIC_ACTIONS.length);
  });

  it.each(roleBound.map((x) => [x.ref, x] as const))("%s", (ref, { e }) => {
    const [owner] = actionOwners.get(ref)!;
    const [, name] = ref.split("#");
    expect(e.isAsync, `${ref}: async`).toBe(true);
    expect(e.wrapped, `${ref}: return runAction(async () => { … })`).toBe(true);
    expect(e.runActionName, `${ref}: runAction(…, "${name}")`).toBe(name);
    expect(e.guard, `${ref}: the first statement inside runAction awaits a guard`).not.toBeNull();
    expect(
      rolesOf(e.guard),
      `${ref}: ${e.guard?.name}(${e.guard?.args.join(", ")}) must admit exactly ${owner!.owner}'s roles`,
    ).toEqual(sorted(owner!.roles!));
  });

  it("the impersonator action starts with requireImpersonator(), outside runAction", () => {
    for (const ref of IMPERSONATOR_ACTIONS) {
      const a = analyzeRef(ref);
      expect("missing" in a ? a.missing : null).toBe(null);
      if ("missing" in a) continue;
      expect(a.fn.wrapped, ref).toBe(false);
      expect(a.fn.firstGuard, ref).toBe("requireImpersonator");
    }
  });

  it("public actions are sign-out only", () => {
    expect([...PUBLIC_ACTIONS]).toEqual(["auth#logout"]);
  });

  it("the resolver reads the guard modules (sanity)", () => {
    expect(rolesOf({ name: "requireSuperAdmin", args: [] })).toEqual(["SUPER_ADMIN"]);
    expect(rolesOf({ name: "requireAdminScopeAction", args: [] })).toEqual(["ADMIN", "SUPER_ADMIN"]);
    expect(rolesOf({ name: "requireAdminScopePage", args: [] })).toEqual(["ADMIN", "SUPER_ADMIN"]);
    expect(rolesOf({ name: "requireSuperAdminPage", args: [] })).toEqual(["SUPER_ADMIN"]);
    expect(rolesOf({ name: "requireActionUser", args: [] })).toEqual(sorted(ROLES));
    expect(rolesOf({ name: "requireImpersonator", args: [] })).toBeNull();
    expect(GUARD_NAMES).toContain("requireAdminScopeAction");
  });
});

describe("route handlers are bound and guarded", () => {
  const routeFiles = walk(path.join(SRC, "app"), (n) => n === "route.ts");
  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  /** Route methods that must be bound: admin and super trees, plus every mutating API route except judge-node ones. */
  const required = routeFiles.flatMap((rel) => {
    const fns = exportedFunctionTexts(readFileSync(path.join(SRC, rel), "utf8"), rel);
    return METHODS.filter((m) => fns.has(m))
      .filter(
        (m) =>
          rel.startsWith("app/api/admin/") ||
          rel.startsWith("app/super/") ||
          (rel.startsWith("app/api/") && !rel.startsWith("app/api/judge/") && m !== "GET"),
      )
      .map((m) => `${rel}#${m}`);
  });
  const owners = new Map<string, Array<{ owner: string; roles: readonly string[] | null }>>();
  for (const c of CAPABILITIES) for (const r of c.routes ?? []) owners.set(r, [...(owners.get(r) ?? []), { owner: c.key, roles: c.roles }]);
  for (const r of PUBLIC_ROUTES) owners.set(r, [...(owners.get(r) ?? []), { owner: "PUBLIC_ROUTES", roles: null }]);

  it("finds the admin import route and the super export route (sanity)", () => {
    expect(required).toContain("app/api/admin/problems/import/route.ts#POST");
    expect(required).toContain("app/super/data/exports/[id]/route.ts#GET");
  });

  it("every required route method is bound exactly once; nothing stale is bound", () => {
    expect(required.filter((r) => (owners.get(r)?.length ?? 0) !== 1)).toEqual([]);
    expect([...owners.keys()].filter((r) => !required.includes(r))).toEqual([]);
  });

  it.each([...owners].filter(([, o]) => o[0]!.roles).map(([r, o]) => [r, o[0]!] as const))("%s", (route, owner) => {
    const [file, method] = route.split("#") as [string, string];
    const source = readFileSync(path.join(SRC, file), "utf8");
    const guard = firstGuardCallIn(source, file, method, GUARD_NAMES);
    expect(guard, `${route} calls a guard`).not.toBeNull();
    expect(rolesOf(guard), `${route}: ${guard?.name} admits exactly ${owner.owner}'s roles`).toEqual(sorted(owner.roles!));
    expect(guardBeforeDb(exportedFunctionText(source, file, method)!, guard!.name), `${route}: guard before db`).toBe(true);
  });
});

describe("every /admin and /super page is bound and guarded", () => {
  const pages = [...walk(path.join(SRC, "app/admin"), (n) => n === "page.tsx"), ...walk(path.join(SRC, "app/super"), (n) => n === "page.tsx")];
  const owners = new Map<string, Array<{ owner: string; roles: readonly string[] }>>();
  for (const c of CAPABILITIES) for (const p of c.pages ?? []) owners.set(p, [...(owners.get(p) ?? []), { owner: c.key, roles: c.roles }]);
  for (const p of SUPER_ADMIN_SUPPORTING_PAGES) owners.set(p, [...(owners.get(p) ?? []), { owner: "SUPER_ADMIN_SUPPORTING_PAGES", roles: ["SUPER_ADMIN"] }]);

  it("finds the pages (sanity)", () => {
    expect(pages.length).toBeGreaterThan(35);
    expect(pages).toContain("app/admin/problems/[id]/page.tsx");
    expect(pages).toContain("app/super/page.tsx");
  });

  it("every page is bound; every bound page exists; a supporting page is in no capability", () => {
    expect(pages.filter((p) => !owners.has(p))).toEqual([]);
    expect([...owners.keys()].filter((p) => !pages.includes(p))).toEqual([]);
    for (const p of SUPER_ADMIN_SUPPORTING_PAGES) expect(owners.get(p), p).toHaveLength(1);
  });

  it.each(pages.map((p) => [p] as const))("%s", (page) => {
    const source = readFileSync(path.join(SRC, page), "utf8");
    const guard = firstStatementGuard(source, page, "default");
    expect(guard && GUARD_NAMES.has(guard.name), `${page}: the first statement awaits a page guard`).toBe(true);
    expect(guardBeforeDb(exportedFunctionText(source, page, "default")!, guard!.name)).toBe(true);
    for (const owner of owners.get(page) ?? []) {
      expect(rolesOf(guard), `${page}: ${guard!.name} admits exactly ${owner.owner}'s roles`).toEqual(sorted(owner.roles));
    }
    if (page.startsWith("app/super/")) expect(guard!.name).toBe("requireSuperAdminPage");
  });

  it.each([
    ["app/admin/layout.tsx", ["ADMIN", "SUPER_ADMIN"]],
    ["app/super/layout.tsx", ["SUPER_ADMIN"]],
  ] as const)("%s guards the whole tree too", (layout, roles) => {
    const guard = firstStatementGuard(readFileSync(path.join(SRC, layout), "utf8"), layout, "default");
    expect(rolesOf(guard)).toEqual([...roles]);
  });
});

describe("roleHas / can / capabilityMatrix", () => {
  const selfKeys = SELF_SERVICE_CAPABILITIES.map((c) => c.key);

  it("gives SUPER_ADMIN everything, ADMIN staff + self-service, every other role self-service only", () => {
    const matrix = capabilityMatrix();
    expect(matrix.SUPER_ADMIN).toEqual(CAPABILITIES.map((c) => c.key));
    expect(matrix.ADMIN).toEqual([...STAFF_CAPABILITIES.map((c) => c.key), ...selfKeys]);
    expect(matrix.STUDENT).toEqual(selfKeys);
    expect(matrix.TA_MENTOR).toEqual(selfKeys);
    expect(matrix.PLACEMENT_OFFICER).toEqual(selfKeys);
    expect(Object.keys(matrix).sort()).toEqual([...ROLES].sort());
  });

  it("no role but SUPER_ADMIN holds any of the twelve; no role below ADMIN holds a staff capability", () => {
    for (const role of ROLES) {
      for (const key of SUPER_ADMIN_CAPABILITY_KEYS) expect(roleHas(role, key)).toBe(role === "SUPER_ADMIN");
      for (const c of STAFF_CAPABILITIES) expect(roleHas(role, c.key)).toBe(role === "ADMIN" || role === "SUPER_ADMIN");
    }
    expect(can).toBe(roleHas);
    expect(roleHas("SUPER_ADMIN", "no.such" as never)).toBe(false);
    expect(capabilityTier("judge.operate")).toBe("staff");
    expect(capabilityTier("xp.void")).toBe("super-admin");
    expect(capabilityTier("judge.submit")).toBe("self-service");
  });

  it("is frozen", () => {
    expect(Object.isFrozen(SUPER_ADMIN_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(SUPER_ADMIN_CAPABILITIES[0])).toBe(true);
    expect(Object.isFrozen(SUPER_ADMIN_CAPABILITIES[0]!.actions)).toBe(true);
    expect(Object.isFrozen(SUPER_ADMIN_SUPPORTING_ACTIONS)).toBe(true);
    expect(Object.isFrozen(STAFF_CAPABILITIES[0]!.roles)).toBe(true);
    expect(Object.isFrozen(SELF_SERVICE_CAPABILITIES[0]!.actions)).toBe(true);
    expect(Object.isFrozen(CAPABILITIES)).toBe(true);
  });
});

describe("docs/SECURITY.md carries the matrix the code renders", () => {
  const START = "<!-- capability-matrix:start -->";
  const END = "<!-- capability-matrix:end -->";

  it("one row per capability, one column per role", () => {
    const table = capabilityMatrixMarkdown().split("\n").filter((l) => l.startsWith("| `"));
    expect(table).toHaveLength(CAPABILITIES.length);
    expect(capabilityMatrixMarkdown().split("\n")[0]).toBe(`| Capability | Tier | ${ROLES.join(" | ")} | Bound to |`);
  });

  it("matches the doc (RECX_UPDATE_DOCS=1 rewrites it)", () => {
    const doc = readFileSync(SECURITY_DOC, "utf8").replace(/\r\n/g, "\n");
    const start = doc.indexOf(START);
    const end = doc.indexOf(END);
    expect(start, `docs/SECURITY.md has ${START}`).toBeGreaterThan(-1);
    expect(end, `docs/SECURITY.md has ${END} after the start marker`).toBeGreaterThan(start);
    const expected = `${START}\n${capabilityMatrixMarkdown()}\n${END}`;
    const actual = doc.slice(start, end + END.length);
    if (actual !== expected && process.env.RECX_UPDATE_DOCS === "1") {
      writeFileSync(SECURITY_DOC, doc.slice(0, start) + expected + doc.slice(end + END.length), "utf8");
      return;
    }
    expect(actual, "the capability matrix in docs/SECURITY.md is stale: run with RECX_UPDATE_DOCS=1").toBe(expected);
  });
});
