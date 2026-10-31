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
