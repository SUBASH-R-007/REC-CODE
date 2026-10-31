// Serve a PRODUCTION build of apps/web in this process (Next's programmatic
// server on a free loopback port — no child process) and report, for each
// path fetched signed out, what its HTML makes a browser download and run:
//
//   * external scripts (<script src=…>) and script preloads
//     (<link rel="preload" as="script">, <link rel="modulepreload">);
//   * Next's bootstrap data (<script id="__NEXT_DATA__">);
//   * inline scripts without src (the theme script is expected there).
//
// scripts/size-budget.mjs uses it to measure Pages Router routes from what
// is really served — and to hold /login to zero JavaScript (src/pages/login.tsx,
// `unstable_runtimeJS: false`). `next dev` injects its HMR client into every
// page and is irrelevant here; only a production build is inspected. (Next
// prints its '"next start" does not work with "output: standalone"' warning
// for any programmatic server; the .next build it serves is the same one the
// standalone server.js would.)
//
// Standalone: node scripts/served-html.mjs /login [/other …]
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "..");

/** Every opening tag `<name …>` in `html` with its raw attribute text. */
function tags(html, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, "gi");
  for (let m = re.exec(html); m; m = re.exec(html)) out.push(m[1] ?? "");
  return out;
}

/** The value of attribute `name` in a raw attribute string (quoted or bare), or null. */
function attr(raw, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(raw);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}
const hasAttr = (raw, name) => new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, "i").test(raw);

/** What one HTML document makes the browser execute. */
export function scriptInventory(html) {
  const scripts = tags(html, "script");
  const external = scripts.map((raw) => attr(raw, "src")).filter((src) => src !== null);
  const inline = scripts.filter((raw) => !hasAttr(raw, "src")).length;
  const preloads = tags(html, "link")
    .filter((raw) => {
      const rel = (attr(raw, "rel") ?? "").toLowerCase().split(/\s+/);
      return rel.includes("modulepreload") || (rel.includes("preload") && (attr(raw, "as") ?? "").toLowerCase() === "script");
    })
    .map((raw) => attr(raw, "href") ?? "");
  const nextData = scripts.some((raw) => attr(raw, "id") === "__NEXT_DATA__");
  return { external, preloads, inline, nextData };
}

async function freePort() {
  const probe = createServer();
  await new Promise((done, failed) => {
    probe.once("error", failed);
    probe.listen(0, "127.0.0.1", done);
  });
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/**
 * Start the production build in .next, GET each path (no cookies, no
 * redirects followed), and return { path → { status, html, ...inventory } }.
 * Throws when the build cannot be served or a page does not answer 200.
 */
export async function inspectServedPages(paths, { dir = webDir, timeoutMs = 120_000 } = {}) {
  // Next reads NODE_ENV when it loads; a production build must be served as production.
  process.env.NODE_ENV = "production";
  process.env.NEXT_TELEMETRY_DISABLED ??= "1";
  const { default: next } = await import("next");
  const app = next({ dev: false, dir, hostname: "127.0.0.1" });
  await app.prepare();
  const handle = app.getRequestHandler();
  const port = await freePort();
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise((done, failed) => {
    server.once("error", failed);
    server.listen(port, "127.0.0.1", done);
  });

  const results = {};
  try {
    for (const path of paths) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "text/html" },
      });
      const html = await response.text();
      if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}, not 200`);
      results[path] = { status: response.status, html, ...scriptInventory(html) };
    }
  } finally {
    await new Promise((done) => server.close(done));
    await app.close?.();
  }
  return results;
}

// Standalone use.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: node scripts/served-html.mjs /path [/path …]");
    process.exit(2);
  }
  const results = await inspectServedPages(paths);
  for (const [path, r] of Object.entries(results)) {
    console.log(
      `${path}: ${r.external.length} <script src>, ${r.preloads.length} script preload(s), ` +
        `${r.inline} inline <script>, __NEXT_DATA__ ${r.nextData ? "present" : "absent"}`,
    );
    for (const src of [...r.external, ...r.preloads]) console.log(`  ${src}`);
  }
  process.exit(0);
}
