import { describe, expect, it } from "vitest";
import { LIMITS, type TestResult } from "@recx/shared";
import {
  buildRunResult,
  buildSubmissionDetails,
  compactTestResults,
  truncateBytes,
  utf8Bytes,
  type SampleText,
} from "@/lib/judge/truncate";

const KB = 1024;

function result(i: number, extra: Partial<TestResult> = {}): TestResult {
  return { i, v: "AC", ms: 10 + i, kb: 2048, ...extra };
}

describe("truncateBytes", () => {
  it("returns short text unchanged", () => {
    expect(truncateBytes("hello", 5)).toBe("hello");
    expect(truncateBytes("", 10)).toBe("");
  });

  it("never exceeds the byte limit and marks the cut", () => {
    const out = truncateBytes("a".repeat(10_000), 4 * KB);
    expect(utf8Bytes(out)).toBeLessThanOrEqual(4 * KB);
    expect(out.endsWith("(truncated)")).toBe(true);
  });

  it.each([
    ["2-byte", "é"],
    ["3-byte", "€"],
    ["4-byte", "😀"],
    ["Tamil", "தமிழ்"],
  ])("never splits a %s character", (_label, ch) => {
    const text = ch.repeat(3000);
    for (let max = 1; max < 64; max++) {
      const out = truncateBytes(text, max);
      expect(utf8Bytes(out)).toBeLessThanOrEqual(max);
      expect(out).not.toContain("�");
    }
    const big = truncateBytes(text, 4 * KB);
    expect(utf8Bytes(big)).toBeLessThanOrEqual(4 * KB);
    expect(big).not.toContain("�");
  });

  it("returns an empty string for a non-positive budget", () => {
    expect(truncateBytes("abc", 0)).toBe("");
    expect(truncateBytes("abc", -5)).toBe("");
  });
});

describe("compactTestResults", () => {
  it("keeps only i/v/ms/kb, ordered and de-duplicated", () => {
    const tests = [
      result(2, { stdout: "secret hidden output", stderr: "trace", exitCode: 0, message: "m" }),
      result(0),
      result(2, { v: "WA" }),
    ];
    expect(compactTestResults(tests)).toEqual([
      { i: 0, v: "AC", ms: 10, kb: 2048 },
      { i: 2, v: "AC", ms: 12, kb: 2048 },
    ]);
  });
});

describe("buildSubmissionDetails", () => {
  const samples: SampleText[] = [
    { index: 0, input: "[2,7,11,15]\n9\n", expected: "[0,1]\n" },
    { index: 1, input: "[3,2,4]\n6\n", expected: "[1,2]\n" },
  ];

  it("stores sample tests only and drops hidden stdout/stderr even when the worker sent them", () => {
    const rows = buildSubmissionDetails(
      [
        result(0, { stdout: "[0,1]\n" }),
        result(1, { stdout: "[1,2]\n", stderr: "debug" }),
        result(5, { v: "WA", stdout: "HIDDEN-OUTPUT", stderr: "HIDDEN-ERR" }),
      ],
      samples,
    );
    expect(rows.map((r) => r.testIndex)).toEqual([0, 1]);
    expect(rows[1]).toEqual({ testIndex: 1, input: "[3,2,4]\n6\n", expected: "[1,2]\n", stdout: "[1,2]\n", stderr: "debug" });
    expect(JSON.stringify(rows)).not.toContain("HIDDEN");
  });

  it("keeps null for output the worker did not send", () => {
    const [row] = buildSubmissionDetails([result(0)], samples);
    expect(row?.stdout).toBeNull();
    expect(row?.stderr).toBeNull();
  });

  it("caps every field at 4 KB", () => {
    const huge = "x".repeat(50 * KB);
    const [row] = buildSubmissionDetails(
      [result(0, { stdout: huge, stderr: huge })],
      [{ index: 0, input: huge, expected: huge }],
    );
    for (const field of [row!.input, row!.expected, row!.stdout, row!.stderr]) {
      expect(utf8Bytes(field!)).toBeLessThanOrEqual(LIMITS.detail.perTestBytes);
    }
  });

  it("caps the whole submission at 32 KB", () => {
    const huge = "€".repeat(20 * KB);
    const many = Array.from({ length: 20 }, (_, i) => ({ index: i, input: huge, expected: huge }));
    const rows = buildSubmissionDetails(
      many.map((s) => result(s.index, { stdout: huge, stderr: huge })),
      many,
    );
    const total = rows.reduce(
      (sum, r) => sum + [r.input, r.expected, r.stdout, r.stderr].reduce((s, f) => s + (f ? utf8Bytes(f) : 0), 0),
      0,
    );
    expect(total).toBeLessThanOrEqual(LIMITS.detail.perSubmissionBytes);
    expect(rows).toHaveLength(20);
    // The budget runs out part-way: later rows exist but carry no content.
    expect(rows.at(-1)).toMatchObject({ input: null, expected: null, stdout: null, stderr: null });
    expect(JSON.stringify(rows)).not.toContain("�");
  });
});

describe("buildRunResult", () => {
  it("keeps visible stdout ≤ 64 KB and stderr ≤ 8 KB for a custom run, index 0 only", () => {
    const out = buildRunResult(
      [result(0, { stdout: "o".repeat(100 * KB), stderr: "e".repeat(20 * KB) }), result(3, { stdout: "nope" })],
      { kind: "custom" },
    );
    expect(out).toHaveLength(1);
    expect(utf8Bytes(out[0]!.stdout)).toBeLessThanOrEqual(LIMITS.customRun.stdoutBytes);
    expect(utf8Bytes(out[0]!.stderr)).toBeLessThanOrEqual(LIMITS.customRun.stderrBytes);
    expect(out[0]).not.toHaveProperty("input");
  });

  it("adds input and expected (≤ 4 KB) for sample runs and drops unknown indices", () => {
    const out = buildRunResult([result(1, { stdout: "[1,2]\n" }), result(0), result(9, { stdout: "x" })], {
      kind: "samples",
      samples: [
        { index: 0, input: "a".repeat(10 * KB), expected: "[0,1]\n" },
        { index: 1, input: "[3,2,4]\n6\n", expected: "[1,2]\n" },
      ],
    });
    expect(out.map((e) => e.i)).toEqual([0, 1]);
    expect(utf8Bytes(out[0]!.input!)).toBeLessThanOrEqual(LIMITS.detail.perTestBytes);
    expect(out[0]!.stdout).toBe("");
    expect(out[1]).toMatchObject({ stdout: "[1,2]\n", input: "[3,2,4]\n6\n", expected: "[1,2]\n" });
  });
});
