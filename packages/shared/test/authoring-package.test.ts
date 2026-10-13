import { describe, expect, it } from "vitest";
import {
  IMPORT_LIMITS,
  TEST_FILE_PATTERN,
  displayCodeSchema,
  packagePathSchema,
  problemPackageMetaSchema,
  problemSlugSchema,
} from "../src/authoring/package";

function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    slug: "loud-echo",
    displayCode: "REC-0101",
    title: "Loud Echo",
    difficulty: "EASY",
    topics: ["STRINGS"],
    origin: "FACULTY",
    constraints: ["1 ≤ |w| ≤ 100"],
    ioMode: "STDIN",
    functionSignature: null,
    compareMode: "TOKEN",
    floatEpsilon: null,
    scoringMode: "ICPC",
    stopOnFirstFailure: true,
    timeLimitMs: 1000,
    memoryLimitKb: 262144,
    samples: [0],
    subtasks: [],
    solutions: [{ file: "solutions/model.cpp", language: "cpp20", expected: "AC", label: "Model" }],
    starters: {},
    checker: null,
    ...overrides,
  };
}

const messages = (value: unknown) => {
  const r = problemPackageMetaSchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("problemPackageMetaSchema", () => {
  it("accepts a complete meta.json", () => {
    expect(messages(meta())).toEqual([]);
  });

  it("requires a declared comparator, with no default", () => {
    const { compareMode: _drop, ...rest } = meta();
    expect(messages(rest).join("\n")).toMatch(/compareMode is required/);
    expect(messages(meta({ compareMode: "INTERACTIVE" })).join("\n")).toMatch(/compareMode is required/);
  });

  it("needs a FUNCTION signature with a comparator, and no signature on STDIN", () => {
    const sig = { className: "Solution", methodName: "solve", params: [{ name: "a", type: "int" }], returns: "int", mutatedParam: null };
    expect(messages(meta({ ioMode: "FUNCTION", functionSignature: sig })).join("\n")).toMatch(/functionSignature.comparator is required/);
    expect(messages(meta({ ioMode: "FUNCTION", functionSignature: { ...sig, comparator: "EXACT" } }))).toEqual([]);
    expect(messages(meta({ ioMode: "FUNCTION" })).join("\n")).toMatch(/needs a functionSignature/);
    expect(messages(meta({ functionSignature: { ...sig, comparator: "EXACT" } })).join("\n")).toMatch(/Only a FUNCTION problem/);
  });

  it("ties the checker to CHECKER / CUSTOM_CHECKER", () => {
    expect(messages(meta({ compareMode: "CHECKER" })).join("\n")).toMatch(/needs checker.cpp/);
    expect(messages(meta({ compareMode: "CHECKER", checker: "checker.cpp" }))).toEqual([]);
    expect(messages(meta({ checker: "checker.cpp" })).join("\n")).toMatch(/not CHECKER/);
  });

  it("enforces the 15 s / 1 GB rule", () => {
    expect(messages(meta({ timeLimitMs: 20_000 })).join("\n")).toMatch(/timeLimitMs must be at most 15000/);
    expect(messages(meta({ memoryLimitKb: 2_097_152 })).join("\n")).toMatch(/memoryLimitKb must be at most 1048576/);
  });

  it("checks subtasks: SUBTASK scoring only, earlier dependencies, disjoint tests", () => {
    const subtasks = [
      { index: 1, points: 40, tests: [0, 1] },
      { index: 2, points: 60, dependsOn: [1], tests: [2] },
    ];
    expect(messages(meta({ scoringMode: "SUBTASK", subtasks }))).toEqual([]);
    expect(messages(meta({ subtasks })).join("\n")).toMatch(/only used with SUBTASK/);
    expect(messages(meta({ scoringMode: "SUBTASK" })).join("\n")).toMatch(/needs subtasks/);
    const overlap = [
      { index: 1, points: 40, tests: [0, 1] },
      { index: 2, points: 60, dependsOn: [3], tests: [1] },
    ];
    const text = messages(meta({ scoringMode: "SUBTASK", subtasks: overlap })).join("\n");
    expect(text).toMatch(/earlier subtask/);
    expect(text).toMatch(/more than one subtask/);
  });

  it("is strict about unknown keys and keeps solutions under solutions/", () => {
    expect(messages(meta({ extra: true })).join("\n")).toMatch(/Unrecognized key/);
    expect(messages(meta({ solutions: [{ file: "model.cpp", language: "cpp20", expected: "AC", label: "M" }] })).join("\n")).toMatch(
      /under solutions/,
    );
  });
});

describe("field schemas", () => {
  it("validates slugs and display codes", () => {
    expect(problemSlugSchema.safeParse("loud-echo").success).toBe(true);
    expect(problemSlugSchema.safeParse("Loud Echo").success).toBe(false);
    expect(displayCodeSchema.safeParse("REC-0101").success).toBe(true);
    expect(displayCodeSchema.safeParse("REC-101").success).toBe(false);
  });

  it("refuses unsafe package paths", () => {
    for (const bad of ["../x", "/abs", "a//b", "a/./b", "a\\b", "C:/x", "a\u0000b", "x".repeat(IMPORT_LIMITS.pathChars + 1)]) {
      expect(packagePathSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(packagePathSchema.safeParse("solutions/model.cpp").success).toBe(true);
  });

  it("names tests NNN.in / NNN.out", () => {
    expect(TEST_FILE_PATTERN.exec("testcases/007.in")?.slice(1)).toEqual(["007", "in"]);
    expect(TEST_FILE_PATTERN.test("testcases/7.in")).toBe(false);
    expect(TEST_FILE_PATTERN.test("testcases/007.ans")).toBe(false);
  });
});
