import { NextResponse } from "next/server";
import { isProduction } from "@/lib/env";
import { referenceId } from "@/lib/errors";
import { readFormBody, seeOther } from "@/lib/http/form-body";
import { isSameOrigin } from "@/lib/help/same-origin";
import { loginFailed } from "@/lib/metrics";
import { signIn } from "@/lib/auth/sign-in";
import { LOGIN_IDENTIFIER_COOKIE } from "@/lib/auth/login-cookie";
import type { SignInFailure } from "@/lib/auth/sign-in-errors";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login — the sign-in form's target. /login is a plain HTML
 * page with no JavaScript (src/pages/login.tsx), so this answers every
 * outcome with a 303 to a page:
 *
 *   success  → the role's home (homeForRole — never a URL from the request;
 *              the new session cookie is set here)
 *   failure  → /login?error=<code> (lib/auth/sign-in-errors.ts holds the
 *              words), with the typed roll number / email kept in a
 *              60-second, /login-only, httpOnly cookie so the form comes
 *              back filled in — never in the URL.
 *
 * Cross-site posts are refused before the body is read (login CSRF; the
 * session cookie is SameSite=Lax on top). Rate limits, the Argon2id check
 * (a decoy hash for unknown accounts), session rotation and the audit trail
 * live in signIn().
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return failed("cross-site");

  const form = await readFormBody(request);
  if (!form) return failed("identifier-missing");
  const identifier = form.get("identifier");
  const typed = typeof identifier === "string" ? identifier.trim().slice(0, 254) : "";

  try {
    const result = await signIn({ identifier, password: form.get("password") });
    if (result.ok) {
      const response = see(result.home);
      response.cookies.delete({ name: LOGIN_IDENTIFIER_COOKIE, path: "/login" });
      return response;
    }
    return failed(result.failure, { typed, retry: result.retryMinutes });
  } catch (error) {
    const ref = referenceId();
    console.error(`[auth] unexpected sign-in error (ref ${ref}):`, error);
    return failed("unavailable", { typed, ref });
  }
}

/**
 * The 303 again, as a NextResponse: this route sets and clears a cookie on
 * the redirect, which needs NextResponse's cookie helpers. Same status and
 * headers as `seeOther()` in lib/http/form-body.ts, which the other two
 * auth routes use directly.
 */
function see(location: string): NextResponse {
  const shared = seeOther(location);
  return new NextResponse(null, { status: shared.status, headers: shared.headers });
}

function failed(failure: SignInFailure, extra: { typed?: string; retry?: number; ref?: string } = {}): NextResponse {
  /**
   * `auth_login_failures_total` is counted HERE rather than in `signIn()`,
   * because this is the funnel every refusal passes through: a cross-site
   * post and a body that was not our form never reach `signIn` at all, and
   * those are precisely the shapes an attack has. Phase 10b's "failed logins
   * > 100/min" alert reads the sum.
   *
   * Counted for `rate-limited` too. The limiter is working when that code is
   * returned, but a credential-stuffing run against one account shows up as
   * a handful of `credentials` and then hundreds of `rate-limited`, so a rule
   * that ignored them could not see the attack it exists to catch.
   */
  loginFailed(failure);
  const query = new URLSearchParams({ error: failure });
  if (extra.retry !== undefined) query.set("retry", String(extra.retry));
  if (extra.ref) query.set("ref", extra.ref);
  const response = see(`/login?${query.toString()}`);
  if (extra.typed) {
    response.cookies.set(LOGIN_IDENTIFIER_COOKIE, extra.typed, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction(),
      path: "/login",
      maxAge: 60,
    });
  }
  return response;
}
