import {
  LANGUAGE_CATALOG,
  LANGUAGE_KEYS,
  TOOLCHAIN_ID_PATTERN,
  TOOLCHAIN_ROOT,
  worstVerdict,
  type CheckerSpec,
  type CompareMode,
  type JudgeJobSpec,
  type LanguageRuntime,
  type ProgressEvent,
  type SubtaskAggregation,
  type TestResult,
  type TestSpec,
  type Verdict,
} from "@recx/shared";
import { functionCompareSpec, type FunctionCompareSpec } from "@recx/shared/harness";
import type { SubtaskOutcome } from "../drivers/types";
import { InfraError, PermanentJudgeError } from "../errors";

/**
 * What a job means before anything runs, and the order its tests run in.
 *
 * planJob() validates everything about a spec that no node could fix by
 * retrying — an unsupported compare mode, a runtime whose toolchains the
 * language catalog does not know, a program path outside the job's own
 * toolchains, a malformed checker reference, a subtask table that does not
 * describe the tests — and throws PermanentJudgeError for it, before any box
 * is created. A toolchain the catalog knows but THIS node lacks is not
 * checked here: that is an ordinary, retryable InfraError raised by the
 * driver.
 *
 * executeTests() runs the tests through a caller-supplied runOne():
 *
 *   ICPC       index order; with stopOnFirstFailure the first test that is
 *              not AC ends the run and the rest are SKIPPED.
 *   PER_TEST   index order; every test runs.
 *   SUBTASK    subtask by subtask in dependency order (ties by index), each
 *              subtask's tests in index order:
 *                - a subtask with a dependency that was not fully passed is
 *                  SKIPPED: none of its tests run, it earns 0;
 *                - MIN: the subtask earns points × the smallest test fraction;
 *                  with stopOnFirstFailure a test earning nothing ends the
 *                  subtask (its remaining tests are SKIPPED — the score is
 *                  already decided);
 *                - SUM_FRACTION: points × (sum of test fractions) / tests;
 *                  every test runs.
 *              A {type:"subtask"} progress event follows each subtask.
 *   runs       (the Run button) index order, feedback only — never scored,
 *              never grouped into subtasks.
 *
 * A test's fraction is 1 for AC, n/100 for testlib partial credit
 * (PARTIAL), else 0. "Fully passed" means every test of the subtask is AC.
 */

export interface ResolvedSubtask {
  index: number;
  points: number;
  aggregation: SubtaskAggregation;
  dependsOn: number[];
  /** The subtask's tests, in index order. */
  tests: TestSpec[];
}

export interface JudgePlan {
  /**
   * The spec's compare mode, validated. For FUNCTION jobs it decides only
   * whether the checker runs (CHECKER ⇔ CUSTOM_CHECKER); the output itself is
   * compared structurally through `functionCompare`.
   */
  compareMode: CompareMode;
  /** The checker, when compareMode is CHECKER. */
  checker: CheckerSpec | null;
  /** SUBTASK scoring of a submission or validation, in execution order; null otherwise. */
  subtasks: ResolvedSubtask[] | null;
  /**
   * FUNCTION jobs (protocol 3): the structured comparison of the program's
   * output (@recx/shared/harness compare.ts) — every comparator, including
   * CUSTOM_CHECKER, whose output is canonicalised before the checker runs.
   * Null for STDIN jobs.
   */
  functionCompare: FunctionCompareSpec | null;
}

export interface TestOutcome {
  result: TestResult;
  /** Share of the test's points earned: 1 for AC, n/100 for checker partial credit, else 0. */
  fraction: number;
}

export interface ExecutedTests {
  /** One per spec test (SKIPPED for tests that never ran), in index order. */
  results: TestResult[];
  /** Earned fraction per test index; absent = 0. */
  fractions: ReadonlyMap<number, number>;
  /** SUBTASK scoring only, in execution order. */
  subtasks: SubtaskOutcome[];
}

