import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SQL_JUDGE_VERSION } from "../src/version";

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
