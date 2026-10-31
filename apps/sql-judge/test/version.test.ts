import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SQL_JUDGE_VERSION, engineVersionOf } from "../src/version";

describe("the version it reports", () => {
  it("is the one in package.json", () => {
    // A constant, so the bundled dist/main.js needs no package.json at
    // runtime — and this test is what keeps the two equal.
    const manifest = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(SQL_JUDGE_VERSION).toBe(manifest.version);
  });
});

describe("engineVersionOf", () => {
  it("keeps the version and drops the packaging build", () => {
    // What a Debian/Ubuntu package reports in server_version.
    expect(engineVersionOf("17.11 (Ubuntu 17.11-1.pgdg24.04+2)")).toBe("PostgreSQL 17.11");
    expect(engineVersionOf("17.6")).toBe("PostgreSQL 17.6");
  });

  it("says so rather than inventing one", () => {
    expect(engineVersionOf(undefined)).toBe("PostgreSQL unknown");
    expect(engineVersionOf("   ")).toBe("PostgreSQL unknown");
  });
});
