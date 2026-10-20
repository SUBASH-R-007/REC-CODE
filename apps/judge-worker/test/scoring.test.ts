import { describe, expect, it } from "vitest";
import {
  JUDGE_PROTOCOL_VERSION,
  LANGUAGE_CATALOG,
  resultRequestSchema,
  type JudgeJobSpec,
  type ProgressEvent,
  type SubtaskSpec,
  type Verdict,
} from "@recx/shared";
import { TWO_SUM } from "@recx/shared/samples/two-sum";
import type { JudgeOutcome } from "../src/drivers/types";
import { PermanentJudgeError } from "../src/errors";
import { aggregate, compileErrorOutcome, maxScoreFor } from "../src/judge/aggregate";
import {
  assertRuntimeKnown,
  effectiveCompareMode,
  executeTests,
  planJob,
  resolveSubtasks,
  scoreSubtask,
  type TestOutcome,
} from "../src/judge/plan";
import { buildJob, type TestCaseInput } from "./support/jobs";

/** Fabricated per-test outcomes: AC unless listed; a number is a checker partial fraction (PARTIAL). */
type Script = Record<number, Verdict | number>;

async function judge(spec: JudgeJobSpec, script: Script = {}) {
  const plan = planJob(spec);
  const events: ProgressEvent[] = [];
  const ran: number[] = [];
  const executed = await executeTests(
    spec,
    plan,
    async (test): Promise<TestOutcome> => {
      ran.push(test.index);
      const entry = script[test.index] ?? "AC";
      if (typeof entry === "number") return { result: { i: test.index, v: "PARTIAL", ms: 10, kb: 100 }, fraction: entry };
      return { result: { i: test.index, v: entry, ms: 10, kb: 100 }, fraction: entry === "AC" ? 1 : 0 };
    },
    (e) => events.push(e),
  );
  const outcome = aggregate(spec, executed, null);
  return { outcome, events, ran, plan };
}

function asResult(spec: JudgeJobSpec, outcome: JudgeOutcome) {
  return {
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: spec.kind,
    id: spec.id,
    claimToken: spec.claimToken,
    ...outcome,
    judgeNodeId: "judge-test-01",
    calibrationScore: null,
  };
}

const cases = (subtasks: number[], points: (number | null)[] = []): TestCaseInput[] =>
  subtasks.map((subtask, i) => ({ input: `${i}\n`, output: `${i}\n`, subtask, points: points[i] ?? null }));

const st = (index: number, points: number, aggregation: SubtaskSpec["aggregation"], dependsOn: number[] = []): SubtaskSpec => ({
  index,
  points,
  aggregation,
  dependsOn,
});

/**
 * Subtask 0: MIN, 20 pts, tests 0â€“1
 * Subtask 1: SUM_FRACTION, 30 pts, tests 2â€“4
 * Subtask 2: MIN, 50 pts, tests 5â€“6, depends on subtask 0
 */
type SpecPatch = Partial<Omit<JudgeJobSpec, "language" | "source" | "tests">>;

function threeSubtasks(overrides: SpecPatch = {}) {
  return buildJob({
    cases: cases([0, 0, 1, 1, 1, 2, 2]),
    scoringMode: "SUBTASK",
    subtasks: [st(0, 20, "MIN"), st(1, 30, "SUM_FRACTION"), st(2, 50, "MIN", [0])],
    ...overrides,
  }).spec;
}

