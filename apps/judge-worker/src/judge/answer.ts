import { LIMITS, truncateUtf8, type JudgeJobSpec, type TestResult } from "@recx/shared";
import type { JudgeOutcome } from "../drivers/types";
import { InfraError, PermanentJudgeError } from "../errors";
import { aggregate } from "./aggregate";
import { CheckerRunner, checkerMessage, prepareChecker } from "./checker";
import { compareOutputs } from "./compare";
import { planJob, type TestOutcome } from "./plan";
import type { RunJobContext } from "./run-job";

/**
 * An output-only job (Phase 12n): the submission IS the answer.
 *
 * Nothing is compiled and nothing is run, so this path has no run box, no
 * CPU time, no memory peak and no compile output. What it has is the
 * comparison every other job ends with — and, for a CHECKER problem, the
 * author's checker in its own box, judging the student's text against the
 * expected answer exactly as it judges a program's stdout.
 *
 * Why it is here rather than in the web process: a CHECKER answer-problem
 * runs the AUTHOR's program, and author code may only ever run in a box.
 * Keeping the whole kind in the fleet also means its verdicts come with a
 * node, a lane, a rejudge path and a `/metrics` row, like every other
 * verdict on the platform.
 *
 * The time and memory limits in the spec are the CHECKER's box limits here
 * — the only thing that runs — and the student's own time and memory are
 * reported as zero, because that is what they were.
 */
export async function runAnswerJob(spec: JudgeJobSpec, ctx: RunJobContext): Promise<JudgeOutcome> {
  if (spec.ioMode !== "OUTPUT_ONLY") throw new InfraError("runAnswerJob called for a job that is not output-only");
  const plan = planJob(spec);
  if (plan.interactor) throw new PermanentJudgeError("an output-only problem has no conversation to hold");

  const [test] = spec.tests;
  if (!test || spec.tests.length !== 1) {
    throw new PermanentJudgeError(`an output-only job has exactly one case; this one has ${spec.tests.length}`);
  }
  if (test.output === null) throw new PermanentJudgeError("an output-only job has no expected answer to compare against");

  const answer = Buffer.from(spec.source, "utf8");
  const input = await ctx.blobs.get(test.input);
  const expected = await ctx.blobs.get(test.output);

  let checker: CheckerRunner | null = null;
  if (plan.checker) {
    const prepared = await prepareChecker(plan.checker, ctx);
    checker = new CheckerRunner(ctx.sandbox, prepared.binary, ctx.signal);
    ctx.logger.debug({ cached: prepared.cached }, "checker ready");
  }

  ctx.progress({ type: "state", state: "RUNNING" });
  try {
    const result: TestResult = { i: test.index, v: "AC", ms: 0, kb: 0 };
    let fraction = 0;
    if (checker) {
      const decision = await checker.check({ input, output: answer, answer: expected });
      if (decision.kind === "infra") throw new InfraError(`${decision.reason} (the answer check)`);
      if (decision.kind === "fail") throw new PermanentJudgeError(decision.reason);
      result.v = decision.verdict;
      fraction = decision.fraction;
      const report = checkerMessage(decision.report);
      if (report) result.message = report;
    } else {
      const equal = compareOutputs(plan.compareMode, expected, answer, { floatEpsilon: spec.floatEpsilon });
      result.v = equal ? "AC" : "WA";
      fraction = equal ? 1 : 0;
    }
    /**
     * The case is visible — an output-only problem's data is the question —
     * so the student's own answer comes back with the result, the way a
     * sample test's stdout does. It is their own text, so there is nothing
     * to withhold.
     */
    result.stdout = truncateUtf8(answer.toString("utf8"), LIMITS.detail.perTestBytes);

    const outcome: TestOutcome = { result, fraction };
    return aggregate(
      spec,
      {
        results: [outcome.result],
        fractions: new Map([[test.index, outcome.fraction]]),
        subtasks: [],
      },
      null,
    );
  } finally {
    if (checker) await ctx.sandbox.cleanup("checker");
  }
}
