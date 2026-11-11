import { describe, expect, it } from "vitest";
import { ANSWER_LANGUAGE_KEY, ANSWER_RUNTIME, JUDGE_PROTOCOL_VERSION } from "@recx/shared";
import { buildAnswerJobSpec } from "@/lib/judge/answer-job-spec";
import { JobSpecError, type JobSpecInput } from "@/lib/judge/job-spec";

/**
 * The output-only job spec (Phase 12n, slice 1).
 *
 * The one isolate spec with no runtime: `language` is null, there is
 * exactly one visible case, and the student's answer travels as `source`.
 * Everything this builder refuses is a version that could not be judged
 * honestly — two cases (which answer?), a hidden case (answer what?), a
 * comparison that is not a text comparison.
 */

const base: JobSpecInput = {
  kind: "submission",
  id: "sub_1",
  lane: "PRACTICE",
  claimToken: "token-token-token",
  attempt: 1,
  language: ANSWER_LANGUAGE_KEY,
  runtime: ANSWER_RUNTIME,
  source: "42\n",
  version: {
    ioMode: "OUTPUT_ONLY",
    functionSignature: null,
    compareMode: "TOKEN",
    floatEpsilon: null,
    scoringMode: "ICPC",
    stopOnFirstFailure: true,
    timeLimitMs: 2000,
    memoryLimitKb: 262_144,
  },
  tests: [
    {
      index: 0,
      isSample: true,
      points: null,
      subtaskIndex: null,
      input: { sha256: "a".repeat(64), sizeBytes: 12 },
      output: { sha256: "b".repeat(64), sizeBytes: 3 },
    },
  ],
};

describe("an output-only spec", () => {
  it("carries the answer, no runtime, and one visible case", () => {
    const spec = buildAnswerJobSpec(base);
    expect(spec.protocolVersion).toBe(JUDGE_PROTOCOL_VERSION);
    expect(spec.language).toBeNull();
    expect(spec.ioMode).toBe("OUTPUT_ONLY");
    expect(spec.source).toBe("42\n");
    expect(spec.tests).toHaveLength(1);
    expect(spec.tests[0]?.isSample).toBe(true);
    expect(spec.checker).toBeNull();
    expect(spec.interactor).toBeNull();
    expect(spec.subtasks).toEqual([]);
  });

  it("sends the version's limits, which are the checker's box limits here", () => {
    const spec = buildAnswerJobSpec(base);
    expect(spec.timeLimitMs).toBe(2000);
    expect(spec.memoryLimitKb).toBe(262_144);
  });

  it("keeps the author's scoring mode, because partial credit depends on it", () => {
    expect(buildAnswerJobSpec(base).scoringMode).toBe("ICPC");
    const perTest = buildAnswerJobSpec({ ...base, version: { ...base.version, scoringMode: "PER_TEST" } });
    expect(perTest.scoringMode).toBe("PER_TEST");
    /**
     * Found by the real-isolate run: under ICPC a checker's partial
     * verdict collapses to WA, so a question that awards part marks for a
     * best-effort answer must be scored PER_TEST. Forcing ICPC here threw
     * away exactly the credit the checker had just worked out.
     */
    expect(() => buildAnswerJobSpec({ ...base, version: { ...base.version, scoringMode: "SUBTASK" } })).toThrow(
      /cannot be scored by subtasks/,
    );
  });

  it("sends the checker when the answer is judged by one", () => {
    const spec = buildAnswerJobSpec({
      ...base,
      version: { ...base.version, compareMode: "CHECKER" },
      checker: { sha256: "c".repeat(64), sizeBytes: 100, testlibId: "testlib-0.9.41" },
    });
    expect(spec.checker?.testlibId).toBe("testlib-0.9.41");
    expect(spec.checker?.source.sha256).toBe("c".repeat(64));
  });
});

describe("what it refuses", () => {
  const refuses = (input: JobSpecInput, pattern: RegExp) =>
    expect(() => buildAnswerJobSpec(input)).toThrow(pattern);

  it("a runtime that is not the answer language's", () => {
    refuses({ ...base, runtime: { key: "cpp20" } }, /runtime is invalid/);
    refuses({ ...base, language: "cpp20" }, /answered in answer1/);
  });

  it("more than one case, or none", () => {
    refuses({ ...base, tests: [] }, /exactly one case/);
    refuses({ ...base, tests: [base.tests[0]!, { ...base.tests[0]!, index: 1 }] }, /exactly one case/);
  });

  it("a hidden case: its data is the question", () => {
    refuses({ ...base, tests: [{ ...base.tests[0]!, isSample: false }] }, /must be visible/);
  });

  it("a CHECKER version with no checker, or no pinned testlib", () => {
    refuses({ ...base, version: { ...base.version, compareMode: "CHECKER" } }, /no checker source/);
    refuses(
      {
        ...base,
        version: { ...base.version, compareMode: "CHECKER" },
        checker: { sha256: "c".repeat(64), sizeBytes: 10, testlibId: null },
      },
      /no pinned testlib/,
    );
  });

  it("a comparison that is not a comparison of text", () => {
    refuses({ ...base, version: { ...base.version, compareMode: "INTERACTIVE" } }, /compared as text/);
    refuses({ ...base, version: { ...base.version, compareMode: "ROWS" } }, /compared as text/);
  });

  it("a Run, because there is nothing to run", () => {
    refuses({ ...base, kind: "run" }, /nothing to run/);
  });

  it("a validation job with no expected verdict", () => {
    refuses({ ...base, kind: "validation" }, /expected verdict/);
    expect(buildAnswerJobSpec({ ...base, kind: "validation", expectedVerdict: "AC" }).kind).toBe("validation");
  });

  it("and every refusal is a JobSpecError, so the job fails rather than retrying", () => {
    expect(() => buildAnswerJobSpec({ ...base, tests: [] })).toThrow(JobSpecError);
  });
});
