import { LIMITS, sanitizeToolOutput, type InteractorSpec, type Verdict } from "@recx/shared";
import type { InteractivePairResult, InteractiveStop, IsolateMeta, Sandbox } from "../sandbox/types";
import {
  CHECKER_BINARY,
  CHECKER_SOURCE,
  checkerCacheKey,
  checkerMessage,
  checkerToolchainIds,
  interpretChecker,
  prepareChecker,
  type CheckerDecision,
  type CheckerContext,
} from "./checker";
import { checkerLimits } from "./limits";
import { signalName } from "./verdict";

/**
 * Interactive problems (Phase 12l, compareMode INTERACTIVE).
 *
 * The student's program and the author's INTERACTOR run at the same time in
 * two different boxes, and talk: the solution's stdout is the interactor's
 * stdin and the interactor's stdout is the solution's stdin, relayed by the
 * worker (`Sandbox.execPair`). There is no expected output and no second
 * comparison — the interactor decides as it goes and exits with the
 * verdict, using the CHECKER's own exit codes, which is why everything
 * about compiling, caching and interpreting one is the checker's code
 * (src/judge/checker.ts) rather than a second copy of it.
 *
 * ── The precedence, which is the whole of this file ──────────────────────
 *
 * Both programs can fail at once, and in a conversation the SECOND failure
 * is usually caused by the first: an interactor that exits on a wrong
 * answer leaves the solution writing into a closed pipe, and a solution
 * that is killed for time leaves the interactor reading from one. So the
 * order is fixed, and it is this:
 *
 *   1. isolate itself failed (XX) on either side → infrastructure.
 *   2. the solution hit its OWN limits — time, memory, output → that
 *      verdict. A student's resource failure is theirs whatever the
 *      interactor then said about it.
 *   3. the conversation deadlocked (no byte either way for
 *      LIMITS.interactive.idleMs) → TLE, with a sentence that says so.
 *   4. the interactor FAILED (exit 3, a crash, its own limits, or flooding
 *      the solution) → the problem's bug: released permanently, never a
 *      verdict for the student.
 *   5. the solution crashed, and not of SIGPIPE → RE. A program that
 *      segfaults mid-conversation has a bug of its own, and the
 *      interactor's "wrong answer" is only what it concluded from the
 *      silence that followed.
 *   6. the interactor decided (0 / 1 / 2 / 16+n) → AC / WA / PARTIAL.
 *   7. nothing of the above: the interactor ended without deciding, which
 *      is its author's bug (4) by another route.
 *
 * SIGPIPE is the exception in rule 5, and the integration suite is what
 * made it one. An interactor that has decided exits; the solution's next
 * write then goes into a closed pipe and kills it. Reporting RE there
 * would blame the student for the interactor's own, correct, decision —
 * while reporting WA for a segfault would hide a crash behind a verdict
 * about the answer. Both mistakes are wrong verdicts, and they pull in
 * opposite directions, so the signal decides which.
 */

export const INTERACTOR_BINARY = CHECKER_BINARY;
export const INTERACTOR_SOURCE = CHECKER_SOURCE;
/** testlib's interactor convention: the input file, then where a checker would read the output. */
export const INTERACTOR_ARGV = ["./checker", "input.txt", "output.txt"] as const;
const INTERACTOR_STDERR = "interactor.stderr";
const SOLUTION_STDERR = "error.txt";

/** The signal a program gets for writing to a pipe nobody is reading. */
const SIGPIPE = 13;

export const DEADLOCK_MESSAGE =
  "Neither your program nor the interactor wrote anything for " +
  `${LIMITS.interactive.idleMs / 1000} seconds. Both are waiting to read — this is usually a missing flush after printing a query.`;

export { checkerCacheKey as interactorCacheKey, checkerToolchainIds as interactorToolchainIds };

/** The interactor binary: the checker path, with the checker's own cache key. */
export function prepareInteractor(interactor: InteractorSpec, ctx: CheckerContext) {
  return prepareChecker(interactor, ctx, "interactor");
}

export interface InteractiveJudgement {
  verdict: Verdict;
  /** Share of the test's points: 1, 0, or n/100 from testlib's _pc(n). */
  fraction: number;
  /** The interactor's report, where the caller may show it. */
  report?: string;
  /** Said to the student instead of the report: why the conversation ended. */
  message?: string;
}

export type InteractiveOutcome =
  | { kind: "judged"; judgement: InteractiveJudgement }
  /** The interactor is broken or reported FAIL: release permanently. */
  | { kind: "fail"; reason: string }
  | { kind: "infra"; reason: string };

/** True when the interactor exited with a code that decides the verdict. */
function decided(decision: CheckerDecision): decision is Extract<CheckerDecision, { kind: "verdict" }> {
  return decision.kind === "verdict";
}

export interface SolutionRunFacts {
  /** What the solution's own meta means for a non-interactive run. */
  verdict: Verdict | null;
  timeMs: number;
  memoryKb: number;
  exitCode: number | null;
  signal: string | null;
  /** The supervisor stopped it for writing too much. */
  outputLimitExceeded: boolean;
}

/**
 * The verdict of one interactive case. Pure: the caller has already run the
 * pair and classified the solution's own meta.
 */
