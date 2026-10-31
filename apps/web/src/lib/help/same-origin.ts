/**
 * Same-origin check for cookie-authenticated POST route handlers (CSRF
 * defence in depth on top of the SameSite=Lax session cookie; server
 * actions get Next's own origin check, route handlers do not).
 *
 * Uses the Fetch-Metadata header when the browser sends one, otherwise
 * compares Origin with Host. A request with neither header (an old browser,
 * a non-browser client) carries no cross-site ambient credentials concern
 * that Fetch-Metadata could have answered, and is let through.
 */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