/** Every toolchain directory id some catalog language uses. */
const CATALOG_TOOLCHAINS: ReadonlySet<string> = new Set(
  LANGUAGE_KEYS.flatMap((key) => [LANGUAGE_CATALOG[key].toolchainId, ...LANGUAGE_CATALOG[key].extraToolchainIds]),
);

/** A checker's testlib directory: /opt/toolchains/testlib-<version>. */
const TESTLIB_ID = /^testlib-[0-9][0-9A-Za-z.+_-]*$/;

/** Points are floats (subtask points); keep sums free of binary-fraction noise. */
export function roundPoints(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

const testWeight = (points: number | null | undefined) => points ?? 1;

export function planJob(spec: JudgeJobSpec): JudgePlan {
  assertRuntimeKnown(spec.language);
  const indexes = new Set<number>();
  for (const t of spec.tests) {
    if (indexes.has(t.index)) throw new PermanentJudgeError(`job spec lists test ${t.index} twice`);
    indexes.add(t.index);
  }
  const compareMode = effectiveCompareMode(spec);
  let checker: CheckerSpec | null = null;
  if (compareMode === "CHECKER") {
    checker = spec.checker;
    if (!checker) throw new PermanentJudgeError("CHECKER comparison without a checker in the job spec");
    if (!TESTLIB_ID.test(checker.testlibId) || !TOOLCHAIN_ID_PATTERN.test(checker.testlibId)) {
      throw new PermanentJudgeError(`checker testlib id ${JSON.stringify(checker.testlibId)} is not a testlib-<version> directory`);
    }
  }
  const subtasks = spec.kind !== "run" && spec.scoringMode === "SUBTASK" ? resolveSubtasks(spec) : null;
  const functionCompare =
    spec.ioMode === "FUNCTION" && spec.functionSignature ? functionCompareSpec(spec.functionSignature, spec.floatEpsilon) : null;
  return { compareMode, checker, subtasks, functionCompare };
}

/**
 * Every toolchain id of the runtime is a plain directory name some catalog
 * language uses, and every absolute program path lies inside the runtime's
 * own toolchains. A runtime failing this can never run on any node.
 */
export function assertRuntimeKnown(
  runtime: Pick<LanguageRuntime, "key" | "toolchainId" | "extraToolchainIds" | "compile" | "run">,
): void {
  const ids = [runtime.toolchainId, ...runtime.extraToolchainIds];
  for (const id of ids) {
    if (!TOOLCHAIN_ID_PATTERN.test(id)) {
      throw new PermanentJudgeError(`illegal toolchain id ${JSON.stringify(id)} for ${runtime.key}`);
    }
    if (!CATALOG_TOOLCHAINS.has(id)) {
      throw new PermanentJudgeError(`toolchain ${id} of ${runtime.key} is unknown to this judge's language catalog`);
    }
  }
  const dirs = ids.map((id) => `${TOOLCHAIN_ROOT}/${id}/`);
  for (const program of [runtime.compile?.argv[0], runtime.run.argv[0]]) {
    if (program === undefined) continue;
    const inBox = /^\.\/[A-Za-z0-9_][A-Za-z0-9_.$-]{0,127}$/.test(program) && !program.includes("..");
    const inToolchain = dirs.some((dir) => program.startsWith(dir)) && !program.split("/").includes("..");
    if (!inBox && !inToolchain) {
      throw new PermanentJudgeError(`program ${JSON.stringify(program)} of ${runtime.key} is outside its toolchains`);
    }
  }
}

/**
 * The comparison actually applied; PermanentJudgeError when this judge cannot
 * apply the one asked for. STDIN: the spec's mode (INTERACTIVE refused).
 * FUNCTION: every comparator is judged (structurally, see planJob); the
 * spec's compareMode must mirror it — CHECKER exactly when the comparator is
 * CUSTOM_CHECKER — and is otherwise unused.
 */
export function effectiveCompareMode(
  spec: Pick<JudgeJobSpec, "compareMode" | "ioMode" | "functionSignature">,
): CompareMode {
  if (spec.compareMode === "INTERACTIVE") {
    throw new PermanentJudgeError("INTERACTIVE comparison is not available on this judge");
  }
  if (spec.ioMode !== "FUNCTION") return spec.compareMode;

  const sig = spec.functionSignature;
  if (!sig) throw new PermanentJudgeError("FUNCTION-mode job without a function signature");
  const custom = sig.comparator === "CUSTOM_CHECKER";
  if (custom && spec.compareMode !== "CHECKER") {
    throw new PermanentJudgeError("FUNCTION comparator CUSTOM_CHECKER needs CHECKER comparison and a checker");
  }
  if (!custom && spec.compareMode === "CHECKER") {
    throw new PermanentJudgeError(`FUNCTION comparator ${sig.comparator} cannot be judged by a checker (CHECKER goes only with CUSTOM_CHECKER)`);
  }
  return spec.compareMode;
}

/**
 * The subtask table in execution order. With no subtasks in the spec (a
 * version authored before subtask tables existed), every distinct
 * test.subtask (null → 0) is a MIN subtask worth its tests' points, with no
 * dependencies — the Phase 1 rule.
 */
export function resolveSubtasks(spec: Pick<JudgeJobSpec, "subtasks" | "tests">): ResolvedSubtask[] {
  const tests = [...spec.tests].sort((a, b) => a.index - b.index);

  if (spec.subtasks.length === 0) {
    const groups = new Map<number, TestSpec[]>();
    for (const t of tests) {
      const key = t.subtask ?? 0;
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    return [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, members]) => ({
        index,
        points: members.reduce((sum, t) => sum + testWeight(t.points), 0),
        aggregation: "MIN" as const,
        dependsOn: [],
        tests: members,
      }));
  }

  const declared = new Map<number, ResolvedSubtask>();
  for (const s of spec.subtasks) {
    if (declared.has(s.index)) throw new PermanentJudgeError(`subtask ${s.index} is declared twice`);
    declared.set(s.index, { index: s.index, points: s.points, aggregation: s.aggregation, dependsOn: [...new Set(s.dependsOn)], tests: [] });
  }
  for (const t of tests) {
    if (t.subtask === null) throw new PermanentJudgeError(`test ${t.index} belongs to no subtask under SUBTASK scoring`);
    const owner = declared.get(t.subtask);
    if (!owner) throw new PermanentJudgeError(`test ${t.index} names undeclared subtask ${t.subtask}`);
    owner.tests.push(t);
  }
  for (const s of declared.values()) {
    if (s.tests.length === 0) throw new PermanentJudgeError(`subtask ${s.index} has no tests`);
    for (const d of s.dependsOn) {
      if (d === s.index) throw new PermanentJudgeError(`subtask ${s.index} depends on itself`);
      if (!declared.has(d)) throw new PermanentJudgeError(`subtask ${s.index} depends on undeclared subtask ${d}`);
    }
  }

  // Dependency order; among the subtasks that are ready, the lowest index first.
  const order: ResolvedSubtask[] = [];
  const remaining = new Map(declared);
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((s) => s.dependsOn.every((d) => !remaining.has(d)))
      .sort((a, b) => a.index - b.index)[0];
    if (!ready) {
      throw new PermanentJudgeError(`subtask dependencies form a cycle among ${[...remaining.keys()].join(", ")}`);
    }
    order.push(ready);
    remaining.delete(ready.index);
  }
  return order;
}

