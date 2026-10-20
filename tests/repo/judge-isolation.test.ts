import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODE_EXTENSIONS,
  abs,
  allDependencies,
  findFiles,
  isTestPath,
  lexSource,
  lineAt,
  moduleSpecifiers,
  readRepoFile,
  workspacePackages,
  type WorkspacePackage,
} from "./support/repo";

/**
 * The judge host is credential-free (docs/ARCHITECTURE.md): apps/judge-worker
 * holds no database URL and cannot reach Postgres, and student code never
 * runs in the web process. Lint enforces the same at the import level; this
 * test also follows workspace dependencies and checks env schemas.
 */

const WORKER_DIR = "apps/judge-worker";
const WORKER_CONFIG = `${WORKER_DIR}/src/config.ts`;

const DB_PACKAGES = new Set(["@recx/db", "@prisma/client", "prisma"]);
const isDbPackage = (name: string) => DB_PACKAGES.has(name) || name.startsWith("@prisma/");

/** A module specifier that would put a database client into the worker. */
function isDbSpecifier(spec: string): boolean {
  return (
    /^@recx\/db(?:\/|$)/.test(spec) ||
    /^@prisma\//.test(spec) ||
    /^prisma(?:\/|$)/.test(spec) ||
    /(?:^|\/)\.prisma(?:\/|$)/.test(spec) ||
    /(?:^|\/)packages\/db(?:\/|$)/.test(spec)
  );
}

/** Process-spawning modules. apps/web may import none of them. */
const SPAWN_MODULES = new Set(["child_process", "execa", "cross-spawn", "shelljs", "zx", "node-pty"]);
function isSpawnSpecifier(spec: string): boolean {
  const bare = spec.replace(/^node:/, "");
  const root = bare.startsWith("@") ? bare.split("/").slice(0, 2).join("/") : (bare.split("/")[0] ?? bare);
  return SPAWN_MODULES.has(root);
}

interface Hit {
  file: string;
  line: number;
  specifier: string;
}
const formatHit = (h: Hit) => `${h.file}:${h.line}  imports "${h.specifier}"`;

function importsMatching(files: string[], predicate: (spec: string) => boolean): Hit[] {
  return files.flatMap((file) =>
    moduleSpecifiers(readRepoFile(file))
      .filter((ref) => predicate(ref.specifier))
      .map((ref) => ({ file, line: ref.line, specifier: ref.specifier })),
  );
}

/**
 * The worker plus every workspace package it reaches through any dependency
 * kind, each with the path by which it was reached.
 */
function workerClosure(): Array<{ pkg: WorkspacePackage; via: string[] }> {
  const all = workspacePackages();
  const worker = [...all.values()].find((p) => p.dir === WORKER_DIR);
  if (!worker) throw new Error(`${WORKER_DIR}/package.json not found`);
  const seen = new Map<string, string[]>();
  const queue: Array<{ pkg: WorkspacePackage; via: string[] }> = [{ pkg: worker, via: [worker.name] }];
  while (queue.length > 0) {
    const { pkg, via } = queue.shift()!;
    if (seen.has(pkg.name)) continue;
    seen.set(pkg.name, via);
    for (const dep of allDependencies(pkg.json)) {
      const target = all.get(dep.name);
      // link-workspace-packages=true: a workspace name links locally whatever its specifier.
      if (target && !seen.has(target.name)) queue.push({ pkg: target, via: [...via, target.name] });
    }
  }
  return [...seen.entries()].map(([name, via]) => ({ pkg: all.get(name)!, via }));
}

