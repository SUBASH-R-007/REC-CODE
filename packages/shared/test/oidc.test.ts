import { describe, expect, it } from "vitest";
import {
  OIDC_ALG,
  OIDC_CLOCK_LEEWAY_SECONDS,
  OIDC_MAX_TOKEN_AGE_SECONDS,
  OIDC_SCOPE,
  authorizeUrl,
  idTokenClaimProblem,
  isAllowedEndpoint,
  lmsSignInOffered,
  readDiscovery,
} from "../src/oidc";

/**
 * The half of LMS sign-in with no I/O in it (Phase 16i).
 *
 * Every refusal here is one somebody has shipped a CVE for: a discovery
 * document that answers for a different issuer, a token minted for another
 * client, a replayed token, a token whose `iat` is a year old. They are
 * cheap to check and each one is a way in if it is missing, so each one is
 * a case below rather than a line in a comment.
 *
 * The signature itself is checked in apps/web/test/oidc-provider.test.ts,
 * against a provider served on loopback with a key generated in-process:
 * `alg: none`, an algorithm swap and a wrong key all need a real verifier
 * to be worth testing.
 */

const ISSUER = "https://learning.example.edu/oidc";
const CLIENT = "recx-web";

/** A discovery document that passes, which each case then breaks one way. */
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

/** Claims that pass, which each case then breaks one way. */
const NOW = 1_800_000_000;
const CLAIMS = { iss: ISSUER, sub: "lms-99", aud: CLIENT, exp: NOW + 300, iat: NOW - 5, nonce: "the-nonce" };
const check = (claims: Record<string, unknown>, nowSeconds = NOW) =>
  idTokenClaimProblem({ claims, issuer: ISSUER, clientId: CLIENT, nonce: "the-nonce", nowSeconds });

describe("isAllowedEndpoint", () => {
  it("accepts https anywhere", () => {
    expect(isAllowedEndpoint("https://learning.example.edu/token")).toBe(true);
  });

  it("accepts http only on loopback, which is what lets a test serve a provider", () => {
    expect(isAllowedEndpoint("http://127.0.0.1:41234/token")).toBe(true);
    expect(isAllowedEndpoint("http://localhost:41234/token")).toBe(true);
  });

  it("refuses plain http elsewhere, and anything that is not a URL", () => {
    expect(isAllowedEndpoint("http://learning.example.edu/token")).toBe(false);
    // The ones that matter: a hostname that merely CONTAINS a loopback name.
    expect(isAllowedEndpoint("http://localhost.evil.example/token")).toBe(false);
    expect(isAllowedEndpoint("http://127.0.0.1.evil.example/token")).toBe(false);
    for (const bad of ["", "not a url", "/token", "javascript:alert(1)", "ftp://x/y", 42, null, undefined]) {
      expect(isAllowedEndpoint(bad)).toBe(false);
    }
  });
});

describe("readDiscovery", () => {
  it("reads a well-formed document", () => {
    const result = readDiscovery(DISCOVERY, ISSUER);
    expect(result).toEqual({
      ok: true,
      discovery: {
        issuer: ISSUER,
        authorizationEndpoint: `${ISSUER}/authorize`,
        tokenEndpoint: `${ISSUER}/token`,
        jwksUri: `${ISSUER}/jwks`,
      },
    });
  });

  it("tolerates a trailing slash on either side, and nothing else about the issuer", () => {
    expect(readDiscovery({ ...DISCOVERY, issuer: `${ISSUER}/` }, ISSUER).ok).toBe(true);
    expect(readDiscovery(DISCOVERY, `${ISSUER}/`).ok).toBe(true);
    // A prefix is not a match: this is the check that makes a document
    // fetched from the configured issuer prove it is that issuer's.
    expect(readDiscovery({ ...DISCOVERY, issuer: `${ISSUER}.evil.example` }, ISSUER)).toEqual({
      ok: false,
      problem: "issuer-mismatch",
    });
  });

  it.each([
    [{}, "issuer-missing"],
    [{ issuer: "" }, "issuer-missing"],
    [{ ...DISCOVERY, issuer: "https://elsewhere.example" }, "issuer-mismatch"],
    [{ ...DISCOVERY, authorization_endpoint: undefined }, "authorization-endpoint-missing"],
    [{ ...DISCOVERY, token_endpoint: undefined }, "token-endpoint-missing"],
    [{ ...DISCOVERY, jwks_uri: undefined }, "jwks-uri-missing"],
    [{ ...DISCOVERY, token_endpoint: "http://learning.example.edu/token" }, "endpoint-not-https"],
    [{ ...DISCOVERY, jwks_uri: "http://learning.example.edu/jwks" }, "endpoint-not-https"],
  ] as const)("refuses %#", (document, problem) => {
    expect(readDiscovery(document, ISSUER)).toEqual({ ok: false, problem });
  });

  it("refuses something that is not an object at all", () => {
    for (const value of [null, undefined, "", "{}", 7]) {
      expect(readDiscovery(value, ISSUER).ok).toBe(false);
    }
  });
});