export interface SubtaskScore {
  earned: number;
  verdict: Verdict;
  /** Every test of the subtask ran and is AC. */
  fullyPassed: boolean;
}

/**
 * One subtask's score from the tests that ran (`ran`; tests that did not run
 * — stopped early — count as earning nothing). `testCount` is the number of
 * tests in the subtask.
 */
export function scoreSubtask(
  subtask: Pick<ResolvedSubtask, "points" | "aggregation">,
  testCount: number,
  ran: readonly TestOutcome[],
): SubtaskScore {
  const fractions = ran.map((o) => clampFraction(o.fraction));
  const missing = testCount - ran.length;
  const fullyPassed = missing === 0 && ran.every((o) => o.result.v === "AC");

  let share: number;
  if (testCount === 0) share = 0;
  else if (subtask.aggregation === "MIN") share = missing > 0 ? 0 : Math.min(...fractions);
  else share = fractions.reduce((sum, f) => sum + f, 0) / testCount;
  const earned = fullyPassed ? subtask.points : roundPoints(subtask.points * share);

  let verdict: Verdict;
  if (fullyPassed) verdict = "AC";
  else if (earned > 0) verdict = "PARTIAL";
  else {
    const failures = ran.map((o) => o.result.v).filter((v) => v !== "AC" && v !== "SKIPPED");
    verdict = failures.length > 0 ? worstVerdict(failures) : "SKIPPED";
  }
  return { earned, verdict, fullyPassed };
}

