import { describe, expect, it } from "vitest";
import { ANSWER_LANGUAGE_KEY } from "../src/index";
import { versionContentIssues, type VersionContentInput } from "../src/authoring";
import { problemPackageMetaSchema } from "../src/authoring/package";

/**
 * What an output-only version must look like before it can be published
 * (Phase 12n, slice 2).
 *
 * Two of these rules no CHECK could hold, and they are the ones that
 * decide whether the question can be answered at all: there is exactly ONE
 * case, and it is a SAMPLE. One, because a submission carries one answer;
 * visible, because its data is the question.
 *
 * The third is the model answer. Validating it proves the stored expected
 * output and the comparator agree about the author's own answer — the
 * mistake an output-only problem is prone to is a trailing newline, not a
 * wrong algorithm.
 */

const base: VersionContentInput = {
  ioMode: "OUTPUT_ONLY",
  compareMode: "TOKEN",
  floatEpsilon: null,
  functionSignature: null,
  checkerSha256: null,
  testlibId: null,
  scoringMode: "ICPC",
  timeLimitMs: 2_000,
  memoryLimitKb: 262_144,
  statementMd: "Here is the data. Submit the answer.",
  tests: [{ index: 0, isSample: true, subtaskIndex: null, points: null, inputBytes: 120, outputBytes: 12, sampleInlineable: true }],
  subtasks: [],
  references: [{ language: ANSWER_LANGUAGE_KEY, expectedVerdict: "AC" }],
};

const codesOf = (input: VersionContentInput) =>
  versionContentIssues(input)
    .filter((i) => i.severity === "error")
    .map((i) => i.code);

const warningsOf = (input: VersionContentInput) =>
  versionContentIssues(input)
    .filter((i) => i.severity === "warning")
    .map((i) => i.code);

describe("an output-only version that is ready", () => {
  it("has no errors: one visible case with an expected answer, and the model answer", () => {
    expect(codesOf(base)).toEqual([]);
  });

  it("is not asked for a hidden test, because its one case is the question", () => {
    expect(codesOf(base)).not.toContain("NO_HIDDEN_TEST");
  });

  it("is not asked for a C++ model solution, because the model is not a program", () => {
    expect(warningsOf(base)).not.toContain("NO_CPP_MODEL");
  });

  it("may be compared exactly, by token, with a tolerance, or by a checker", () => {
    expect(codesOf({ ...base, compareMode: "EXACT" })).toEqual([]);
    expect(codesOf({ ...base, compareMode: "FLOAT", floatEpsilon: 1e-6 })).toEqual([]);
    expect(codesOf({ ...base, compareMode: "CHECKER", checkerSha256: "a".repeat(64), testlibId: "testlib-0.9.41" })).toEqual([]);
  });
});

describe("what it is refused for", () => {
  it("more than one case: one instance, one answer", () => {
    const codes = codesOf({
      ...base,
      tests: [
        base.tests[0]!,
        { index: 1, isSample: false, subtaskIndex: null, points: null, inputBytes: 4, outputBytes: 2, sampleInlineable: true },
      ],
    });
    expect(codes).toContain("ANSWER_ONE_CASE");
  });

  it("no case at all", () => {
    expect(codesOf({ ...base, tests: [] })).toContain("ANSWER_ONE_CASE");
  });

  it("a hidden case: nobody can answer data they cannot see", () => {
    expect(codesOf({ ...base, tests: [{ ...base.tests[0]!, isSample: false }] })).toContain("ANSWER_HIDDEN_CASE");
  });

  it("no expected answer stored: there would be nothing to compare", () => {
    expect(codesOf({ ...base, tests: [{ ...base.tests[0]!, outputBytes: 0 }] })).toContain("ANSWER_NO_EXPECTED");
  });

  it("no model answer, and a model that is a program", () => {
    expect(codesOf({ ...base, references: [] })).toContain("ANSWER_NO_REFERENCE");
    expect(codesOf({ ...base, references: [{ language: "cpp20", expectedVerdict: "AC" }] })).toContain(
      "ANSWER_FOREIGN_REFERENCE",
    );
  });

  it("a conversation, a result-set comparison, a signature, an interactor or an edit budget", () => {
    expect(codesOf({ ...base, compareMode: "INTERACTIVE" })).toContain("ANSWER_ARTEFACT");
    expect(codesOf({ ...base, compareMode: "ROWS" })).toContain("ANSWER_ARTEFACT");
    expect(codesOf({ ...base, functionSignature: { methodName: "x" } })).toContain("ANSWER_ARTEFACT");
    expect(codesOf({ ...base, interactorSha256: "b".repeat(64) })).toContain("ANSWER_ARTEFACT");
    expect(codesOf({ ...base, maxEditedLines: 2 })).toContain("ANSWER_ARTEFACT");
  });

  it("and leaves every other kind of problem's rules alone", () => {
    const stdin: VersionContentInput = {
      ...base,
      ioMode: "STDIN",
      references: [{ language: "cpp20", expectedVerdict: "AC" }],
      tests: [
        base.tests[0]!,
        { index: 1, isSample: false, subtaskIndex: null, points: null, inputBytes: 4, outputBytes: 2, sampleInlineable: true },
      ],
    };
    expect(codesOf(stdin)).toEqual([]);
    expect(codesOf(stdin).filter((c) => c.startsWith("ANSWER_"))).toEqual([]);
  });
});

describe("the import package", () => {
  const meta = {
    format: 1,
    slug: "the-hard-instance",
    displayCode: "REC-0210",
    title: "The hard instance",
    difficulty: "HARD",
    topics: ["MATH_BITS"],
    origin: "FACULTY",
    ioMode: "OUTPUT_ONLY",
    compareMode: "TOKEN",
    timeLimitMs: 2_000,
    samples: [0],
    solutions: [{ file: "solutions/answer.txt", language: ANSWER_LANGUAGE_KEY, expected: "AC", label: "the answer" }],
  };

  it("describes an output-only problem, model answer and all", () => {
    const parsed = problemPackageMetaSchema.parse(meta);
    expect(parsed.ioMode).toBe("OUTPUT_ONLY");
    expect(parsed.solutions[0]?.language).toBe(ANSWER_LANGUAGE_KEY);
  });

  it("still describes a SQL problem's reference query, which it could not before", () => {
    const sql = problemPackageMetaSchema.safeParse({
      ...meta,
      slug: "top-scorers",
      ioMode: "SQL",
      compareMode: "TOKEN",
      solutions: [{ file: "solutions/model.sql", language: "sql17", expected: "AC", label: "the query" }],
      samples: [0, 1],
    });
    expect(sql.success).toBe(true);
  });

  it("refuses more than one case, a starter, or no model answer", () => {
    for (const bad of [
      { samples: [0, 1] },
      { starters: { cpp20: "starters/cpp20.cpp" } },
      { solutions: [{ file: "solutions/model.cpp", language: "cpp20", expected: "AC", label: "model" }] },
    ]) {
      expect(problemPackageMetaSchema.safeParse({ ...meta, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("refuses a conversation on one", () => {
    const result = problemPackageMetaSchema.safeParse({
      ...meta,
      compareMode: "INTERACTIVE",
      interactor: "interactor.cpp",
    });
    expect(result.success).toBe(false);
  });
});
