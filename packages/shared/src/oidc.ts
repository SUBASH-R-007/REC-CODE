/**
 * Signing in through REC Learning (Phase 16i).
 *
 * SPEC §1: *"the LMS remains the identity source of record"*, and
 * `/admin/students/import` has acted on that since Phase 4 — every roster
 * row needs its `lmsUserId`, and the accounts it creates have
 * `passwordHash = null`. `docs/OPEN-QUESTIONS.md` recorded what was
 * missing: *"Accounts it creates have role STUDENT, status ACTIVE and
 * `passwordHash = null`, so they cannot sign in until LMS sign-in (OIDC)
 * ships in Phase 10."* Phase 10 shipped ops instead, and Phases 11a and 11f
 * built an interim — a one-time link, and an initial password good for one
 * sign-in. Both work. Both are a second credential for every student on a
 * campus whose LMS already has one.
 *
 * This module is the half with no I/O in it: the URL to send a browser to,
 * the shape of a discovery document, and the claim checks. Everything that
 * fetches or verifies a signature is in `apps/web/src/lib/auth/oidc.ts`,
 * because this file is also read by tests that must not reach a network.
 *
 * **Authorization code with PKCE, and nothing else.** No implicit flow, no
 * hybrid, no `response_mode=form_post`. The id_token arrives at the token
 * endpoint over a back channel, so it never touches a redirect URL, a
 * browser history or a server log.
 *
 * **Never auto-create an account.** A subject the roster does not know is
 * refused and told to see their department. The roster import is the thing
 * that creates accounts, deliberately — it reconciles roll numbers, refuses
 * duplicate keys and leaves conflicts to a super-admin, and none of that
 * can happen inside a sign-in.
 */

export const OIDC_SCOPE = "openid profile email";

/** The only signing algorithm this accepts. */
export const OIDC_ALG = "RS256";

/** How far apart the clocks may be before a token is refused, in seconds. */
export const OIDC_CLOCK_LEEWAY_SECONDS = 120;

/** An id_token older than this is refused even if it has not expired. */
export const OIDC_MAX_TOKEN_AGE_SECONDS = 600;

export interface OidcDiscovery {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
}

export type DiscoveryProblem =
  | "not-an-object"
  | "issuer-missing"
  | "issuer-mismatch"
  | "authorization-endpoint-missing"
  | "token-endpoint-missing"
  | "jwks-uri-missing"
  | "endpoint-not-https";

/** An https URL, or a loopback http one so a test can serve a provider. */
export function isAllowedEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
}

/**
 * Read a discovery document, refusing anything that does not describe the
 * issuer it was fetched for.
 *
 * The `issuer-mismatch` check is the one that matters: a provider that
 * answers for a different issuer than the one configured is either
 * misconfigured or being impersonated, and in both cases the right answer
 * is to stop rather than to carry on with whichever endpoints it offered.
 */
