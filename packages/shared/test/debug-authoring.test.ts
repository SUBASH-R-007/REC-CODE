import { describe, expect, it } from "vitest";
import { versionContentIssues, type VersionContentInput } from "../src/authoring";
import { problemPackageMetaSchema } from "../src/authoring/package";

/**
 * What a debugging version must look like before it can be published
 * (Phase 12m, slice 1).
 *
 * Two of these rules the database says as well (migration
 * 20261101150000): the range, and that the budget belongs to a problem
 * with a program to repair. The other two cannot be CHECKs and are the
 * ones that matter — a budget with no broken program is a question the
 * workspace could offer in no language at all, and a budget the author's
 * own model solution does not fit is a question nobody can answer.
 */

const BROKEN = `#include <iostream>
int main() {
  int n;
  std::cin >> n;
  int sum = 0;
  for (int i = 0; i <= n; i++) sum += i;
  std::cout << sum << std::endl;
}
`;
const FIXED = BROKEN.replace("i <= n", "i < n");

const base: VersionContentInput = {
  ioMode: "STDIN",
  compareMode: "TOKEN",
  floatEpsilon: null,
  functionSignature: null,
  checkerSha256: null,
  testlibId: null,
  scoringMode: "ICPC",
  timeLimitMs: 2_000,
  memoryLimitKb: 262_144,
  statementMd: "The program below adds up 1..n-1 but it does not. Fix it.",
  tests: [
    { index: 0, isSample: true, subtaskIndex: null, points: null, inputBytes: 2, outputBytes: 2, sampleInlineable: true },
    { index: 1, isSample: false, subtaskIndex: null, points: null, inputBytes: 2, outputBytes: 3, sampleInlineable: true },
  ],
  subtasks: [],
  references: [{ language: "cpp20", expectedVerdict: "AC", source: FIXED }],
  starters: [{ language: "cpp20", code: BROKEN }],
  maxEditedLines: 1,
};

const codesOf = (input: VersionContentInput) =>
  versionContentIssues(input)
    .filter((i) => i.severity === "error")
    .map((i) => i.code);

const messageOf = (input: VersionContentInput, code: string) =>
  versionContentIssues(input).find((i) => i.code === code)?.message ?? "";

describe("a debugging version that is ready", () => {
  it("has no errors: a broken program, and a fix that fits the budget", () => {
    expect(codesOf(base)).toEqual([]);
  });

  it("leaves every other problem alone — no budget, no rules", () => {
    expect(codesOf({ ...base, maxEditedLines: null, starters: [], references: [{ language: "cpp20", expectedVerdict: "AC" }] })).toEqual([]);
  });
});

