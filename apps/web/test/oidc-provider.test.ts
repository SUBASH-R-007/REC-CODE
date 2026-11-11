import { createHash, createSign, generateKeyPairSync, randomBytes, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Signing in through REC Learning, against a REAL OpenID provider served on
 * loopback (Phase 16i).
 *
 * The claim checks are pure and are tested in `packages/shared`. The
 * SIGNATURE cannot be: `alg: none`, an algorithm swap and a key that did
 * not sign the token are exactly the three bugs that a fake `fetch` and a
 * hand-written token object cannot catch, because each of them is about
 * what the verifier does with real bytes.
 *
 * So this file generates an RSA key pair in-process, serves
 * `/.well-known/openid-configuration`, `/jwks` and `/token` from a
 * `node:http` server on 127.0.0.1, mints id_tokens with that key, and runs
 * the real `verifyIdToken` and `exchangeCode` over the real global `fetch`.
 * No network, no provider account, and no key that exists anywhere but in
 * this process for the length of the run.
 *
 * `isAllowedEndpoint` admits plain http on loopback for this reason and
 * only this reason — every other host must be https, which is its own case
 * in the shared suite.
 */

const KEY_ID = "test-key-1";
const CLIENT_ID = "recx-web-under-test";
/** A value this test invents, for a provider this test runs. */
const CLIENT_SECRET = "loopback-provider-secret";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
/** A second pair, so "signed by the wrong key" can be a real signature. */
const strangerKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

const h = vi.hoisted(() => ({
  env: {
    APP_URL: "http://localhost:3100",
    LMS_OIDC_ISSUER: "" as string,
    LMS_OIDC_CLIENT_ID: "recx-web-under-test",
    LMS_OIDC_CLIENT_SECRET: "loopback-provider-secret",
  },
}));

vi.mock("@/lib/env", () => ({ env: () => h.env, isProduction: () => false }));

const { discover, exchangeCode, lmsSignInConfig, resetOidcCaches, verifyIdToken } = await import("@/lib/auth/oidc");

/** What the provider last saw at /token, so the request shape can be asserted. */
interface TokenRequest {
  readonly contentType: string;
  readonly body: Record<string, string>;
}

let server: Server;
let issuer: string;
let lastToken: TokenRequest | null = null;
/** What /token answers with next; a test sets this to the token it minted. */
let nextIdToken: string | null = null;
/** What /jwks answers with; one test empties it. */
let publishedKeys: unknown[] = [];
/** A test that needs discovery to answer for somebody else sets this. */
let discoveryIssuerOverride: string | null = null;

function json(body: unknown): string {
  return JSON.stringify(body);
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/.well-known/openid-configuration") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        json({
          issuer: discoveryIssuerOverride ?? issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
        }),
      );
      return;
    }
    if (url.pathname === "/jwks") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(json({ keys: publishedKeys }));
      return;
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        lastToken = {
          contentType: String(request.headers["content-type"] ?? ""),
          body: Object.fromEntries(new URLSearchParams(text)),
        };
        if (nextIdToken === null) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(json({ error: "invalid_grant" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(json({ access_token: "not-used-by-this-client", token_type: "Bearer", id_token: nextIdToken }));
      });
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h.env.LMS_OIDC_ISSUER = issuer;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  resetOidcCaches();
  lastToken = null;
  nextIdToken = null;
  discoveryIssuerOverride = null;
  publishedKeys = [publicJwk(keys.publicKey, KEY_ID)];
});

/** A public key as the provider publishes it. */
function publicJwk(key: KeyObject, kid: string): Record<string, unknown> {
  return { ...key.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
}

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

/**
 * Mint an id_token. Every part is a parameter, because every part is
 * something a provider — or somebody pretending to be one — can get wrong.
 */
function mint(options: {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  signWith?: KeyObject | null;
  nowSeconds?: number;
}): string {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: KEY_ID, ...options.header };
  const claims = {
    iss: issuer,
    sub: "lms-subject-1",
    aud: CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce: "the-nonce",
    email: "student@rajalakshmi.edu.in",
    ...options.claims,
  };
  const signingInput = `${b64(header)}.${b64(claims)}`;
  if (options.signWith === null) return `${signingInput}.`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  return `${signingInput}.${signer.sign(options.signWith ?? keys.privateKey, "base64url")}`;
}

