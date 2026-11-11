import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two LMS sign-in routes (Phase 16i): what they set, what they clear,
 * and the ORDER in which the callback refuses.
 *
 * The provider itself is tested over a socket in `oidc-provider.test.ts`
 * and the claim rules in `packages/shared`. What is left — and what this
 * file is for — is the part of the flow that is about the browser rather
 * than the token: three cookies spent on arrival whatever happens next, a
 * `state` compared before a code is exchanged, and a refusal that lands on
 * the sign-in page as a CODE rather than as anything a provider put in a
 * query string.
 */

interface CookieSet {
  readonly name: string;
  readonly value: string;
  readonly options: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  env: {
    APP_URL: "http://localhost:3100",
    LMS_OIDC_ISSUER: "https://learning.example.edu" as string | undefined,
    LMS_OIDC_CLIENT_ID: "recx-web" as string | undefined,
    LMS_OIDC_CLIENT_SECRET: "a value this test invents" as string | undefined,
  },
  jar: new Map<string, string>(),
  sets: [] as CookieSet[],
  discover: vi.fn(async () => ({
    issuer: "https://learning.example.edu",
    authorizationEndpoint: "https://learning.example.edu/authorize",
    tokenEndpoint: "https://learning.example.edu/token",
    jwksUri: "https://learning.example.edu/jwks",
  })),
  exchangeCode: vi.fn(async () => ({ idToken: "the.id.token" }) as { idToken: string } | null),
  verifyIdToken: vi.fn(
    async () =>
      ({ ok: true, claims: { sub: "lms-1" } }) as
        | { ok: true; claims: { sub: string } }
        | { ok: false; problem: string },
  ),
  signIn: vi.fn(
    async (_subject: string) =>
      ({ ok: true, home: "/dashboard" }) as { ok: true; home: string } | { ok: false; failure: string },
  ),
}));

vi.mock("@/lib/env", () => ({ env: () => h.env, isProduction: () => false }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      h.sets.push({ name, value, options });
      if (options?.maxAge === 0) h.jar.delete(name);
      else h.jar.set(name, value);
    },
  }),
}));
/**
 * The verifying half is stubbed HERE and only here: this file is about the
 * route's control flow, and a real provider would make every case below
 * depend on a socket it is not testing. `lmsSignInConfig` is NOT stubbed —
 * the "not switched on" case has to be the real predicate reading the real
 * environment, or it proves nothing about the deployment switch.
 */
vi.mock("@/lib/auth/oidc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/oidc")>("@/lib/auth/oidc");
  return {
    ...actual,
    discover: h.discover,
    exchangeCode: h.exchangeCode,
    verifyIdToken: h.verifyIdToken,
  };
});
vi.mock("@/lib/auth/sign-in", () => ({ signInWithLmsSubject: h.signIn }));

const start = await import("@/app/api/auth/oidc/start/route");
const callback = await import("@/app/api/auth/oidc/callback/route");
/**
 * From `lib/auth/oidc-cookies.ts` and NOT from the route: a Next.js
 * `route.ts` may export only route fields, and exporting a constant from
 * one is a build error `tsc --noEmit` cannot see (it lives in the types
 * Next generates during a build). The gate caught it; this import is where
 * the names live now.
 */
const cookieNames = await import("@/lib/auth/oidc-cookies");
const COOKIES = cookieNames.OIDC_COOKIES;

beforeEach(() => {
  h.jar.clear();
  h.sets.length = 0;
  h.env.LMS_OIDC_ISSUER = "https://learning.example.edu";
  h.env.LMS_OIDC_CLIENT_ID = "recx-web";
  h.env.LMS_OIDC_CLIENT_SECRET = "a value this test invents";
  h.discover.mockClear();
  h.exchangeCode.mockClear();
  h.exchangeCode.mockResolvedValue({ idToken: "the.id.token" });
  h.verifyIdToken.mockClear();
  h.verifyIdToken.mockResolvedValue({ ok: true, claims: { sub: "lms-1" } });
  h.signIn.mockClear();
  h.signIn.mockResolvedValue({ ok: true, home: "/dashboard" });
});

