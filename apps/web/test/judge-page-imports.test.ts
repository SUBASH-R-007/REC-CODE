import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * /judge ships no client JavaScript of its own: nothing it imports — its own
 * modules, transitively, and the design-system components it uses — is a
 * "use client" module. (The production-build check is size-budget.mjs,
 * "serverRendered".) Type-only imports are erased and not followed.
 */

const SRC = path.resolve(__dirname, "../src");
const DESIGN_SRC = path.resolve(__dirname, "../../../packages/design/src");
const PAGE = path.join(SRC, "app/(public)/judge/page.tsx");

const IMPORT = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm;

function resolveLocal(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const file = base + suffix;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  throw new Error(`cannot resolve ${spec} from ${path.relative(SRC, from)}`);
}

const isClient = (file: string) => /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(readFileSync(file, "utf8"));

/** @recx/design export name → its source file (from the barrel). */
function designExports(): Map<string, string> {
  const barrel = readFileSync(path.join(DESIGN_SRC, "index.ts"), "utf8");
  const map = new Map<string, string>();
  for (const m of barrel.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const file = resolveLocal(path.join(DESIGN_SRC, "index.ts"), m[2] as string);
    for (const name of (m[1] as string).split(",").map((n) => n.trim().replace(/^type\s+/, ""))) {
      if (name && file) map.set(name, file);
    }
  }
  return map;
}

function walk(): { files: string[]; design: Map<string, string> } {
  const seen = new Set<string>();
  const design = new Map<string, string>();
  const exportsOf = designExports();
  const queue = [PAGE];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const [, , typeOnly, clause, spec] = m as unknown as [string, string, string | undefined, string, string];
      if (typeOnly) continue;
      if (spec === "@recx/design") {
        const names = (clause.match(/\{([^}]*)\}/)?.[1] ?? "").split(",").map((n) => n.trim());
        for (const name of names) {
          if (!name || name.startsWith("type ")) continue;
          const source = exportsOf.get(name);
          if (!source) throw new Error(`@recx/design has no export ${name}`);
          design.set(name, source);
        }
        continue;
      }
      const target = resolveLocal(file, spec);
      if (target) queue.push(target);
    }
  }
  return { files: [...seen], design };
}

describe("/judge imports no client module", () => {
  const { files, design } = walk();

  it("walks the page's own module graph (sanity)", () => {
    const rel = files.map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(rel).toEqual(
      expect.arrayContaining([
        "app/(public)/judge/page.tsx",
        "lib/judge/transparency.ts",
        "lib/judge/judge-links.ts",
        "server/queries/judge-languages.ts",
      ]),
    );
    expect(design.size).toBeGreaterThan(0);
  });

  it("no first-party module it imports is 'use client'", () => {
    const client = files.filter(isClient).map((f) => path.relative(SRC, f));
    expect(client).toEqual([]);
  });

  it("every design-system component it uses is a server component", () => {
    const client = [...design].filter(([, file]) => isClient(file)).map(([name]) => name);
    expect(client).toEqual([]);
  });

  it("the detector sees a client module (self-check)", () => {
    expect(isClient(path.join(SRC, "components/theme/theme-toggle.tsx"))).toBe(true);
    expect(isClient(path.join(DESIGN_SRC, "components/toast.tsx"))).toBe(true);
  });
});
