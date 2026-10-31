import type { BoxRole } from "../config";

export type { BoxRole };

/**
 * The low-level sandbox the shared judging logic (src/judge/**) runs on.
 * IsolateSandbox is the production implementation; unit tests use an
 * in-memory fake. A sandbox owns one box per role for the current slot; file
 * names are plain names inside that box (no directories, no traversal).
 */

/** Every resource cap of one execution. Units are in the names. */
export interface SandboxLimits {
  cpuMs: number;
  wallSec: number;
  memoryKb: number;
  stackKb: number;
  processes: number;
  openFiles: number;
  fsizeKb: number;
}

/** isolate's meta file, parsed. Absent keys are null. */
export interface IsolateMeta {
  /** RE = non-zero exit, SG = killed by a signal, TO = time limit, XX = isolate internal error, null = OK. */
  status: "RE" | "SG" | "TO" | "XX" | null;
  /** CPU time in seconds (cgroup CPU time under --cg). */
  timeSec: number | null;
  wallSec: number | null;
  maxRssKb: number | null;
  /** cgroup memory.peak, in KiB. */
  cgMemKb: number | null;
  cgOomKilled: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  killed: boolean;
  message: string | null;
}

export interface CapturedOutput {
  /** The first `capBytes` of the file. */
  head: Buffer;
  /** The last ≤ 2 KiB of the file (where a crash's final message sits). */
  tail: Buffer;
  /** Full size of the file. */
  bytes: number;
}

export interface ExecRequest {
  role: BoxRole;
  /** argv[0] is "./name" inside the box or an absolute path inside one of `toolchainIds`. */
  argv: string[];
  /** Toolchain directories (under /opt/toolchains) bound read-only for this run. */
  toolchainIds: string[];
  /** The language's environment. HOME and LANG are set by the sandbox. */
  env: Record<string, string>;
  limits: SandboxLimits;
  /** File names inside the box. stdin null = no input. */
  stdin: string | null;
  stdout: string;
  stderr: string;
  stdoutCapBytes: number;
  stderrCapBytes: number;
  /** Early output-limit trip: stop the run once stdout exceeds this many bytes. */
  outputLimitBytes: number | null;
  /** Aborting kills the run (worker shutdown). */
  signal?: AbortSignal;
}

export interface ExecResult {
  meta: IsolateMeta;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  /** The supervisor stopped the run because stdout passed outputLimitBytes. */
  outputLimitExceeded: boolean;
}

/**
 * One side of an interactive pair (Phase 12l).
 *
 * Like an `ExecRequest` without stdin and stdout: those two are PIPES held
 * by the worker rather than files in the box, which is what lets the two
 * programs talk while sharing no directory. stderr stays a file — it is
 * the interactor's report and the solution's diagnostics, both read after
 * the conversation ends.
 */
export interface InteractiveSide {
  role: BoxRole;
  argv: string[];
  toolchainIds: string[];
  env: Record<string, string>;
  limits: SandboxLimits;
  stderr: string;
  stderrCapBytes: number;
  /** Bytes this side may send before the worker stops the pair. */
  outputLimitBytes: number;
}

export interface InteractivePairRequest {
  /** The student's program. Its stdout goes to the interactor's stdin. */
  solution: InteractiveSide;
  /** The author's interactor. Its stdout goes to the solution's stdin. */
  interactor: InteractiveSide;
  /** No byte in EITHER direction for this long: both are blocked reading. */
  idleMs: number;
  /**
   * Bytes of the CONVERSATION to keep, for a case the student may see.
   * The worker is already in the middle, so this costs a buffer and is the
   * only way a student can be shown what their program actually said —
   * there is no output file in an interactive case. The caller decides
   * whether to show it, exactly as it decides about stdout.
   */
  transcriptBytes: number;
  signal?: AbortSignal;
}

/** Why the worker stopped the conversation, if it did. */
export type InteractiveStop = "none" | "solution-output" | "interactor-output" | "idle" | "aborted";

export interface InteractiveSideResult {
  meta: IsolateMeta;
  stderr: CapturedOutput;
  /** Bytes this side wrote to the other one. */
  bytes: number;
}

export interface InteractivePairResult {
  solution: InteractiveSideResult;
  interactor: InteractiveSideResult;
  stopped: InteractiveStop;
  /**
   * The conversation, line by line, marked by direction: `> ` is what the
   * solution sent and `< ` is what the interactor replied. Truncated to
   * `transcriptBytes` on a line boundary.
   */
  transcript: Buffer;
}

export interface SandboxFileInfo {
  name: string;
  size: number;
  mode: number;
}

export interface Sandbox {
  /** A fresh, empty box (and a fresh cgroup) for this role, replacing any previous one. */
  init(role: BoxRole): Promise<void>;
  /** Create a new file (never through an existing name or link) with exactly this mode. */
  writeFile(role: BoxRole, name: string, data: Buffer | string, mode: number): Promise<void>;
  /** A regular file's bytes (never following a link); larger than maxBytes is an error. */
  readFile(role: BoxRole, name: string, maxBytes: number): Promise<Buffer>;
  /** Regular files at the top level of the box. Links, directories and devices are ignored. */
  listFiles(role: BoxRole): Promise<SandboxFileInfo[]>;
  unlink(role: BoxRole, name: string): Promise<void>;
  exec(request: ExecRequest): Promise<ExecResult>;
  /**
   * Two boxes at once, their stdin and stdout wired to each other through
   * the worker (Phase 12l). Both boxes must already be initialised and
   * staged. Returns when both have exited, or when the worker stopped them.
   */
  execPair(request: InteractivePairRequest): Promise<InteractivePairResult>;
  /** Remove the box. Idempotent; never throws. */
  cleanup(role: BoxRole): Promise<void>;
}

/** Plain file names only: no separators, no "..", no leading dot. */
export const BOX_FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.$-]{0,127}$/;

export function assertBoxFileName(name: string): void {
  if (!BOX_FILE_NAME.test(name) || name.includes("..")) {
    throw new Error(`Illegal box file name: ${JSON.stringify(name)}`);
  }
}
