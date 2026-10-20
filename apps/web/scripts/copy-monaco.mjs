// Self-host Monaco from /public/monaco/vs. Never the jsdelivr AMD loader:
// strict CSP, a cold cross-origin cost on 3 Mbps campus wifi, and dead on an
// exam LAN. Only the editor core, the generic editor worker and the
// tokenizers for enabled languages are shipped — the TypeScript, JSON, CSS
// and HTML language services (their workers alone are ~700 KB) are not.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let pkgDir;
try {
  pkgDir = dirname(require.resolve("monaco-editor/package.json"));
} catch {
  console.warn("[copy-monaco] monaco-editor not installed yet; skipping");
  process.exit(0);
}

const src = join(pkgDir, "min", "vs");
const dest = join(here, "..", "public", "monaco", "vs");
const KEEP_LANGUAGES = new Set(["cpp", "python", "java", "go", "kotlin", "javascript"]);

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

// Drop the language services entirely (TS/JSON/CSS/HTML workers + modes).
rmSync(join(dest, "language"), { recursive: true, force: true });

// Keep only the tokenizers we offer.
const basic = join(dest, "basic-languages");
if (existsSync(basic)) {
  for (const entry of readdirSync(basic)) {
    if (!KEEP_LANGUAGES.has(entry) && !entry.endsWith(".js")) {
      rmSync(join(basic, entry), { recursive: true, force: true });
    }
  }
}

// Non-English NLS bundles are not used.
for (const entry of readdirSync(join(dest, "editor"))) {
  if (/^editor\.main\.nls\.[a-z-]+\.js$/.test(entry)) rmSync(join(dest, "editor", entry), { force: true });
}

console.log(`[copy-monaco] ${src} -> ${dest}`);