describe("SUBTASK scoring", () => {
  it("all tests AC â†’ AC with the full score", async () => {
    const spec = threeSubtasks();
    const { outcome, events } = await judge(spec);
    expect(outcome).toMatchObject({ verdict: "AC", score: 100, maxScore: 100, passedCases: 7, firstFailedIndex: null });
    expect(outcome.subtasks).toEqual([
      { index: 0, earned: 20, max: 20, verdict: "AC" },
      { index: 1, earned: 30, max: 30, verdict: "AC" },
      { index: 2, earned: 50, max: 50, verdict: "AC" },
    ]);
    expect(events.filter((e) => e.type === "subtask")).toEqual([
      { type: "subtask", index: 0, v: "AC" },
      { type: "subtask", index: 1, v: "AC" },
      { type: "subtask", index: 2, v: "AC" },
    ]);
  });

  it("MIN fails on one test, SUM_FRACTION earns its share, a dependent subtask is SKIPPED without running â†’ PARTIAL", async () => {
    const spec = threeSubtasks();
    const { outcome, events, ran } = await judge(spec, { 1: "WA", 3: "TLE" });
    expect(outcome.subtasks).toEqual([
      { index: 0, earned: 0, max: 20, verdict: "WA" },
      { index: 1, earned: 20, max: 30, verdict: "PARTIAL" },
      { index: 2, earned: 0, max: 50, verdict: "SKIPPED" },
    ]);
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 20, maxScore: 100, firstFailedIndex: 1 });
    // Subtask 2's tests never ran; they are reported SKIPPED.
    expect(ran).toEqual([0, 1, 2, 3, 4]);
    expect(outcome.tests.map((t) => t.v)).toEqual(["AC", "WA", "AC", "TLE", "AC", "SKIPPED", "SKIPPED"]);
    expect(outcome.cpuMs).toBe(50);
    expect(events).toEqual([
      { type: "test", i: 0, v: "AC", done: 1, total: 7 },
      { type: "test", i: 1, v: "WA", done: 2, total: 7 },
      { type: "subtask", index: 0, v: "WA" },
      { type: "test", i: 2, v: "AC", done: 3, total: 7 },
      { type: "test", i: 3, v: "TLE", done: 4, total: 7 },
      { type: "test", i: 4, v: "AC", done: 5, total: 7 },
      { type: "subtask", index: 1, v: "PARTIAL" },
      { type: "subtask", index: 2, v: "SKIPPED" },
    ]);
  });

  it("within a MIN subtask the first failure stops it (stopOnFirstFailure) â€” the rest are SKIPPED", async () => {
    const spec = buildJob({ cases: cases([0, 0, 0, 1]), scoringMode: "SUBTASK", subtasks: [st(0, 60, "MIN"), st(1, 40, "MIN")] }).spec;
    const { outcome, ran } = await judge(spec, { 1: "RE" });
    expect(ran).toEqual([0, 1, 3]);
    expect(outcome.tests.map((t) => t.v)).toEqual(["AC", "RE", "SKIPPED", "AC"]);
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 40, maxScore: 100 });
  });

  it("without stopOnFirstFailure every test of a MIN subtask runs (validation wants every time)", async () => {
    const spec = buildJob({
      cases: cases([0, 0, 0]),
      scoringMode: "SUBTASK",
      stopOnFirstFailure: false,
      subtasks: [st(0, 10, "MIN")],
    }).spec;
    const { outcome, ran } = await judge(spec, { 0: "WA" });
    expect(ran).toEqual([0, 1, 2]);
    expect(outcome).toMatchObject({ verdict: "WA", score: 0, maxScore: 10 });
  });

  it("a SUM_FRACTION subtask never stops early", async () => {
    const spec = buildJob({ cases: cases([0, 0, 0, 0]), scoringMode: "SUBTASK", subtasks: [st(0, 100, "SUM_FRACTION")] }).spec;
    const { outcome, ran } = await judge(spec, { 0: "WA", 1: "WA", 2: "WA" });
    expect(ran).toEqual([0, 1, 2, 3]);
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 25 });
    expect(outcome.subtasks[0]).toEqual({ index: 0, earned: 25, max: 100, verdict: "PARTIAL" });
  });

  it("score 0 â†’ the worst verdict by precedence (RE > TLE > WA)", async () => {
    const spec = buildJob({ cases: cases([0, 1, 2]), scoringMode: "SUBTASK", subtasks: [st(0, 1, "MIN"), st(1, 1, "MIN"), st(2, 1, "MIN")] }).spec;
    const { outcome } = await judge(spec, { 0: "WA", 1: "TLE", 2: "RE" });
    expect(outcome).toMatchObject({ verdict: "RE", score: 0, maxScore: 3, firstFailedIndex: 0 });
  });

  it("checker partial credit: MIN takes the smallest fraction, SUM_FRACTION the mean", async () => {
    const spec = buildJob({
      cases: cases([0, 0, 0, 1, 1]),
      scoringMode: "SUBTASK",
      subtasks: [st(0, 40, "MIN"), st(1, 60, "SUM_FRACTION")],
    }).spec;
    const { outcome } = await judge(spec, { 1: 0.5, 2: 0.8, 4: 0.25 });
    expect(outcome.subtasks).toEqual([
      { index: 0, earned: 20, max: 40, verdict: "PARTIAL" },
      { index: 1, earned: 37.5, max: 60, verdict: "PARTIAL" },
    ]);
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 57.5, maxScore: 100 });
  });

  it("runs subtasks in dependency order (ties by index), whatever their numbering", async () => {
    const spec = buildJob({
      cases: cases([0, 1, 2]),
      scoringMode: "SUBTASK",
      subtasks: [st(0, 10, "MIN", [2]), st(1, 10, "MIN"), st(2, 10, "MIN", [1])],
    }).spec;
    const { ran, outcome } = await judge(spec);
    expect(ran).toEqual([1, 2, 0]);
    expect(outcome.subtasks.map((s) => s.index)).toEqual([1, 2, 0]);
    expect(outcome.tests.map((t) => t.i)).toEqual([0, 1, 2]);
  });

  it("a dependency that is only partially passed still blocks", async () => {
    const spec = buildJob({
      cases: cases([0, 0, 1]),
      scoringMode: "SUBTASK",
      subtasks: [st(0, 50, "SUM_FRACTION"), st(1, 50, "MIN", [0])],
    }).spec;
    const { outcome, ran } = await judge(spec, { 1: "WA" });
    expect(ran).toEqual([0, 1]);
    expect(outcome.subtasks[1]).toEqual({ index: 1, earned: 0, max: 50, verdict: "SKIPPED" });
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 25 });
  });

  it("non-integer shares are rounded, not left with float noise", async () => {
    const spec = buildJob({ cases: cases([0, 0, 0]), scoringMode: "SUBTASK", subtasks: [st(0, 10, "SUM_FRACTION")] }).spec;
    const { outcome } = await judge(spec, { 0: "WA" });
    expect(outcome.score).toBe(6.666667);
  });

  it("a version without a subtask table: one MIN subtask per test.subtask, worth its tests' points (Phase 1 rule)", async () => {
    const spec = buildJob({ cases: cases([0, 0, 1, 1], [10, 10, 30, null]), scoringMode: "SUBTASK" }).spec;
    expect(resolveSubtasks(spec).map((s) => ({ index: s.index, points: s.points, aggregation: s.aggregation }))).toEqual([
      { index: 0, points: 20, aggregation: "MIN" },
      { index: 1, points: 31, aggregation: "MIN" },
    ]);
    const { outcome } = await judge(spec, { 3: "WA" });
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 20, maxScore: 51 });
  });

  it.each<[string, SpecPatch & { cases?: TestCaseInput[] }, RegExp]>([
    ["a duplicate subtask", { subtasks: [st(0, 1, "MIN"), st(0, 2, "MIN")] }, /declared twice/],
    ["a test naming an undeclared subtask", { subtasks: [st(0, 1, "MIN")], cases: cases([0, 5]) }, /undeclared subtask 5/],
    ["a test in no subtask", { subtasks: [st(0, 1, "MIN")], cases: [{ input: "1", output: "1", subtask: null }] }, /no subtask/],
    ["a subtask with no tests", { subtasks: [st(0, 1, "MIN"), st(1, 1, "MIN")], cases: cases([0]) }, /no tests/],
    ["a self dependency", { subtasks: [st(0, 1, "MIN", [0])], cases: cases([0]) }, /depends on itself/],
    ["an unknown dependency", { subtasks: [st(0, 1, "MIN", [9])], cases: cases([0]) }, /undeclared subtask 9/],
    ["a cycle", { subtasks: [st(0, 1, "MIN", [1]), st(1, 1, "MIN", [0])], cases: cases([0, 1]) }, /cycle/],
  ])("%s is a permanent failure", (_name, patch, message) => {
    const { cases: testCases = cases([0]), ...rest } = patch;
    const spec = buildJob({ cases: testCases, scoringMode: "SUBTASK", ...rest }).spec;
    expect(() => planJob(spec)).toThrow(PermanentJudgeError);
    expect(() => planJob(spec)).toThrow(message);
  });

  it("a Run of a SUBTASK problem is feedback: no subtasks, no score, every sample runs", async () => {
    const spec = threeSubtasks({ kind: "run", stopOnFirstFailure: false });
    const { outcome, events, ran, plan } = await judge(spec, { 1: "WA" });
    expect(plan.subtasks).toBeNull();
    expect(ran).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(outcome).toMatchObject({ verdict: "WA", score: null, maxScore: null, subtasks: [] });
    expect(events.some((e) => e.type === "subtask")).toBe(false);
  });
});

