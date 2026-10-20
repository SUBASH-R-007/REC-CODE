import { worstVerdict, type CompileResult, type JudgeJobSpec, type TestResult, type Verdict } from "@recx/shared";
import type { JudgeOutcome } from "../drivers/types";
import { roundPoints, type ExecutedTests, type ResolvedSubtask } from "./plan";

/**
 * Executed tests → one outcome (protocol v2: score, maxScore, subtasks, cpuMs).
 *
 *   ICPC      verdict = the first failing test's verdict (index order), else
 *             AC — a test with testlib partial credit counts as WA here,
 *             since ICPC has no partial credit; score 1 or 0, maxScore 1.
 *   PER_TEST  score = Σ points × fraction over the tests (a test without
 *             points weighs 1; fraction 1 for AC, n/100 for checker partial
 *             credit), maxScore = Σ points.
 *   SUBTASK   score = Σ subtask earned (src/judge/plan.ts), maxScore = Σ
 *             subtask points, plus one entry per subtask.
 *
 *   PER_TEST and SUBTASK verdict: AC when score = maxScore (with maxScore 0:
 *   when every test is AC), PARTIAL when 0 < score < maxScore, otherwise the
 *   worst failing verdict by VERDICT_PRECEDENCE.
 *
 * Runs (the workspace Run button) are feedback, not scoring: verdict as for
 * ICPC but a partial test stays PARTIAL; score and maxScore null.
 *
 * cpuMs is the sum of the CPU time of every test that ran — what the user's
 * daily CPU budget is charged. Compile and checker time are the platform's,
 * not the user's.
 */

type ScoringSpec = Pick<JudgeJobSpec, "kind" | "scoringMode" | "tests">;

const weight = (points: number | null | undefined) => points ?? 1;
const EPSILON = 1e-9;

function isFailure(v: Verdict): boolean {
  return v !== "AC" && v !== "SKIPPED";
}

/** Points available: null for runs, 1 for ICPC, Σ test points for PER_TEST, Σ subtask points for SUBTASK. */
export function maxScoreFor(spec: ScoringSpec, subtasks: readonly Pick<ResolvedSubtask, "points">[] | null): number | null {
  if (spec.kind === "run") return null;
  switch (spec.scoringMode) {
    case "ICPC":
      return 1;
    case "PER_TEST":
      return roundPoints(spec.tests.reduce((sum, t) => sum + weight(t.points), 0));
    case "SUBTASK":
      return roundPoints((subtasks ?? []).reduce((sum, s) => sum + s.points, 0));
  }
}

export function aggregate(spec: ScoringSpec, executed: ExecutedTests, compile: CompileResult | null): JudgeOutcome {
  const ordered = [...executed.results].sort((a, b) => a.i - b.i);
  const ran = ordered.filter((r) => r.v !== "SKIPPED");
  const failures = ordered.filter((r) => isFailure(r.v));
  const firstFailure = failures[0] ?? null;
  const allPassed = ordered.length === spec.tests.length && ordered.every((r) => r.v === "AC");

  const base = {
    compile,
    tests: ordered,
    passedCases: ordered.filter((r) => r.v === "AC").length,
    totalCases: spec.tests.length,
    maxTimeMs: ran.reduce((max, r) => Math.max(max, r.ms), 0),
    maxMemoryKb: ran.reduce((max, r) => Math.max(max, r.kb), 0),
    firstFailedIndex: firstFailure?.i ?? null,
    cpuMs: ran.reduce((sum, r) => sum + r.ms, 0),
  };

  if (spec.kind === "run") {
    const verdict: Verdict = allPassed ? "AC" : (firstFailure?.v ?? "SKIPPED");
    return { ...base, verdict, score: null, maxScore: null, subtasks: [] };
  }

  if (spec.scoringMode === "ICPC") {
    let verdict: Verdict = "AC";
    if (!allPassed) verdict = firstFailure ? (firstFailure.v === "PARTIAL" ? "WA" : firstFailure.v) : "SKIPPED";
    return { ...base, verdict, score: allPassed ? 1 : 0, maxScore: 1, subtasks: [] };
  }

  let score: number;
  let maxScore: number;
  if (spec.scoringMode === "SUBTASK") {
    score = roundPoints(executed.subtasks.reduce((sum, s) => sum + s.earned, 0));
    maxScore = roundPoints(executed.subtasks.reduce((sum, s) => sum + s.max, 0));
  } else {
    const byIndex = new Map(ordered.map((r) => [r.i, r]));
    score = roundPoints(
      spec.tests.reduce((sum, t) => {
        const v = byIndex.get(t.index)?.v;
        const fraction = v === "AC" ? 1 : v === "PARTIAL" ? (executed.fractions.get(t.index) ?? 0) : 0;
        return sum + weight(t.points) * fraction;
      }, 0),
    );
    maxScore = maxScoreFor(spec, null) ?? 0;
  }

  let verdict: Verdict;
  const full = maxScore > 0 ? score >= maxScore - EPSILON : allPassed;
  if (full) verdict = "AC";
  else if (score > 0) verdict = "PARTIAL";
  else verdict = failures.length > 0 ? worstVerdict(failures.map((r) => r.v)) : "SKIPPED";

  return {
    ...base,
    verdict,
    score,
    maxScore,
    subtasks: spec.scoringMode === "SUBTASK" ? executed.subtasks : [],
  };
}

/** A compile error ends the job: no tests run, score 0 of maxScore (null for a run). */
export function compileErrorOutcome(
  spec: ScoringSpec,
  compile: CompileResult,
  subtasks: readonly Pick<ResolvedSubtask, "points">[] | null,
): JudgeOutcome {
  return {
    verdict: "CE",
    compile,
    tests: [] as TestResult[],
    passedCases: 0,
    totalCases: spec.tests.length,
    maxTimeMs: 0,
    maxMemoryKb: 0,
    firstFailedIndex: null,
    score: spec.kind === "run" ? null : 0,
    maxScore: maxScoreFor(spec, subtasks),
    subtasks: [],
    cpuMs: 0,
  };
}