const config = () => {
  const value = lmsSignInConfig();
  if (!value) throw new Error("the test env should configure LMS sign-in");
  return value;
};

const verify = (token: string, nonce = "the-nonce") => verifyIdToken(token, { config: config(), nonce });

describe("discovery over a socket", () => {
  it("reads the provider's own document", async () => {
    const discovered = await discover(config());
    expect(discovered).toEqual({
      issuer,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      jwksUri: `${issuer}/jwks`,
    });
  });

  it("refuses a provider that answers for a different issuer", async () => {
    // The impersonation case: this host serves a document naming somebody
    // else as the issuer, and the endpoints in it are therefore not to be
    // trusted with a code or a client secret.
    discoveryIssuerOverride = "https://learning.elsewhere.example";
    await expect(discover(config())).rejects.toThrow(/issuer-mismatch/);
  });

  it("caches, so a sign-in is one round trip to the provider and not three", async () => {
    await discover(config());
    discoveryIssuerOverride = "https://learning.elsewhere.example";
    // Still the cached document: the override would fail if it were refetched.
    await expect(discover(config())).resolves.toMatchObject({ issuer });
    resetOidcCaches();
    await expect(discover(config())).rejects.toThrow(/issuer-mismatch/);
  });
});

describe("verifyIdToken: the signature, against real bytes", () => {
  it("accepts a token this provider signed", async () => {
    const result = await verify(mint({}));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe("lms-subject-1");
  });

  it('refuses alg: "none" — with no signature at all', async () => {
    // The canonical JWT vulnerability. The check is first in the function
    // on purpose, so this fails before a single claim is read.
    const result = await verify(mint({ header: { alg: "none" }, signWith: null }));
    expect(result).toEqual({ ok: false, problem: "algorithm-not-allowed" });
  });

  it("refuses an algorithm swap to HS256, where the public key would be the secret", async () => {
    // The other canonical one: a verifier that trusts the header would
    // HMAC the token with the provider's PUBLIC key, which anybody can
    // fetch from /jwks.
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "JWT", kid: KEY_ID };
    const claims = { iss: issuer, sub: "lms-subject-1", aud: CLIENT_ID, exp: now + 300, iat: now, nonce: "the-nonce" };
    const signingInput = `${b64(header)}.${b64(claims)}`;
    const forged = createHash("sha256").update(signingInput).digest("base64url");
    const result = await verify(`${signingInput}.${forged}`);
    expect(result).toEqual({ ok: false, problem: "algorithm-not-allowed" });
  });

  it("refuses RS512 and every other algorithm the provider did not promise", async () => {
    for (const alg of ["RS384", "RS512", "PS256", "ES256", "HS512", "", "rs256"]) {
      const result = await verify(mint({ header: { alg } }));
      expect(result, alg).toEqual({ ok: false, problem: "algorithm-not-allowed" });
    }
  });

  it("refuses a real signature made with a key the provider does not publish", async () => {
    // Everything about this token is well-formed, including the signature:
    // it is simply somebody else's.
    const result = await verify(mint({ signWith: strangerKeys.privateKey }));
    expect(result).toEqual({ ok: false, problem: "bad-signature" });
  });

  it("refuses a tampered payload, signature and all", async () => {
    const token = mint({});
    const [header, , signature] = token.split(".");
    const swapped = b64({ iss: issuer, sub: "somebody-else", aud: CLIENT_ID, exp: 9_999_999_999, nonce: "the-nonce" });
    const result = await verify(`${header}.${swapped}.${signature}`);
    expect(result).toEqual({ ok: false, problem: "bad-signature" });
  });

  it("refuses when the provider publishes no key that could have signed it", async () => {
    publishedKeys = [];
    expect(await verify(mint({}))).toEqual({ ok: false, problem: "no-matching-key" });
    // A key of another type is not a candidate either.
    publishedKeys = [{ kty: "oct", k: "not-a-signing-key", kid: KEY_ID }];
    expect(await verify(mint({}))).toEqual({ ok: false, problem: "no-matching-key" });
  });

  it("picks the right key by kid when the provider is mid-rotation", async () => {
    // Both keys published, the new one first: the token names the one that
    // signed it, and a verifier that simply took the first would fail.
    publishedKeys = [publicJwk(strangerKeys.publicKey, "the-new-key"), publicJwk(keys.publicKey, KEY_ID)];
    expect((await verify(mint({}))).ok).toBe(true);
  });

  it("refuses a kid that names a key which did not sign it", async () => {
    publishedKeys = [publicJwk(strangerKeys.publicKey, "the-new-key")];
    expect(await verify(mint({ header: { kid: "the-new-key" } }))).toEqual({ ok: false, problem: "bad-signature" });
  });

  it("refuses a malformed token without reaching the provider", async () => {
    for (const bad of ["", "a", "a.b", "a.b.c.d", "...", "not.base64url.at-all"]) {
      const result = await verify(bad);
      expect(result.ok, bad).toBe(false);
      expect(["malformed", "algorithm-not-allowed"]).toContain(result.ok ? "" : result.problem);
    }
  });
});

