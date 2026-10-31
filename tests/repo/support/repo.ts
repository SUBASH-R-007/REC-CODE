import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Helpers shared by the repository-wide structural tests (tests/repo/*.test.ts).
 * Everything here is read-only: the tests inspect the checkout, never change it.
 */

/** Absolute path of the repository root (this file is tests/repo/support/repo.ts). */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** Directory names skipped wherever they appear: dependencies and build output. */
const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".next",
  ".git",
  ".turbo",
  "dist",
  "coverage",
  "playwright-report",
  "test-results",
]);

/** Repo-relative prefixes skipped entirely: vendored assets and local storage. */
const SKIP_PREFIXES = ["apps/web/public/", "storage/", "out/"];

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function abs(rel: string): string {
  return path.join(REPO_ROOT, ...rel.split("/"));
}

export function readRepoFile(rel: string): string {
  return readFileSync(abs(rel), "utf8");
}

function isSkipped(rel: string): boolean {
  if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) return true;
  return rel.split("/").some((seg) => SKIP_DIR_NAMES.has(seg));
}

function gitListing(): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter((p) => p.length > 0);
  } catch {
    return null;
  }
}

function walk(dirRel: string, out: string[]) {
  const dirAbs = dirRel ? abs(dirRel) : REPO_ROOT;
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) || isSkipped(`${rel}/`)) continue;
      walk(rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

let cachedListing: string[] | null = null;

/**
 * Every file that belongs to the repository: tracked plus untracked-but-not-
 * ignored (so a file another contributor has just written is included before
 * its first commit). Falls back to a directory walk when git is unavailable.
 * Dependencies, build output, apps/web/public and local storage are skipped
 * either way.
 */
export function repoFiles(): string[] {
  if (!cachedListing) {
    let files = gitListing();
    if (!files) {
      files = [];
      walk("", files);
    }
    cachedListing = files
      .map(toPosix)
      .filter((rel) => !isSkipped(rel))
      .filter((rel) => {
        try {
          return statSync(abs(rel)).isFile();
        } catch {
          return false; // deleted from the working tree but still in the index
        }
      })
      .sort();
  }
  return cachedListing;
}

export interface FileQuery {
  /** Repo-relative directory prefixes to include (default: whole repo). */
  under?: string[];
  /** File extensions to include, with the dot. */
  extensions: readonly string[];
  /** Extra exclusion predicate on the repo-relative path. */
  exclude?: (rel: string) => boolean;
}

export function findFiles(query: FileQuery): string[] {
  const prefixes = query.under?.map((p) => (p.endsWith("/") ? p : `${p}/`));
  return repoFiles().filter((rel) => {
    if (prefixes && !prefixes.some((p) => rel.startsWith(p))) return false;
    if (!query.extensions.some((ext) => rel.endsWith(ext))) return false;
    return !query.exclude?.(rel);
  });
}

/** Test files and test-only directories. */
export function isTestPath(rel: string): boolean {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return true;
  return rel.split("/").some((seg) => seg === "test" || seg === "tests" || seg === "__tests__");
}

export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: REPO_ROOT, stdio: "ignore" });
    return existsSync(REPO_ROOT);
  } catch {
    return false;
  }
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// ── A small JS/TS lexer: comments out, strings kept ──────────────────────

export interface StringSpan {
  /** Offset of the opening quote. */
  start: number;
  /** Offset just past the closing quote. */
  end: number;
  /** Raw text between the quotes (templates include their ${…} parts). */
  body: string;
}

export interface LexedSource {
  /**
   * The source with every comment replaced by spaces (newlines kept), so
   * offsets and line numbers match the original file exactly.
   */
  code: string;
  /** String and template literals, in source order. */
  strings: StringSpan[];
}

const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/**
 * Strip comments from JS/TS/JSX source while keeping string literals intact.
 * Good enough for structural scanning (not a parser): quote and regex modes
 * end at a newline, so a misread apostrophe in JSX text cannot swallow more
 * than the rest of its line.
 */
