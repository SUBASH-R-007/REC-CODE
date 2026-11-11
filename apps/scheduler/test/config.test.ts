import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEV_ENV_FILES, describeDatabaseUrl, loadConfig, withSingleConnection } from "../src/config";

const DIRECT = "postgresql://recx:pw@db.internal:5432/recx";
const POOLED = "postgresql://recx:pw@pgbouncer.internal:6432/recx?pgbouncer=true&connection_limit=10";

describe("loadConfig", () => {
  it("prefers DATABASE_URL_DIRECT", () => {
    const config = loadConfig({ NODE_ENV: "production", DATABASE_URL_DIRECT: DIRECT, DATABASE_URL: POOLED, REDIS_URL: "redis://cache:6379" });
    expect(config.databaseUrl).toBe(DIRECT);
    expect(config.databaseUrlSource).toBe("DATABASE_URL_DIRECT");
    expect(config.redisUrl).toBe("redis://cache:6379");
  });

  it("falls back to DATABASE_URL in development only", () => {
    const config = loadConfig({ NODE_ENV: "development", DATABASE_URL: DIRECT });
    expect(config.databaseUrl).toBe(DIRECT);
    expect(config.databaseUrlSource).toBe("DATABASE_URL");
    expect(config.redisUrl).toBe("redis://127.0.0.1:6379");
  });

  it("treats an unset NODE_ENV as development", () => {
    expect(loadConfig({ DATABASE_URL: DIRECT }).nodeEnv).toBe("development");
  });

  it("requires DATABASE_URL_DIRECT in production and test", () => {
    expect(() => loadConfig({ NODE_ENV: "production", DATABASE_URL: DIRECT, REDIS_URL: "redis://cache:6379" })).toThrow(
      /DATABASE_URL_DIRECT/,
    );
    expect(() => loadConfig({ NODE_ENV: "test", DATABASE_URL: DIRECT })).toThrow(/DATABASE_URL_DIRECT/);
  });

  it("requires some database URL in development", () => {
    expect(() => loadConfig({ NODE_ENV: "development" })).toThrow(/DATABASE_URL_DIRECT/);
  });

  it("rejects a PgBouncer URL, directly or as the development fallback", () => {
    expect(() => loadConfig({ NODE_ENV: "production", DATABASE_URL_DIRECT: POOLED, REDIS_URL: "redis://cache:6379" })).toThrow(
      /non-pooled/,
    );
    expect(() => loadConfig({ NODE_ENV: "development", DATABASE_URL: POOLED })).toThrow(/non-pooled/);
  });

  it("requires REDIS_URL in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production", DATABASE_URL_DIRECT: DIRECT })).toThrow(/REDIS_URL/);
  });

  it("rejects malformed URLs", () => {
    expect(() => loadConfig({ DATABASE_URL_DIRECT: "mysql://x/y" })).toThrow(/postgres/);
    expect(() => loadConfig({ DATABASE_URL: DIRECT, REDIS_URL: "localhost:6379" })).toThrow(/redis/);
  });

  it("validates LOG_LEVEL", () => {
    expect(loadConfig({ DATABASE_URL: DIRECT, LOG_LEVEL: "debug" }).logLevel).toBe("debug");
    expect(() => loadConfig({ DATABASE_URL: DIRECT, LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
  });
});

describe("withSingleConnection", () => {
  it("pins the pool to one connection and keeps other parameters", () => {
    const url = new URL(withSingleConnection("postgresql://recx:p%40ss@localhost:5433/recx?sslmode=disable&connection_limit=9"));
    expect(url.searchParams.get("connection_limit")).toBe("1");
    expect(url.searchParams.get("sslmode")).toBe("disable");
    expect(url.password).toBe("p%40ss");
    expect(url.pathname).toBe("/recx");
  });
});

describe("describeDatabaseUrl", () => {
  it("names the host and database without the credentials", () => {
    const described = describeDatabaseUrl("postgresql://recx:s3cret@localhost:5433/recx?connection_limit=1");
    expect(described).toBe("localhost:5433/recx");
    expect(described).not.toContain("s3cret");
  });
});

describe("DEV_ENV_FILES", () => {
  it("tries the scheduler's own .env.local before the web app's", () => {
    const packageDir = fileURLToPath(new URL("..", import.meta.url));
    expect(DEV_ENV_FILES.map((f) => path.relative(packageDir, f))).toEqual([
      ".env.local",
      path.join("..", "web", ".env.local"),
    ]);
  });
});
