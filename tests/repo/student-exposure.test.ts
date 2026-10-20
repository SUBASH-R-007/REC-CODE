import { describe, expect, it } from "vitest";
import {
  analyzeActionExports,
  exportedFunctionBodies,
  exportedFunctionFirstGuard,
  inlineUseServerLines,
  isStaffGuard,
  isUseServerFile,
  scanReferenceSolutions,
  scanTestBytes,
  scanTestCaseQueries,
  staffGuardBeforeBody,
  startsWithServerOnly,
  type Finding,
} from "./support/exposure-rules";
import { ModuleGraph, importEdges, resolveSpecifier } from "./support/module-graph";
import { findFiles, isTestPath, readRepoFile, repoFiles } from "./support/repo";

/**
 * Phase 4 gate, static half: "no STUDENT-reachable route can return a
 * non-sample test file or a ReferenceSolution.source" (gate-tests §4.3 D1,
 * folded together with the authoring design's content-leak fence). The
 * runtime half is apps/web/test/student-exposure.db.test.ts (canaries).
 *
 * Sensitive code — anything that reads hidden test bytes, checker sources or
 * reference solutions — is confined to SENSITIVE_PREFIXES. Over every other
 * file in apps/web/src (comments never count):
 *
 *   R1  no referenceSolution(s) / ReferenceSolution, in code or in SQL text
 *   R2  no testBlob delegate, readBlobBytes, getTestDataStore, checkerSha256,
 *       and no SQL naming "TestBlob", "inline", "storageKey" or "checkerSha256"
 *   R3  every testCase(s) query block selecting input/output says isSample: true
 *   R4  no value import of a sensitive module (type-only imports are erased)
 *
 * And over the import graph (resolved through "@/" and relative paths):
 *
 *   R5  every student entry — page, layout, route, loading, error,
 *       global-error, not-found, template or default under src/app except
 *       admin/**, super/**, api/judge/** and api/admin/**, plus
 *       src/middleware.ts and src/pages/** — has a closure with no sensitive
 *       module in it
 *   R6  every "use server" file whose closure reaches a sensitive module
 *       starts EVERY export's runAction body with a staff-only guard:
 *       requireSuperAdmin(), requireActionRole(…) with ADMIN or SUPER_ADMIN
 *       and never STUDENT, or a composite guard that itself starts so; no
 *       inline (function-level) "use server" anywhere in src
 *   R7  every route handler under app/api/admin/** calls a staff-only guard
 *       before it reads the request body or touches the database
 *   R8  every sensitive library module (lib/**, server/queries/**) starts
 *       with `import "server-only"`, except the listed pure helpers
 *
 * Every rule has flagged and clean self-tests.
 */

const WEB_SRC = "apps/web/src";

/** Paths (prefixes) allowed to read hidden test data, checkers or reference sources, each with its reason. */
export const SENSITIVE_PREFIXES = [
  "apps/web/src/app/api/judge/",
  "apps/web/src/app/api/admin/",
  "apps/web/src/lib/judge/claim.ts",
  "apps/web/src/lib/judge/finalize.ts",
  "apps/web/src/lib/judge/validation.ts",
  "apps/web/src/lib/testdata/",
  "apps/web/src/lib/authoring/",
  "apps/web/src/lib/privileged/",
  "apps/web/src/server/queries/admin-",
  "apps/web/src/server/queries/super-",
  "apps/web/src/server/actions/admin-",
  "apps/web/src/server/actions/super-",
  "apps/web/src/server/actions/privileged.ts",
  "apps/web/src/app/admin/",
  "apps/web/src/app/super/",
  "apps/web/src/components/admin/",
  "apps/web/src/components/super/",
] as const;