/** The Location of a redirect response, relative to the app. */
function destination(response: Response): string {
  const location = response.headers.get("location") ?? "";
  return location.startsWith(h.env.APP_URL) ? location.slice(h.env.APP_URL.length) : location;
}

const hit = (query: string) =>
  callback.GET(new Request(`http://localhost:3100/api/auth/oidc/callback${query}`, { method: "GET" }));

const quiet = () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return () => {
    warn.mockRestore();
    error.mockRestore();
  };
};

describe("GET /api/auth/oidc/start", () => {
  it("sets three httpOnly cookies scoped to the callback path and redirects to the provider", async () => {
    const response = await start.GET();
    expect(response.status).toBe(303);
    const authorize = new URL(response.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe("https://learning.example.edu/authorize");
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

    expect(h.sets.map((c) => c.name).sort()).toEqual([...COOKIES].sort());
    for (const cookie of h.sets) {
      expect(cookie.options.httpOnly, cookie.name).toBe(true);
      expect(cookie.options.sameSite, cookie.name).toBe("lax");
      expect(cookie.options.path, cookie.name).toBe("/api/auth/oidc");
      expect(cookie.options.maxAge, cookie.name).toBe(600);
      expect(cookie.value.length, cookie.name).toBeGreaterThanOrEqual(32);
    }
  });

  it("the challenge in the URL is the SHA-256 of a verifier the browser never sees", async () => {
    const response = await start.GET();
    const challenge = new URL(response.headers.get("location")!).searchParams.get("code_challenge")!;
    const verifier = h.sets.find((c) => c.name === cookieNames.OIDC_VERIFIER_COOKIE)!.value;
    const { createHash } = await import("node:crypto");
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    // And the verifier is not in the URL, which is the whole point of PKCE.
    expect(response.headers.get("location")).not.toContain(verifier);
  });

  it("mints a different state and nonce every time", async () => {
    await start.GET();
    const first = h.sets.map((c) => c.value);
    h.sets.length = 0;
    await start.GET();
    expect(h.sets.map((c) => c.value)).not.toEqual(first);
  });

  it("goes nowhere near a provider when LMS sign-in is not configured", async () => {
    h.env.LMS_OIDC_CLIENT_SECRET = undefined;
    const response = await start.GET();
    expect(destination(response)).toContain("error=lms-off");
    expect(h.discover).not.toHaveBeenCalled();
    expect(h.sets).toEqual([]);
  });

  it("a provider that cannot be reached is lms-unavailable, and sets no cookies", async () => {
    const restore = quiet();
    h.discover.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const response = await start.GET();
    expect(destination(response)).toContain("error=lms-unavailable");
    expect(h.sets).toEqual([]);
    restore();
  });
});

describe("GET /api/auth/oidc/callback", () => {
  /** Put a browser mid-sign-in: the three cookies /start would have set. */
  function midFlow(): void {
    h.jar.set(cookieNames.OIDC_STATE_COOKIE, "the-state");
    h.jar.set(cookieNames.OIDC_NONCE_COOKIE, "the-nonce");
    h.jar.set(cookieNames.OIDC_VERIFIER_COOKIE, "the-verifier");
  }

  it("signs the candidate in and sends them to their role's home", async () => {
    midFlow();
    const response = await hit("?code=the-code&state=the-state");
    expect(destination(response)).toBe("/dashboard");
    expect(h.exchangeCode).toHaveBeenCalledWith(expect.objectContaining({ code: "the-code", codeVerifier: "the-verifier" }));
    expect(h.verifyIdToken).toHaveBeenCalledWith("the.id.token", expect.objectContaining({ nonce: "the-nonce" }));
    expect(h.signIn).toHaveBeenCalledWith("lms-1");
  });

  it("clears all three cookies on the way in, on EVERY path", async () => {
    // A state that survives a failed attempt is a state somebody can
    // retry, so this is asserted for a success and for each refusal.
    const restore = quiet();
    const cases: Array<[string, () => void]> = [
      ["success", () => h.signIn.mockResolvedValue({ ok: true, home: "/dashboard" })],
      ["state mismatch", () => undefined],
      ["exchange refused", () => h.exchangeCode.mockResolvedValue(null)],
      ["token rejected", () => h.verifyIdToken.mockResolvedValue({ ok: false, problem: "bad-signature" })],
      ["not enrolled", () => h.signIn.mockResolvedValue({ ok: false, failure: "not-enrolled" })],
      ["thrown", () => h.exchangeCode.mockRejectedValue(new Error("socket hang up"))],
    ];
    for (const [label, arrange] of cases) {
      h.jar.clear();
      h.sets.length = 0;
      h.exchangeCode.mockResolvedValue({ idToken: "the.id.token" });
      h.verifyIdToken.mockResolvedValue({ ok: true, claims: { sub: "lms-1" } });
      h.signIn.mockResolvedValue({ ok: true, home: "/dashboard" });
      arrange();
      midFlow();
      await hit(label === "state mismatch" ? "?code=c&state=somebody-elses-state" : "?code=c&state=the-state");
      const cleared = h.sets.filter((c) => c.options.maxAge === 0 && c.value === "");
      expect(cleared.map((c) => c.name).sort(), label).toEqual([...COOKIES].sort());
      for (const cookie of cleared) expect(cookie.options.path, `${label}: ${cookie.name}`).toBe("/api/auth/oidc");
      expect(h.jar.size, `${label}: nothing left in the jar`).toBe(0);
    }
    restore();
  });

  it("refuses a state that is not this browser's, before exchanging anything", async () => {
    midFlow();
    const response = await hit("?code=the-code&state=somebody-elses-state");
    expect(destination(response)).toContain("error=lms-failed");
    // The point of the ordering: a forged callback costs the provider
    // nothing and this app one redirect.
    expect(h.exchangeCode).not.toHaveBeenCalled();
    expect(h.signIn).not.toHaveBeenCalled();
  });

  it("refuses a callback with no cookies as lms-expired — the ten minutes ran out", async () => {
    const response = await hit("?code=the-code&state=the-state");
    expect(destination(response)).toContain("error=lms-expired");
    expect(h.exchangeCode).not.toHaveBeenCalled();
  });

  it("refuses a callback with no code or no state", async () => {
    midFlow();
    expect(destination(await hit("?state=the-state"))).toContain("error=lms-failed");
    midFlow();
    expect(destination(await hit("?code=the-code"))).toContain("error=lms-failed");
    expect(h.exchangeCode).not.toHaveBeenCalled();
  });

  it("never renders what the provider put in the query string", async () => {
    const restore = quiet();
    midFlow();
    const response = await hit("?error=" + encodeURIComponent("<b>access_denied by the admin</b>"));
    // A code, not a message: nothing from a redirect reaches the page.
    expect(destination(response)).toBe("/login?error=lms-failed");
    expect(response.headers.get("location")).not.toContain("access_denied");
    expect(h.exchangeCode).not.toHaveBeenCalled();
    restore();
  });

  it("a rejected id_token is lms-failed, and the reason is never in the URL", async () => {
    const restore = quiet();
    midFlow();
    h.verifyIdToken.mockResolvedValue({ ok: false, problem: "algorithm-not-allowed" });
    const response = await hit("?code=the-code&state=the-state");
    expect(destination(response)).toBe("/login?error=lms-failed");
    expect(response.headers.get("location")).not.toContain("algorithm");
    expect(h.signIn).not.toHaveBeenCalled();
    restore();
  });

  it("a subject with no roster row is told to see their department", async () => {
    midFlow();
    h.signIn.mockResolvedValue({ ok: false, failure: "not-enrolled" });
    expect(destination(await hit("?code=the-code&state=the-state"))).toBe("/login?error=lms-not-enrolled");
  });

  it("a suspended account is told its own thing", async () => {
    midFlow();
    h.signIn.mockResolvedValue({ ok: false, failure: "inactive" });
    expect(destination(await hit("?code=the-code&state=the-state"))).toBe("/login?error=lms-inactive");
  });

  it("refuses everything when LMS sign-in is not configured, cookies or no cookies", async () => {
    h.env.LMS_OIDC_ISSUER = undefined;
    midFlow();
    const response = await hit("?code=the-code&state=the-state");
    expect(destination(response)).toBe("/login?error=lms-off");
    expect(h.exchangeCode).not.toHaveBeenCalled();
    // Still spent: a deployment that switches LMS sign-in off mid-flow
    // should not leave a usable state cookie behind.
    expect(h.jar.size).toBe(0);
  });

  it("a thrown exchange is lms-failed and is logged, not surfaced", async () => {
    const restore = quiet();
    midFlow();
    h.exchangeCode.mockRejectedValue(new Error("socket hang up"));
    const response = await hit("?code=the-code&state=the-state");
    expect(destination(response)).toBe("/login?error=lms-failed");
    expect(response.headers.get("location")).not.toContain("socket");
    restore();
  });

  it("every refusal lands on /login, which still offers the password form", async () => {
    const restore = quiet();
    const seen = new Set<string>();
    const arrangements: Array<() => void> = [
      () => h.exchangeCode.mockResolvedValue(null),
      () => h.verifyIdToken.mockResolvedValue({ ok: false, problem: "expired" }),
      () => h.signIn.mockResolvedValue({ ok: false, failure: "not-enrolled" }),
      () => h.signIn.mockResolvedValue({ ok: false, failure: "inactive" }),
    ];
    for (const arrange of arrangements) {
      h.exchangeCode.mockResolvedValue({ idToken: "the.id.token" });
      h.verifyIdToken.mockResolvedValue({ ok: true, claims: { sub: "lms-1" } });
      h.signIn.mockResolvedValue({ ok: true, home: "/dashboard" });
      arrange();
      midFlow();
      const where = destination(await hit("?code=the-code&state=the-state"));
      expect(where.startsWith("/login?error=lms-")).toBe(true);
      seen.add(where);
    }
    expect(seen.size).toBe(3); // failed, not-enrolled, inactive
    restore();
  });
});

describe("the sentences the page shows", () => {
  it("every lms-* code the routes can emit has a message", async () => {
    const { signInErrorMessage } = await import("@/lib/auth/sign-in-errors");
    for (const code of ["lms-off", "lms-unavailable", "lms-failed", "lms-expired", "lms-not-enrolled", "lms-inactive"]) {
      const message = signInErrorMessage(code);
      expect(message, code).toBeTruthy();
      expect(message!.length, code).toBeGreaterThan(20);
    }
  });

  it("the not-enrolled and inactive sentences are the ones @recx/shared defines", async () => {
    const { signInErrorMessage } = await import("@/lib/auth/sign-in-errors");
    const { OIDC_MESSAGES } = await import("@recx/shared/oidc");
    // Two copies of a sentence is two things to keep in step; the fence is
    // that they must match exactly.
    expect(signInErrorMessage("lms-not-enrolled")).toBe(OIDC_MESSAGES.notEnrolled);
    expect(signInErrorMessage("lms-inactive")).toBe(OIDC_MESSAGES.inactive);
    expect(signInErrorMessage("lms-failed")).toBe(OIDC_MESSAGES.failed);
    expect(signInErrorMessage("lms-expired")).toBe(OIDC_MESSAGES.expired);
    expect(signInErrorMessage("lms-off")).toBe(OIDC_MESSAGES.disabled);
  });

  it("tells a student nothing about whether an account exists", async () => {
    const { signInErrorMessage } = await import("@/lib/auth/sign-in-errors");
    // "no REC Code account for you yet" is said for a subject the roster
    // does not know AND for one it never knew — the route cannot
    // distinguish them and the sentence does not try.
    expect(signInErrorMessage("lms-not-enrolled")).not.toMatch(/does not exist|unknown|invalid/i);
  });
});
