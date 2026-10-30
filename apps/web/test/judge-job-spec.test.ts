import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { judgeJobSpecSchema, LANGUAGE_CATALOG, LIMITS } from "@recx/shared";
import { generateTwoSumTests, TWO_SUM } from "@recx/shared/samples/two-sum";
import { buildJudgeJobSpec, JobSpecError, type JobSpecInput, type JobSpecTestRow } from "@/lib/judge/job-spec";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Fixture rows shaped like the claim's Prisma select for the seeded two-sum. */
const testRows: JobSpecTestRow[] = generateTwoSumTests()
  .map((t) => ({
    index: t.index,
    isSample: t.isSample,
    points: null,
    subtaskIndex: null,
    input: { sha256: sha(t.input), sizeBytes: Buffer.byteLength(t.input) },
    output: { sha256: sha(t.output), sizeBytes: Buffer.byteLength(t.output) },
  }))
  .reverse(); // the mapping must order by index itself

const version = {
  ioMode: "FUNCTION" as const,
  functionSignature: JSON.parse(JSON.stringify(TWO_SUM.signature)) as unknown,
  compareMode: "TOKEN" as const,
  floatEpsilon: null,
  scoringMode: "ICPC" as const,
  stopOnFirstFailure: true,
  timeLimitMs: TWO_SUM.timeLimitMs,
  memoryLimitKb: TWO_SUM.memoryLimitKb,
};

function submissionInput(overrides: Partial<JobSpecInput> = {}): JobSpecInput {
  return {
    kind: "submission",
    id: "cmsub000000000000000000001",
    lane: "PRACTICE",
    claimToken: "x".repeat(43),
    attempt: 1,
    language: "cpp20",
    // jsonb round trip, exactly as read from LanguageConfig.runtime
    runtime: JSON.parse(JSON.stringify(LANGUAGE_CATALOG.cpp20)) as unknown,
    source: "class Solution {};\n",
    version,
    tests: testRows,
    ...overrides,
  };
}

describe("buildJudgeJobSpec — submissions", () => {
  it("produces a spec that validates against judgeJobSpecSchema", () => {
    const spec = buildJudgeJobSpec(submissionInput());
    expect(judgeJobSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.kind).toBe("submission");
    expect(spec.lane).toBe("PRACTICE");
    expect(spec.language.key).toBe("cpp20");
    expect(spec.ioMode).toBe("FUNCTION");
    expect(spec.functionSignature?.methodName).toBe("twoSum");
    expect(spec.stopOnFirstFailure).toBe(true);
    expect(spec.timeLimitMs).toBe(TWO_SUM.timeLimitMs);
    expect(spec.inlineBlobs).toEqual({});
  });

  it("includes every test, hidden ones too, ordered by index, as references only", () => {
    const spec = buildJudgeJobSpec(submissionInput());
    expect(spec.tests).toHaveLength(14);
    expect(spec.tests.map((t) => t.index)).toEqual([...Array(14).keys()]);
    expect(spec.tests.filter((t) => t.isSample)).toHaveLength(2);
    for (const t of spec.tests) {
      expect(Object.keys(t.input).sort()).toEqual(["sha256", "sizeBytes"]);
      expect(t.output).not.toBeNull();
    }
  });

  it("maps STDIN problems with a null signature", () => {
    const spec = buildJudgeJobSpec(
      submissionInput({ version: { ...version, ioMode: "STDIN", functionSignature: { junk: true } } }),
    );
    expect(spec.functionSignature).toBeNull();
  });

  it("rejects a runtime whose key does not match the submission's language", () => {
    expect(() => buildJudgeJobSpec(submissionInput({ language: "py312" }))).toThrow(JobSpecError);
  });

  it("rejects a corrupt runtime and a corrupt signature", () => {
    expect(() => buildJudgeJobSpec(submissionInput({ runtime: { key: "cpp20" } }))).toThrow(JobSpecError);
    expect(() =>
      buildJudgeJobSpec(submissionInput({ version: { ...version, functionSignature: { className: "Main" } } })),
    ).toThrow(JobSpecError);
  });

  it("rejects limits outside the limits table", () => {
    expect(() =>
      buildJudgeJobSpec(submissionInput({ version: { ...version, timeLimitMs: LIMITS.cpuTime.ceilingMs + 1 } })),
    ).toThrow(JobSpecError);
  });

  it("rejects a version without tests", () => {
    expect(() => buildJudgeJobSpec(submissionInput({ tests: [] }))).toThrow(JobSpecError);
  });
});

