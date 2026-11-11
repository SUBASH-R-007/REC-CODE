import { describe, expect, it } from "vitest";
import {
  MAX_CUSTOM_INPUT_BYTES,
  MAX_SOURCE_BYTES,
  fitsUtf8,
  runCodeSchema,
  submitSolutionSchema,
} from "@/lib/judge/submit-schema";

const KB = 1024;

function submit(source: string) {
  return submitSolutionSchema.safeParse({ slug: "two-sum", language: "cpp20", source });
}

function firstMessage(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.error?.issues[0]?.message;
}

describe("submitSolutionSchema", () => {
  it("accepts a normal submission", () => {
    const result = submit("class Solution {};\n");
    expect(result.success).toBe(true);
  });

  it("caps source at exactly 256 KB of UTF-8", () => {
    expect(MAX_SOURCE_BYTES).toBe(256 * KB);
    expect(submit("a".repeat(256 * KB)).success).toBe(true);
    expect(submit("a".repeat(256 * KB + 1)).success).toBe(false);
  });

  it("rejects a 257 KB source with a friendly message", () => {
    const result = submit("x".repeat(257 * KB));
    expect(result.success).toBe(false);
    expect(firstMessage(result)).toMatch(/256 KB/);
  });

  it("counts multi-byte characters as bytes, not string length", () => {
    // "é" is 1 UTF-16 unit but 2 UTF-8 bytes: 128 Ki of them is exactly 256 KB.
    expect(submit("é".repeat(128 * KB)).success).toBe(true);
    expect(submit("é".repeat(128 * KB + 1)).success).toBe(false);
    // "€" is 3 bytes; 100 Ki characters is 300 KB although .length is 100 Ki.
    const euros = "€".repeat(100 * KB);
    expect(euros.length).toBeLessThan(MAX_SOURCE_BYTES);
    expect(submit(euros).success).toBe(false);
    // An emoji is 2 UTF-16 units and 4 bytes.
    expect(fitsUtf8("😀".repeat(64 * KB), MAX_SOURCE_BYTES)).toBe(true);
    expect(fitsUtf8("😀".repeat(64 * KB) + "a", MAX_SOURCE_BYTES)).toBe(false);
  });

  it("rejects empty or whitespace-only source", () => {
    expect(submit("").success).toBe(false);
    expect(submit("  \n\t ").success).toBe(false);
  });

  it("rejects NUL characters (Postgres text cannot store them)", () => {
    expect(submit("int main() {}\u0000").success).toBe(false);
  });

  it("only accepts catalog language keys", () => {
    const bad = submitSolutionSchema.safeParse({ slug: "two-sum", language: "cobol", source: "x" });
    expect(bad.success).toBe(false);
    expect(firstMessage(bad)).toBe("Choose a supported language.");
    for (const language of ["cpp20", "py312"]) {
      expect(submitSolutionSchema.safeParse({ slug: "two-sum", language, source: "x" }).success).toBe(true);
    }
  });

  it("validates the slug shape", () => {
    for (const slug of ["", "Two-Sum", "two_sum", "../etc", "two--sum", "-two"]) {
      expect(submitSolutionSchema.safeParse({ slug, language: "cpp20", source: "x" }).success).toBe(false);
    }
  });
});

describe("runCodeSchema", () => {
  const run = (customInput: unknown) =>
    runCodeSchema.safeParse({ slug: "two-sum", language: "py312", source: "print(1)", customInput });

  it("accepts null (run the samples) and a small custom input", () => {
    expect(run(null).success).toBe(true);
    expect(run("[2,7,11,15]\n9\n").success).toBe(true);
    expect(run("").success).toBe(true);
  });

  it("requires customInput to be present (null or a string)", () => {
    expect(run(undefined).success).toBe(false);
    expect(run(42).success).toBe(false);
  });

  it("caps custom input at 64 KB of UTF-8", () => {
    expect(MAX_CUSTOM_INPUT_BYTES).toBe(64 * KB);
    expect(run("1".repeat(64 * KB)).success).toBe(true);
    expect(run("1".repeat(64 * KB + 1)).success).toBe(false);
    expect(run("é".repeat(32 * KB + 1)).success).toBe(false);
  });
});
