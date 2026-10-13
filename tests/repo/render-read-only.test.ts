import { describe, expect, it } from "vitest";
import { findFiles, isTestPath, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * Rendering never writes (governance design §9.11). Impersonation is
 * read-only because every mutation is a guarded server action that refuses
 * during an impersonation; that holds only if no render path writes on its
 * own. So in apps/web/src:
 *
 *   - app/** page, layout, template, loading, not-found and default files,
 *   - server/queries/**,
 *   - components/**,
 *
 * contain no Prisma write (db / tx / prisma .model.create… / update… /
 * upsert / delete…), no $executeRaw / $executeRawUnsafe, and no raw SQL
 * INSERT, UPDATE or DELETE on a table. Writes belong in server actions
 * (src/server/actions/**), route handlers and lib/**.
 */

const RENDER_FILE = /\/(page|layout|template|loading|not-found|default)\.[jt]sx?$/;

export function isRenderPath(rel: string): boolean {
  if (rel.startsWith("apps/web/src/app/")) return RENDER_FILE.test(rel);
  return rel.startsWith("apps/web/src/server/queries/") || rel.startsWith("apps/web/src/components/");
}

const MODEL_WRITE =
  /\b(?:db|tx|prisma)(?:\s*\??\.\s*\w+|\s*\[\s*["'`]\w+["'`]\s*\])\s*\??\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/g;
const EXECUTE_RAW = /\$executeRaw(?:Unsafe)?\b/g;
const SQL_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?public"?\.)?"[A-Z]\w*"/;

interface Finding {
  file: string;
  line: number;
  what: string;
}

export function renderWrites(file: string, source: string): Finding[] {
  const { code, strings } = lexSource(source);
  const findings: Finding[] = [];
  for (const m of code.matchAll(MODEL_WRITE)) findings.push({ file, line: lineAt(code, m.index), what: m[0] });
  for (const m of code.matchAll(EXECUTE_RAW)) findings.push({ file, line: lineAt(code, m.index), what: m[0] });
  for (const s of strings) if (SQL_WRITE.test(s.body)) findings.push({ file, line: lineAt(code, s.start), what: "raw SQL write" });
  return findings;
}

describe("detector self-test", () => {
  it.each([
    ["await db.submission.update({ where, data })"],
    ["tx.auditLog.create({ data })"],
    ["prisma.user.deleteMany()"],
    ['db["notification"].upsert({ where })'],
    ["db.problem.createManyAndReturn({ data })"],
    ["await db.$executeRaw`SELECT 1`"],
    ["await db.$executeRawUnsafe(sql)"],
    ['db.$queryRaw`UPDATE "User" SET "status" = ${s}`'],
    ['db.$queryRaw`INSERT INTO "public"."Notification" ("id") VALUES (${id})`'],
  ])("flags %s", (snippet) => {
    expect(renderWrites("x.ts", snippet)).toHaveLength(1);
  });

  it.each([
    ["db.submission.findMany({ where })"],
    ["tx.user.count()"],
    ['db.$queryRaw`SELECT "id" FROM "User"`'],
    ["// db.submission.update({ data })"],
    ['const label = "Update profile";'],
    ["router.update(state)"],
    ["form.delete(key)"],
  ])("ignores %s", (snippet) => {
    expect(renderWrites("x.ts", snippet)).toEqual([]);
  });

  it.each([
    ["apps/web/src/app/(student)/dashboard/page.tsx", true],
    ["apps/web/src/app/admin/layout.tsx", true],
    ["apps/web/src/app/super/users/loading.tsx", true],
    ["apps/web/src/server/queries/dashboard.ts", true],
    ["apps/web/src/components/admin/roster-table.tsx", true],
    ["apps/web/src/app/api/submissions/route.ts", false],
    ["apps/web/src/server/actions/admin-problems.ts", false],
    ["apps/web/src/lib/audit.ts", false],
  ])("isRenderPath(%s) is %s", (rel, expected) => {
    expect(isRenderPath(rel)).toBe(expected);
  });
});

describe("render paths are read-only", () => {
  const files = findFiles({ under: ["apps/web/src"], extensions: [".ts", ".tsx"], exclude: isTestPath }).filter(
    isRenderPath,
  );

  it("scans pages, layouts, queries and components (sanity)", () => {
    expect(files.some((f) => f.endsWith("/page.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("/layout.tsx"))).toBe(true);
    expect(files.some((f) => f.startsWith("apps/web/src/server/queries/"))).toBe(true);
    expect(files.some((f) => f.startsWith("apps/web/src/components/"))).toBe(true);
    expect(files.length).toBeGreaterThan(50);
  });

  it("contain no database write", () => {
    const found = files
      .flatMap((f) => renderWrites(f, readRepoFile(f)))
      .map((f) => `${f.file}:${f.line}  ${f.what}`);
    expect(found).toEqual([]);
  });
});