describe("buildJudgeJobSpec — runs", () => {
  const run = (customInput: string | null) =>
    buildJudgeJobSpec(submissionInput({ kind: "run", lane: "RUN", id: "cmrun000000000000000000001", customInput }));

  it("runs only the sample tests when there is no custom input", () => {
    const spec = run(null);
    expect(judgeJobSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.lane).toBe("RUN");
    expect(spec.tests.map((t) => t.index)).toEqual([0, 1]);
    expect(spec.tests.every((t) => t.isSample && t.output !== null)).toBe(true);
    expect(spec.stopOnFirstFailure).toBe(false);
    expect(spec.inlineBlobs).toEqual({});
  });

  it("runs one synthetic visible test with the custom stdin delivered inline", () => {
    const stdin = "[1, 2, 3]\n4\nनमस्ते\n";
    const spec = run(stdin);
    expect(judgeJobSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.tests).toEqual([
      {
        index: 0,
        isSample: true,
        input: { sha256: sha(stdin), sizeBytes: Buffer.byteLength(stdin, "utf8") },
        output: null,
        points: null,
        subtask: null,
      },
    ]);
    expect(spec.inlineBlobs).toEqual({ [sha(stdin)]: stdin });
  });

  it("delivers an empty custom stdin too", () => {
    const spec = run("");
    expect(spec.tests).toHaveLength(1);
    expect(spec.inlineBlobs[sha("")]).toBe("");
  });

  it("caps the run time limit at the custom-run ceiling", () => {
    const spec = buildJudgeJobSpec(
      submissionInput({
        kind: "run",
        lane: "RUN",
        customInput: null,
        version: { ...version, timeLimitMs: LIMITS.cpuTime.ceilingMs },
      }),
    );
    expect(spec.timeLimitMs).toBe(LIMITS.customRun.cpuMaxMs);
  });
});

// ── Protocol v2: subtasks, checker, per-language limits, startup credit ──

const SUBTASKS = [
  { index: 1, points: 20, aggregation: "MIN" as const, dependsOn: [] },
  { index: 2, points: 30, aggregation: "MIN" as const, dependsOn: [] },
  { index: 3, points: 50, aggregation: "MIN" as const, dependsOn: [2, 1] },
];

/** A STDIN, SUBTASK-scored version: tests 0–1 samples in subtask 1, then one test per subtask. */
function subtaskInput(overrides: Partial<JobSpecInput> = {}): JobSpecInput {
  const rows: JobSpecTestRow[] = [1, 1, 1, 2, 3].map((subtask, index) => ({
    index,
    isSample: index < 2,
    points: null,
    subtaskIndex: subtask,
    input: { sha256: sha(`in${index}`), sizeBytes: 3 },
    output: { sha256: sha(`out${index}`), sizeBytes: 4 },
  }));
  return submissionInput({
    version: { ...version, ioMode: "STDIN", functionSignature: null, scoringMode: "SUBTASK", stopOnFirstFailure: false },
    tests: rows,
    subtasks: SUBTASKS,
    ...overrides,
  });
}

const CHECKER = { sha256: sha("checker source"), sizeBytes: 14, testlibId: "testlib-0.9.41" };

