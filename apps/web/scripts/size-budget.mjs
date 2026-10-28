// Front-end size budgets for REC Code (replaces the size-limit package — no
// new dependency). Reads a PRODUCTION build of apps/web (.next with a
// BUILD_ID) and checks it against size-budgets.json:
//
//   * per App Router route, the gzip size of the first-load JS: Next's
//     rootMainFiles (webpack runtime, React, the Next client) plus every
//     client chunk of the route's layout chain (layouts, templates, error /
//     loading / not-found boundaries, global-error) and of the page itself,
//     taken from .next/app-build-manifest.json;
//   * per Pages Router route (`page`), the scripts its SERVED HTML makes the
//     browser load: the build is served in-process (scripts/served-html.mjs)
//     and the page fetched signed out. A route marked `zeroJs` must ship no
//     JavaScript at all — no <script src>, no script preload, no
//     __NEXT_DATA__ (the inline theme script is the only script allowed) —
//     and its compiled page must export unstable_runtimeJS: false. The HTML
//     detector is self-checked on zeroJsSelfCheck.path, an App Router page
//     that must show its scripts;
//   * the first-party share of the chunks two or more budgeted routes load
//     (routes marked `shared: false` are left out of this measure);
//   * that each serverRendered page adds no client JS of its own: beyond
//     the framework and its layout chain, its chunks hold only Next's page
//     stub (one module named exactly "apps/web"), within maxOwnKb;
//   * the Monaco chunk (the main-thread /monaco/vs code a cold workspace
//     load fetches), the Monaco editor worker on its own line, and the lazy
//     CodeMirror set (react-loadable-manifest.json);
//   * that no Monaco module appears anywhere in the chunk graph — first-load
//     or lazy — of the routes listed under monacoFree. Module identities come
//     from .next/recx-client-chunks.json, written by the ClientChunkMapPlugin
//     in next.config.ts; the chunk text is also scanned for the loader's
//     markers in case a module is renamed.
//
// Usage (from apps/web, after `next build`):
//   node scripts/size-budget.mjs [--json out.json] [--markdown] [--verbose]
// Exit codes: 0 all within budget, 1 a budget breached, Monaco leaked, a
// zero-JS page shipped script or a server-rendered page shipped client code,
// 2 the build output is missing, unreadable or cannot be served (or a listed
// entry is not in it).
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { inspectServedPages } from "./served-html.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "..");
const repoRoot = resolve(webDir, "../..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name) => process.argv.includes(name);

// The build is served from .next (next.config.ts defaults distDir to it;
// RECX_DIST_DIR is for running a second dev server beside a production one).
const nextDir = resolve(webDir, ".next");
const budgets = JSON.parse(readFileSync(join(webDir, "size-budgets.json"), "utf8"));
const verbose = flag("--verbose");

function fail(message) {
  console.error(`[size] ${message}`);
  process.exit(2);
}

if (!existsSync(join(nextDir, "BUILD_ID"))) {
  fail("no production build in apps/web/.next (BUILD_ID missing) — run `next build` first.");
}
const readJson = (file) => JSON.parse(readFileSync(join(nextDir, file), "utf8"));
const buildManifest = readJson("build-manifest.json");
const appBuildManifest = readJson("app-build-manifest.json");
const pagesManifest = existsSync(join(nextDir, "server", "pages-manifest.json")) ? readJson("server/pages-manifest.json") : {};
const loadableManifest = existsSync(join(nextDir, "react-loadable-manifest.json"))
  ? readJson("react-loadable-manifest.json")
  : {};
if (!existsSync(join(nextDir, "recx-client-chunks.json"))) {
  fail("recx-client-chunks.json is missing — it is written by ClientChunkMapPlugin (next.config.ts) on every production build; rebuild.");
}
const chunkMap = readJson("recx-client-chunks.json").chunks;

// ── Sizes ────────────────────────────────────────────────────────────────
const KB = 1024;
const gzipCache = new Map();
function gzipBytes(absPath) {
  let size = gzipCache.get(absPath);
  if (size === undefined) {
    size = gzipSync(readFileSync(absPath), { level: 9 }).length;
    gzipCache.set(absPath, size);
  }
  return size;
}
const chunkGzip = (file) => gzipBytes(join(nextDir, file));
const kb = (bytes) => `${(bytes / KB).toFixed(1)} KB`;
const isJs = (file) => file.endsWith(".js");
const sum = (files) => [...files].reduce((total, file) => total + chunkGzip(file), 0);

// ── App Router first-load sets ───────────────────────────────────────────
const pages = appBuildManifest.pages;
const BOUNDARIES = ["layout", "template", "error", "loading", "not-found", "forbidden", "unauthorized"];

/** "/(student)/problems/[slug]/page" → the manifest entries rendered with it. */
function chainEntries(entry) {
  const segments = entry.split("/").filter(Boolean).slice(0, -1);
  const keys = ["/global-error"];
  for (let depth = 0; depth <= segments.length; depth++) {
    const prefix = depth === 0 ? "" : `/${segments.slice(0, depth).join("/")}`;
    for (const boundary of BOUNDARIES) keys.push(`${prefix}/${boundary}`);
  }
  keys.push(entry);
  return keys.filter((key) => pages[key]);
}

function firstLoad(entry) {
  if (!pages[entry]) throw new Error(`entry ${entry} is not in app-build-manifest.json`);
  const files = new Set(buildManifest.rootMainFiles.filter(isJs));
  for (const key of chainEntries(entry)) for (const file of pages[key]) if (isJs(file)) files.add(file);
  return files;
}

// ── Pages Router routes: what the served HTML loads ──────────────────────
const pagesRoutes = budgets.routes.filter((r) => r.page);
for (const { page } of pagesRoutes) {
  if (!pagesManifest[page]) fail(`page ${page} is not in server/pages-manifest.json — is src/pages${page}.tsx still there?`);
}
// The detector's self-check page is served too: it must show scripts.
const selfCheckPath = budgets.zeroJsSelfCheck?.path;
const servedPaths = [...pagesRoutes.map((r) => r.page), ...(selfCheckPath ? [selfCheckPath] : [])];
let served = {};
if (servedPaths.length > 0) {
  try {
    served = await inspectServedPages(servedPaths);
  } catch (error) {
    fail(`could not serve the production build to inspect ${servedPaths.join(", ")}: ${error instanceof Error ? error.message : error}`);
  }
}

/** Does the compiled server page export `config.unstable_runtimeJS = false`? */
function compiledWithoutRuntimeJs(page) {
  const compiled = readFileSync(join(nextDir, "server", pagesManifest[page]), "utf8");
  return /unstable_runtimeJS\s*:\s*(?:!1|false)\b/.test(compiled);
}

/** A served script URL → its file under .next (only this build's /_next/static files exist). */
function staticFile(src) {
  const path = new URL(src, "http://localhost").pathname;
  if (!path.startsWith("/_next/static/")) return null;
  const file = join("static", decodeURIComponent(path.slice("/_next/static/".length)));
  return existsSync(join(nextDir, file)) ? file.split(sep).join("/") : null;
}

// ── Module identities ────────────────────────────────────────────────────
const isThirdParty = (name) => name.startsWith("node_modules/") || name.includes("/node_modules/");
const MONACO_MODULE = /(^|\/)node_modules\/monaco-editor\/|apps\/web\/src\/components\/editor\/monaco-[a-z-]+\.ts$/;
// The loader's own strings survive minification; the package's AMD/ESM builds carry these too.
const MONACO_TEXT = ["/monaco/vs", "vs/editor/editor.main", "MonacoEnvironment"];

/** Lazy chunks reachable from the modules in `files` (react-loadable-manifest), transitively. */
function withLazy(files) {
  const all = new Set(files);
  const importers = Object.entries(loadableManifest).map(([key, value]) => {
    const [from] = key.split(" -> ");
    const abs = resolve(webDir, "src", from ?? "");
    const name = relative(repoRoot, abs).split(sep).join("/");
    const nm = name.lastIndexOf("node_modules/");
    return { from: nm >= 0 ? name.slice(nm) : name, files: value.files ?? [] };
  });
  let grew = true;
  while (grew) {
    grew = false;
    const present = new Set();
    for (const file of all) for (const [name] of chunkMap[file] ?? []) present.add(name);
    for (const lazy of importers) {
      if (!present.has(lazy.from)) continue;
      for (const file of lazy.files) {
        if (isJs(file) && !all.has(file)) {
          all.add(file);
          grew = true;
        }
      }
    }
  }
  return all;
}

function monacoHits(files) {
  const hits = [];
  for (const file of files) {
    for (const [name] of chunkMap[file] ?? []) if (MONACO_MODULE.test(name)) hits.push(`${file}: ${name}`);
    const text = readFileSync(join(nextDir, file), "utf8");
    for (const marker of MONACO_TEXT) if (text.includes(marker)) hits.push(`${file}: contains "${marker}"`);
  }
  return [...new Set(hits)];
}

// ── Checks ───────────────────────────────────────────────────────────────
const rows = [];
let breached = false;
function row(name, bytes, maxKb, note = "") {
  const ok = maxKb === null || bytes <= maxKb * KB;
  if (!ok) breached = true;
  rows.push({ name, bytes, maxKb, ok, note });
}

const zeroJsFailures = [];
const framework = new Set(buildManifest.rootMainFiles.filter(isJs));
const routeSets = new Map();
for (const { route, entry, page, zeroJs, maxKb, shared } of budgets.routes) {
  if (page) {
    const html = served[page];
    const loaded = [...html.external, ...html.preloads];
    const files = new Set(loaded.map(staticFile).filter((file) => file !== null && isJs(file)));
    const unknown = loaded.filter((src) => staticFile(src) === null);
    if (shared !== false) routeSets.set(route, files);
    if (zeroJs) {
      const problems = [];
      if (html.external.length > 0) problems.push(`${html.external.length} <script src>: ${html.external.join(", ")}`);
      if (html.preloads.length > 0) problems.push(`${html.preloads.length} script preload(s): ${html.preloads.join(", ")}`);
      if (html.nextData) problems.push("__NEXT_DATA__ bootstrap present");
      if (!compiledWithoutRuntimeJs(page)) problems.push("the compiled page does not export config.unstable_runtimeJS = false");
      if (problems.length > 0) zeroJsFailures.push({ route, problems });
    }
    if (unknown.length > 0) zeroJsFailures.push({ route, problems: [`scripts outside this build's /_next/static: ${unknown.join(", ")}`] });
    row(
      route,
      sum(files),
      maxKb,
      `Pages Router, served HTML: ${html.external.length} <script src>, ${html.preloads.length} script preloads, ` +
        `${html.inline} inline script${html.inline === 1 ? "" : "s"}${zeroJs ? "; zero-JS page" : ""}`,
    );
    if (verbose) {
      console.log(`\n${route} (served ${page})`);
      for (const file of files) console.log(`  ${kb(chunkGzip(file)).padStart(9)}  ${file}`);
    }
    continue;
  }
  const files = firstLoad(entry);
  if (shared !== false) routeSets.set(route, files);
  const own = [...files].filter((file) => !framework.has(file));
  row(route, sum(files), maxKb, `framework ${kb(sum(framework))} + app ${kb(sum(own))}`);
  if (verbose) {
    console.log(`\n${route} (${entry})`);
    for (const file of files) console.log(`  ${kb(chunkGzip(file)).padStart(9)}  ${file}`);
  }
}

if (selfCheckPath && budgets.routes.some((r) => r.zeroJs) && served[selfCheckPath].external.length === 0) {
  zeroJsFailures.push({
    route: `${selfCheckPath} (self-check)`,
    problems: ["the HTML detector found no <script src> on an App Router page — scripts/served-html.mjs has gone blind"],
  });
}

// Shared first-party: the first-party share of every chunk that two or more
// budgeted routes load (the design system, the shells, shared libraries).
const sets = [...routeSets.values()];
const shared = [...new Set(sets.flatMap((set) => [...set]))].filter(
  (file) => sets.filter((set) => set.has(file)).length >= 2,
);
let sharedFirstParty = 0;
for (const file of shared) {
  const modules = chunkMap[file] ?? [];
  const total = modules.reduce((t, [, size]) => t + size, 0);
  const own = modules.reduce((t, [name, size]) => t + (isThirdParty(name) ? 0 : size), 0);
  if (total > 0) sharedFirstParty += Math.round((chunkGzip(file) * own) / total);
}
row(
  "Shared first-party",
  sharedFirstParty,
  budgets.sharedFirstParty.maxKb,
  `of ${kb(sum(shared))} in chunks loaded by 2+ budgeted routes`,
);

// Server-rendered pages: nothing of their own beyond Next's page stub. "Own"
// = the page's chunks minus the framework and every chunk its layout chain
// already loads (a chunk shared with a layout, e.g. next/link, is not the
// page's). The stub is one module named exactly "apps/web".
const serverRenderedFailures = [];
const serverRenderedOwn = {};
const serverRenderedMaxKb = budgets.serverRendered?.maxOwnKb ?? 1;
for (const entry of budgets.serverRendered?.entries ?? []) {
  if (!pages[entry]) fail(`serverRendered entry ${entry} is not in app-build-manifest.json`);
  const chain = new Set();
  for (const key of chainEntries(entry)) if (key !== entry) for (const file of pages[key]) chain.add(file);
  const own = pages[entry].filter((file) => isJs(file) && !framework.has(file) && !chain.has(file));
  const problems = [];
  for (const file of own) {
    const modules = chunkMap[file];
    if (!modules) {
      problems.push(`${file}: not in recx-client-chunks.json`);
      continue;
    }
    for (const [name] of modules) if (name !== "apps/web") problems.push(`${file}: ${name}`);
  }
  const bytes = sum(own);
  if (bytes > serverRenderedMaxKb * KB) problems.push(`own client JS ${kb(bytes)} > ${serverRenderedMaxKb} KB`);
  serverRenderedOwn[entry] = { files: own, bytes };
  if (problems.length > 0) serverRenderedFailures.push({ entry, problems });
  if (verbose) {
    console.log(`\n${entry} (server-rendered: own chunks)`);
    for (const file of own) console.log(`  ${kb(chunkGzip(file)).padStart(9)}  ${file}`);
  }
}

// Monaco (self-hosted AMD build): the main-thread chunk, then the worker.
const monacoDir = join(webDir, budgets.monaco.dir);
if (!existsSync(join(monacoDir, "loader.js"))) fail(`${budgets.monaco.dir} is missing — scripts/copy-monaco.mjs runs before next build.`);
let monacoBytes = 0;
const monacoParts = [];
for (const file of budgets.monaco.files) {
  const size = gzipBytes(join(monacoDir, file));
  monacoBytes += size;
  monacoParts.push(`${file.split("/").pop()} ${kb(size)}`);
}
if (budgets.monaco.largestOf) {
  const base = join(monacoDir, budgets.monaco.largestOf);
  let largest = { name: "", size: 0 };
  for (const lang of readdirSync(base)) {
    const dir = join(base, lang);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      const size = gzipBytes(join(dir, file));
      if (size > largest.size) largest = { name: file, size };
    }
  }
  monacoBytes += largest.size;
  monacoParts.push(`largest grammar ${largest.name} ${kb(largest.size)}`);
}
row("Monaco chunk (lazy, /monaco/vs)", monacoBytes, budgets.monaco.maxKb, monacoParts.join(" + "));
const workerFile = budgets.monacoWorker.file;
if (!existsSync(join(monacoDir, workerFile))) fail(`${budgets.monaco.dir}/${workerFile} is missing — the editor worker Monaco is told to load (monaco-loader.ts).`);
row("Monaco editor worker (lazy)", gzipBytes(join(monacoDir, workerFile)), budgets.monacoWorker.maxKb, workerFile);
for (const file of budgets.monaco.report ?? []) {
  row(`  + ${file.split("/").pop()} (not budgeted)`, gzipBytes(join(monacoDir, file)), null);
}

