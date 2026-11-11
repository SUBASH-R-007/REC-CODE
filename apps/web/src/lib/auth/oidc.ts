import "server-only";
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from "node:crypto";
import {
  OIDC_ALG,
  idTokenClaimProblem,
  isAllowedEndpoint,
  lmsSignInOffered,
  readDiscovery,
  type IdTokenClaims,
  type OidcDiscovery,
} from "@recx/shared";
import { env } from "@/lib/env";

/**
 * The half of LMS sign-in that fetches and verifies (Phase 16i).
 *
 * The pure half — the authorize URL, the discovery shape and every claim
 * check — is `@recx/shared`'s `oidc.ts`, and the reasoning for the flow is
 * there too.
 *
 * **Why no library.** `jose` is the obvious choice and is not in this
 * repository. The verification here is small enough to read in one sitting:
 * Node 22 imports a JWK directly (`createPublicKey({ format: "jwk" })`), so
 * there is no key parsing to get wrong, and the algorithm is a hard-coded
 * allow-list of exactly one. Against that is a new dependency in the ONE
 * application that holds `DATABASE_URL` — SPEC §1 pins the stack for this
 * reason, and this file is forty lines of it. The negative cases that
 * matter (`alg: none`, an algorithm swap, a key that did not sign it) are
 * each a test.
 */

export interface LmsSignInConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

/** The configuration, or null when LMS sign-in is not switched on. */
export function lmsSignInConfig(): LmsSignInConfig | null {
  const e = env();
  // The same predicate the sign-in page draws its button from.
  if (!lmsSignInOffered(e) || !e.LMS_OIDC_ISSUER || !e.LMS_OIDC_CLIENT_ID || !e.LMS_OIDC_CLIENT_SECRET) return null;
  return {
    issuer: e.LMS_OIDC_ISSUER,
    clientId: e.LMS_OIDC_CLIENT_ID,
    clientSecret: e.LMS_OIDC_CLIENT_SECRET,
    redirectUri: `${e.APP_URL.replace(/\/+$/, "")}/api/auth/oidc/callback`,
  };
}

/** PKCE: a verifier the browser never sees, and the challenge that does travel. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function newOpaqueValue(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Discovery and JWKS, cached in the process.
 *
 * Short, because a key rotation at the provider must not lock students out
 * for longer than a coffee break, and a cache miss is one request.
 */
const CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;

let discoveryCache: { at: number; value: OidcDiscovery } | null = null;
let jwksCache: { at: number; uri: string; keys: JsonWebKey[] } | null = null;

async function fetchJson(url: string): Promise<unknown> {
  if (!isAllowedEndpoint(url)) throw new Error("oidc: endpoint is not https");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`oidc: ${url} answered ${response.status}`);
  return response.json();
}

export async function discover(config: LmsSignInConfig, now = Date.now()): Promise<OidcDiscovery> {
  if (discoveryCache && now - discoveryCache.at < CACHE_MS) return discoveryCache.value;
  const url = `${config.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const parsed = readDiscovery(await fetchJson(url), config.issuer);
  if (!parsed.ok) throw new Error(`oidc: discovery is unusable (${parsed.problem})`);
  discoveryCache = { at: now, value: parsed.discovery };
  return parsed.discovery;
}

async function jwks(uri: string, now = Date.now()): Promise<JsonWebKey[]> {
  if (jwksCache && jwksCache.uri === uri && now - jwksCache.at < CACHE_MS) return jwksCache.keys;
  const body = (await fetchJson(uri)) as { keys?: unknown };
  const keys = Array.isArray(body.keys) ? (body.keys as JsonWebKey[]) : [];
  jwksCache = { at: now, uri, keys };
  return keys;
}

/** For tests, which stand up a provider of their own on loopback. */
export function resetOidcCaches(): void {
  discoveryCache = null;
  jwksCache = null;
}

interface JwtParts {
  readonly header: { alg?: unknown; kid?: unknown; typ?: unknown };
  readonly claims: IdTokenClaims;
  readonly signingInput: string;
  readonly signature: Buffer;
}

function decode(token: string): JwtParts | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as JwtParts["header"];
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as IdTokenClaims;
    return {
      header,
      claims,
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2]!, "base64url"),
    };
  } catch {
    return null;
  }
}

export type IdTokenProblem =
  | "malformed"
  | "algorithm-not-allowed"
  | "no-matching-key"
  | "bad-signature"
  | ReturnType<typeof idTokenClaimProblem>;

/**
 * Verify an id_token: the algorithm, then the signature, then the claims.
 *
 * In that order on purpose. Reading claims out of a token whose signature
 * has not been checked is how `alg: none` works, so nothing here looks at a
 * claim for any purpose other than finding the key until the signature has
 * verified.
 */
export async function verifyIdToken(
  token: string,
  input: { config: LmsSignInConfig; nonce: string; nowSeconds?: number },
): Promise<{ ok: true; claims: IdTokenClaims & { sub: string } } | { ok: false; problem: IdTokenProblem }> {
  const parts = decode(token);
  if (!parts) return { ok: false, problem: "malformed" };
  // One algorithm, named. `none` and every HMAC variant fail here, before
  // anything else is read.
  if (parts.header.alg !== OIDC_ALG) return { ok: false, problem: "algorithm-not-allowed" };

  const discovery = await discover(input.config);
  const keys = await jwks(discovery.jwksUri);
  const kid = typeof parts.header.kid === "string" ? parts.header.kid : null;
  const candidates = keys.filter((key) => {
    if ((key as { kty?: string }).kty !== "RSA") return false;
    const keyKid = (key as { kid?: string }).kid;
    return kid === null || keyKid === undefined || keyKid === kid;
  });
  if (candidates.length === 0) return { ok: false, problem: "no-matching-key" };

  const verified = candidates.some((jwk) => {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      return verifySignature("RSA-SHA256", Buffer.from(parts.signingInput, "utf8"), key, parts.signature);
    } catch {
      return false;
    }
  });
  if (!verified) return { ok: false, problem: "bad-signature" };

  const problem = idTokenClaimProblem({
    claims: parts.claims,
    issuer: input.config.issuer,
    clientId: input.config.clientId,
    nonce: input.nonce,
    nowSeconds: input.nowSeconds ?? Math.floor(Date.now() / 1000),
  });
  if (problem) return { ok: false, problem };
  return { ok: true, claims: parts.claims as IdTokenClaims & { sub: string } };
}

/**
 * Exchange the code. The client secret goes in the POST body over the back
 * channel and never near the browser.
 */
export async function exchangeCode(input: {
  config: LmsSignInConfig;
  code: string;
  codeVerifier: string;
}): Promise<{ idToken: string } | null> {
  const discovery = await discover(input.config);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.config.redirectUri,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    code_verifier: input.codeVerifier,
  });
  const response = await fetch(discovery.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) return null;
  const json = (await response.json()) as { id_token?: unknown };
  return typeof json.id_token === "string" && json.id_token.length > 0 ? { idToken: json.id_token } : null;
}
