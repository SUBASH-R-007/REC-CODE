import { NextResponse, type NextRequest } from "next/server";
import { THEME_SCRIPT_CSP_HASH } from "@/lib/theme-script";

/**
 * Per-request Content-Security-Policy with a nonce for framework scripts.
 * Defense-in-depth: problem statements are rendered from sanitised Markdown
 * and the app has no known XSS sink, but a strict CSP contains the blast
 * radius of any future injection.
 *
 * The nonce reaches the app two ways, both as REQUEST headers:
 *   - `content-security-policy`: Next reads the nonce out of this header and
 *     stamps it on its own framework and flight-data scripts;
 *   - `x-nonce`: the root layout reads it for the brand <style>.
 * The single inline theme script is allow-listed by its content hash
 * instead, so its tag carries no nonce attribute.
 *
 * Pages must render dynamically for a per-request nonce to exist; the root
 * layout reads headers(), so every page does.
 */
export function middleware(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== "production" });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

/** 128 random bits, base64 (edge runtime: Web Crypto only, no Buffer). */
function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildCsp(nonce: string, { dev }: { dev: boolean }): string {
  return [
    `default-src 'self'`,
    // 'strict-dynamic' lets the nonce'd Next loader pull in its chunks (and
    // the self-hosted Monaco loader its modules); the theme script is
    // trusted by hash; dev needs 'unsafe-eval' for React Refresh / HMR.
    `script-src 'self' 'nonce-${nonce}' ${THEME_SCRIPT_CSP_HASH} 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Deliberately NO nonce here. Once a style-src carries a nonce (or a
    // hash), browsers ignore 'unsafe-inline' — and then every React `style`
    // attribute (progress bars, avatars, resizable panels) and the styles
    // Monaco injects at runtime are blocked. The tradeoff: an injected
    // <style> could restyle the page. It cannot run script, and CSS-based
    // exfiltration is limited by img-src/font-src/connect-src being 'self'.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    // Same-origin only: SSE progress streams and server actions. Dev adds
    // ws: for the HMR socket.
    `connect-src 'self'${dev ? " ws:" : ""}`,
    // Monaco's language workers are spawned from blob: URLs.
    `worker-src 'self' blob:`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    // Dev runs on plain http://localhost; upgrading would break it.
    ...(dev ? [] : [`upgrade-insecure-requests`]),
  ].join("; ");
}

export const config = {
  matcher: [
    {
      // The CSP matters on documents. Skip immutable static files, the
      // self-hosted Monaco bundle, and the judge-node protocol (machine
      // endpoints authenticated by node token; they never return HTML).
      source: "/((?!_next/static|_next/image|favicon.ico|icon.png|icon.svg|apple-icon.png|monaco/|api/judge/).*)",
      // Router prefetches render no document.
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