describe("verifyIdToken: the claims, once the signature holds", () => {
  it("refuses a token minted for a different client", async () => {
    expect(await verify(mint({ claims: { aud: "some-other-app" } }))).toEqual({
      ok: false,
      problem: "audience-mismatch",
    });
  });

  it("refuses a replayed token: the nonce must be this sign-in's", async () => {
    const token = mint({});
    expect((await verify(token)).ok).toBe(true);
    // The same token, offered against a different request's nonce — which
    // is what a captured id_token is.
    expect(await verify(token, "a-different-nonce")).toEqual({ ok: false, problem: "nonce-mismatch" });
  });

  it("refuses an expired token even though it verifies", async () => {
    const stale = Math.floor(Date.now() / 1000) - 4000;
    expect(await verify(mint({ nowSeconds: stale, claims: { exp: stale + 300 } }))).toEqual({
      ok: false,
      problem: "expired",
    });
  });

  it("refuses a token whose issuer claim is not the configured issuer", async () => {
    expect(await verify(mint({ claims: { iss: "https://learning.elsewhere.example" } }))).toEqual({
      ok: false,
      problem: "issuer-mismatch",
    });
  });

  it("refuses a token with no subject", async () => {
    expect(await verify(mint({ claims: { sub: "" } }))).toEqual({ ok: false, problem: "subject-missing" });
  });
});

describe("exchangeCode over a socket", () => {
  it("posts the code, the verifier and the client secret as a form, and reads the id_token back", async () => {
    nextIdToken = mint({});
    const verifier = randomBytes(32).toString("base64url");
    const exchanged = await exchangeCode({ config: config(), code: "the-code", codeVerifier: verifier });

    expect(exchanged).toEqual({ idToken: nextIdToken });
    expect(lastToken?.contentType).toContain("application/x-www-form-urlencoded");
    expect(lastToken?.body).toEqual({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: `${h.env.APP_URL}/api/auth/oidc/callback`,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code_verifier: verifier,
    });
  });

  it("sends the secret in the body over the back channel, never in the URL", async () => {
    nextIdToken = mint({});
    await exchangeCode({ config: config(), code: "the-code", codeVerifier: "v" });
    // The whole reason the authorization-code flow is the one chosen: a
    // secret in a query string is a secret in an access log.
    expect(lastToken?.body.client_secret).toBe(CLIENT_SECRET);
  });

  it("answers null when the provider refuses the code", async () => {
    nextIdToken = null; // the server then answers 400 invalid_grant
    expect(await exchangeCode({ config: config(), code: "spent", codeVerifier: "v" })).toBeNull();
  });
});

describe("the whole way through, as the callback route runs it", () => {
  it("a code becomes a verified subject", async () => {
    // Exactly the callback's order: exchange, then verify, then (in the
    // route) look up a roster row. The subject is all that leaves here —
    // no claim from the provider becomes a field on an account.
    nextIdToken = mint({ claims: { sub: "lms-2116231001001" } });
    const exchanged = await exchangeCode({ config: config(), code: "the-code", codeVerifier: "the-verifier" });
    expect(exchanged).not.toBeNull();
    const verified = await verify(exchanged!.idToken);
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.claims.sub).toBe("lms-2116231001001");
  });

  it("a provider that mints a token for another client gets no further than the verifier", async () => {
    nextIdToken = mint({ claims: { aud: "some-other-app" } });
    const exchanged = await exchangeCode({ config: config(), code: "the-code", codeVerifier: "the-verifier" });
    expect((await verify(exchanged!.idToken)).ok).toBe(false);
  });
});