export function readDiscovery(
  value: unknown,
  expectedIssuer: string,
): { ok: true; discovery: OidcDiscovery } | { ok: false; problem: DiscoveryProblem } {
  if (typeof value !== "object" || value === null) return { ok: false, problem: "not-an-object" };
  const doc = value as Record<string, unknown>;
  if (typeof doc.issuer !== "string" || doc.issuer.length === 0) return { ok: false, problem: "issuer-missing" };
  if (trimSlash(doc.issuer) !== trimSlash(expectedIssuer)) return { ok: false, problem: "issuer-mismatch" };
  if (typeof doc.authorization_endpoint !== "string") return { ok: false, problem: "authorization-endpoint-missing" };
  if (typeof doc.token_endpoint !== "string") return { ok: false, problem: "token-endpoint-missing" };
  if (typeof doc.jwks_uri !== "string") return { ok: false, problem: "jwks-uri-missing" };
  for (const endpoint of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri]) {
    if (!isAllowedEndpoint(endpoint)) return { ok: false, problem: "endpoint-not-https" };
  }
  return {
    ok: true,
    discovery: {
      issuer: doc.issuer,
      authorizationEndpoint: doc.authorization_endpoint,
      tokenEndpoint: doc.token_endpoint,
      jwksUri: doc.jwks_uri,
    },
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export interface AuthorizeInput {
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

/** Where to send the browser. Built here so a test can read it without a network. */
export function authorizeUrl(input: AuthorizeInput): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", OIDC_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // The LMS and this app are the same institution's; a silent re-auth would
  // make "sign out" mean nothing, so the provider is asked to ask.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export interface IdTokenClaims {
  readonly iss?: unknown;
  readonly sub?: unknown;
  readonly aud?: unknown;
  readonly exp?: unknown;
  readonly iat?: unknown;
  readonly nonce?: unknown;
  readonly email?: unknown;
}

export type ClaimProblem =
  | "issuer-mismatch"
  | "subject-missing"
  | "audience-mismatch"
  | "expiry-missing"
  | "expired"
  | "issued-in-the-future"
  | "too-old"
  | "nonce-mismatch";

/**
 * Every check that does not need a key, in one pure function.
 *
 * `aud` may be a string or an array (the spec allows both); an array must
 * CONTAIN this client, and `azp` is not consulted because this client never
 * accepts a token issued for somebody else regardless of who authorised it.
 */
export function idTokenClaimProblem(input: {
  readonly claims: IdTokenClaims;
  readonly issuer: string;
  readonly clientId: string;
  readonly nonce: string;
  readonly nowSeconds: number;
}): ClaimProblem | null {
  const { claims, issuer, clientId, nonce, nowSeconds } = input;
  if (typeof claims.iss !== "string" || trimSlash(claims.iss) !== trimSlash(issuer)) return "issuer-mismatch";
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return "subject-missing";

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.some((entry) => entry === clientId)) return "audience-mismatch";

  if (typeof claims.exp !== "number") return "expiry-missing";
  if (nowSeconds - OIDC_CLOCK_LEEWAY_SECONDS >= claims.exp) return "expired";

  if (typeof claims.iat === "number") {
    if (claims.iat - OIDC_CLOCK_LEEWAY_SECONDS > nowSeconds) return "issued-in-the-future";
    if (nowSeconds - claims.iat > OIDC_MAX_TOKEN_AGE_SECONDS + OIDC_CLOCK_LEEWAY_SECONDS) return "too-old";
  }

  // The nonce binds this token to the request that started it, which is
  // what makes a replayed token useless.
  if (typeof claims.nonce !== "string" || claims.nonce !== nonce) return "nonce-mismatch";

  return null;
}

/**
 * What a candidate is told. Deliberately the same sentence for "no such
 * subject" and "not on the roster": a signed-in LMS user learns nothing
 * about who else has an account here.
 */
export const OIDC_MESSAGES = Object.freeze({
  notEnrolled:
    "You signed in to REC Learning, but there is no REC Code account for you yet. Your department adds accounts from the roster — ask them, and nothing is needed from you in the meantime.",
  inactive:
    "Your REC Code account is not active. Ask your department, who can see why and can put it back.",
  failed:
    "That sign-in could not be completed. Start again from the sign-in page, and tell your department if it keeps happening.",
  expired: "That sign-in took too long. Start again from the sign-in page.",
  disabled: "Signing in through REC Learning is not switched on for this deployment.",
});

/** The button on the sign-in page. */
export const OIDC_BUTTON_LABEL = "Sign in with REC Learning";

/** The path the button points at. A GET, because the page ships no script. */
export const OIDC_START_PATH = "/api/auth/oidc/start";

/**
 * Is LMS sign-in configured?
 *
 * Over a plain record rather than over `env()`, because two callers need
 * the answer from opposite sides of a bundling boundary: `lmsSignInConfig()`
 * in the App Router, and the sign-in page, which is Pages Router and so
 * cannot import anything marked `server-only`. One function means the
 * button cannot appear for a deployment the routes would refuse, or stay
 * hidden for one they would serve.
 *
 * All three or none — `env.ts` refuses a partial set at boot, and this
 * agrees with it rather than restating it.
 */
export function lmsSignInOffered(source: {
  readonly LMS_OIDC_ISSUER?: string | undefined;
  readonly LMS_OIDC_CLIENT_ID?: string | undefined;
  readonly LMS_OIDC_CLIENT_SECRET?: string | undefined;
}): boolean {
  return Boolean(
    source.LMS_OIDC_ISSUER?.trim() && source.LMS_OIDC_CLIENT_ID?.trim() && source.LMS_OIDC_CLIENT_SECRET?.trim(),
  );
}