describe("buildJudgeJobSpec — v2 subtasks", () => {
  it("maps Subtask rows for SUBTASK scoring, ordered, dependencies sorted", () => {
    const spec = buildJudgeJobSpec(subtaskInput({ subtasks: [...SUBTASKS].reverse() }));
    expect(judgeJobSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.subtasks).toEqual([
      { index: 1, points: 20, aggregation: "MIN", dependsOn: [] },
      { index: 2, points: 30, aggregation: "MIN", dependsOn: [] },
      { index: 3, points: 50, aggregation: "MIN", dependsOn: [1, 2] },
    ]);
    expect(spec.tests.map((t) => t.subtask)).toEqual([1, 1, 1, 2, 3]);
  });

  it("sends no subtasks for ICPC or PER_TEST scoring", () => {
    expect(buildJudgeJobSpec(submissionInput({ subtasks: SUBTASKS })).subtasks).toEqual([]);
  });

  it("refuses a SUBTASK version with no subtasks, unknown references or forward dependencies", () => {
    expect(() => buildJudgeJobSpec(subtaskInput({ subtasks: [] }))).toThrow(/no subtasks/);
    expect(() => buildJudgeJobSpec(subtaskInput({ subtasks: SUBTASKS.slice(0, 2) }))).toThrow(/subtask 3/);
    expect(() =>
      buildJudgeJobSpec(subtaskInput({ subtasks: [SUBTASKS[0]!, { ...SUBTASKS[1]!, dependsOn: [3] }, SUBTASKS[2]!] })),
    ).toThrow(JobSpecError);
    expect(() =>
      buildJudgeJobSpec(subtaskInput({ subtasks: [{ ...SUBTASKS[0]!, dependsOn: [1] }, ...SUBTASKS.slice(1)] })),
    ).toThrow(JobSpecError);
  });
});

describe("buildJudgeJobSpec — the interactor (Phase 12l)", () => {
  const interactiveVersion = {
    ...version,
    ioMode: "STDIN" as const,
    functionSignature: null,
    compareMode: "INTERACTIVE" as const,
  };
  const INTERACTOR = { sha256: sha("interactor source"), sizeBytes: 17, testlibId: "testlib-0.9.41" };

  it("references the interactor blob with its pinned testlib", () => {
    const spec = buildJudgeJobSpec(submissionInput({ version: interactiveVersion, interactor: INTERACTOR }));
    expect(judgeJobSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.interactor).toEqual({
      source: { sha256: INTERACTOR.sha256, sizeBytes: INTERACTOR.sizeBytes },
      language: "cpp20",
      testlibId: "testlib-0.9.41",
    });
    // One judge, not two.
    expect(spec.checker).toBeNull();
  });

  it("sends no interactor for any other compare mode, even when one is stored", () => {
    expect(buildJudgeJobSpec(submissionInput({ interactor: INTERACTOR })).interactor).toBeNull();
  });

  it("refuses an interactive version with nothing to judge it", () => {
    expect(() => buildJudgeJobSpec(submissionInput({ version: interactiveVersion, interactor: null }))).toThrow(
      /no interactor source/,
    );
    expect(() =>
      buildJudgeJobSpec(submissionInput({ version: interactiveVersion, interactor: { ...INTERACTOR, testlibId: null } })),
    ).toThrow(/testlib/);
  });

  it("refuses a conversation on a problem that has no stdin", () => {
    // A FUNCTION answer is a return value; there is no dialogue to have.
    expect(() =>
      buildJudgeJobSpec(
        submissionInput({
          version: { ...interactiveVersion, ioMode: "FUNCTION" as const, functionSignature: version.functionSignature },
          interactor: INTERACTOR,
        }),
      ),
    ).toThrow(/standard input/);
  });

  it("keeps it for a sample run, which is a conversation too", () => {
    const spec = buildJudgeJobSpec(
      submissionInput({
        kind: "run",
        lane: "RUN",
        customInput: null,
        version: interactiveVersion,
        interactor: INTERACTOR,
      }),
    );
    expect(spec.interactor).not.toBeNull();
  });
});

