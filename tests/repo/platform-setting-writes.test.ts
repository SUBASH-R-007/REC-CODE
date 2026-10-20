import { describe, expect, it } from "vitest";
import { findFiles, isTestPath, lexSource, lineAt, readRepoFile } from "./support/repo";

/**
 * PlatformSetting and PlatformTheme writes are SUPER_ADMIN-only capability
 * "settings.write" (lib/auth/capabilities.ts). In apps/web/src they may
 * appear only in the four audited super-admin action files; anywhere else
 * a write would bypass the guard and the audit. (The seed and other
 * scripts are not request paths and are not scanned.)
 */

const ALLOWED = new Set([
  "apps/web/src/server/actions/xp-settings.ts",
  "apps/web/src/server/actions/super-settings.ts",
  "apps/web/src/server/actions/super-flags.ts",
  "apps/web/src/server/actions/super-branding.ts",
]);

const MODEL_WRITE =
  /\b(?:platformSetting|platformTheme)\b["'`]?\]?\s*\??\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/g;
const SQL_WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:"?public"?\.)?"?Platform(?:Setting|Theme)"?/i;

interface Finding {
  file: string;
  line: number;
  what: string;
}

export function settingWrites(file: string, source: string): Finding[] {
  const { code, strings } = lexSource(source);
  const findings: Finding[] = [];
  for (const m of code.matchAll(MODEL_WRITE)) findings.push({ file, line: lineAt(code, m.index), what: m[0] });
  for (const s of strings) if (SQL_WRITE.test(s.body)) findings.push({ file, line: lineAt(code, s.start), what: "raw SQL write" });
  return findings;
}

describe("detector self-test", () => {
  it.each([
    ["db.platformSetting.upsert({ where })"],
    ["await tx.platformTheme.update({ data })"],
    ['db["platformSetting"].deleteMany()'],
    ['tx.$executeRaw`UPDATE "PlatformSetting" SET value = ${v}`'],
  ])("flags %s", (snippet) => {
    expect(settingWrites("x.ts", snippet)).toHaveLength(1);
  });

  it.each([["db.platformSetting.findUnique({ where })"], ["// db.platformSetting.upsert()"], ["const platformSetting = 1"]])(
    "ignores %s",
    (snippet) => {
      expect(settingWrites("x.ts", snippet)).toEqual([]);
    },
  );
});

describe("PlatformSetting / PlatformTheme writes", () => {
  const files = findFiles({ under: ["apps/web/src"], extensions: [".ts", ".tsx"], exclude: isTestPath });

  it("scans the web app (sanity)", () => {
    expect(files.length).toBeGreaterThan(50);
    for (const allowed of ALLOWED) expect(files).toContain(allowed);
  });

  it("happen only in the four super-admin settings actions", () => {
    const outside = files
      .filter((f) => !ALLOWED.has(f))
      .flatMap((f) => settingWrites(f, readRepoFile(f)))
      .map((f) => `${f.file}:${f.line}  ${f.what}`);
    expect(outside).toEqual([]);
  });

  it("each allowed file really writes (the allow-list stays honest)", () => {
    for (const f of ALLOWED) expect(settingWrites(f, readRepoFile(f)).length, f).toBeGreaterThan(0);
  });
});