const SENSITIVE_REASONS: Record<(typeof SENSITIVE_PREFIXES)[number], string> = {
  "apps/web/src/app/api/judge/": "judge-node routes: serve test blobs, checkers and reference sources to authenticated nodes",
  "apps/web/src/app/api/admin/": "staff routes (problem import writes hidden tests and references)",
  "apps/web/src/lib/judge/claim.ts": "builds job specs holding hidden test keys, checker and reference sources",
  "apps/web/src/lib/judge/finalize.ts": "reads test bytes to write sample details; validation finalise reads references",
  "apps/web/src/lib/judge/validation.ts": "validation and publish: reads references, test blobs, writes bundles",
  "apps/web/src/lib/testdata/": "the test-data store and blob reads",
  "apps/web/src/lib/authoring/": "problem authoring: edits hidden tests, references and checkers",
  "apps/web/src/lib/privileged/": "SUPER_ADMIN executors (problem/version delete, global rejudge, purge)",
  "apps/web/src/server/queries/admin-": "staff queries (authoring shows hidden tests and references)",
  "apps/web/src/server/queries/super-": "SUPER_ADMIN queries",
  "apps/web/src/server/actions/admin-": "staff actions (authoring writes hidden tests and references)",
  "apps/web/src/server/actions/super-": "SUPER_ADMIN actions",
  "apps/web/src/server/actions/privileged.ts": "SUPER_ADMIN two-person approval; runs the lib/privileged executors",
  "apps/web/src/app/admin/": "staff pages (authoring pages render hidden tests and references)",
  "apps/web/src/app/super/": "SUPER_ADMIN pages and the PII export route",
  "apps/web/src/components/admin/": "staff UI (authoring editors show hidden tests and references)",
  "apps/web/src/components/super/": "SUPER_ADMIN console UI",
};

export function isSensitive(rel: string): boolean {
  return SENSITIVE_PREFIXES.some((p) => rel.startsWith(p));
}

/**
 * Sensitive-path modules a student entry may load anyway, with the reason.
 * Each must be a "use server" file whose every export is staff-guarded (or
 * listed in UNWRAPPED_ACTIONS), and the graph is still followed THROUGH it:
 * anything sensitive it imports is flagged on the student entry as usual.
 */
const STUDENT_REACHABLE_ACTIONS: Record<string, string> = {
  "apps/web/src/server/actions/super-impersonate.ts":
    "the root layout renders the impersonation banner, whose form posts endImpersonation; " +
    "every export is SUPER_ADMIN-guarded or requireImpersonator() (passes only during an impersonation a SUPER_ADMIN started)",
};

/**
 * Exports exempt from the runAction shape in R6, each with the guard its
 * first statement must await (mirrors tests/repo/action-guards.test.ts).
 */
const UNWRAPPED_ACTIONS: Record<string, string> = {
  "apps/web/src/server/actions/super-impersonate.ts#endImpersonation": "requireImpersonator",
};

/** Sensitive for the student-entry rules (R4, R5). */
export function isSensitiveForStudents(rel: string): boolean {
  return isSensitive(rel) && !(rel in STUDENT_REACHABLE_ACTIONS);
}

/** Composite action guards and where each is defined; each must itself start with a staff-only guard. */
const COMPOSITE_STAFF_GUARDS: Record<string, string> = {
  requireAdminScopeAction: "apps/web/src/lib/auth/scope.ts",
};

/**
 * Sensitive library modules that may omit `import "server-only"`, with the
 * reason. They hold no data access of their own that a client bundle could
 * use, and some are loaded outside the react-server condition.
 */
const SERVER_ONLY_EXEMPT: Record<string, string> = {
  "apps/web/src/lib/testdata/blobs.ts": "content-addressing helpers taking an explicit db/store; loaded by scripts/seed.ts",
  "apps/web/src/lib/testdata/bundle.ts": "bundle builder; loaded by scripts/seed.ts",
  "apps/web/src/lib/testdata/keys.ts": "object-key naming and KeyNotFoundError; pure",
  "apps/web/src/lib/testdata/tar.ts": "tar encoder; pure",
  "apps/web/src/lib/testdata/local-fs.ts": "store driver, reached only through lib/testdata/store.ts (server-only)",
  "apps/web/src/lib/testdata/s3.ts": "store driver, reached only through lib/testdata/store.ts (server-only)",
  "apps/web/src/lib/privileged/csv.ts": "pure CSV encoding for the export route",
  "apps/web/src/lib/privileged/payloads.ts": "zod payload schemas and labels the super pages render; no db access",
  "apps/web/src/lib/privileged/policy.ts": "pure approval-policy functions",
  "apps/web/src/lib/privileged/types.ts": "types and constants only",
};

