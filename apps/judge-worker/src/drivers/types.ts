import type {
  BlobRef,
  CompileResult,
  JudgeJobSpec,
  LanguageKey,
  ProgressEvent,
  ResultRequest,
  TestResult,
  Verdict,
} from "@recx/shared";
import type { Logger } from "../logger";

/**
 * The high-level judging contract. A driver takes a claimed job spec and
 * returns its outcome; the worker's job path (src/processor.ts) handles
 * claiming, posting and releasing around it.
 *
 *   IsolateDriver  production (Linux): IsolateSandbox + the shared logic in src/judge
 *   DockerDriver   not available (throws at construction)
 *   MockJudgeDriver Windows development: executes nothing, fabricates verdicts
 *
 * judge() resolves with a deterministic verdict or throws InfraError (a
 * PermanentJudgeError when no node could ever judge the job as specified).
 * It never resolves with IE: an internal error is not a statement about the
 * student's code and must be released, not posted.
 */

export type DriverName = "isolate" | "docker" | "mock";

/** Per-subtask outcome (SUBTASK scoring only), exactly as posted. */
export type SubtaskOutcome = ResultRequest["subtasks"][number];

/** The verdict-bearing part of a result; the processor adds identity and the claim token. */
export interface JudgeOutcome {
  verdict: Verdict;
  compile: CompileResult | null;
  tests: TestResult[];
  passedCases: number;
  totalCases: number;
  maxTimeMs: number;
  maxMemoryKb: number;
  firstFailedIndex: number | null;
  /** Points earned: ICPC 1 / 0; PER_TEST and SUBTASK the sum of points. Null for runs. */
  score: number | null;
  /** Points available. Null for runs. */
  maxScore: number | null;
  /** SUBTASK scoring only; empty otherwise. */
  subtasks: SubtaskOutcome[];
  /** Sum of the CPU ms of every test that ran (compile and checker time excluded). */
  cpuMs: number;
}

/** Verified blob bytes for the job being judged. */
export interface BlobSource {
  get(ref: BlobRef): Promise<Buffer>;
}

export interface JudgeIO {
  /** Concurrency slot (0-based); decides the isolate box ids. */
  slot: number;
  blobs: BlobSource;
  /**
   * Live progress. Fire-and-forget: never throws, never blocks judging. The
   * processor wires a no-op for validation jobs (they publish nothing).
   */
  progress(event: ProgressEvent): void;
  logger: Logger;
  /** Aborted on worker shutdown: a running sandbox is killed, the job is released. */
  signal?: AbortSignal;
}

export interface DriverInfo {
  driver: DriverName;
  /** isolate's version for the isolate driver; "mock" for the mock driver. */
  version: string;
  /** Languages this node can judge (reported in every heartbeat). */
  languages: LanguageKey[];
}

export interface JudgeDriver {
  readonly name: DriverName;
  info(): Promise<DriverInfo>;
  judge(spec: JudgeJobSpec, io: JudgeIO): Promise<JudgeOutcome>;
}