/** The pnpm-lock.yaml importer block for one workspace directory. */
function lockfileImporter(dir: string): string | null {
  if (!existsSync(abs("pnpm-lock.yaml"))) return null;
  const lines = readRepoFile("pnpm-lock.yaml").split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${dir}:`);
  if (start === -1) return null;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

describe("judge isolation", () => {
  describe("self-test", () => {
    it("recognises database and spawn imports in every module form", () => {
      const src = [
        'import { db } from "@recx/db";',
        "import type { Prisma } from '@prisma/client';",
        'const p = await import(".prisma/client");',
        'const { PrismaClient } = require("@prisma/client");',
        'export * from "../../packages/db/src";',
        'import { spawn } from "node:child_process";',
        "const cp = require('child_process');",
        "const x = await import(`child_process`);",
        'import cp2 = require("child_process");',
        '// import { exec } from "child_process";',
        'import { z } from "zod";',
      ].join("\n");
      const specs = moduleSpecifiers(src);
      expect(specs.filter((r) => isDbSpecifier(r.specifier)).map((r) => r.line)).toEqual([1, 2, 3, 4, 5]);
      expect(specs.filter((r) => isSpawnSpecifier(r.specifier)).map((r) => r.line)).toEqual([6, 7, 8, 9]);
      expect(isDbSpecifier("@recx/shared")).toBe(false);
      expect(isSpawnSpecifier("@recx/shared")).toBe(false);
    });
  });

  it("apps/judge-worker/package.json declares no database package (any dependency kind)", () => {
    const worker = workspacePackages();
    const pkg = [...worker.values()].find((p) => p.dir === WORKER_DIR);
    expect(pkg, `${WORKER_DIR}/package.json`).toBeDefined();
    const offending = allDependencies(pkg!.json)
      .filter((d) => isDbPackage(d.name))
      .map((d) => `${d.kind}: ${d.name}@${d.spec}`);
    expect(offending).toEqual([]);
  });

  it("no workspace package the worker depends on (transitively) declares a database package", () => {
    const closure = workerClosure();
    expect(closure.map((c) => c.pkg.name)).toContain("@recx/shared");
    const offending = closure.flatMap(({ pkg, via }) =>
      allDependencies(pkg.json)
        .filter((d) => isDbPackage(d.name))
        .map((d) => `${via.join(" → ")} → ${d.name} (${d.kind})`),
    );
    expect(offending).toEqual([]);
  });

  it("pnpm-lock.yaml resolves no database package for the worker", () => {
    const block = lockfileImporter(WORKER_DIR);
    if (block === null) return; // no lockfile entry yet; the package.json checks still apply
    expect(block).not.toMatch(/^\s+'?(?:@recx\/db|@prisma\/[\w-]+|prisma)'?:\s*$/m);
  });

  it("no file under apps/judge-worker imports @recx/db, @prisma/client or .prisma", () => {
    const files = findFiles({ under: [WORKER_DIR], extensions: CODE_EXTENSIONS });
    expect(importsMatching(files, isDbSpecifier).map(formatHit)).toEqual([]);
  });

  it("no source of a workspace package the worker bundles imports the database", () => {
    const dirs = workerClosure()
      .map((c) => c.pkg.dir)
      .filter((d) => d !== WORKER_DIR);
    const files = findFiles({ under: dirs, extensions: CODE_EXTENSIONS, exclude: isTestPath });
    expect(importsMatching(files, isDbSpecifier).map(formatHit)).toEqual([]);
  });

  it("apps/judge-worker/src/config.ts has no DATABASE_URL and no DATABASE* env key", () => {
    expect(existsSync(abs(WORKER_CONFIG)), `${WORKER_CONFIG} (the worker's env schema) must exist`).toBe(true);
    const { code } = lexSource(readRepoFile(WORKER_CONFIG));
    const hits = code
      .split("\n")
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => /DATABASE/.test(text) || /database_?url/i.test(text))
      .map(({ text, line }) => `${WORKER_CONFIG}:${line}  ${text.trim()}`);
    expect(hits).toEqual([]);
  });

  it("no worker source reads a DATABASE* environment variable", () => {
    const files = findFiles({ under: [`${WORKER_DIR}/src`], extensions: CODE_EXTENSIONS, exclude: isTestPath });
    const pattern = /\bprocess\.env\s*(?:\.\s*DATABASE\w*|\[\s*["'`]DATABASE\w*["'`]\s*\])|\bDATABASE_URL\w*\b/g;
    const hits = files.flatMap((file) => {
      const { code } = lexSource(readRepoFile(file));
      return [...code.matchAll(pattern)].map((m) => `${file}:${lineAt(code, m.index)}  ${m[0]}`);
    });
    expect(hits).toEqual([]);
  });

  it("no env file in apps/judge-worker defines a DATABASE* key", () => {
    // Read key names only; values are never printed.
    const envFiles = [".env", ".env.local", ".env.example", ".env.production", ".env.development"]
      .map((name) => `${WORKER_DIR}/${name}`)
      .filter((rel) => existsSync(abs(rel)));
    const hits = envFiles.flatMap((rel) =>
      readRepoFile(rel)
        .split(/\r?\n/)
        .map((line, i) => ({ key: /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=/.exec(line)?.[1], line: i + 1 }))
        .filter((e): e is { key: string; line: number } => !!e.key && /DATABASE/i.test(e.key))
        .map((e) => `${rel}:${e.line}  ${e.key}`),
    );
    expect(hits).toEqual([]);
  });

  it("apps/web never imports child_process (src, scripts and root config files)", () => {
    const files = [
      ...findFiles({ under: ["apps/web/src", "apps/web/scripts"], extensions: CODE_EXTENSIONS }),
      ...findFiles({
        under: ["apps/web"],
        extensions: CODE_EXTENSIONS,
        exclude: (rel) => rel.slice("apps/web/".length).includes("/"),
      }),
    ];
    expect(files.length).toBeGreaterThan(0);
    expect(importsMatching(files, isSpawnSpecifier).map(formatHit)).toEqual([]);
  });
});
