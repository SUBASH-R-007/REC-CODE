import {
  ANSWER_LANGUAGE_KEY,
  JUDGE_PROTOCOL_VERSION,
  answerRuntimeSchema,
  judgeJobSpecSchema,
  type JudgeJobSpec,
} from "@recx/shared";
import { JobSpecError, type JobSpecInput } from "@/lib/judge/job-spec";

/**
 * An output-only job's spec (Phase 12n, protocol 6).
 *
 * The one isolate job with no program: `source` is the student's ANSWER,
 * the single case's input is the question's data, and the verdict comes
 * from comparing the answer with the expected output — or from the
 * author's checker, which runs in its own box as it always has.
 *
 * Pure, like `buildJudgeJobSpec` and `buildSqlJobSpec`: rows in, spec out.
 * It is a separate builder rather than another branch of the program one
 * because almost nothing is shared — no runtime to parse, no per-language
 * limit, no startup credit, no compile — and a function that computes a
 * time limit for a job that runs nothing would invite someone to use it.
 *
 * The version's limits are still sent, because they are the limits of the
 * CHECKER's box, which is the only thing that runs here.
 */
export function buildAnswerJobSpec(input: JobSpecInput): JudgeJobSpec {
  const runtime = answerRuntimeSchema.safeParse(input.runtime);
  if (!runtime.success) {
    throw new JobSpecError(`The answer language's LanguageConfig runtime is invalid: ${runtime.error.issues[0]?.message}`);
  }
  if (input.language !== ANSWER_LANGUAGE_KEY) {
    throw new JobSpecError(`An output-only problem is answered in ${ANSWER_LANGUAGE_KEY}, not ${input.language}.`);
  }
  if (input.kind === "validation" && !input.expectedVerdict) {
    throw new JobSpecError("A validation job needs its reference solution's expected verdict.");
  }
  /**
   * There is nothing to run, so a Run would judge the answer against the
   * one case it is already judged against — the same verdict, off the
   * student's run quota. The action refuses it with a sentence; this is
   * the other half, because a job that reached here would be a bug.
   */
  if (input.kind === "run") throw new JobSpecError("An output-only problem has nothing to run.");

  const tests = [...input.tests].sort((a, b) => a.index - b.index);
  if (tests.length !== 1) {
    throw new JobSpecError(`An output-only problem has exactly one case; this version has ${tests.length}.`);
  }
  const [only] = tests as [(typeof tests)[number]];
  if (!only.isSample) {
    throw new JobSpecError("An output-only problem's case must be visible: its data is the question.");
  }

  /**
   * The scoring mode is the author's, and it matters here more than
   * anywhere else: under ICPC a partial verdict collapses to WA ("all
   * tests or nothing"), so a checker that awards part marks for a
   * best-effort answer only means something under PER_TEST. The real
   * isolate run of slice 1 is what established that — a checker scoring
   * 3 of 10 came back WA under the ICPC this builder used to force.
   *
   * SUBTASK is refused: one case cannot be a table of subtasks.
   */
  if (input.version.scoringMode === "SUBTASK") {
    throw new JobSpecError("An output-only problem has one case, so it cannot be scored by subtasks.");
  }

  let checker: JudgeJobSpec["checker"] = null;
  if (input.version.compareMode === "CHECKER") {
    if (!input.checker) throw new JobSpecError("A CHECKER version has no checker source.");
    if (!input.checker.testlibId) throw new JobSpecError("A CHECKER version has no pinned testlib toolchain.");
    checker = {
      source: { sha256: input.checker.sha256, sizeBytes: input.checker.sizeBytes },
      language: "cpp20",
      testlibId: input.checker.testlibId,
    };
  } else if (input.version.compareMode === "INTERACTIVE" || input.version.compareMode === "ROWS") {
    // The database refuses this pairing too (ProblemVersion_output_only_fields).
    throw new JobSpecError(`An answer is compared as text; ${input.version.compareMode} is not a comparison for one.`);
  }

  const spec = judgeJobSpecSchema.safeParse({
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: input.kind,
    id: input.id,
    lane: input.lane,
    claimToken: input.claimToken,
    attempt: input.attempt,
    // No program, so no runtime: the protocol says null exactly here.
    language: null,
    source: input.source,
    ioMode: "OUTPUT_ONLY",
    functionSignature: null,
    compareMode: input.version.compareMode,
    floatEpsilon: input.version.floatEpsilon,
    scoringMode: input.version.scoringMode,
    stopOnFirstFailure: true,
    timeLimitMs: input.version.timeLimitMs,
    memoryLimitKb: input.version.memoryLimitKb,
    tests: [
      {
        index: only.index,
        isSample: true,
        input: only.input,
        output: only.output,
        points: only.points,
        subtask: null,
      },
    ],
    subtasks: [],
    checker,
    interactor: null,
    inlineBlobs: {},
  });
  if (!spec.success) {
    const issue = spec.error.issues[0];
    throw new JobSpecError(`Answer job spec failed validation at ${issue?.path.join(".") || "spec"}: ${issue?.message}`);
  }
  return spec.data;
}