export function interpretInteractive(input: {
  solution: SolutionRunFacts;
  solutionMeta: IsolateMeta;
  interactorMeta: IsolateMeta;
  interactorReport: string;
  stopped: InteractiveStop;
}): InteractiveOutcome {
  const { solution, stopped } = input;

  // 1. isolate itself.
  if (input.solutionMeta.status === "XX") {
    return { kind: "infra", reason: `isolate internal error in the run box: ${input.solutionMeta.message ?? "unknown"}` };
  }
  if (input.interactorMeta.status === "XX") {
    return {
      kind: "infra",
      reason: `isolate internal error in the interactor box: ${input.interactorMeta.message ?? "unknown"}`,
    };
  }

  const decision = interpretChecker(input.interactorMeta, input.interactorReport);
  if (decision.kind === "infra") return { kind: "infra", reason: decision.reason };

  // 2. The student's own resource failures.
  if (solution.outputLimitExceeded || stopped === "solution-output") {
    return { kind: "judged", judgement: { verdict: "OLE", fraction: 0 } };
  }
  if (solution.verdict === "TLE" || solution.verdict === "MLE") {
    return { kind: "judged", judgement: { verdict: solution.verdict, fraction: 0 } };
  }

  // 3. Both blocked reading.
  if (stopped === "idle") {
    return { kind: "judged", judgement: { verdict: "TLE", fraction: 0, message: DEADLOCK_MESSAGE } };
  }

  // 4. The interactor's own failure, including flooding the solution.
  if (stopped === "interactor-output") {
    return {
      kind: "fail",
      reason: `interactor FAIL: it sent more than ${LIMITS.interactive.interactorOutputBytes} bytes to the solution`,
    };
  }
  if (decision.kind === "fail") return { kind: "fail", reason: decision.reason.replace(/^checker /, "interactor ") };

  /**
   * 5. The solution's own crash, unless it is the pipe closing under it.
   *
   * `classifyRun` has already turned the meta into RE; what matters here is
   * only WHY, because a solution killed by SIGPIPE was killed by the
   * interactor's exit.
   */
  const sigpipe = input.solutionMeta.status === "SG" && input.solutionMeta.exitSignal === SIGPIPE;
  if (solution.verdict === "RE" && !sigpipe) {
    return { kind: "judged", judgement: { verdict: "RE", fraction: 0 } };
  }

  // 6. What the interactor decided.
  if (decided(decision)) {
    return {
      kind: "judged",
      judgement: {
        verdict: decision.verdict,
        fraction: decision.fraction,
        report: checkerMessage(decision.report),
      },
    };
  }

  // 7. Nothing decided, and the solution has an opinion of its own.
  if (solution.verdict !== null) {
    return { kind: "judged", judgement: { verdict: solution.verdict, fraction: 0 } };
  }
  const signalText = input.solutionMeta.exitSignal === null ? null : signalName(input.solutionMeta.exitSignal);
  return {
    kind: "fail",
    reason:
      "interactor FAIL: it ended without deciding the verdict" +
      (signalText ? ` (the solution was killed by ${signalText})` : ""),
  };
}

export interface InteractiveRunRequest {
  /** Files already staged in the run box; the interactor's binary is staged here. */
  interactorBinary: Buffer;
  /** The case's input: the interactor's hidden data. */
  input: Buffer;
  solution: {
    argv: string[];
    toolchainIds: string[];
    env: Record<string, string>;
    limits: InteractiveLimits;
    /** Bytes the solution may send before the pair is stopped. */
    outputLimitBytes: number;
  };
  stderrCapBytes: number;
  signal?: AbortSignal;
}

type InteractiveLimits = Parameters<Sandbox["exec"]>[0]["limits"];

/**
 * Runs one case's conversation. The caller owns both boxes: the run box is
 * initialised and staged with the program, and this initialises the
 * interactor box for every case (a fresh box and cgroup per case, exactly
 * as a checker gets).
 */
export class InteractiveRunner {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly binary: Buffer,
    private readonly signal?: AbortSignal,
  ) {}

  async converse(request: {
    input: Buffer;
    solution: InteractiveRunRequest["solution"];
    stderrCapBytes: number;
    /** Bytes of the conversation to keep for a case the student may see. */
    transcriptBytes: number;
  }): Promise<InteractivePairResult> {
    const { sandbox } = this;
    await sandbox.init("checker");
    await sandbox.writeFile("checker", INTERACTOR_BINARY, this.binary, 0o755);
    await sandbox.writeFile("checker", "input.txt", request.input, 0o444);
    // testlib's interactor writes the contestant's answers here for a
    // checker that this platform does not run; it must still be writable.
    await sandbox.writeFile("checker", "output.txt", "", 0o644);
    return sandbox.execPair({
      solution: {
        role: "run",
        argv: request.solution.argv,
        toolchainIds: request.solution.toolchainIds,
        env: request.solution.env,
        limits: request.solution.limits,
        stderr: SOLUTION_STDERR,
        stderrCapBytes: request.stderrCapBytes,
        outputLimitBytes: request.solution.outputLimitBytes,
      },
      interactor: {
        role: "checker",
        argv: [...INTERACTOR_ARGV],
        toolchainIds: [],
        env: { PATH: "/usr/bin:/bin" },
        limits: checkerLimits(),
        stderr: INTERACTOR_STDERR,
        stderrCapBytes: LIMITS.checker.outputBytes,
        outputLimitBytes: LIMITS.interactive.interactorOutputBytes,
      },
      idleMs: LIMITS.interactive.idleMs,
      transcriptBytes: request.transcriptBytes,
      signal: this.signal,
    });
  }

  /** The interactor's report: stderr if it wrote one (testlib's quitf does). */
  static report(pair: InteractivePairResult): string {
    return sanitizeToolOutput(pair.interactor.stderr.head.toString("utf8"), LIMITS.checker.outputBytes);
  }
}
