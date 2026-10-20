import { describe, expect, it } from "vitest";
import { findFiles, isTestPath, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * Rendering never mutates (governance design §9.11, optional fence).
 *
 * A server component runs on every render, on a GET, and React may render it
 * more than once; Next.js may also prerender or revalidate it. A write on
 * that path would therefore fire without an action guard, without
 * `runAction()`, without an audit row and without CSRF protection — and more
 * than once. Mutations live in `src/server/actions/*.ts` (see
 * `tests/repo/action-guards.test.ts`, which proves every one of those starts
 * with a guard) and in route handlers.
 *
 * So over every render path — `page`, `layout`, `template`, `default`,
 * `loading`, `error`, `global-error` and `not-found` under
 * `apps/web/src/app`, plus all of `src/server/queries/**` (read helpers by
 * definition) and `src/components/**` — a file may not contain:
 *
 *   W1  a Prisma delegate write on `db`, `tx`, `client` or `prisma`:
 *       create, createMany, createManyAndReturn, update, updateMany,
 *       updateManyAndReturn, upsert, delete, deleteMany;
 *   W2  `$executeRaw` / `$executeRawUnsafe` — a statement, not a query, even
 *       when the SQL only takes an advisory lock (still a side effect);
 *   W3  raw SQL naming a table in INSERT INTO, UPDATE, DELETE FROM or
 *       TRUNCATE, whichever method sends it (so a write smuggled through
 *       `$queryRaw` is caught too).
 *
 * Comments never count (the lexer blanks them). §9.11 names
 * `{page,layout}.tsx`; the other render entries are in scope here because
 * they are the same kind of file and the same argument applies to them.
 *
 * An interactive transaction needs no rule of its own: its callback body sits
 * in the same file, so `tx.<model>.<write>(…)` inside it is caught by W1.
 *
 * `src/app/**\/route.ts` is deliberately NOT in scope: a route handler is a
 * request path, it may write, and `action-guards.test.ts` already requires a
 * guard on every non-judge handler that exports POST/PUT/PATCH/DELETE.
 */

const RENDER_ENTRY = /\/(?:page|layout|template|default|loading|error|global-error|not-found)\.tsx?$/;

const PREFIXES = ["apps/web/src/server/queries/", "apps/web/src/components/"];

export function isRenderPath(rel: string): boolean {
  if (rel.startsWith("apps/web/src/app/") && RENDER_ENTRY.test(rel)) return true;
  return PREFIXES.some((p) => rel.startsWith(p));
}

const WRITE_METHODS =
  "create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany";

/** db.user.update(…), tx?.user?.update(…), db["user"].update(…), client.x.delete(…) */
const DELEGATE_WRITE = new RegExp(
  "\\b(?:db|tx|client|prisma)\\s*" +
    "(?:\\??\\.\\s*[a-z][A-Za-z0-9_$]*|\\??\\.?\\s*\\[\\s*[\"'`][A-Za-z0-9_$]+[\"'`]\\s*\\])" +
    `\\s*\\??\\.\\s*(?:${WRITE_METHODS})\\s*\\(`,
  "g",
);

const RAW_EXEC = /\b(?:db|tx|client|prisma)\s*\??\.\s*\$executeRaw(?:Unsafe)?\b/g;

const SQL_WRITE =
  /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:"?public"?\s*\.\s*)?"[A-Za-z_]\w*"/i;

export interface Finding {
  line: number;
  rule: "W1" | "W2" | "W3";
  what: string;
}

