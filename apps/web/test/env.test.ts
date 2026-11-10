import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/**
 * The server environment: what it accepts, what it refuses, and where a
 * secret may come from.
 *
 * Two of these refusals exist because of what reviewing the deployment made
 * obvious: `APP_URL` and `REDIS_URL` have development defaults that are not
 * merely unhelpful in production but silently wrong — links to `localhost`, and a rate limiter whose Redis is
 * not there, failing open exactly as designed and so leaving a production
 * deployment with no rate limiting and nothing to say so.
 *
 * `env()` caches, so every case re-imports the module with its own
 * environment.
 */

const dir = mkdtempSync(path.join(tmpdir(), "recx-web-env-"));
const original = process.env;
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  process.env = original;
});

/** Enough to parse: everything else in the schema has a default. */
const MINIMUM = {
  DATABASE_URL: "postgresql://recx:pw@127.0.0.1:5433/recx",
  IP_HASH_PEPPER: "a-pepper-of-at-least-16",
} as const;

/** What a real deployment must add on top. */
const PRODUCTION = {
  NODE_ENV: "production",
  APP_URL: "https://code.example.invalid",
  REDIS_URL: "redis://redis:6379",
  EXPORT_SIGNING_SECRET: "an-export-signing-secret-of-32-chars-or-more",
  EXAM_BROWSER_SECRET: "an-exam-browser-secret-of-32-characters-or-more",
} as const;

async function loadEnv(source: Record<string, string>) {
  vi.resetModules();
  process.env = { ...source } as NodeJS.ProcessEnv;
  const loaded = await import("@/lib/env");
  return loaded;
}

describe("the development defaults", () => {
  it("need only a database URL and a pepper", async () => {
    const { env } = await loadEnv({ ...MINIMUM });
    expect(env().APP_URL).toBe("http://localhost:3000");
    expect(env().REDIS_URL).toBe("redis://127.0.0.1:6379");
    expect(env().TESTDATA_DRIVER).toBe("local");
    expect(env().TRUST_PROXY).toBe(false);
  });
});

/**
 * Phase 15g: `AI_BASE_URL` may name several addresses, because a
 * super-admin picks among them and cannot add one. It is read by
 * `aiAllowedEndpoints`, which drops what it cannot use — so the point of
 * the refinement here is the deployment that mistypes its ONLY address and
 * would otherwise find out as "no endpoint configured" much later and
 * somewhere else.
 */
describe("the addresses an OpenAI-compatible model may be reached at", () => {
  it("takes one, or several separated by commas", async () => {
    const one = await loadEnv({ ...MINIMUM, AI_BASE_URL: "https://ai.example.invalid/v1" });
    expect(one.env().AI_BASE_URL).toBe("https://ai.example.invalid/v1");
    const many = await loadEnv({
      ...MINIMUM,
      AI_BASE_URL: "https://a.example.invalid/v1, https://b.example.invalid/v1",
    });
    expect(many.env().AI_BASE_URL).toContain("b.example.invalid");
    // A model on this box, which is how a college hosts one to begin with.
    const local = await loadEnv({ ...MINIMUM, AI_BASE_URL: "http://127.0.0.1:8000/v1" });
    expect(local.env().AI_BASE_URL).toBe("http://127.0.0.1:8000/v1");
  });

  it("refuses a deployment whose only address is not usable", async () => {
    // `env()` parses on first call, so that is where a refusal lands.
    const { env: notAUrl } = await loadEnv({ ...MINIMUM, AI_BASE_URL: "ai.example.invalid/v1" });
    expect(() => notAUrl()).toThrow(/AI_BASE_URL/);
    // Plain http anywhere but this machine: the key would cross the network
    // in the clear.
    const { env: plainHttp } = await loadEnv({ ...MINIMUM, AI_BASE_URL: "http://ai.example.invalid/v1" });
    expect(() => plainHttp()).toThrow(/AI_BASE_URL/);
  });
});

/**
 * Phase 16i. `docs/RUNBOOK.md` §2.21 tells an operator "all three or none —
 * the app refuses to start on a partial set", and a sentence in a runbook
 * that the code does not keep is worse than no sentence: somebody acts on
 * it. So the refusal is asserted here, both ways round.
 *
 * The reason the rule exists: a half-configured provider means a "Sign in
 * with REC Learning" link on the sign-in page that fails AFTER a redirect,
 * which for a student is worse than no link at all.
 */
describe("LMS sign-in is configured whole or not at all", () => {
  const LMS = {
    LMS_OIDC_ISSUER: "https://learning.example.invalid/oidc",
    LMS_OIDC_CLIENT_ID: "recx-web",
    // A value this test invents.
    LMS_OIDC_CLIENT_SECRET: "a-client-secret-for-a-test",
  } as const;

  it("accepts all three", async () => {
    const { env } = await loadEnv({ ...MINIMUM, ...LMS });
    expect(env().LMS_OIDC_ISSUER).toBe(LMS.LMS_OIDC_ISSUER);
    expect(env().LMS_OIDC_CLIENT_ID).toBe("recx-web");
  });

  it("accepts none of them", async () => {
    const { env } = await loadEnv({ ...MINIMUM });
    expect(env().LMS_OIDC_ISSUER).toBeUndefined();
  });

  it.each(Object.keys(LMS))("refuses a set missing %s", async (missing) => {
    const partial = { ...MINIMUM, ...LMS } as Record<string, string>;
    delete partial[missing];
    const { env } = await loadEnv(partial);
    expect(() => env()).toThrow(/LMS_OIDC_ISSUER, LMS_OIDC_CLIENT_ID and LMS_OIDC_CLIENT_SECRET/);
  });

  it("refuses an issuer that is not https, and allows a loopback one for a test provider", async () => {
    const { env: plainHttp } = await loadEnv({
      ...MINIMUM,
      ...LMS,
      LMS_OIDC_ISSUER: "http://learning.example.invalid/oidc",
    });
    expect(() => plainHttp()).toThrow(/LMS_OIDC_ISSUER/);

    // `apps/web/test/oidc-provider.test.ts` serves a provider on loopback,
    // which is the only reason plain http is admitted at all.
    const { env: loopback } = await loadEnv({ ...MINIMUM, ...LMS, LMS_OIDC_ISSUER: "http://127.0.0.1:41234" });
    expect(loopback().LMS_OIDC_ISSUER).toBe("http://127.0.0.1:41234");
  });
});