describe("scoreSubtask", () => {
  const o = (v: Verdict, fraction = v === "AC" ? 1 : 0): TestOutcome => ({ result: { i: 0, v, ms: 1, kb: 1 }, fraction });

  it("MIN: all AC earns everything; one failure earns nothing; tests that never ran earn nothing", () => {
    expect(scoreSubtask({ points: 30, aggregation: "MIN" }, 2, [o("AC"), o("AC")])).toEqual({ earned: 30, verdict: "AC", fullyPassed: true });
    expect(scoreSubtask({ points: 30, aggregation: "MIN" }, 2, [o("AC"), o("MLE")])).toEqual({ earned: 0, verdict: "MLE", fullyPassed: false });
    expect(scoreSubtask({ points: 30, aggregation: "MIN" }, 3, [o("AC"), o("AC")])).toMatchObject({ earned: 0, fullyPassed: false });
  });

  it("SUM_FRACTION: points Ã— passed / total", () => {
    expect(scoreSubtask({ points: 30, aggregation: "SUM_FRACTION" }, 3, [o("AC"), o("WA"), o("AC")])).toEqual({
      earned: 20,
      verdict: "PARTIAL",
      fullyPassed: false,
    });
  });

  it("a 0-point subtask is AC only when every test is AC", () => {
    expect(scoreSubtask({ points: 0, aggregation: "MIN" }, 1, [o("AC")])).toMatchObject({ verdict: "AC", fullyPassed: true });
    expect(scoreSubtask({ points: 0, aggregation: "MIN" }, 1, [o("WA")])).toMatchObject({ verdict: "WA", earned: 0 });
  });
});

