import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { abs, readRepoFile, toPosix } from "./support/repo";

/**
 * The seed's authored content (apps/web/scripts/content) is pure data plus
 * deterministic generators. The judge worker's golden suite
 * (apps/judge-worker/test/integration/golden.isolate.test.ts) imports it by
 * relative path, and the worker must never reach the database, the web app
 * or any secret. So the import closure of scripts/content/index.ts may reach
 * ONLY @recx/shared (and its subpaths) and other files inside
 * scripts/content — no @recx/db, no "@/…" web modules, no node: built-ins,
 * no environment.
 */

const CONTENT_DIR = "apps/web/scripts/content/";
const ENTRY = `${CONTENT_DIR}index.ts`;

/** Every module specifier a TypeScript source imports or re-exports (static, dynamic, require). */
export function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) found.push(m[1]!);
  return found;
}

function resolveRelative(fromRel: string, specifier: string): string | null {
  const base = path.posix.join(path.posix.dirname(fromRel), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
    if (candidate.endsWith(".ts") && existsSync(abs(candidate))) return toPosix(candidate);
  }
  return null;
}

const isSharedPackage = (specifier: string) => specifier === "@recx/shared" || specifier.startsWith("@recx/shared/");

/** Walk the closure from the entry; return every file reached and every problem found. */
function closure(entry: string): { files: string[]; problems: string[] } {
  const seen = new Set<string>();
  const problems: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readRepoFile(file);
    if (/\bprocess\.env\b/.test(source)) problems.push(`${file}: reads process.env`);
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const target = resolveRelative(file, specifier);
        if (!target) problems.push(`${file}: cannot resolve ${specifier}`);
        else if (!target.startsWith(CONTENT_DIR)) problems.push(`${file}: imports ${target}, outside scripts/content`);
        else queue.push(target);
      } else if (!isSharedPackage(specifier)) {
        problems.push(`${file}: imports ${specifier} (only @recx/shared is allowed)`);
      }
    }
  }
  return { files: [...seen].sort(), problems };
}

describe("seed content purity", () => {
  const { files, problems } = closure(ENTRY);

  it("reaches the authored problem modules", () => {
    expect(files).toContain(ENTRY);
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.every((f) => f.startsWith(CONTENT_DIR))).toBe(true);
  });

  it("imports only @recx/shared and other content files, and reads no environment", () => {
    expect(problems).toEqual([]);
  });

  it("is what the golden suite imports", () => {
    const golden = readRepoFile("apps/judge-worker/test/integration/golden.isolate.test.ts");
    expect(importSpecifiers(golden)).toContain("../../../web/scripts/content/index");
  });
});

describe("importSpecifiers (detector self-test)", () => {
  it("finds static, type-only, re-export, dynamic and require imports, and ignores comments", () => {
    const source = [
      'import { a } from "@recx/shared";',
      'import type { B } from "./types";',
      'export { c } from "@recx/db";',
      'export * from "./x";',
      'import "node:fs";',
      'const m = await import("@/lib/db");',
      'const r = require("child_process");',
      '// import { z } from "zod";',
      '/* import { y } from "y"; */',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["@recx/shared", "./types", "@recx/db", "./x", "node:fs", "@/lib/db", "child_process"]);
  });

  it("flags a forbidden import in a closure", () => {
    expect(isSharedPackage("@recx/shared/harness")).toBe(true);
    expect(isSharedPackage("@recx/sharedx")).toBe(false);
    expect(isSharedPackage("@recx/db")).toBe(false);
  });
});