// CodeMirror (phone editor).
const cmKey = Object.keys(loadableManifest).find((key) => key.endsWith(` -> ${budgets.codemirror.dynamicImport}`));
if (!cmKey) fail(`no dynamic import of ${budgets.codemirror.dynamicImport} in react-loadable-manifest.json`);
const cmBase = new Set(loadableManifest[cmKey].files.filter(isJs));
const grammarPrefix = budgets.codemirror.grammarsFrom.split("/").join("\\");
let cmGrammar = { name: "none", files: new Set(), extra: 0 };
for (const [key, value] of Object.entries(loadableManifest)) {
  const [from, target] = key.split(" -> ");
  if (from?.split("/").join("\\") !== grammarPrefix) continue;
  const files = new Set(value.files.filter((file) => isJs(file) && !cmBase.has(file)));
  const extra = sum(files);
  if (extra > cmGrammar.extra) cmGrammar = { name: target ?? key, files, extra };
}
row(
  "CodeMirror lazy set (< 768 px)",
  sum(cmBase) + cmGrammar.extra,
  budgets.codemirror.maxKb,
  `core ${kb(sum(cmBase))} + largest grammar ${cmGrammar.name} ${kb(cmGrammar.extra)}`,
);

// Monaco must not reach the listed routes (first-load or lazy).
const monacoFree = [
  ...budgets.monacoFree.entries,
  ...Object.keys(pages).filter(
    (key) => key.endsWith("/page") && budgets.monacoFree.entryPrefixes.some((prefix) => key.startsWith(prefix)),
  ),
];
const leaks = [];
for (const entry of new Set(monacoFree)) {
  const hits = monacoHits(withLazy(firstLoad(entry)));
  if (hits.length > 0) leaks.push({ entry, hits });
}
// The workspace shell must load Monaco lazily, never on first load — and its
// lazy graph MUST show Monaco, or the detector above has gone blind.
const shellEntry = budgets.routes.find((r) => r.entry?.includes("[slug]"))?.entry;
if (shellEntry) {
  const eager = monacoHits(firstLoad(shellEntry));
  if (eager.length > 0) leaks.push({ entry: `${shellEntry} (first load)`, hits: eager });
  if (monacoHits(withLazy(firstLoad(shellEntry))).length === 0) {
    leaks.push({
      entry: `${shellEntry} (self-check)`,
      hits: ["the detector found no Monaco module in the workspace's lazy chunks — update MONACO_MODULE / MONACO_TEXT"],
    });
  }
}