export function renderWrites(source: string): Finding[] {
  const { code, strings } = lexSource(source);
  const findings: Finding[] = [];
  for (const m of code.matchAll(DELEGATE_WRITE)) {
    findings.push({ line: lineAt(code, m.index), rule: "W1", what: m[0].replace(/\s+/g, " ") });
  }
  for (const m of code.matchAll(RAW_EXEC)) {
    findings.push({ line: lineAt(code, m.index), rule: "W2", what: m[0].replace(/\s+/g, " ") });
  }
  for (const s of strings) {
    if (SQL_WRITE.test(s.body)) findings.push({ line: lineAt(code, s.start), rule: "W3", what: "raw SQL write" });
  }
  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

// ── Self-tests ───────────────────────────────────────────────────────────

describe("detector self-tests", () => {
  describe("W1 delegate writes", () => {
    it.each([
      ["db", "const r = await db.user.update({ where: { id }, data });"],
      ["tx inside a transaction", "await db.$transaction(async (tx) => { await tx.xpEvent.create({ data }); });"],
      ["client", "await client.testBlob.upsert({ where, create, update });"],
      ["bracket access", 'await db["user"].deleteMany({ where });'],
      ["optional chain", "await tx?.notification?.createMany({ data });"],
      ["createManyAndReturn", "const rows = await db.notification.createManyAndReturn({ data });"],
      ["newline before the method", "await db.problem\n  .update({ where: { id }, data });"],
    ])("flags %s", (_n, snippet) => expect(renderWrites(snippet).map((f) => f.rule)).toContain("W1"));

    it.each([
      ["a read", "const u = await db.user.findUnique({ where: { id } });"],
      ["a count", "const n = await db.submission.count({ where });"],
      ["a comment", "// await db.user.update({ where, data })"],
      ["a block comment", "/* db.user.delete({ where }) */ const x = 1;"],
      ["a Map delete", "cache.delete(key);"],
      ["a Set on a non-Prisma receiver", "refs.current.delete(node);"],
      ["prose", 'const label = "update your profile";'],
      ["a same-named local", "const update = db.user.findMany; update();"],
    ])("ignores %s", (_n, snippet) => expect(renderWrites(snippet)).toEqual([]));
  });

  describe("W2 raw statements", () => {
    it.each([
      ["executeRaw", "await db.$executeRaw`SELECT pg_advisory_xact_lock(1)`;"],
      ["executeRawUnsafe", "await tx.$executeRawUnsafe(sql);"],
    ])("flags %s", (_n, snippet) => expect(renderWrites(snippet).map((f) => f.rule)).toContain("W2"));

    it("ignores $queryRaw that only reads", () => {
      expect(renderWrites("const rows = await db.$queryRaw`SELECT 1`;")).toEqual([]);
    });
  });

  describe("W3 raw SQL writes", () => {
    it.each([
      ["UPDATE through $queryRaw", 'await db.$queryRaw`UPDATE "User" SET name = ${n} WHERE id = ${id}`;'],
      ["INSERT INTO", 'const sql = `INSERT INTO "XpEvent" (id) VALUES (${id})`;'],
      ["DELETE FROM with a schema", 'const sql = `DELETE FROM "public"."Session" WHERE id = ${id}`;'],
      ["TRUNCATE", 'const sql = `TRUNCATE TABLE "AuditLog"`;'],
    ])("flags %s", (_n, snippet) => expect(renderWrites(snippet).map((f) => f.rule)).toContain("W3"));

    it.each([
      ["a SELECT", 'await db.$queryRaw`SELECT "id" FROM "User" WHERE id = ${id}`;'],
      ["UI prose", 'const copy = "Update your details to delete from the list.";'],
      ["an unquoted word in prose", 'const copy = "We update problems weekly.";'],
    ])("ignores %s", (_n, snippet) => expect(renderWrites(snippet)).toEqual([]));
  });

  describe("scope", () => {
    it.each([
      "apps/web/src/app/(student)/dashboard/page.tsx",
      "apps/web/src/app/layout.tsx",
      "apps/web/src/app/admin/accommodations/[id]/page.tsx",
      "apps/web/src/app/(student)/practice/loading.tsx",
      "apps/web/src/app/global-error.tsx",
      "apps/web/src/server/queries/admin-accommodations.ts",
      "apps/web/src/components/admin/accommodations/accommodation-list.tsx",
    ])("includes %s", (rel) => expect(isRenderPath(rel)).toBe(true));

    it.each([
      "apps/web/src/app/api/judge/claim/route.ts",
      "apps/web/src/app/admin/accommodations/actions.ts",
      "apps/web/src/server/actions/admin-accommodations.ts",
      "apps/web/src/lib/judge/finalize.ts",
      "apps/web/src/middleware.ts",
    ])("excludes %s", (rel) => expect(isRenderPath(rel)).toBe(false));
  });
});

// ── The repository ───────────────────────────────────────────────────────

describe("render paths never write", () => {
  const files = findFiles({
    under: ["apps/web/src"],
    extensions: [".ts", ".tsx"],
    exclude: (rel) => isTestPath(rel) || !isRenderPath(rel),
  });

  it("scans the render paths (so the fence cannot pass by scanning nothing)", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("apps/web/src/app/layout.tsx");
    expect(files.some((f) => f.startsWith("apps/web/src/server/queries/"))).toBe(true);
    expect(files.some((f) => f.startsWith("apps/web/src/components/"))).toBe(true);
    expect(files.some((f) => /\/page\.tsx$/.test(f))).toBe(true);
  });

  it("contain no database write", () => {
    const findings = files.flatMap((f) =>
      renderWrites(readRepoFile(f)).map((w) => `${f}:${w.line}  ${w.rule}  ${w.what}`),
    );
    expect(findings).toEqual([]);
  });
});