/**
 * Phase 16j. `docs/RUNBOOK.md` §2.22 says to generate 32 bytes with
 * `openssl rand -base64 32`, and the whole second factor rests on that key
 * being the right length — a short one would make AES-256-GCM refuse at the
 * first enrolment, from inside an action, long after the deploy.
 */
describe("the key a TOTP secret is encrypted under", () => {
  const key = (bytes: number, encoding: BufferEncoding = "base64") =>
    Buffer.alloc(bytes, 7).toString(encoding);

  it("accepts 32 bytes as base64, base64url or hex", async () => {
    for (const encoding of ["base64", "base64url", "hex"] as const) {
      const { env } = await loadEnv({ ...MINIMUM, TOTP_ENCRYPTION_KEY: key(32, encoding) });
      expect(env().TOTP_ENCRYPTION_KEY, encoding).toBe(key(32, encoding));
    }
  });

  it("is optional, because a second factor is", async () => {
    const { env } = await loadEnv({ ...MINIMUM });
    expect(env().TOTP_ENCRYPTION_KEY).toBeUndefined();
  });

  it("refuses a key of any other length, at boot rather than at an enrolment", async () => {
    for (const bytes of [16, 24, 31, 33, 64]) {
      const { env } = await loadEnv({ ...MINIMUM, TOTP_ENCRYPTION_KEY: key(bytes) });
      expect(() => env(), String(bytes)).toThrow(/TOTP_ENCRYPTION_KEY must decode to exactly 32 bytes/);
    }
    const { env: notAKey } = await loadEnv({ ...MINIMUM, TOTP_ENCRYPTION_KEY: "not a key at all" });
    expect(() => notAKey()).toThrow(/TOTP_ENCRYPTION_KEY/);
  });
});

describe("production refuses a variable it would otherwise default", () => {
  it("names APP_URL and REDIS_URL together, so one deploy fixes both", async () => {
    const { env } = await loadEnv({ ...MINIMUM, NODE_ENV: "production", EXPORT_SIGNING_SECRET: PRODUCTION.EXPORT_SIGNING_SECRET });
    let message = "";
    try {
      env();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("APP_URL");
    expect(message).toContain("REDIS_URL");
    expect(message).toContain("required in production");
  });

  it("accepts them once they are set", async () => {
    const { env } = await loadEnv({ ...MINIMUM, ...PRODUCTION });
    expect(env().APP_URL).toBe("https://code.example.invalid");
    expect(env().REDIS_URL).toBe("redis://redis:6379");
  });

  it("still refuses the development signing secret, and the unhardened-judge switch", async () => {
    const { env: withDevSecret } = await loadEnv({
      ...MINIMUM,
      ...PRODUCTION,
      EXPORT_SIGNING_SECRET: "dev-only-export-signing-secret-change-me",
    });
    expect(() => withDevSecret()).toThrow(/EXPORT_SIGNING_SECRET/);

    /**
     * Phase 14b: the same rule for the exam browser's root secret, and the
     * same reason. Every sitting key is derived from it, so a deployment
     * that never set it would derive them all from a string published in
     * this repository -- which is the shared-key flaw the design exists to
     * avoid, reintroduced by leaving a box empty.
     */
    const { env: withDevBrowserSecret } = await loadEnv({
      ...MINIMUM,
      ...PRODUCTION,
      EXAM_BROWSER_SECRET: "dev-only-exam-browser-secret-change-me",
    });
    expect(() => withDevBrowserSecret()).toThrow(/EXAM_BROWSER_SECRET/);

    const { env: withOverride } = await loadEnv({
      ...MINIMUM,
      ...PRODUCTION,
      JUDGE_ALLOW_UNHARDENED_NODES: "true",
    });
    expect(() => withOverride()).toThrow(/JUDGE_ALLOW_UNHARDENED_NODES/);
  });
});

describe("a secret handed over as a file", () => {
  it("is read, and left where Prisma will also find it", async () => {
    const file = path.join(dir, "database_url");
    const url = "postgresql://recx:from-a-secret@db:5432/recx";
    writeFileSync(file, `${url}\n`);

    const { env } = await loadEnv({
      IP_HASH_PEPPER: MINIMUM.IP_HASH_PEPPER,
      DATABASE_URL_FILE: file,
    });
    expect(env().DATABASE_URL).toBe(url);
    // The point of hydrating rather than copying: packages/db constructs the
    // Prisma client with no URL, so Prisma resolves DATABASE_URL itself.
    expect(process.env.DATABASE_URL).toBe(url);
  });

  it("is refused loudly when the file is missing, not defaulted", async () => {
    const { env } = await loadEnv({
      IP_HASH_PEPPER: MINIMUM.IP_HASH_PEPPER,
      DATABASE_URL_FILE: path.join(dir, "never-written"),
    });
    expect(() => env()).toThrow(/DATABASE_URL_FILE/);
  });
});