describe("buildJudgeJobSpec — v2 checker", () => {
  const checkerVersion = { ...version, ioMode: "STDIN" as const, functionSignature: null, compareMode: "CHECKER" as const };

  it("references the checker blob with its pinned testlib for CHECKER versions", () => {
    const spec = buildJudgeJobSpec(submissionInput({ version: checkerVersion, checker: CHECKER }));
    expect(judgeJobSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.checker).toEqual({
      source: { sha256: CHECKER.sha256, sizeBytes: CHECKER.sizeBytes },
      language: "cpp20",
      testlibId: "testlib-0.9.41",
    });
  });

  it("sends no checker for other compare modes even when one is stored", () => {
    expect(buildJudgeJobSpec(submissionInput({ checker: CHECKER })).checker).toBeNull();
  });

  it("refuses a CHECKER version without a checker or without a testlib id", () => {
    expect(() => buildJudgeJobSpec(submissionInput({ version: checkerVersion, checker: null }))).toThrow(/checker/);
    expect(() =>
      buildJudgeJobSpec(submissionInput({ version: checkerVersion, checker: { ...CHECKER, testlibId: null } })),
    ).toThrow(/testlib/);
  });

  it("keeps the checker for a sample run", () => {
    const spec = buildJudgeJobSpec(
      submissionInput({ kind: "run", lane: "RUN", customInput: null, version: checkerVersion, checker: CHECKER }),
    );
    expect(spec.checker?.source.sha256).toBe(CHECKER.sha256);
  });
});

describe("buildJudgeJobSpec — protocol 3 FUNCTION comparators", () => {
  const custom = { ...TWO_SUM.signature, comparator: "CUSTOM_CHECKER" as const };

  it("refuses a FUNCTION version whose compare mode does not mirror its comparator", () => {
    // CUSTOM_CHECKER without CHECKER …
    expect(() => buildJudgeJobSpec(submissionInput({ version: { ...version, functionSignature: custom } }))).toThrow(
      /CHECKER goes with CUSTOM_CHECKER only/,
    );
    // … and CHECKER without CUSTOM_CHECKER.
    expect(() =>
      buildJudgeJobSpec(submissionInput({ version: { ...version, compareMode: "CHECKER" }, checker: CHECKER })),
    ).toThrow(JobSpecError);
  });

  it("builds a CUSTOM_CHECKER job with its checker, and passes floatEpsilon through", () => {
    const spec = buildJudgeJobSpec(
      submissionInput({ version: { ...version, functionSignature: custom, compareMode: "CHECKER" }, checker: CHECKER }),
    );
    expect(judgeJobSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.checker?.testlibId).toBe("testlib-0.9.41");
    const float = { ...TWO_SUM.signature, comparator: "FLOAT_TOLERANCE" as const, returns: "double" };
    expect(buildJudgeJobSpec(submissionInput({ version: { ...version, functionSignature: float, floatEpsilon: 1e-4 } })).floatEpsilon).toBe(1e-4);
  });

  it("refuses a signature the stricter protocol 3 schema rejects", () => {
    const exactDouble = { ...TWO_SUM.signature, returns: "double" };
    expect(() => buildJudgeJobSpec(submissionInput({ version: { ...version, functionSignature: exactDouble } }))).toThrow(
      /Function signature is invalid/,
    );
  });
});