const STUDENT_ENTRY = /\/(?:page|layout|route|loading|error|global-error|not-found|template|default)\.(?:tsx?|jsx?)$/;
const ENTRY_EXCLUDED = ["apps/web/src/app/admin/", "apps/web/src/app/super/", "apps/web/src/app/api/judge/", "apps/web/src/app/api/admin/"];

const webFiles = findFiles({ under: [WEB_SRC], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"], exclude: isTestPath });
const sourceCache = new Map<string, string>();
const read = (rel: string) => {
  let s = sourceCache.get(rel);
  if (s === undefined) {
    s = readRepoFile(rel);
    sourceCache.set(rel, s);
  }
  return s;
};
const graph = new ModuleGraph({ aliases: { "@/": `${WEB_SRC}/` }, files: new Set(repoFiles()) }, read);
const outside = webFiles.filter((f) => !isSensitive(f));

export function studentEntries(files: readonly string[]): string[] {
  return files.filter(
    (f) =>
      (f.startsWith(`${WEB_SRC}/app/`) && STUDENT_ENTRY.test(f) && !ENTRY_EXCLUDED.some((p) => f.startsWith(p))) ||
      f === `${WEB_SRC}/middleware.ts` ||
      f.startsWith(`${WEB_SRC}/pages/`),
  );
}

function sensitiveReach(g: ModuleGraph, entry: string, sensitive: (rel: string) => boolean): string[] {
  const closure = g.closure(entry);
  return [...closure.keys()].filter(sensitive).map((hit) => ModuleGraph.chain(closure, hit).join(" -> "));
}

function report(file: string, findings: Finding[]): string[] {
  return findings.map((f) => `${file}:${f.line}  ${f.rule}`);
}

// ── Self-tests ───────────────────────────────────────────────────────────

describe("detector self-tests", () => {
  describe("R1 reference solutions", () => {
    it.each([
      ["delegate", "await db.referenceSolution.findMany({ where: { problemVersionId } });"],
      ["nested relation", "select: { referenceSolutions: { select: { source: true } } }"],
      ["bracket access", 'const rows = await db["referenceSolution"].findMany();'],
      ["raw SQL", 'await db.$queryRaw`SELECT "source" FROM "ReferenceSolution" WHERE id = ${id}`;'],
      ["type name", "type Row = Prisma.ReferenceSolutionGetPayload<{}>; const r: ReferenceSolution = x;"],
    ])("flags %s", (_n, snippet) => expect(scanReferenceSolutions(snippet).length).toBeGreaterThan(0));

    it.each([
      ["prose with a space", 'const label = "reference solution";'],
      ["comment", "// db.referenceSolution.findMany()"],
      ["block comment", "/* ReferenceSolution */ const x = 1;"],
    ])("does not flag %s", (_n, snippet) => expect(scanReferenceSolutions(snippet)).toEqual([]));
  });

  describe("R2 test bytes and checker sources", () => {
    it.each([
      ["testBlob delegate", "const b = await db.testBlob.findUnique({ where: { sha256 } });"],
      ["readBlobBytes", "const bytes = await readBlobBytes(db, store, sha);"],
      ["getTestDataStore", "const store = getTestDataStore();"],
      ["checker sha", "select: { checkerSha256: true }"],
      ["raw SQL TestBlob", 'await db.$queryRaw`SELECT "inline" FROM "TestBlob"`;'],
      ["raw SQL inline column", 'await db.$queryRawUnsafe(\'SELECT b."inline" FROM x b\');'],
      ["raw SQL storageKey", 'const sql = `SELECT "storageKey" FROM t`;'],
    ])("flags %s", (_n, snippet) => expect(scanTestBytes(snippet).length).toBeGreaterThan(0));

    it.each([
      ["prose", 'const s = "test blob";'],
      ["comment", "// getTestDataStore()"],
      ["inline as a word in UI text", 'const s = "inline hint";'],
      ["unrelated identifier", "const storage = makeStorage(); const isInline = true;"],
    ])("does not flag %s", (_n, snippet) => expect(scanTestBytes(snippet)).toEqual([]));
  });

  describe("R3 test-case queries", () => {
    it.each([
      [
        "findMany selecting hidden input",
        "await db.testCase.findMany({ where: { problemVersionId }, select: { input: { select: { inline: true } } } });",
      ],
      ["include output", "await tx.testCase.findFirst({ where: { id }, include: { output: true } });"],
      [
        "nested testCases without the filter",
        "select: { testCases: { orderBy: { index: 'asc' }, select: { index: true, input: { select: { inline: true } } } } }",
      ],
      ["isSample false", "select: { testCases: { where: { isSample: false }, select: { output: true } } }"],
      ["non-literal argument", "const rows = await db.testCase.findMany(args);"],
    ])("flags %s", (_n, snippet) => expect(scanTestCaseQueries(snippet).length).toBeGreaterThan(0));

    it.each([
      [
        "sample-only query",
        "await db.testCase.findMany({ where: { problemVersionId, isSample: true }, select: { input: { select: { inline: true } } } });",
      ],
      [
        "nested sample-only select",
        "testCases: {\n  where: { isSample: true },\n  select: { index: true, input: { select: { inline: true } }, output: { select: { inline: true } } },\n}",
      ],
      ["metadata only", "testCases: { select: { index: true, points: true, subtaskIndex: true, isSample: true } }"],
      ["count", "await db.testCase.count({ where: { problemVersionId } });"],
      ["array map", "version.testCases.map((t) => ({ input: t.input.inline }))"],
      ["scalar flag", "select: { testCases: true }"],
    ])("does not flag %s", (_n, snippet) => expect(scanTestCaseQueries(snippet)).toEqual([]));
  });

  describe("R4/R5 import graph", () => {
    const files: Record<string, string> = {
      "apps/web/src/app/(student)/x/page.tsx": 'import { Card } from "@/components/card";\nimport type { T } from "@/lib/judge/validation";\nexport default function P() { return Card; }',
      "apps/web/src/components/card.tsx": 'import { helper } from "./util";\nexport const Card = helper;',
      "apps/web/src/components/util.ts": 'export { publishVersion as helper } from "../lib/judge/validation";',
      "apps/web/src/lib/judge/validation.ts": "export const publishVersion = 1;",
      "apps/web/src/app/(student)/y/page.tsx": 'import { type A, type B } from "@/lib/judge/validation";\nexport default function P() { return null; }',
      "apps/web/src/app/(student)/z/page.tsx": 'const m = await import("@/lib/judge/validation");\nexport default function P() { return m; }',
      "apps/web/src/app/(student)/w/page.tsx": 'import "@/lib/judge/validation";\nexport default function P() { return null; }',
      "apps/web/src/app/(student)/v/page.tsx": 'import x from "@/lib/missing";\nexport default x;',
    };
    const g = new ModuleGraph({ aliases: { "@/": "apps/web/src/" }, files: new Set(Object.keys(files)) }, (rel) => files[rel]!);
    const sensitive = (rel: string) => rel === "apps/web/src/lib/judge/validation.ts";

    it("parses value, type-only, side-effect and dynamic imports", () => {
      expect(importEdges('import type { A } from "a"; import { type B } from "b"; import { C, type D } from "c"; import "d"; export type { E } from "e"; export { F } from "f"; await import("g"); require("h");')).toEqual([
        { specifier: "a", line: 1, typeOnly: true },
        { specifier: "b", line: 1, typeOnly: true },
        { specifier: "c", line: 1, typeOnly: false },
        { specifier: "d", line: 1, typeOnly: false },
        { specifier: "e", line: 1, typeOnly: true },
        { specifier: "f", line: 1, typeOnly: false },
        { specifier: "g", line: 1, typeOnly: false },
        { specifier: "h", line: 1, typeOnly: false },
      ]);
      expect(importEdges("type M = typeof import('m');")).toEqual([]);
    });

    it("resolves @/ and relative specifiers; packages are external", () => {
      const options = { aliases: { "@/": "apps/web/src/" }, files: new Set(Object.keys(files)) };
      expect(resolveSpecifier("apps/web/src/components/card.tsx", "./util", options)).toBe("apps/web/src/components/util.ts");
      expect(resolveSpecifier("apps/web/src/components/util.ts", "../lib/judge/validation", options)).toBe("apps/web/src/lib/judge/validation.ts");
      expect(resolveSpecifier("apps/web/src/x.ts", "@/components/card", options)).toBe("apps/web/src/components/card.tsx");
      expect(resolveSpecifier("apps/web/src/x.ts", "react", options)).toBe(null);
      expect(resolveSpecifier("apps/web/src/x.ts", "@/nope", options)).toBe(undefined);
    });

    it("flags a transitive value import through a re-export (with the chain)", () => {
      expect(sensitiveReach(g, "apps/web/src/app/(student)/x/page.tsx", sensitive)).toEqual([
        "apps/web/src/app/(student)/x/page.tsx -> apps/web/src/components/card.tsx -> apps/web/src/components/util.ts -> apps/web/src/lib/judge/validation.ts",
      ]);
    });

    it("flags dynamic and side-effect imports", () => {
      expect(sensitiveReach(g, "apps/web/src/app/(student)/z/page.tsx", sensitive)).toHaveLength(1);
      expect(sensitiveReach(g, "apps/web/src/app/(student)/w/page.tsx", sensitive)).toHaveLength(1);
    });

    it("does not flag type-only imports", () => {
      expect(sensitiveReach(g, "apps/web/src/app/(student)/y/page.tsx", sensitive)).toEqual([]);
    });

    it("records an unresolvable @/ import", () => {
      g.closure("apps/web/src/app/(student)/v/page.tsx");
      expect(g.unresolved).toEqual([{ from: "apps/web/src/app/(student)/v/page.tsx", specifier: "@/lib/missing", line: 1 }]);
    });

    it("selects student entries", () => {
      expect(
        studentEntries([
          "apps/web/src/app/(student)/x/page.tsx",
          "apps/web/src/app/(student)/layout.tsx",
          "apps/web/src/app/api/runs/[id]/route.ts",
          "apps/web/src/app/global-error.tsx",
          "apps/web/src/app/admin/page.tsx",
          "apps/web/src/app/super/data/exports/[id]/route.ts",
          "apps/web/src/app/api/judge/claim/route.ts",
          "apps/web/src/app/api/admin/problems/import/route.ts",
          "apps/web/src/app/(student)/notes/data.ts",
          "apps/web/src/middleware.ts",
          "apps/web/src/pages/login.tsx",
        ]),
      ).toEqual([
        "apps/web/src/app/(student)/x/page.tsx",
        "apps/web/src/app/(student)/layout.tsx",
        "apps/web/src/app/api/runs/[id]/route.ts",
        "apps/web/src/app/global-error.tsx",
        "apps/web/src/middleware.ts",
        "apps/web/src/pages/login.tsx",
      ]);
    });
  });

  describe("R6 server-action guards", () => {
    const action = (guard: string) => `"use server";
      export async function act(input: unknown) {
        return runAction(async () => {
          ${guard}
          return 1;
        }, "act");
      }`;
    const guardOf = (src: string) => analyzeActionExports(src)[0]!.firstGuard;

    it.each([
      ["requireSuperAdmin", "const actor = await requireSuperAdmin();"],
      ["requireActionRole ADMIN, SUPER_ADMIN", 'const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");'],
      ["requireActionRole SUPER_ADMIN", 'await requireActionRole("SUPER_ADMIN");'],
    ])("accepts %s", (_n, guard) => {
      expect(isUseServerFile(action(guard))).toBe(true);
      expect(isStaffGuard(guardOf(action(guard)))).toBe(true);
    });

    it.each([
      ["requireActionUser", "const user = await requireActionUser();"],
      ["a role list admitting STUDENT", 'await requireActionRole("ADMIN", "STUDENT");'],
      ["TA_MENTOR only", 'await requireActionRole("TA_MENTOR");'],
      ["no roles", "await requireActionRole();"],
      ["guard not first", 'const p = schema.parse(input);\nawait requireActionRole("ADMIN");'],
    ])("rejects %s", (_n, guard) => {
      expect(isStaffGuard(guardOf(action(guard)))).toBe(false);
    });

    it("accepts a verified composite guard only when listed", () => {
      const g = guardOf(action("const { user } = await requireAdminScopeAction();"));
      expect(isStaffGuard(g)).toBe(false);
      expect(isStaffGuard(g, new Set(["requireAdminScopeAction"]))).toBe(true);
    });

    it("reports unwrapped and non-function exports", () => {
      const exports = analyzeActionExports(`"use server";
        export async function bare() { await requireSuperAdmin(); }
        export const value = 1;
        export { other } from "./x";`);
      expect(exports.map((e) => [e.name, e.isFunction, e.wrapped])).toEqual([
        ["bare", true, false],
        ["value", false, false],
        ["<re-export>", false, false],
      ]);
    });

    it("finds a composite guard's first statement", () => {
      const src = 'export async function requireX() { const user = await requireActionRole("ADMIN", "SUPER_ADMIN"); return user; }';
      expect(exportedFunctionFirstGuard(src, "requireX")).toEqual({ name: "requireActionRole", args: ["ADMIN", "SUPER_ADMIN"] });
    });

    it("finds inline 'use server' directives, not the file directive", () => {
      expect(inlineUseServerLines('"use server";\nexport async function a() {}')).toEqual([]);
      expect(inlineUseServerLines('export default function Page() {\n  async function act() {\n    "use server";\n  }\n}')).toEqual([3]);
      expect(isUseServerFile('// "use server"\nexport const a = 1;')).toBe(false);
    });
  });

  describe("R7 admin route guards", () => {
    it.each([
      ["guard first", 'const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");\nconst body = await request.formData();'],
      ["super guard", "await requireSuperAdmin();\nawait db.user.findMany();"],
    ])("accepts %s", (_n, body) => expect(staffGuardBeforeBody(`{ ${body} }`)).toBe(true));

    it.each([
      ["body read first", 'const body = await request.json();\nawait requireActionRole("ADMIN");'],
      ["spool first", 'await spoolRequestBody(request, o);\nawait requireActionRole("ADMIN");'],
      ["db first", 'await db.problem.findMany();\nawait requireActionRole("ADMIN");'],
      ["student-admitting guard", 'await requireActionRole("ADMIN", "STUDENT");\nawait request.json();'],
      ["no guard", "await request.json();"],
      ["guard only in a comment", '// await requireActionRole("ADMIN");\nawait request.json();'],
    ])("rejects %s", (_n, body) => expect(staffGuardBeforeBody(`{ ${body} }`)).toBe(false));
  });

  describe("R8 server-only", () => {
    it("accepts a module that starts with the import", () => {
      expect(startsWithServerOnly('import "server-only";\nimport { db } from "@/lib/db";')).toBe(true);
    });
    it.each([
      ["missing", 'import { db } from "@/lib/db";'],
      ["not first", 'import { db } from "@/lib/db";\nimport "server-only";'],
      ["commented", '// import "server-only";\nexport const a = 1;'],
    ])("rejects %s", (_n, src) => expect(startsWithServerOnly(src)).toBe(false));
  });
});

// ── The checkout ────────────────────────────────────────────────────────

describe("student exposure fence over apps/web/src", () => {
  it("sanity: the file list, every sensitive prefix and its reason exist", () => {
    expect(webFiles.length).toBeGreaterThan(200);
    expect(outside.length).toBeGreaterThan(100);
    for (const prefix of SENSITIVE_PREFIXES) {
      expect(SENSITIVE_REASONS[prefix].length, prefix).toBeGreaterThan(10);
      expect(webFiles.some((f) => f.startsWith(prefix)), `${prefix} matches no file (stale prefix?)`).toBe(true);
    }
    for (const exempt of Object.keys(SERVER_ONLY_EXEMPT)) {
      expect(webFiles, `${exempt} is listed in SERVER_ONLY_EXEMPT but does not exist`).toContain(exempt);
    }
  });

  it("R1: no reference-solution access outside the sensitive paths", () => {
    const hits = outside.flatMap((f) => report(f, scanReferenceSolutions(read(f))));
    expect(hits, "Reference solutions are staff-only; move this code under a SENSITIVE_PREFIXES path behind a staff guard.").toEqual([]);
  });

  it("R2: no test-blob, test-data-store or checker-source access outside the sensitive paths", () => {
    const hits = outside.flatMap((f) => report(f, scanTestBytes(read(f))));
    expect(hits, "Hidden test bytes and checker sources are judge/staff-only.").toEqual([]);
  });

  it("R3: every test-case query outside the sensitive paths that selects content is sample-only", () => {
    const hits = outside.flatMap((f) => report(f, scanTestCaseQueries(read(f))));
    expect(hits, "Select input/output of a test case only together with isSample: true.").toEqual([]);
  });

  it("R3 positive control: the student workspace and submission queries are checked and pass", () => {
    for (const f of ["apps/web/src/server/queries/problems.ts", "apps/web/src/server/queries/submissions.ts"]) {
      expect(read(f)).toMatch(/isSample:\s*true/);
      expect(scanTestCaseQueries(read(f))).toEqual([]);
    }
  });

  it("the graph resolves every @/ and relative import in apps/web/src", () => {
    for (const f of webFiles) graph.edges(f);
    expect(graph.unresolved.map((u) => `${u.from}:${u.line} ${u.specifier}`)).toEqual([]);
  });

  it("R4: no module outside the sensitive paths imports a sensitive one", () => {
    const hits: string[] = [];
    for (const f of outside) {
      for (const edge of graph.edges(f)) {
        if (isSensitiveForStudents(edge.target)) hits.push(`${f}:${edge.line} imports ${edge.target}`);
      }
    }
    expect(hits).toEqual([]);
  });

  const entries = studentEntries(webFiles);

  it("R5 sanity: the student entries include the workspace, the submission routes and the root layout", () => {
    expect(entries).toEqual(
      expect.arrayContaining([
        "apps/web/src/app/(student)/problems/[slug]/page.tsx",
        "apps/web/src/app/(student)/problems/[slug]/submissions/[id]/page.tsx",
        "apps/web/src/app/api/submissions/[id]/route.ts",
        "apps/web/src/app/api/runs/[id]/stream/route.ts",
        "apps/web/src/app/layout.tsx",
        "apps/web/src/app/u/[handle]/page.tsx",
        "apps/web/src/middleware.ts",
        "apps/web/src/pages/login.tsx",
      ]),
    );
    expect(entries.some((e) => e.startsWith("apps/web/src/app/admin/") || e.startsWith("apps/web/src/app/api/judge/"))).toBe(false);
  });

  it("R5 positive control: the judge result route does reach finalize and validation", () => {
    const closure = graph.closure("apps/web/src/app/api/judge/result/route.ts");
    expect(closure.has("apps/web/src/lib/judge/finalize.ts")).toBe(true);
    expect(closure.has("apps/web/src/lib/judge/validation.ts")).toBe(true);
  });

  it("R5 mutation check: a student query that imports validation.ts is caught on the real workspace and submission entries", () => {
    const mutated = "apps/web/src/server/queries/problems.ts";
    const mutatedGraph = new ModuleGraph({ aliases: { "@/": `${WEB_SRC}/` }, files: new Set(repoFiles()) }, (rel) =>
      rel === mutated ? `${read(rel)}\nimport { publishVersion } from "@/lib/judge/validation";\nvoid publishVersion;\n` : read(rel),
    );
    const flagged = entries.filter((e) => sensitiveReach(mutatedGraph, e, isSensitiveForStudents).length > 0);
    expect(flagged).toContain("apps/web/src/app/(student)/problems/[slug]/page.tsx");
    expect(flagged).toContain("apps/web/src/app/(student)/problems/page.tsx");
  });

  it.each(Object.keys(STUDENT_REACHABLE_ACTIONS))("R5: the student-reachable action file %s is a guarded server-action module", (rel) => {
    expect(STUDENT_REACHABLE_ACTIONS[rel]!.length).toBeGreaterThan(20);
    expect(isSensitive(rel), `${rel} is not under a sensitive prefix; drop the exception`).toBe(true);
    expect(isUseServerFile(read(rel), rel)).toBe(true);
    const exports = analyzeActionExports(read(rel), rel);
    expect(exports.length).toBeGreaterThan(0);
    for (const e of exports) {
      const unwrapped = UNWRAPPED_ACTIONS[`${rel}#${e.name}`];
      const ok = e.isFunction && (unwrapped ? !e.wrapped && e.firstGuard?.name === unwrapped : e.wrapped && isStaffGuard(e.firstGuard));
      expect(ok, `${rel}#${e.name}`).toBe(true);
    }
  });

  it.each(entries)("R5: %s reaches no sensitive module", (entry) => {
    expect(sensitiveReach(graph, entry, isSensitiveForStudents)).toEqual([]);
  });

  const useServerFiles = webFiles.filter((f) => /\.tsx?$/.test(f) && isUseServerFile(read(f), f));

  it("R6 sanity: finds the server-action files", () => {
    expect(useServerFiles).toEqual(
      expect.arrayContaining(["apps/web/src/server/actions/judge.ts", "apps/web/src/server/actions/admin-problems.ts"]),
    );
  });

  it.each(Object.entries(COMPOSITE_STAFF_GUARDS))("R6: composite guard %s starts with a staff-only guard", (guard, rel) => {
    const first = exportedFunctionFirstGuard(read(rel), guard, rel);
    expect(first, `${guard} is not exported from ${rel}`).not.toBeUndefined();
    expect(isStaffGuard(first ?? null)).toBe(true);
  });

  it("R6: every server-action file that reaches a sensitive module guards every export as staff-only", () => {
    const composite = new Set(Object.keys(COMPOSITE_STAFF_GUARDS));
    const problems: string[] = [];
    let checked = 0;
    for (const f of useServerFiles) {
      const reach = sensitiveReach(graph, f, isSensitive);
      if (reach.length === 0) continue;
      checked++;
      for (const e of analyzeActionExports(read(f), f)) {
        const where = `${f}#${e.name} (line ${e.line})`;
        const unwrappedGuard = UNWRAPPED_ACTIONS[`${f}#${e.name}`];
        if (!e.isFunction) problems.push(`${where}: not a function`);
        else if (unwrappedGuard) {
          if (e.wrapped || e.firstGuard?.name !== unwrappedGuard) problems.push(`${where}: must start with await ${unwrappedGuard}()`);
        } else if (!e.wrapped) problems.push(`${where}: not \`return runAction(async () => { … })\``);
        else if (!isStaffGuard(e.firstGuard, composite)) {
          problems.push(`${where}: reaches ${reach[0]} but its first statement is ${e.firstGuard ? `${e.firstGuard.name}(${e.firstGuard.args.join(", ")})` : "not a guard"}`);
        }
      }
    }
    expect(checked, "no server-action file reaches a sensitive module (the rule would be vacuous)").toBeGreaterThan(5);
    expect(problems).toEqual([]);
  });

  it("R6: no inline (function-level) \"use server\" in apps/web/src", () => {
    const hits = webFiles
      .filter((f) => /\.tsx?$/.test(f))
      .flatMap((f) => inlineUseServerLines(read(f), f).map((line) => `${f}:${line}`));
    expect(hits, "Define server actions in src/server/actions/*.ts, where the guard fences check them.").toEqual([]);
  });

  const adminRoutes = webFiles.filter((f) => f.startsWith(`${WEB_SRC}/app/api/admin/`) && f.endsWith("/route.ts"));

  it("R7 sanity: the problem-import route exists", () => {
    expect(adminRoutes).toContain(`${WEB_SRC}/app/api/admin/problems/import/route.ts`);
  });

  it.each(adminRoutes)("R7: %s calls a staff-only guard before reading the body", (rel) => {
    const handlers = [...exportedFunctionBodies(read(rel), rel)].filter(([name]) =>
      ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(name),
    );
    expect(handlers.length).toBeGreaterThan(0);
    for (const [name, body] of handlers) expect(staffGuardBeforeBody(body), `${rel}#${name}`).toBe(true);
  });

  it("R8: every sensitive library module starts with import \"server-only\" (or is a listed pure helper)", () => {
    const libs = webFiles.filter(
      (f) => isSensitive(f) && /\.tsx?$/.test(f) && (f.startsWith(`${WEB_SRC}/lib/`) || f.startsWith(`${WEB_SRC}/server/queries/`)),
    );
    expect(libs.length).toBeGreaterThan(20);
    const missing = libs.filter((f) => !(f in SERVER_ONLY_EXEMPT) && !startsWithServerOnly(read(f), f));
    expect(missing).toEqual([]);
    const staleExempt = Object.keys(SERVER_ONLY_EXEMPT).filter((f) => startsWithServerOnly(read(f), f));
    expect(staleExempt, "these now import server-only; drop them from SERVER_ONLY_EXEMPT").toEqual([]);
  });
});
