import { describe, expect, it } from "vitest";
import {
  JUDGEABLE_FUNCTION_COMPARATORS,
  contentErrors,
  versionContentIssues,
  type VersionContentInput,
} from "../src/authoring/content";
import { FUNCTION_COMPARATORS } from "../src/harness/signature";

const test = (index: number, isSample: boolean, extra: Partial<VersionContentInput["tests"][number]> = {}) => ({
  index,
  isSample,
  subtaskIndex: null,
  points: null,
  inputBytes: 10,
  outputBytes: 10,
  sampleInlineable: true,
  ...extra,
});

function base(overrides: Partial<VersionContentInput> = {}): VersionContentInput {
  return {
    ioMode: "STDIN",
    compareMode: "TOKEN",
    floatEpsilon: null,
    functionSignature: null,
    checkerSha256: null,
    testlibId: null,
    scoringMode: "ICPC",
    timeLimitMs: 1000,
    memoryLimitKb: 262_144,
    statementMd: "Read a word and print it in upper case.",
    tests: [test(0, true), test(1, false), test(2, false)],
    subtasks: [],
    references: [{ language: "cpp20", expectedVerdict: "AC" }],
    ...overrides,
  };
}

const codes = (v: VersionContentInput) => versionContentIssues(v).map((i) => `${i.severity}:${i.code}`);

const signature = (comparator: string, extra: Record<string, unknown> = {}) => ({
  className: "Solution",
  methodName: "solve",
  params: [{ name: "nums", type: "list<int>" }],
  returns: "int",
  comparator,
  mutatedParam: null,
  ...extra,
});

describe("versionContentIssues", () => {
  it("passes a complete STDIN revision", () => {
    expect(versionContentIssues(base())).toEqual([]);
  });

  it("judges every FUNCTION comparator the fleet supports (all six)", () => {
    expect([...JUDGEABLE_FUNCTION_COMPARATORS]).toEqual([...FUNCTION_COMPARATORS]);
  });

  it("refuses a FUNCTION problem without a declared comparator", () => {
    const v = base({ ioMode: "FUNCTION", functionSignature: { ...signature("EXACT"), comparator: undefined } });
    const errors = contentErrors(versionContentIssues(v));
    expect(errors.some((e) => e.code === "COMPARATOR" && /comparator/.test(e.message))).toBe(true);
    expect(contentErrors(versionContentIssues(base({ ioMode: "FUNCTION", functionSignature: null })))[0]?.code).toBe("COMPARATOR");
  });

  it("accepts a valid FUNCTION signature and refuses one on a STDIN problem", () => {
    expect(contentErrors(versionContentIssues(base({ ioMode: "FUNCTION", functionSignature: signature("EXACT") })))).toEqual([]);
    expect(codes(base({ functionSignature: signature("EXACT") }))).toContain("error:SIGNATURE_ON_STDIN");
  });

  it("needs a checker for CHECKER and CUSTOM_CHECKER, and warns about an unused one", () => {
    expect(codes(base({ compareMode: "CHECKER" }))).toContain("error:COMPARATOR");
    expect(codes(base({ compareMode: "CHECKER", checkerSha256: "a".repeat(64), testlibId: "testlib-0.9.41" }))).toEqual([]);
    const custom = base({ ioMode: "FUNCTION", compareMode: "CHECKER", functionSignature: signature("CUSTOM_CHECKER") });
    expect(codes(custom)).toContain("error:COMPARATOR");
    expect(codes(base({ checkerSha256: "a".repeat(64), testlibId: "t" }))).toContain("warning:CHECKER_UNUSED");
  });

  it("refuses INTERACTIVE and out-of-range limits (no problem over 15 s or 1 GB)", () => {
    expect(codes(base({ compareMode: "INTERACTIVE" }))).toContain("error:COMPARATOR");
    expect(codes(base({ timeLimitMs: 15_001 }))).toContain("error:LIMIT_OUT_OF_RANGE");
    expect(codes(base({ timeLimitMs: 100 }))).toContain("error:LIMIT_OUT_OF_RANGE");
    expect(codes(base({ memoryLimitKb: 1_048_577 }))).toContain("error:LIMIT_OUT_OF_RANGE");
    expect(codes(base({ timeLimitMs: 15_000, memoryLimitKb: 1_048_576 }))).toEqual([]);
  });

  it("needs a sample, a hidden test, inline samples, gapless indexes and a statement", () => {
    expect(codes(base({ tests: [test(0, false)] }))).toContain("error:NO_SAMPLE");
    expect(codes(base({ tests: [test(0, true)] }))).toContain("error:NO_HIDDEN_TEST");
    expect(codes(base({ tests: [test(0, true, { sampleInlineable: false }), test(1, false)] }))).toContain("error:SAMPLE_NOT_INLINE");
    expect(codes(base({ tests: [test(0, true), test(2, false)] }))).toContain("error:TEST_INDEX_GAP");
    expect(codes(base({ statementMd: "   " }))).toContain("error:STATEMENT_EMPTY");
  });

  it("checks the subtask table", () => {
    const tests = [test(0, true, { subtaskIndex: 1 }), test(1, false, { subtaskIndex: 2 })];
    const good = base({ scoringMode: "SUBTASK", tests, subtasks: [{ index: 1, points: 40, dependsOn: [] }, { index: 2, points: 60, dependsOn: [1] }] });
    expect(codes(good)).toEqual([]);
    expect(codes(base({ scoringMode: "SUBTASK", tests }))).toContain("error:SUBTASK_TABLE");
    const forward = base({ scoringMode: "SUBTASK", tests, subtasks: [{ index: 1, points: 40, dependsOn: [2] }, { index: 2, points: 60, dependsOn: [] }] });
    expect(codes(forward)).toContain("error:SUBTASK_TABLE");
    const unused = base({ scoringMode: "SUBTASK", tests, subtasks: [{ index: 1, points: 40, dependsOn: [] }, { index: 2, points: 30, dependsOn: [] }, { index: 3, points: 30, dependsOn: [] }] });
    expect(versionContentIssues(unused).some((i) => /Subtask 3 has no tests/.test(i.message))).toBe(true);
    expect(codes(base({ subtasks: [{ index: 1, points: 1, dependsOn: [] }] }))).toContain("error:SUBTASK_TABLE");
  });

  it("only warns about a missing C++ model (validation blocks publishing)", () => {
    expect(codes(base({ references: [{ language: "py312", expectedVerdict: "AC" }] }))).toEqual(["warning:NO_CPP_MODEL"]);
    expect(codes(base({ references: [{ language: "cpp17", expectedVerdict: "WA" }] }))).toEqual(["warning:NO_CPP_MODEL"]);
  });
});
