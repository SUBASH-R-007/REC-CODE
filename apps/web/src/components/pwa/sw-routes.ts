/**
 * Service-worker request classification — the TypeScript twin of
 * `classifyRequest` / `isExamPath` in apps/web/public/sw.js (a service
 * worker cannot import this module). test/sw-routes.test.ts runs sw.js in a
 * sandbox and asserts both agree on every case, so change them together.
 *
 *   "static"   cache-first: same-origin GET /_next/static/* (content-hashed)
 *   "navigate" network-first, falling back to the cached /offline page
 *   "bypass"   never intercepted, never cached: non-GET, cross-origin,
 *              /api/*, /admin, /super, the exam routes, RSC / prefetch /
 *              JSON fetches, and everything else
 *
 * Nothing authenticated is ever written to the cache: navigations are
 * passed through (only /offline is precached), and API / RSC / JSON
 * responses are never touched. Lab machines are shared.
 */

export type SwRoute = "static" | "navigate" | "bypass";

export interface SwRequestLike {
  url: string;
  method: string;
  /** Request.mode: "navigate" for document loads. */
  mode: string;
  /** Lower-cased header lookup (rsc, next-router-prefetch, accept, purpose). */
  header(name: string): string | null;
}

/** Path prefixes the worker must never intercept (matched on a segment boundary). */
export const SW_BYPASS_PREFIXES = ["/api", "/admin", "/super"] as const;

const EXAM_PATTERNS: readonly RegExp[] = [/^\/assessments\/[^/]+\/attempt(?:\/|$)/, /^\/contests\/[^/]+\/arena(?:\/|$)/];

/** Decode percent-escapes (so /%61dmin is /admin) and lower-case; never throws. */
export function normalizePath(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // Malformed escapes: classify the raw path.
  }
  return path.toLowerCase().replace(/\/{2,}/g, "/");
}

/**
 * The exam routes (Phase 6/7): a stale cached shell must never serve an
 * exam, so the worker never intercepts them and unregisters itself when one
 * is navigated to; the page-side registration does the same.
 */
export function isExamPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  return EXAM_PATTERNS.some((pattern) => pattern.test(path));
}

function hasPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function classifyRequest(request: SwRequestLike, origin: string): SwRoute {
  if (request.method !== "GET") return "bypass";
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return "bypass";
  }
  if (url.origin !== origin) return "bypass";

  const path = normalizePath(url.pathname);
  if (SW_BYPASS_PREFIXES.some((prefix) => hasPrefix(path, prefix))) return "bypass";
  if (isExamPath(path)) return "bypass";

  if (path.startsWith("/_next/static/")) return "static";

  // React Server Component payloads, router prefetches and JSON are
  // per-user data: never ours to answer.
  if (request.header("rsc") !== null || request.header("next-router-prefetch") !== null) return "bypass";
  if (url.searchParams.has("_rsc")) return "bypass";
  if ((request.header("accept") ?? "").includes("application/json")) return "bypass";

  if (request.mode === "navigate") return "navigate";
  return "bypass";
}