describe("what it is refused for", () => {
  it("a budget outside the range an author may set", () => {
    expect(codesOf({ ...base, maxEditedLines: 0 })).toContain("DEBUG_BUDGET_RANGE");
    expect(codesOf({ ...base, maxEditedLines: 51 })).toContain("DEBUG_BUDGET_RANGE");
    expect(codesOf({ ...base, maxEditedLines: 1.5 })).toContain("DEBUG_BUDGET_RANGE");
  });

  it("no broken program: the starter IS the question", () => {
    expect(codesOf({ ...base, starters: [] })).toContain("DEBUG_NO_STARTER");
    // An empty starter is no starter, whatever the row says.
    expect(codesOf({ ...base, starters: [{ language: "cpp20", code: "   \n" }] })).toContain("DEBUG_NO_STARTER");
    expect(messageOf({ ...base, starters: [] }, "DEBUG_NO_STARTER")).toContain("offered in");
  });

  it("a model solution that rewrites the program rather than repairing it", () => {
    const rewritten = "#include <cstdio>\nint main(){int n;scanf(\"%d\",&n);printf(\"%d\\n\",n*(n-1)/2);}\n";
    const codes = codesOf({ ...base, references: [{ language: "cpp20", expectedVerdict: "AC", source: rewritten }] });
    expect(codes).toContain("DEBUG_UNSOLVABLE");
    const message = messageOf({ ...base, references: [{ language: "cpp20", expectedVerdict: "AC", source: rewritten }] }, "DEBUG_UNSOLVABLE");
    expect(message).toContain("allows 1");
  });

  it("but accepts a larger budget for the same pair, because then it fits", () => {
    const rewritten = "#include <cstdio>\nint main(){int n;scanf(\"%d\",&n);printf(\"%d\\n\",n*(n-1)/2);}\n";
    expect(codesOf({ ...base, maxEditedLines: 20, references: [{ language: "cpp20", expectedVerdict: "AC", source: rewritten }] })).toEqual([]);
  });

  it("says nothing about a model solution whose source it was not given", () => {
    // The gate reads sources only for a debugging version; a reference row
    // without one is not evidence of anything.
    expect(codesOf({ ...base, references: [{ language: "cpp20", expectedVerdict: "AC" }] })).toEqual([]);
  });

  it("measures each language against its own starter, not against another's", () => {
    const codes = codesOf({
      ...base,
      maxEditedLines: 1,
      starters: [
        { language: "cpp20", code: BROKEN },
        { language: "py312", code: "n = int(input())\nprint(sum(range(n + 1)))\n" },
      ],
      references: [
        { language: "cpp20", expectedVerdict: "AC", source: FIXED },
        { language: "py312", expectedVerdict: "AC", source: "n = int(input())\nprint(sum(range(n)))\n" },
      ],
    });
    expect(codes).toEqual([]);
  });

  it("a kind of problem with no program to repair", () => {
    expect(codesOf({ ...base, compareMode: "INTERACTIVE", interactorSha256: "a".repeat(64), testlibId: "testlib-0.9.41" })).toContain(
      "DEBUG_NOT_APPLICABLE",
    );
    expect(
      codesOf({ ...base, ioMode: "SQL", compareMode: "ROWS", sqlDialect: "postgres17", sqlOrdered: true }),
    ).toContain("DEBUG_NOT_APPLICABLE");
  });

  it("and says that one once, without piling on the rules of a kind it is not", () => {
    const codes = codesOf({ ...base, compareMode: "INTERACTIVE", interactorSha256: "a".repeat(64), testlibId: "testlib-0.9.41" });
    expect(codes.filter((c) => c.startsWith("DEBUG_"))).toEqual(["DEBUG_NOT_APPLICABLE"]);
  });
});

describe("the import package", () => {
  const meta = {
    format: 1,
    slug: "fix-the-sum",
    displayCode: "REC-0199",
    title: "Fix the sum",
    difficulty: "EASY",
    topics: ["ARRAYS_HASHING"],
    origin: "FACULTY",
    ioMode: "STDIN",
    compareMode: "TOKEN",
    timeLimitMs: 2_000,
    samples: [0],
    solutions: [{ file: "solutions/model.cpp", language: "cpp20", label: "model", expected: "AC" }],
    starters: { cpp20: "starters/cpp20.cpp" },
  };

  it("carries the budget, and defaults it to null for every existing package", () => {
    const plain = problemPackageMetaSchema.parse(meta);
    expect(plain.maxEditedLines).toBeNull();
    expect(problemPackageMetaSchema.parse({ ...meta, maxEditedLines: 2 }).maxEditedLines).toBe(2);
  });

  it("refuses a budget out of range", () => {
    expect(problemPackageMetaSchema.safeParse({ ...meta, maxEditedLines: 0 }).success).toBe(false);
    expect(problemPackageMetaSchema.safeParse({ ...meta, maxEditedLines: 99 }).success).toBe(false);
  });

  it("refuses a budget with no starter to repair, naming the directory", () => {
    const result = problemPackageMetaSchema.safeParse({ ...meta, starters: {}, maxEditedLines: 2 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((i) => i.message.includes("starters/"))).toBe(true);
  });

  it("refuses a budget on a conversation", () => {
    const result = problemPackageMetaSchema.safeParse({
      ...meta,
      compareMode: "INTERACTIVE",
      interactor: "interactor.cpp",
      maxEditedLines: 2,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((i) => i.path.includes("maxEditedLines"))).toBe(true);
  });
});