export function lexSource(src: string): LexedSource {
  const out: string[] = new Array<string>(src.length);
  const strings: StringSpan[] = [];
  const n = src.length;
  let i = 0;
  let lastSig = "";
  let lastWordTail = "";
  // Brace depth at which each open template's ${ … } interpolation started.
  const templateStack: { start: number; depth: number }[] = [];
  let braceDepth = 0;

  const keep = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = src[k]!;
  };
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) out[k] = src[k] === "\n" || src[k] === "\r" ? src[k]! : " ";
  };

  // Scan a template literal body starting just after a backtick (or just
  // after the closing } of an interpolation). Returns the index after the
  // closing backtick, or the index just after "${" when an interpolation
  // opens (pushing the template onto the stack).
  const scanTemplate = (from: number, start: number): number => {
    let k = from;
    while (k < n) {
      const c = src[k]!;
      if (c === "\\") {
        k += 2;
        continue;
      }
      if (c === "`") {
        keep(from, k + 1);
        strings.push({ start, end: k + 1, body: src.slice(start + 1, k) });
        lastSig = "`";
        return k + 1;
      }
      if (c === "$" && src[k + 1] === "{") {
        keep(from, k + 2);
        templateStack.push({ start, depth: braceDepth });
        braceDepth++;
        lastSig = "{";
        return k + 2;
      }
      k++;
    }
    keep(from, n);
    return n;
  };

  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      let k = i;
      while (k < n && src[k] !== "\n") k++;
      blank(i, k);
      i = k;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = src.indexOf("*/", i + 2);
      const k = close === -1 ? n : close + 2;
      blank(i, k);
      i = k;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      const end = Math.min(n, src[k] === c ? k + 1 : k);
      keep(i, end);
      strings.push({ start: i, end, body: src.slice(i + 1, src[k] === c ? k : end) });
      lastSig = c;
      i = end;
      continue;
    }
    if (c === "`") {
      i = scanTemplate(i + 1, i);
      continue;
    }
    if (c === "{") {
      braceDepth++;
    } else if (c === "}") {
      braceDepth--;
      const top = templateStack[templateStack.length - 1];
      if (top && top.depth === braceDepth) {
        // End of a ${ … } interpolation: resume the enclosing template.
        templateStack.pop();
        out[i] = c;
        i = scanTemplate(i + 1, top.start);
        continue;
      }
    }
    if (c === "/") {
      const isRegex = lastSig === "" || REGEX_PRECEDERS.has(lastSig) || REGEX_KEYWORDS.test(lastWordTail);
      if (isRegex) {
        let k = i + 1;
        let inClass = false;
        while (k < n && src[k] !== "\n") {
          const ch = src[k]!;
          if (ch === "\\") {
            k += 2;
            continue;
          }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) break;
          k++;
        }
        k = Math.min(n, k + 1);
        while (k < n && /[a-z]/i.test(src[k]!)) k++;
        keep(i, k);
        lastSig = "/";
        lastWordTail = "";
        i = k;
        continue;
      }
    }
    out[i] = c;
    if (!/\s/.test(c)) {
      lastSig = /[\w$]/.test(c) ? "a" : c;
      lastWordTail = /[\w$]/.test(c) ? (lastWordTail + c).slice(-12) : "";
    }
    i++;
  }

  // Fill any holes (only possible if the source ended mid-escape).
  for (let k = 0; k < n; k++) if (out[k] === undefined) out[k] = src[k]!;
  return { code: out.join(""), strings };
}

// ── Module specifiers ─────────────────────────────────────────────────────

export interface ImportRef {
  specifier: string;
  line: number;
}

const IMPORT_PATTERNS = [
  // import x from "m"; import { a } from "m"; export * from "m"; export { a } from "m"
  /\b(?:import|export)\b[^;'"`]*?\bfrom\s*(["'`])([^"'`\n]+)\1/g,
  // import "m";
  /\bimport\s*(["'`])([^"'`\n]+)\1/g,
  // import("m"), require("m"), require.resolve("m"), import x = require("m")
  /\b(?:import|require(?:\s*\.\s*resolve)?)\s*\(\s*(["'`])([^"'`\n]+)\1\s*[,)]/g,
];

/** Every module specifier a JS/TS file references, comments ignored. */
export function moduleSpecifiers(source: string): ImportRef[] {
  const { code } = lexSource(source);
  const refs: ImportRef[] = [];
  const seen = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const m of code.matchAll(pattern)) {
      const specifier = m[2]!;
      const line = lineAt(code, m.index);
      const key = `${line}:${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ specifier, line });
    }
  }
  return refs.sort((a, b) => a.line - b.line);
}

// ── Workspace packages ─────────────────────────────────────────────────────

export interface WorkspacePackage {
  name: string;
  /** Repo-relative directory, e.g. "packages/shared". */
  dir: string;
  json: PackageJson;
}

export interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export const DEPENDENCY_KINDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export function readPackageJson(dirRel: string): PackageJson {
  return JSON.parse(readRepoFile(`${dirRel}/package.json`)) as PackageJson;
}

/** apps/* and packages/* (the globs in pnpm-workspace.yaml), keyed by name. */
export function workspacePackages(): Map<string, WorkspacePackage> {
  const map = new Map<string, WorkspacePackage>();
  for (const group of ["apps", "packages"]) {
    const groupAbs = abs(group);
    if (!existsSync(groupAbs)) continue;
    for (const entry of readdirSync(groupAbs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${group}/${entry.name}`;
      if (!existsSync(abs(`${dir}/package.json`))) continue;
      const json = readPackageJson(dir);
      if (json.name) map.set(json.name, { name: json.name, dir, json });
    }
  }
  return map;
}

export function allDependencies(json: PackageJson): Array<{ name: string; spec: string; kind: string }> {
  const deps: Array<{ name: string; spec: string; kind: string }> = [];
  for (const kind of DEPENDENCY_KINDS) {
    for (const [name, spec] of Object.entries(json[kind] ?? {})) deps.push({ name, spec, kind });
  }
  return deps;
}
