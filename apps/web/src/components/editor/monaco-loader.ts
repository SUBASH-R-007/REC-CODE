import type { AmdRequire, MonacoApi, MonacoWindow } from "@/components/editor/monaco-types";

/**
 * Lazily load the self-hosted Monaco AMD build from /monaco/vs (copied into
 * public/ by scripts/copy-monaco.mjs) — never a CDN: strict CSP, a cold
 * cross-origin cost on campus wifi, and dead on an exam LAN.
 *
 * Only the generic editor worker is used: the TS/JSON/CSS/HTML language
 * services are not shipped, so every worker request resolves to
 * vs/base/worker/workerMain.js.
 */

const MONACO_BASE = "/monaco/vs";
const LOAD_TIMEOUT_MS = 30_000;

let pending: Promise<MonacoApi> | null = null;

function monacoWindow(): MonacoWindow {
  // @types/node types a global `require` too; the AMD one replaces it here.
  return window as unknown as MonacoWindow;
}

/** Reuse the page's CSP nonce (if any) for the injected loader script. */
function pageNonce(): string | undefined {
  const script = document.querySelector<HTMLScriptElement>("script[nonce]");
  return script?.nonce || script?.getAttribute("nonce") || undefined;
}

/**
 * Start DOWNLOADING the loader, the editor core and its stylesheet, all at
 * once, without running any of them (idempotent). Otherwise they arrive one
 * after the other: the AMD loader asks for editor.main.js only once
 * loader.js has run, and for editor.main.css only once editor.main.js has
 * run. Same URLs and the same kind of elements the loader creates (no
 * crossorigin), so the browser hands the preloaded responses over instead
 * of fetching twice. Nothing executes until loadMonaco(), which turns the
 * stylesheet preload into the stylesheet itself (applyPreloadedStyles).
 */
export function preloadMonaco(): void {
  const nonce = pageNonce();
  for (const [file, as] of [
    ["loader.js", "script"],
    ["editor/editor.main.js", "script"],
    ["editor/editor.main.css", "style"],
  ] as const) {
    const href = `${MONACO_BASE}/${file}`;
    if (document.head.querySelector(`link[rel="preload"][href="${href}"]`)) continue;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = as;
    link.href = href;
    if (nonce) link.nonce = nonce;
    document.head.appendChild(link);
  }
}

/**
 * Monaco's AMD `vs/css` plugin treats a stylesheet as ALREADY LOADED when
 * any <link> with its href exists, whatever the rel — so a rel="preload"
 * link left as it is would leave the editor unstyled (no overflow guard, a
 * visible input textarea, unstyled aria live region). Before editor.main
 * runs, every /monaco/vs stylesheet preload becomes that stylesheet (the
 * browser reuses the preloaded response); the plugin then finds it applied.
 */
function applyPreloadedStyles(): void {
  for (const link of document.head.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="style"]')) {
    if (link.getAttribute("href")?.startsWith(`${MONACO_BASE}/`)) link.rel = "stylesheet";
  }
}

function injectLoader(): Promise<AmdRequire> {
  const w = monacoWindow();
  if (w.require && typeof w.require.config === "function") return Promise.resolve(w.require);
  preloadMonaco();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${MONACO_BASE}/loader.js`;
    script.async = true;
    const nonce = pageNonce();
    if (nonce) script.nonce = nonce;
    script.onload = () => {
      const amd = monacoWindow().require;
      if (amd && typeof amd.config === "function") resolve(amd);
      else reject(new Error("Monaco loader did not install require()"));
    };
    script.onerror = () => reject(new Error("Monaco loader failed to load"));
    document.head.appendChild(script);
  });
}

export function loadMonaco(): Promise<MonacoApi> {
  if (pending) return pending;
  const w = monacoWindow();
  if (w.monaco?.editor) return Promise.resolve(w.monaco);

  w.MonacoEnvironment = {
    getWorkerUrl: () => `${MONACO_BASE}/base/worker/workerMain.js`,
  };

  pending = new Promise<MonacoApi>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Monaco took too long to load")), LOAD_TIMEOUT_MS);
    injectLoader()
      .then((amd) => {
        amd.config({ paths: { vs: MONACO_BASE } });
        applyPreloadedStyles();
        amd(
          ["vs/editor/editor.main"],
          () => {
            clearTimeout(timer);
            const monaco = monacoWindow().monaco;
            if (monaco?.editor) resolve(monaco);
            else reject(new Error("Monaco loaded without an editor API"));
          },
          (error) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error("Monaco failed to load"));
          },
        );
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Monaco failed to load"));
      });
  });
  // A failed load may be retried on the next mount (e.g. after reconnecting).
  pending.catch(() => {
    pending = null;
  });
  return pending;
}