describe("PER_TEST scoring", () => {
  it("score = points of AC tests, maxScore = all points; PARTIAL when some were earned", async () => {
    const spec = buildJob({ cases: cases([0, 0, 0, 0], [10, 20, 30, 40]), scoringMode: "PER_TEST", stopOnFirstFailure: true }).spec;
    const { outcome, ran } = await judge(spec, { 1: "WA", 3: "TLE" });
    expect(ran).toEqual([0, 1, 2, 3]); // PER_TEST never stops early
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 40, maxScore: 100, subtasks: [], firstFailedIndex: 1 });
  });

  it("null points weigh 1; checker partial credit earns its share of the test", async () => {
    const spec = buildJob({ cases: cases([0, 0, 0], [null, null, 8]), scoringMode: "PER_TEST" }).spec;
    expect(maxScoreFor(spec, null)).toBe(10);
    const { outcome } = await judge(spec, { 2: 0.25 });
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 4, maxScore: 10 });
  });

  it("everything AC â†’ AC; nothing earned â†’ the worst verdict", async () => {
    const spec = buildJob({ cases: cases([0, 0], [5, 5]), scoringMode: "PER_TEST" }).spec;
    expect((await judge(spec)).outcome).toMatchObject({ verdict: "AC", score: 10, maxScore: 10 });
    expect((await judge(spec, { 0: "WA", 1: "OLE" })).outcome).toMatchObject({ verdict: "OLE", score: 0 });
  });
});