function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return fraction >= 1 ? 1 : fraction;
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new InfraError("job aborted: the worker is shutting down");
}

export async function executeTests(
  spec: Pick<JudgeJobSpec, "scoringMode" | "stopOnFirstFailure" | "tests">,
  plan: Pick<JudgePlan, "subtasks">,
  runOne: (test: TestSpec) => Promise<TestOutcome>,
  progress: (event: ProgressEvent) => void,
  signal?: AbortSignal,
): Promise<ExecutedTests> {
  const total = spec.tests.length;
  const results = new Map<number, TestResult>();
  const fractions = new Map<number, number>();

  const skip = (test: TestSpec) => {
    results.set(test.index, { i: test.index, v: "SKIPPED", ms: 0, kb: 0 });
  };
  const run = async (test: TestSpec): Promise<TestOutcome> => {
    checkAborted(signal);
    const outcome = await runOne(test);
    const fraction = clampFraction(outcome.fraction);
    results.set(test.index, outcome.result);
    fractions.set(test.index, fraction);
    progress({ type: "test", i: test.index, v: outcome.result.v, done: results.size, total });
    return { result: outcome.result, fraction };
  };
  const ordered = () => [...results.values()].sort((a, b) => a.i - b.i);

  if (!plan.subtasks) {
    const stopOnFailure = spec.scoringMode === "ICPC" && spec.stopOnFirstFailure;
    let stopped = false;
    for (const test of [...spec.tests].sort((a, b) => a.index - b.index)) {
      if (stopped) {
        skip(test);
        continue;
      }
      const outcome = await run(test);
      if (outcome.result.v !== "AC" && stopOnFailure) stopped = true;
    }
    return { results: ordered(), fractions, subtasks: [] };
  }

  const subtasks: SubtaskOutcome[] = [];
  const fullyPassed = new Set<number>();
  for (const subtask of plan.subtasks) {
    if (subtask.dependsOn.some((d) => !fullyPassed.has(d))) {
      for (const test of subtask.tests) skip(test);
      subtasks.push({ index: subtask.index, earned: 0, max: subtask.points, verdict: "SKIPPED" });
      progress({ type: "subtask", index: subtask.index, v: "SKIPPED" });
      continue;
    }
    const ran: TestOutcome[] = [];
    let stopped = false;
    for (const test of subtask.tests) {
      if (stopped) {
        skip(test);
        continue;
      }
      const outcome = await run(test);
      ran.push(outcome);
      if (subtask.aggregation === "MIN" && outcome.fraction === 0 && spec.stopOnFirstFailure) stopped = true;
    }
    const score = scoreSubtask(subtask, subtask.tests.length, ran);
    if (score.fullyPassed) fullyPassed.add(subtask.index);
    subtasks.push({ index: subtask.index, earned: score.earned, max: subtask.points, verdict: score.verdict });
    progress({ type: "subtask", index: subtask.index, v: score.verdict });
  }
  return { results: ordered(), fractions, subtasks };
}