// ── Report ───────────────────────────────────────────────────────────────
const markdown = flag("--markdown");
const lines = [];
if (markdown) {
  lines.push("| Budget | Gzip | Limit | Status | Breakdown |", "|---|---|---|---|---|");
  for (const r of rows) {
    const status = r.maxKb === null ? "—" : r.ok ? "pass" : `**over by ${kb(r.bytes - r.maxKb * KB)}**`;
    lines.push(`| ${r.name.trim()} | ${kb(r.bytes)} | ${r.maxKb === null ? "—" : `${r.maxKb} KB`} | ${status} | ${r.note} |`);
  }
} else {
  const width = Math.max(...rows.map((r) => r.name.length));
  lines.push(`${"Budget".padEnd(width)}  ${"gzip".padStart(10)}  ${"limit".padStart(9)}  status`);
  lines.push("-".repeat(width + 40));
  for (const r of rows) {
    const status = r.maxKb === null ? "" : r.ok ? "ok" : `OVER by ${kb(r.bytes - r.maxKb * KB)}`;
    const limit = r.maxKb === null ? "" : `${r.maxKb} KB`;
    lines.push(`${r.name.padEnd(width)}  ${kb(r.bytes).padStart(10)}  ${limit.padStart(9)}  ${status}${r.note ? `   (${r.note})` : ""}`);
  }
}
console.log(lines.join("\n"));
const zeroJsRoutes = budgets.routes.filter((r) => r.zeroJs).map((r) => r.route);
if (zeroJsRoutes.length > 0) {
  console.log(
    zeroJsFailures.length === 0
      ? `\nZero-JS: ok — ${zeroJsRoutes.join(", ")} served from this build with no <script src>, no script preload and no __NEXT_DATA__` +
          (selfCheckPath ? `; the detector sees ${served[selfCheckPath].external.length} <script src> on ${selfCheckPath} (self-check).` : ".")
      : `\nZero-JS: FAIL\n${zeroJsFailures.map((f) => `  ${f.route}\n${f.problems.map((p) => `    ${p}`).join("\n")}`).join("\n")}`,
  );
}
console.log(
  leaks.length === 0
    ? `\nMonaco-free: ok — ${new Set(monacoFree).size} routes checked (first-load + lazy chunks); the workspace shell loads Monaco lazily, and the detector sees it there (self-check).`
    : `\nMonaco-free: FAIL\n${leaks.map((l) => `  ${l.entry}\n${l.hits.map((h) => `    ${h}`).join("\n")}`).join("\n")}`,
);
const serverRenderedEntries = Object.keys(serverRenderedOwn);
if (serverRenderedEntries.length > 0) {
  console.log(
    serverRenderedFailures.length === 0
      ? `\nServer-rendered: ok — ${serverRenderedEntries
          .map((entry) => `${entry} adds ${kb(serverRenderedOwn[entry].bytes)} (page stub only)`)
          .join(", ")}.`
      : `\nServer-rendered: FAIL\n${serverRenderedFailures.map((f) => `  ${f.entry}\n${f.problems.map((p) => `    ${p}`).join("\n")}`).join("\n")}`,
  );
}

const jsonOut = arg("--json");
if (jsonOut) {
  writeFileSync(
    resolve(process.cwd(), jsonOut),
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        rows,
        zeroJs: Object.fromEntries(
          pagesRoutes.map((r) => {
            const { html: _html, ...inventory } = served[r.page];
            return [r.route, inventory];
          }),
        ),
        zeroJsFailures,
        monacoLeaks: leaks,
        monacoFreeRoutes: [...new Set(monacoFree)],
        serverRendered: serverRenderedOwn,
        serverRenderedFailures,
      },
      null,
      2,
    ),
  );
}

if (breached || leaks.length > 0 || zeroJsFailures.length > 0 || serverRenderedFailures.length > 0) {
  console.error(
    `\n[size] FAIL: ${rows.filter((r) => !r.ok).length} budget(s) breached, ${leaks.length} Monaco leak(s), ` +
      `${zeroJsFailures.length} zero-JS failure(s), ${serverRenderedFailures.length} server-rendered failure(s).`,
  );
  process.exit(1);
}
console.log("\n[size] all budgets met.");
// The in-process server (and any database client it opened) must not keep the process alive.
process.exit(0);
