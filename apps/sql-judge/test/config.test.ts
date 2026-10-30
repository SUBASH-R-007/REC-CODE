import { describe, expect, it } from "vitest";
import {
  ConfigError,
  FORBIDDEN_ENV_KEYS,
  forbiddenKeysPresent,
  parseConfig,
  sqlJudgeEnvShape,
} from "../src/config";

/**
 * The SQL judge is the one judge process that holds a database credential,
 * so what it must NOT hold is the thing worth testing.
 */

const BASE: NodeJS.ProcessEnv = {
  RECX_NODE_ID: "sql-1",
  RECX_NODE_TOKEN: "a".repeat(32),
  RECX_APP_URL: "http://127.0.0.1:3000/",
  REDIS_URL: "redis://127.0.0.1:6379",
  RECX_SQL_OWNER_URL: "postgresql://owner:pw@127.0.0.1:5433/recx_sql_sandbox",
  RECX_SQL_STUDENT_URL: "postgresql://student:pw@127.0.0.1:5433/recx_sql_sandbox",
};

describe("the environment it accepts", () => {
  it("parses the two sandbox URLs and nothing else is required", () => {
    const config = parseConfig({ ...BASE });
    expect(config.RECX_SQL_OWNER_URL).toContain("owner");
    expect(config.RECX_SQL_STUDENT_URL).toContain("student");
    // The trailing slash is trimmed, as the isolate worker's is.
    expect(config.RECX_APP_URL).toBe("http://127.0.0.1:3000");
    expect(config.RECX_QUEUES).toEqual(["judge-sql-practice", "judge-sql-run"]);
  });

  it("only accepts SQL queues", () => {
    expect(() => parseConfig({ ...BASE, RECX_QUEUES: "judge-practice" })).toThrow(ConfigError);
    expect(parseConfig({ ...BASE, RECX_QUEUES: "judge-sql-assessment" }).RECX_QUEUES).toEqual([
      "judge-sql-assessment",
    ]);
  });

  it("refuses one connection string used for both roles", () => {
    // Otherwise the student's statement runs as the schema's owner, and the
    // read-only promise is a comment.
    expect(() => parseConfig({ ...BASE, RECX_SQL_STUDENT_URL: BASE.RECX_SQL_OWNER_URL })).toThrow(
      /different role/,
    );
  });

  it("refuses something that is not a postgres URL", () => {
    expect(() => parseConfig({ ...BASE, RECX_SQL_OWNER_URL: "mysql://x/y" })).toThrow(ConfigError);
  });

  it("refuses the development override in production", () => {
    expect(() =>
      parseConfig({ ...BASE, NODE_ENV: "production", RECX_DEV_ALLOW_UNHARDENED_CLUSTER: "1" }),
    ).toThrow(/development switch/);
  });
});

describe("the credentials it must never hold", () => {
  it("refuses to start with any application secret in the environment", () => {
    for (const key of FORBIDDEN_ENV_KEYS) {
      expect(() => parseConfig({ ...BASE, [key]: "anything" }), key).toThrow(ConfigError);
      expect(() => parseConfig({ ...BASE, [key]: "anything" }), key).toThrow(key);
    }
  });

  it("names the application's database URL, auth secret, pepper and storage key", () => {
    // SPEC's anti-requirements, as a list this file can check.
    for (const key of ["DATABASE_URL", "AUTH_SECRET", "IP_HASH_PEPPER", "S3_SECRET_ACCESS_KEY"]) {
      expect(FORBIDDEN_ENV_KEYS as readonly string[]).toContain(key);
    }
  });

  it("ignores an empty value, so an unset-but-exported key is not a failure", () => {
    expect(forbiddenKeysPresent({ DATABASE_URL: "" })).toEqual([]);
    expect(forbiddenKeysPresent({ DATABASE_URL: "   " })).toEqual([]);
    expect(forbiddenKeysPresent({ DATABASE_URL: "postgres://x" })).toEqual(["DATABASE_URL"]);
  });

  it("has no key of its own that reads like an application credential", () => {
    const keys = Object.keys(sqlJudgeEnvShape);
    for (const key of keys) {
      expect(key, `${key} must not look like an application secret`).not.toMatch(
        /^(DATABASE_URL|AUTH_SECRET|IP_HASH_PEPPER|AI_API_KEY)/,
      );
    }
    // Its own two are unmistakably the sandbox's.
    expect(keys).toContain("RECX_SQL_OWNER_URL");
    expect(keys).toContain("RECX_SQL_STUDENT_URL");
  });
});
