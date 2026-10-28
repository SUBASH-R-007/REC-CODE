#!/usr/bin/env node
/**
 * Run the PRODUCTION build of the web app on this laptop — the real bundle,
 * no dev server — for a demo or a look at the shipped thing.
 *
 *   npx pnpm@9.15.9 --filter @recx/web build
 *   node scripts/dev/start-prod.mjs
 *   node scripts/dev/start-prod.mjs --port 3100
 *
 * Why this exists rather than `pnpm --filter @recx/web start`: three things
 * stand between a development laptop and a production start, and each one
 * fails quietly.
 *
 * 1. `apps/web/next.config.ts` sets `output: "standalone"` (right for the
 *    Linux deployment, where the image carries its own server), so
 *    `next start` prints a warning about it.
 * 2. `lib/env.ts` REFUSES two things in production that a dev env file has:
 *    the development default for `EXPORT_SIGNING_SECRET`, and
 *    `JUDGE_ALLOW_UNHARDENED_NODES=true`. `env()` then throws for every
 *    caller — and the visible symptom is mild and misleading, because
 *    `/api/health` reports `"redis":"down"` about a Redis that answers a PING
 *    from the same laptop (`pingRedis()` catches, and every caller of `env()`
 *    is written to tolerate Redis being down). `/api/metrics` returns 500 and
 *    the log names the real reason.
 * 3. Next loads `apps/web/.env.local` itself at startup, so unsetting a
 *    variable here does not unset it. The only file that wins is
 *    `.env.production.local`, which `next dev` ignores.
 *
 * So this script loads the env files the way a production start does, checks
 * the two refusals BEFORE starting (naming the fix rather than leaving a 500
 * behind), and starts the server. It prints the KEY NAMES it supplied and
 * never a value: `docs/CONVENTIONS.md` keeps dev credentials in gitignored
 * files and out of every log.
 *
 * It is a convenience for this laptop. The deployment does not use it:
 * `deploy/compose.app.yml` passes each secret as a Docker secret and runs the
 * standalone server.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const WEB_DIR = path.join(REPO_ROOT, "apps", "web");

/**
 * Next's own precedence for a production start, most specific first. The
 * first file to define a key wins, and anything already in the environment
 * beats all of them — so `REDIS_URL=… node scripts/dev/start-prod.mjs` still
 * overrides.
 */
const PRODUCTION_OVERRIDE_FILE = ".env.production.local";
const ENV_FILES = [PRODUCTION_OVERRIDE_FILE, ".env.local", ".env.production", ".env"];

/**
 * Development-only variables `lib/env.ts` refuses in production.
 *
 * `JUDGE_ALLOW_UNHARDENED_NODES=true` is the one a dev laptop always has,
 * because a WSL2 judge node cannot pass the kernel hardening check and needs
 * the override to take jobs at all. Overriding it to false has a consequence
 * worth knowing BEFORE a demo: in production that same node is QUARANTINED
 * on its first heartbeat, so Run and Submit queue and sit there. Nothing is
 * judged. That rail is deliberate — judge on the dev server.
 */
const REFUSED_WHEN_TRUE = ["JUDGE_ALLOW_UNHARDENED_NODES"];

/** KEY=VALUE, with `export ` tolerated, quotes stripped, `#` comments dropped. */
function parseEnvFile(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      // An unquoted trailing comment is not part of the value.
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    if (!values.has(key)) values.set(key, value);
  }
  return values;
}

const argv = process.argv.slice(2);
const portIndex = argv.findIndex((arg) => arg === "--port" || arg === "-p");
const port = portIndex === -1 ? "3000" : (argv[portIndex + 1] ?? "3000");

if (!existsSync(path.join(WEB_DIR, ".next", "BUILD_ID"))) {
  console.error(
    "No production build found (apps/web/.next/BUILD_ID is missing).\n" +
      "Run `npx pnpm@9.15.9 --filter @recx/web build` first.\n" +
      "Note that `next dev` overwrites apps/web/.next, so a dev server since the last build means rebuilding.",
  );
  process.exit(1);
}

const supplied = [];
const environment = { ...process.env };
for (const file of ENV_FILES) {
  const full = path.join(WEB_DIR, file);
  if (!existsSync(full)) continue;
  for (const [key, value] of parseEnvFile(readFileSync(full, "utf8"))) {
    if (environment[key] !== undefined) continue;
    environment[key] = value;
    supplied.push(`${key} (${file})`);
  }
}

// Names only. Never a value.
console.log(
  supplied.length > 0
    ? `[start-prod] supplied ${supplied.length} variables: ${supplied.join(", ")}`
    : "[start-prod] every variable was already in the environment",
);

const problems = [];
if (!environment.APP_URL) problems.push("APP_URL is required in production (it has a development default).");
if (!environment.REDIS_URL) problems.push("REDIS_URL is required in production (it has a development default).");
if (!environment.EXPORT_SIGNING_SECRET || environment.EXPORT_SIGNING_SECRET.startsWith("dev-only-")) {
  problems.push(
    "EXPORT_SIGNING_SECRET must be a real secret of 32+ characters; the development default is refused in production.\n" +
      "      Generate one into apps/web/.env.local (gitignored, value never printed):\n" +
      "      node -e \"const c=require('crypto'),f=require('fs');f.appendFileSync('apps/web/.env.local','\\nEXPORT_SIGNING_SECRET='+c.randomBytes(48).toString('base64url')+'\\n')\"",
  );
}
for (const key of REFUSED_WHEN_TRUE) {
  if (environment[key] !== "true") continue;
  problems.push(
    `${key}=true is not allowed in production.\n` +
      `      Set it to false in apps/web/${PRODUCTION_OVERRIDE_FILE} — a production start reads that file first, and \`next dev\` ignores it:\n` +
      `        ${key}=false\n` +
      "      A WSL2 judge node is then quarantined and nothing is judged, which is the rail working. Judge on the dev server.",
  );
}
if (problems.length > 0) {
  console.error(`[start-prod] the server would refuse its environment:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

if (environment.JUDGE_ALLOW_UNHARDENED_NODES === "false") {
  console.log(
    "[start-prod] judging is OFF: a development judge node is quarantined in production, so Run and Submit will queue. Use the dev server to show judging.",
  );
}
console.log(`[start-prod] starting the production build on http://127.0.0.1:${port}`);

const child = spawn(
  process.execPath,
  [path.join(WEB_DIR, "node_modules", "next", "dist", "bin", "next"), "start", "-p", port],
  { cwd: WEB_DIR, env: environment, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
