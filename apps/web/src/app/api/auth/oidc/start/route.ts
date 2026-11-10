import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeUrl } from "@recx/shared/oidc";
import { seeOther } from "@/lib/http/form-body";
import {
  OIDC_COOKIE_PATH,
  OIDC_COOKIE_SECONDS,
  OIDC_NONCE_COOKIE,
  OIDC_STATE_COOKIE,
  OIDC_VERIFIER_COOKIE,
} from "@/lib/auth/oidc-cookies";
import { isProduction } from "@/lib/env";
import { discover, lmsSignInConfig, newOpaqueValue, newPkce } from "@/lib/auth/oidc";

export const dynamic = "force-dynamic";

/**
 * GET /api/auth/oidc/start — begin a sign-in through REC Learning
 * (Phase 16i).
 *
 * A GET because it is a link on a page with no JavaScript, and because
 * nothing here changes any state the platform owns: it mints three random
 * values, puts them in short-lived cookies and redirects. The session is
 * created only on the way back, after a signature has been checked.
 *
 * The three values and what each one is for:
 *   * `state` — this redirect came from a start this browser made, so a
 *     callback somebody else triggered cannot complete;
 *   * `nonce` — this id_token was issued for that request, so one captured
 *     earlier cannot be replayed;
 *   * the PKCE verifier — this code is being exchanged by the client that
 *     asked for it, so a stolen code is worth nothing on its own.
 *
 * All three are httpOnly and scoped to the callback path, and all three
 * expire in ten minutes. A sign-in that takes longer than that is one the
 * student should start again.
 */


export async function GET(): Promise<Response> {
  const config = lmsSignInConfig();
  if (!config) {
    // Not an error page: the button is not drawn when this is off, so
    // reaching here means a bookmark or a guess.
    return seeOther("/login?error=lms-off");
  }

  let authorize: string;
  try {
    const discovery = await discover(config);
    const { verifier, challenge } = newPkce();
    const state = newOpaqueValue();
    const nonce = newOpaqueValue();
    authorize = authorizeUrl({
      authorizationEndpoint: discovery.authorizationEndpoint,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state,
      nonce,
      codeChallenge: challenge,
    });

    const jar = await cookies();
    const common = {
      httpOnly: true,
      sameSite: "lax" as const,
      secure: isProduction(),
      path: OIDC_COOKIE_PATH,
      maxAge: OIDC_COOKIE_SECONDS,
    };
    jar.set(OIDC_STATE_COOKIE, state, common);
    jar.set(OIDC_NONCE_COOKIE, nonce, common);
    jar.set(OIDC_VERIFIER_COOKIE, verifier, common);
  } catch (error) {
    // A provider that cannot be reached is an operational fault, not the
    // student's; it is logged with its reason and they are sent back to a
    // page that still offers the password form.
    console.error(`[auth] LMS sign-in could not start: ${error instanceof Error ? error.message : String(error)}`);
    return seeOther("/login?error=lms-unavailable");
  }

  /**
   * The one absolute redirect in the product, and the reason this file is
   * named in `ALLOWED` in `tests/repo/form-redirects.test.ts`: the
   * destination is the identity provider, which is another origin by
   * definition. `authorize` is built from the issuer's own discovery
   * document and never from anything in the request, and the two refusals
   * above -- both to pages of this product -- go through `seeOther()` like
   * every other redirect here.
   */
  return NextResponse.redirect(authorize, { status: 303 });
}
