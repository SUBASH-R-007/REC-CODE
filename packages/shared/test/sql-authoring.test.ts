import { describe, expect, it } from "vitest";
import { versionContentIssues, type VersionContentInput } from "../src/authoring";

/**
 * What a SQL version must look like before it can be published
 * (Phase 12k).
 *
 * The database says most of this too, in its CHECKs. These are here so an
 * author reads a sentence rather than meeting a constraint violation — and
 * the one rule that is only here is the reference query, because no
 * constraint can say "this version has a model solution in the one
 * language that can produce its expected results".
 */

const base: VersionContentInput = {
  ioMode: "SQL",
  compareMode: "ROWS",
  sqlDialect: "postgres17",
  sqlOrdered: true,
  floatEpsilon: null,
  functionSignature: null,
  checkerSha256: null,
  testlibId: null,
  scoringMode: "ICPC",
  timeLimitMs: 5_000,
  memoryLimitKb: 262_144,
  statementMd: "List every student, by id.",
  tests: [
    { index: 0, isSample: true, subtaskIndex: null, points: null, inputBytes: 90, outputBytes: 60, sampleInlineable: true },
    { index: 1, isSample: false, subtaskIndex: null, points: null, inputBytes: 90, outputBytes: 60, sampleInlineable: true },
  ],
  subtasks: [],
  references: [{ language: "sql17", expectedVerdict: "AC" }],
};

const codesOf = (input: VersionContentInput) =>
  versionContentIssues(input)
    .filter((i) => i.severity === "error")
    .map((i) => i.code);

describe("a SQL version that is ready", () => {
  it("has no errors", () => {
    expect(codesOf(base)).toEqual([]);
  });

  it("is not asked for a C++ model solution", () => {
    // That warning is about programs; a SQL problem's model solution is its
    // reference query, which is an ERROR to be missing rather than a nudge.
    const warnings = versionContentIssues(base).filter((i) => i.severity === "warning");
    expect(warnings.map((w) => w.code)).not.toContain("NO_CPP_MODEL");
  });
});

describe("what a SQL version is refused for", () => {
  it("not comparing result sets", () => {
    expect(codesOf({ ...base, compareMode: "TOKEN" })).toContain("SQL_FIELDS");
  });

  it("not stating its dialect, or its ordering rule", () => {
    expect(codesOf({ ...base, sqlDialect: null })).toContain("SQL_FIELDS");
    expect(codesOf({ ...base, sqlOrdered: null })).toContain("SQL_FIELDS");
  });

  it("carrying a function signature or a checker", () => {
    expect(codesOf({ ...base, functionSignature: { name: "x" } })).toContain("SQL_ARTEFACT");
    expect(codesOf({ ...base, checkerSha256: "a".repeat(64), testlibId: "testlib-0.9.41" })).toContain("SQL_ARTEFACT");
  });

  it("having no reference query", () => {
    const codes = codesOf({ ...base, references: [] });
    expect(codes).toContain("SQL_NO_REFERENCE");
    // And the message says WHY it is needed, not just that it is.
    const issue = versionContentIssues({ ...base, references: [] }).find((i) => i.code === "SQL_NO_REFERENCE");
    expect(issue?.message).toContain("produces the expected results");
  });

  it("having a reference query that is not expected to pass", () => {
    expect(codesOf({ ...base, references: [{ language: "sql17", expectedVerdict: "WA" }] })).toContain(
      "SQL_NO_REFERENCE",
    );
  });

  it("carrying a solution in a language that is not SQL", () => {
    const codes = codesOf({
      ...base,
      references: [
        { language: "sql17", expectedVerdict: "AC" },
        { language: "cpp20", expectedVerdict: "AC" },
      ],
    });
    expect(codes).toContain("SQL_FOREIGN_REFERENCE");
  });

  it("the same rules every other version is refused for", () => {
    // No sample, no hidden case, an empty statement: a SQL problem is a
    // problem.
    expect(codesOf({ ...base, tests: [base.tests[1]!] })).toContain("NO_SAMPLE");
    expect(codesOf({ ...base, tests: [base.tests[0]!] })).toContain("NO_HIDDEN_TEST");
    expect(codesOf({ ...base, statementMd: "   " })).toContain("STATEMENT_EMPTY");
  });

  it("a sample whose dataset is too big for a student to see", () => {
    const tests = [{ ...base.tests[0]!, sampleInlineable: false }, base.tests[1]!];
    expect(codesOf({ ...base, tests })).toContain("SAMPLE_NOT_INLINE");
  });
});

describe("the SQL columns on a version that is not SQL", () => {
  const stdin: VersionContentInput = {
    ...base,
    ioMode: "STDIN",
    compareMode: "TOKEN",
    sqlDialect: null,
    sqlOrdered: null,
    references: [{ language: "cpp20", expectedVerdict: "AC" }],
  };

  it("are refused", () => {
    expect(codesOf({ ...stdin, sqlDialect: "postgres17" })).toContain("SQL_FIELDS");
    expect(codesOf({ ...stdin, sqlOrdered: true })).toContain("SQL_FIELDS");
  });

  it("and a STDIN version with none of them still passes", () => {
    expect(codesOf(stdin)).toEqual([]);
  });
});