describe("ICPC scoring", () => {
  it("score 1 / 0 of maxScore 1, stopping at the first failure", async () => {
    const spec = buildJob({ cases: cases([0, 0, 0]) }).spec;
    const pass = await judge(spec);
    expect(pass.outcome).toMatchObject({ verdict: "AC", score: 1, maxScore: 1 });
    const fail = await judge(spec, { 1: "MLE" });
    expect(fail.ran).toEqual([0, 1]);
    expect(fail.outcome).toMatchObject({ verdict: "MLE", score: 0, maxScore: 1, firstFailedIndex: 1 });
    expect(fail.outcome.tests.map((t) => t.v)).toEqual(["AC", "MLE", "SKIPPED"]);
  });

  it("stopOnFirstFailure false runs everything; the verdict is still the first failure's", async () => {
    const spec = buildJob({ cases: cases([0, 0, 0]), stopOnFirstFailure: false }).spec;
    const { outcome, ran } = await judge(spec, { 1: "WA", 2: "RE" });
    expect(ran).toEqual([0, 1, 2]);
    expect(outcome.verdict).toBe("WA");
  });

  it("partial checker credit is not credit under ICPC: the job is WA, the test stays PARTIAL", async () => {
    const spec = buildJob({ cases: cases([0, 0]) }).spec;
    const { outcome } = await judge(spec, { 0: 0.6 });
    expect(outcome).toMatchObject({ verdict: "WA", score: 0 });
    expect(outcome.tests[0]!.v).toBe("PARTIAL");
  });
});