describe("buildJudgeJobSpec — v2 time and memory limits", () => {
  const py = (overrides: Partial<JobSpecInput> = {}) =>
    submissionInput({
      language: "py312",
      runtime: JSON.parse(JSON.stringify(LANGUAGE_CATALOG.py312)) as unknown,
      ...overrides,
    });

  it("uses the fallback multiplier when the version has no limit row for the language", () => {
    // CPython: 1000 ms × 5 + 1000 ms
    const spec = buildJudgeJobSpec(py());
    expect(spec.timeLimitMs).toBe(6000);
    expect(spec.memoryLimitKb).toBe(TWO_SUM.memoryLimitKb);
  });

  it("uses the measured ProblemLanguageLimit row when one exists", () => {
    const spec = buildJudgeJobSpec(py({ languageLimit: { timeLimitMs: 1300, memoryLimitKb: 524_288 } }));
    expect(spec.timeLimitMs).toBe(1300);
    expect(spec.memoryLimitKb).toBe(524_288);
  });

  it("adds the claiming node's startup credit", () => {
    expect(buildJudgeJobSpec(py({ startupCreditMs: 23 })).timeLimitMs).toBe(6023);
    expect(
      buildJudgeJobSpec(py({ languageLimit: { timeLimitMs: 1300, memoryLimitKb: 262_144 }, startupCreditMs: 23 }))
        .timeLimitMs,
    ).toBe(1323);
  });

  it("clamps limit plus credit to the ceiling", () => {
    const spec = buildJudgeJobSpec(
      py({ languageLimit: { timeLimitMs: LIMITS.cpuTime.ceilingMs, memoryLimitKb: 262_144 }, startupCreditMs: 500 }),
    );
    expect(spec.timeLimitMs).toBe(LIMITS.cpuTime.ceilingMs);
  });

  it("ignores a negative or non-finite credit", () => {
    expect(buildJudgeJobSpec(py({ startupCreditMs: -50 })).timeLimitMs).toBe(6000);
    expect(buildJudgeJobSpec(py({ startupCreditMs: Number.NaN })).timeLimitMs).toBe(6000);
  });

  it("refuses a limit row outside the limits table", () => {
    expect(() => buildJudgeJobSpec(py({ languageLimit: { timeLimitMs: 50, memoryLimitKb: 262_144 } }))).toThrow(
      JobSpecError,
    );
  });

  it("keeps the custom-run cap for runs, credit included", () => {
    const capped = buildJudgeJobSpec(py({ kind: "run", lane: "RUN", customInput: "1\n", startupCreditMs: 40 }));
    expect(capped.timeLimitMs).toBe(LIMITS.customRun.cpuMaxMs);
    const fast = buildJudgeJobSpec(
      py({
        kind: "run",
        lane: "RUN",
        customInput: null,
        languageLimit: { timeLimitMs: 900, memoryLimitKb: 262_144 },
        startupCreditMs: 40,
      }),
    );
    expect(fast.timeLimitMs).toBe(940);
  });
});

describe("buildJudgeJobSpec — validation jobs", () => {
  const validation = (expectedVerdict: "AC" | "TLE" | "WA", overrides: Partial<JobSpecInput> = {}) =>
    buildJudgeJobSpec(
      submissionInput({
        kind: "validation",
        lane: "REJUDGE",
        id: "cmval000000000000000000001",
        expectedVerdict,
        ...overrides,
      }),
    );

  it("measures a model solution at the ceiling on every test", () => {
    const spec = validation("AC", { languageLimit: { timeLimitMs: 1000, memoryLimitKb: 262_144 }, startupCreditMs: 5 });
    expect(judgeJobSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.kind).toBe("validation");
    expect(spec.lane).toBe("REJUDGE");
    expect(spec.timeLimitMs).toBe(LIMITS.cpuTime.ceilingMs);
    expect(spec.stopOnFirstFailure).toBe(false);
    expect(spec.tests).toHaveLength(14);
  });

  it("judges a deliberately-wrong solution at the derived limit and stops at its first failure", () => {
    const spec = validation("TLE", { languageLimit: { timeLimitMs: 1000, memoryLimitKb: 262_144 }, startupCreditMs: 5 });
    expect(judgeJobSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.timeLimitMs).toBe(1005);
    expect(spec.stopOnFirstFailure).toBe(true);
    expect(validation("WA").timeLimitMs).toBe(TWO_SUM.timeLimitMs);
  });

  it("needs the expected verdict", () => {
    expect(() => buildJudgeJobSpec(submissionInput({ kind: "validation", lane: "REJUDGE" }))).toThrow(
      /expected verdict/,
    );
  });
});
