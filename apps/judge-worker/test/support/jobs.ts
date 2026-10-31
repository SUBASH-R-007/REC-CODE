import { createHash } from "node:crypto";
import {
  JUDGE_PROTOCOL_VERSION,
  LANGUAGE_CATALOG,
  judgeJobSpecSchema,
  type BlobRef,
  type JudgeJobSpec,
  type LanguageKey,
  type TestSpec,
} from "@recx/shared";
import { TWO_SUM, generateTwoSumTests } from "@recx/shared/samples/two-sum";

/** Test-data builders shared by the unit tests and the Linux integration test. */

export function blob(content: string | Buffer): { ref: BlobRef; data: Buffer } {
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return { ref: { sha256: createHash("sha256").update(data).digest("hex"), sizeBytes: data.byteLength }, data };
}

export interface TestCaseInput {
  input: string;
  /** null = custom run input (no expected output). */
  output: string | null;
  isSample?: boolean;
  points?: number | null;
  subtask?: number | null;
}

export interface BuiltJob {
  spec: JudgeJobSpec;
  /** Every blob the job references, by sha256. */
  blobs: Map<string, Buffer>;
}

let counter = 0;

/** A valid JudgeJobSpec (parsed through the protocol schema) plus its blobs. */
export function buildJob(
  options: {
    language?: LanguageKey;
    source?: string;
    cases?: TestCaseInput[];
    /** A testlib checker's source: sets compareMode CHECKER and spec.checker. */
    checkerSource?: string;
    /** A testlib interactor's source: sets compareMode INTERACTIVE and spec.interactor (Phase 12l). */
    interactorSource?: string;
    /**
     * An OUTPUT_ONLY job (Phase 12n): the submission is the answer, so the
     * spec carries no language runtime at all. `source` is the answer.
     */
    answer?: boolean;
    testlibId?: string;
  } & Partial<Omit<JudgeJobSpec, "language" | "source" | "tests">>,
): BuiltJob {
  const {
    language = "cpp20",
    source = "int main(){}",
    cases = [],
    checkerSource,
    interactorSource,
    answer = false,
    testlibId = "testlib-0.9.41",
    ...rest
  } = options;
  const blobs = new Map<string, Buffer>();
  let checker: JudgeJobSpec["checker"] = null;
  if (checkerSource !== undefined) {
    const c = blob(checkerSource);
    blobs.set(c.ref.sha256, c.data);
    checker = { source: c.ref, language: "cpp20", testlibId };
  }
  let interactor: JudgeJobSpec["interactor"] = null;
  if (interactorSource !== undefined) {
    const i = blob(interactorSource);
    blobs.set(i.ref.sha256, i.data);
    interactor = { source: i.ref, language: "cpp20", testlibId };
  }
  const tests: TestSpec[] = cases.map((c, index) => {
    const input = blob(c.input);
    blobs.set(input.ref.sha256, input.data);
    let output: BlobRef | null = null;
    if (c.output !== null) {
      const out = blob(c.output);
      blobs.set(out.ref.sha256, out.data);
      output = out.ref;
    }
    return {
      index,
      isSample: c.isSample ?? false,
      input: input.ref,
      output,
      points: c.points ?? null,
      subtask: c.subtask ?? null,
    };
  });
  counter++;
  const spec = judgeJobSpecSchema.parse({
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: "submission",
    id: `sub_test_${counter}`,
    lane: "PRACTICE",
    claimToken: `claim-token-${counter}-0123456789abcdef`,
    attempt: 1,
    language: answer ? null : LANGUAGE_CATALOG[language],
    source,
    ioMode: answer ? "OUTPUT_ONLY" : "STDIN",
    functionSignature: null,
    compareMode: interactor ? "INTERACTIVE" : checker ? "CHECKER" : "TOKEN",
    floatEpsilon: null,
    scoringMode: "ICPC",
    stopOnFirstFailure: true,
    timeLimitMs: 1000,
    memoryLimitKb: 262_144,
    tests,
    subtasks: [],
    checker,
    interactor,
    inlineBlobs: {},
    ...rest,
  });
  return { spec, blobs };
}

/** The seed problem as a FUNCTION-mode job: 2 samples + 12 hidden tests. */
export function twoSumJob(
  language: LanguageKey,
  source: string,
  overrides: Partial<Omit<JudgeJobSpec, "language" | "source" | "tests">> = {},
): BuiltJob {
  return buildJob({
    language,
    source,
    ioMode: "FUNCTION",
    functionSignature: TWO_SUM.signature,
    compareMode: "TOKEN",
    timeLimitMs: TWO_SUM.timeLimitMs,
    memoryLimitKb: TWO_SUM.memoryLimitKb,
    cases: generateTwoSumTests().map((t) => ({ input: t.input, output: t.output, isSample: t.isSample })),
    ...overrides,
  });
}
