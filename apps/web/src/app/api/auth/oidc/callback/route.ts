import { cookies } from "next/headers";
import { seeOther } from "@/lib/http/form-body";
import { exchangeCode, lmsSignInConfig, verifyIdToken } from "@/lib/auth/oidc";
import { signInWithLmsSubject } from "@/lib/auth/sign-in";
import {
  OIDC_COOKIES,
  OIDC_COOKIE_PATH,
  OIDC_NONCE_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_VERIFIER_COOKIE,
} from "@/lib/auth/oidc-cookies";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/oidc/callback — the way back from REC Learning
 * (Phase 16i).
 *
 * Order matters here more than anywhere else in the sign-in path, and it is
 * the order below: the three cookies this browser carries are read and
 * CLEARED first, then `state` is compared, then the code is exchanged over
 * the back channel, then the id_token's signature and claims are checked,
 * and only then is an account looked up. Nothing reads a claim before the
 * signature verifies, and nothing touches the database before the claims
 * pass.
 *
 * Every refusal lands on `/login?error=<code>` with a sentence from
 * `OIDC_MESSAGES`, because the password form is still there and is still
 * the answer for staff. A code is used in the URL rather than a message so
 * that nothing a provider or a browser can put in a query string ends up
 * rendered.
 */
export async function GET(request: Request): Promise<Response> {
  const config = lmsSignInConfig();
  /**
   * A RELATIVE Location, through the shared helper
   * (`tests/repo/form-redirects.test.ts`): an absolute one is built from the
   * host Next believes it is serving, which behind a proxy or an alternate
   * hostname crosses origin and is then refused by `form-action 'self'`.
   * Every destination here is a page of this product, so none of them needs
   * to be absolute.
   */
  const home = (path: string) => seeOther(path);

  const jar = await cookies();
  const state = jar.get(OIDC_STATE_COOKIE)?.value ?? null;
  const nonce = jar.get(OIDC_NONCE_COOKIE)?.value ?? null;
  const verifier = jar.get(OIDC_VERIFIER_COOKIE)?.value ?? null;
  // Spent on arrival, whatever happens next: a state that survives a failed
  // attempt is a state somebody can retry.
  for (const name of OIDC_COOKIES) {
    jar.set(name, "", { httpOnly: true, sameSite: "lax", path: OIDC_COOKIE_PATH, maxAge: 0 });
  }

  if (!config) return home("/login?error=lms-off");

  const url = new URL(request.url);
  // A provider that refused says so in the query string; it is logged by
  // code and never rendered.
  const providerError = url.searchParams.get("error");
  if (providerError) {
    console.warn(`[auth] LMS sign-in refused by the provider: ${providerError.slice(0, 64)}`);
    return home("/login?error=lms-failed");
  }

  const returned = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !nonce || !verifier) return home("/login?error=lms-expired");
  if (!returned || returned !== state) return home("/login?error=lms-failed");
  if (!code) return home("/login?error=lms-failed");

  try {
    const exchanged = await exchangeCode({ config, code, codeVerifier: verifier });
    if (!exchanged) return home("/login?error=lms-failed");

    const verified = await verifyIdToken(exchanged.idToken, { config, nonce });
    if (!verified.ok) {
      console.warn(`[auth] LMS id_token rejected: ${String(verified.problem)}`);
      return home("/login?error=lms-failed");
    }

    const result = await signInWithLmsSubject(verified.claims.sub);
    if (!result.ok) {
      return home(result.failure === "not-enrolled" ? "/login?error=lms-not-enrolled" : "/login?error=lms-inactive");
    }
    return home(result.home);
  } catch (error) {
    console.error(`[auth] LMS sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    return home("/login?error=lms-failed");
  }
}
