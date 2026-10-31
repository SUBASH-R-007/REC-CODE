import { describe, expect, it } from "vitest";
import { AUTHORABLE_COMPARE_MODES, versionContentIssues, type VersionContentInput } from "../src/authoring";
import { comparatorIssues } from "../src/harness";

/**
 * What an interactive version must look like before it can be published
 * (Phase 12l).
 *
 * The database says most of this too, in the CHECKs of migration
 * 20261101140000. These are here so an author reads a sentence rather than
 * meeting a constraint violation — and the one rule that is ONLY here is
 * the expected output, because `TestCase.outputSha256` is required for
 * every kind of problem and an interactive case stores the empty blob in
 * it. No constraint can say "those bytes are meaningless".
 */

const base: VersionContentInput = {
  ioMode: "STDIN",
  compareMode: "INTERACTIVE",
  floatEpsilon: null,
  functionSignature: null,
  checkerSha256: null,
  interactorSha256: "a".repeat(64),
  testlibId: "testlib-0.9.41",
  scoringMode: "ICPC",
  timeLimitMs: 2_000,
  memoryLimitKb: 262_144,
  statementMd: "Guess the number in at most 40 queries.",
  tests: [
    { index: 0, isSample: true, subtaskIndex: null, points: null, inputBytes: 8, outputBytes: 0, sampleInlineable: true },
    { index: 1, isSample: false, subtaskIndex: null, points: null, inputBytes: 8, outputBytes: 0, sampleInlineable: true },
  ],
  subtasks: [],
  references: [{ language: "cpp20", expectedVerdict: "AC" }],
};

const codesOf = (input: VersionContentInput) =>
  versionContentIssues(input)
    .filter((i) => i.severity === "error")
    .map((i) => i.code);

describe("an interactive version that is ready", () => {
  it("has no errors", () => {
    expect(codesOf(base)).toEqual([]);
  });

  it("is a mode an author may choose at all", () => {
    // It was not, until this phase: the engine refused it.
    expect(AUTHORABLE_COMPARE_MODES).toContain("INTERACTIVE");
  });
});

describe("what it is refused for", () => {
  it("no interactor: there is nothing to decide the verdict", () => {
    expect(codesOf({ ...base, interactorSha256: null })).toContain("INTERACTIVE_NO_INTERACTOR");
    expect(codesOf({ ...base, testlibId: null })).toContain("INTERACTIVE_NO_INTERACTOR");
  });

  it("a checker as well: one judge, not two", () => {
    expect(codesOf({ ...base, checkerSha256: "b".repeat(64) })).toContain("INTERACTIVE_ARTEFACT");
  });

  it("a float tolerance: nothing compares output, so it would change nothing", () => {
    expect(codesOf({ ...base, floatEpsilon: 1e-6 })).toContain("INTERACTIVE_ARTEFACT");
  });

  it("expected output on a case: the interactor decides as it goes", () => {
    const withOutput = {
      ...base,
      tests: base.tests.map((t, i) => (i === 0 ? { ...t, outputBytes: 12 } : t)),
    };
    const issue = versionContentIssues(withOutput).find((i) => i.code === "INTERACTIVE_EXPECTED_OUTPUT");
    expect(issue?.severity).toBe("error");
    // The message says what to do, and names the case.
    expect(issue?.message).toContain("Test 0");
    expect(issue?.message).toContain("Clear the expected output");
  });

  it("a FUNCTION or SQL problem: a conversation needs stdin and stdout", () => {
    for (const ioMode of ["FUNCTION", "SQL"] as const) {
      const issues = comparatorIssues({
        ioMode,
        compareMode: "INTERACTIVE",
        functionSignature: null,
        floatEpsilon: null,
        checkerSha256: null,
        interactorSha256: "a".repeat(64),
        testlibId: "testlib-0.9.41",
      });
      expect(issues.join(" "), ioMode).toContain("standard input and output");
    }
  });

  it("not for the unused-checker warning, which would be about a checker it does not have", () => {
    const warnings = versionContentIssues(base).filter((i) => i.severity === "warning");
    expect(warnings.map((w) => w.code)).not.toContain("CHECKER_UNUSED");
  });
});

describe("the rules a checker problem keeps", () => {
  it("a CHECKER version still needs its checker", () => {
    const issues = comparatorIssues({
      ioMode: "STDIN",
      compareMode: "CHECKER",
      functionSignature: null,
      floatEpsilon: null,
      checkerSha256: null,
      testlibId: null,
    });
    expect(issues.join(" ")).toContain("checker source");
  });

  it("and an interactive one is not satisfied by a checker", () => {
    const issues = comparatorIssues({
      ioMode: "STDIN",
      compareMode: "INTERACTIVE",
      functionSignature: null,
      floatEpsilon: null,
      checkerSha256: "b".repeat(64),
      interactorSha256: null,
      testlibId: "testlib-0.9.41",
    });
    expect(issues.join(" ")).toContain("interactor source");
  });
});