describe("authorizeUrl", () => {
  const url = new URL(
    authorizeUrl({
      authorizationEndpoint: `${ISSUER}/authorize`,
      clientId: CLIENT,
      redirectUri: "https://code.example.edu/api/auth/oidc/callback",
      state: "the-state",
      nonce: "the-nonce",
      codeChallenge: "the-challenge",
    }),
  );

  it("asks for a code with PKCE S256 and nothing else", () => {
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("the-challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    // No implicit and no hybrid: the id_token must not be able to arrive
    // through the browser, where it would land in a history entry.
    expect(url.searchParams.get("response_type")).not.toContain("token");
    expect(url.searchParams.has("response_mode")).toBe(false);
  });

  it("carries the client, redirect, scope, state and nonce", () => {
    expect(url.searchParams.get("client_id")).toBe(CLIENT);
    expect(url.searchParams.get("redirect_uri")).toBe("https://code.example.edu/api/auth/oidc/callback");
    expect(url.searchParams.get("scope")).toBe(OIDC_SCOPE);
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("nonce")).toBe("the-nonce");
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });

  it("asks for no scope beyond identity — no grades, no enrolments, no roster", () => {
    expect(OIDC_SCOPE.split(" ").sort()).toEqual(["email", "openid", "profile"]);
  });

  it("keeps the endpoint's own host and path", () => {
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
  });
});

describe("idTokenClaimProblem", () => {
  it("passes a token that is everything it should be", () => {
    expect(check(CLAIMS)).toBeNull();
  });

  it("refuses another issuer's token, and a sub that is missing or empty", () => {
    expect(check({ ...CLAIMS, iss: "https://elsewhere.example" })).toBe("issuer-mismatch");
    expect(check({ ...CLAIMS, iss: undefined })).toBe("issuer-mismatch");
    expect(check({ ...CLAIMS, sub: "" })).toBe("subject-missing");
    expect(check({ ...CLAIMS, sub: 99 })).toBe("subject-missing");
  });

  it("refuses a token minted for a different client, array audience included", () => {
    expect(check({ ...CLAIMS, aud: "some-other-app" })).toBe("audience-mismatch");
    expect(check({ ...CLAIMS, aud: ["some-other-app"] })).toBe("audience-mismatch");
    expect(check({ ...CLAIMS, aud: undefined })).toBe("audience-mismatch");
    // An array containing this client is fine — the spec allows it, and a
    // provider that lists two audiences is not thereby untrustworthy.
    expect(check({ ...CLAIMS, aud: ["some-other-app", CLIENT] })).toBeNull();
  });

  it("refuses an expired token, and allows exactly the configured leeway", () => {
    expect(check({ ...CLAIMS, exp: undefined })).toBe("expiry-missing");
    expect(check({ ...CLAIMS, exp: "soon" })).toBe("expiry-missing");
    const expired = { ...CLAIMS, exp: NOW, iat: NOW - 5 };
    // Inside the leeway: still accepted, because the clocks are two
    // machines' and a minute of drift is not an attack.
    expect(check(expired, NOW + OIDC_CLOCK_LEEWAY_SECONDS - 1)).toBeNull();
    expect(check(expired, NOW + OIDC_CLOCK_LEEWAY_SECONDS)).toBe("expired");
  });

  it("refuses a token issued in the future beyond the leeway", () => {
    expect(check({ ...CLAIMS, iat: NOW + OIDC_CLOCK_LEEWAY_SECONDS })).toBeNull();
    expect(check({ ...CLAIMS, iat: NOW + OIDC_CLOCK_LEEWAY_SECONDS + 1 })).toBe("issued-in-the-future");
  });

  it("refuses a token older than the maximum age even when it has not expired", () => {
    const old = OIDC_MAX_TOKEN_AGE_SECONDS + OIDC_CLOCK_LEEWAY_SECONDS;
    // `exp` far away on purpose: a provider that mints hour-long id_tokens
    // must not give somebody an hour to use a captured one.
    expect(check({ ...CLAIMS, iat: NOW - old, exp: NOW + 100_000 })).toBeNull();
    expect(check({ ...CLAIMS, iat: NOW - old - 1, exp: NOW + 100_000 })).toBe("too-old");
  });

  it("ignores an iat that is not a number rather than refusing the token", () => {
    // `iat` is optional in practice; the expiry check is the one that is
    // not negotiable, and it has already run by here.
    expect(check({ ...CLAIMS, iat: undefined })).toBeNull();
    expect(check({ ...CLAIMS, iat: "yesterday" })).toBeNull();
  });

  it("refuses a replayed token: the nonce must be this request's", () => {
    expect(check({ ...CLAIMS, nonce: "a-nonce-from-an-earlier-sign-in" })).toBe("nonce-mismatch");
    expect(check({ ...CLAIMS, nonce: undefined })).toBe("nonce-mismatch");
    expect(check({ ...CLAIMS, nonce: "" })).toBe("nonce-mismatch");
  });

  it("checks the issuer first, so a stranger's token fails on being a stranger's", () => {
    // Everything wrong at once: the reported problem is the first one in
    // the order the function applies, which is the order a reader of a log
    // needs — whose token this is before whether it is fresh.
    expect(check({ iss: "https://elsewhere.example", aud: "other", exp: 1, nonce: "x" })).toBe("issuer-mismatch");
  });
});

describe("the algorithm is an allow-list of one", () => {
  it("is RS256", () => {
    expect(OIDC_ALG).toBe("RS256");
  });
});

describe("lmsSignInOffered", () => {
  const full = { LMS_OIDC_ISSUER: ISSUER, LMS_OIDC_CLIENT_ID: CLIENT, LMS_OIDC_CLIENT_SECRET: "a value this test invents" };

  it("is true only with all three", () => {
    expect(lmsSignInOffered(full)).toBe(true);
    expect(lmsSignInOffered({})).toBe(false);
    for (const key of Object.keys(full) as Array<keyof typeof full>) {
      expect(lmsSignInOffered({ ...full, [key]: undefined }), key).toBe(false);
      expect(lmsSignInOffered({ ...full, [key]: "   " }), `${key} blank`).toBe(false);
    }
  });
});