describe("protocol v2 result shapes", () => {
  it.each<[string, () => JudgeJobSpec, Script]>([
    ["ICPC", () => buildJob({ cases: cases([0, 0]) }).spec, { 1: "WA" }],
    ["PER_TEST", () => buildJob({ cases: cases([0, 0], [3, 7]), scoringMode: "PER_TEST" }).spec, { 1: 0.5 }],
    ["SUBTASK", () => threeSubtasks(), { 1: "WA" }],
    ["run", () => buildJob({ kind: "run", cases: [{ input: "1 2\n", output: null }] }).spec, {}],
    ["validation", () => buildJob({ kind: "validation", cases: cases([0, 0]) }).spec, {}],
  ])("%s validates against resultRequestSchema", async (_name, make, script) => {
    const spec = make();
    const { outcome } = await judge(spec, script);
    const parsed = resultRequestSchema.safeParse(asResult(spec, outcome));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("a CE carries maxScore and no subtasks", () => {
    const spec = threeSubtasks();
    const ce = compileErrorOutcome(spec, { ok: false, output: "main.cpp:1: error", timeMs: 5, cached: false, resourceExceeded: false }, planJob(spec).subtasks);
    expect(ce).toMatchObject({ verdict: "CE", score: 0, maxScore: 100, subtasks: [], cpuMs: 0, tests: [] });
    expect(resultRequestSchema.safeParse(asResult(spec, ce)).success).toBe(true);
    const run = buildJob({ kind: "run", cases: cases([0]) }).spec;
    expect(compileErrorOutcome(run, ce.compile!, null)).toMatchObject({ score: null, maxScore: null });
  });
});

describe("planJob â€” what no node can judge is refused permanently", () => {
  it("INTERACTIVE, and CHECKER without a checker", () => {
    expect(() => planJob(buildJob({ compareMode: "INTERACTIVE", cases: cases([0]) }).spec)).toThrow(PermanentJudgeError);
    expect(() => planJob(buildJob({ compareMode: "CHECKER", cases: cases([0]) }).spec)).toThrow(/without a checker/);
  });

  it("a checker whose testlib id is not a testlib-<version> directory", () => {
    // First fence: the protocol schema refuses a malformed toolchain id, so
    // such a claim response never parses (fixtures go through the schema).
    for (const testlibId of ["testlib", "../testlib-1", "testlib-1/../../x"]) {
      expect(() => buildJob({ checkerSource: "int main(){}", testlibId, cases: cases([0]) })).toThrow();
    }
    // Second fence: planJob itself, reached here by mutating a parsed spec.
    for (const testlibId of ["gcc-13.2.0", "testlib", "../testlib-1", "testlib-1/../../x"]) {
      const spec = buildJob({ checkerSource: "int main(){}", testlibId: "testlib-0.9.41", cases: cases([0]) }).spec;
      const tampered = { ...spec, checker: { ...spec.checker!, testlibId } };
      expect(() => planJob(tampered)).toThrow(PermanentJudgeError);
    }
    expect(planJob(buildJob({ checkerSource: "int main(){}", testlibId: "testlib-0.9.41", cases: cases([0]) }).spec).compareMode).toBe("CHECKER");
  });

  it("a toolchain the language catalog does not know; a program outside the job's toolchains", () => {
    const cpp = LANGUAGE_CATALOG.cpp20;
    expect(() => assertRuntimeKnown({ ...cpp, toolchainId: "gcc-99.0.0" })).toThrow(/unknown to this judge's language catalog/);
    expect(() => assertRuntimeKnown({ ...cpp, extraToolchainIds: ["../etc"] })).toThrow(PermanentJudgeError);
    expect(() => assertRuntimeKnown({ ...cpp, run: { argv: ["/bin/sh", "-c", "id"] } })).toThrow(/outside its toolchains/);
    expect(() => assertRuntimeKnown({ ...cpp, run: { argv: ["./sub/main"] } })).toThrow(/outside its toolchains/);
    expect(() =>
      assertRuntimeKnown({ ...cpp, compile: { argv: ["/opt/toolchains/gcc-13.2.0/../cpython-3.12.6/bin/python3"], slow: false } }),
    ).toThrow(/outside its toolchains/);
    for (const key of Object.keys(LANGUAGE_CATALOG) as (keyof typeof LANGUAGE_CATALOG)[]) {
      expect(() => assertRuntimeKnown(LANGUAGE_CATALOG[key])).not.toThrow();
    }
  });

  it("a test index listed twice", () => {
    const spec = buildJob({ cases: cases([0, 0]) }).spec;
    const doubled = { ...spec, tests: [spec.tests[0]!, { ...spec.tests[1]!, index: 0 }] };
    expect(() => planJob(doubled)).toThrow(/twice/);
  });

  it("FUNCTION comparators: all six are judged; CHECKER exactly mirrors CUSTOM_CHECKER (protocol 3)", () => {
    const sigFor = (comparator: string): JudgeJobSpec["functionSignature"] => {
      switch (comparator) {
        case "FLOAT_TOLERANCE":
          return { ...TWO_SUM.signature, comparator, returns: "double" } as JudgeJobSpec["functionSignature"];
        case "ROWS_ANY_ORDER":
          return { ...TWO_SUM.signature, comparator, returns: "matrix<int>" } as JudgeJobSpec["functionSignature"];
        case "IN_PLACE_MUTATION":
          return { ...TWO_SUM.signature, comparator, returns: "void", mutatedParam: "nums" } as JudgeJobSpec["functionSignature"];
        default:
          return { ...TWO_SUM.signature, comparator } as JudgeJobSpec["functionSignature"];
      }
    };
    const fn = (comparator: string, compareMode: JudgeJobSpec["compareMode"] = "TOKEN") =>
      effectiveCompareMode({ ioMode: "FUNCTION", compareMode, functionSignature: sigFor(comparator) });
    for (const comparator of ["EXACT", "IN_PLACE_MUTATION", "FLOAT_TOLERANCE", "SET_EQUAL", "ROWS_ANY_ORDER"]) {
      expect(fn(comparator), comparator).toBe("TOKEN");
      expect(() => fn(comparator, "CHECKER"), comparator).toThrow(PermanentJudgeError);
    }
    expect(fn("CUSTOM_CHECKER", "CHECKER")).toBe("CHECKER");
    expect(() => fn("CUSTOM_CHECKER")).toThrow(/needs CHECKER/);
    expect(() => effectiveCompareMode({ ioMode: "FUNCTION", compareMode: "TOKEN", functionSignature: null })).toThrow(/without a function signature/);
    expect(() => fn("EXACT", "INTERACTIVE")).toThrow(PermanentJudgeError);
  });

  it("FUNCTION jobs carry a structured comparison; STDIN jobs do not", () => {
    const fnJob = buildJob({ ioMode: "FUNCTION", functionSignature: TWO_SUM.signature, floatEpsilon: 0.5, cases: cases([0]) }).spec;
    expect(planJob(fnJob).functionCompare).toMatchObject({ comparator: "EXACT", type: { kind: "list" }, floatEpsilon: 0.5 });
    expect(planJob(buildJob({ cases: cases([0]) }).spec).functionCompare).toBeNull();
  });
});
