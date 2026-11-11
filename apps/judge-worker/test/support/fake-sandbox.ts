import type {
  BoxRole,
  CapturedOutput,
  ExecRequest,
  ExecResult,
  InteractivePairRequest,
  InteractivePairResult,
  InteractiveStop,
  IsolateMeta,
  Sandbox,
  SandboxFileInfo,
} from "../../src/sandbox/types";
import { assertBoxFileName } from "../../src/sandbox/types";

/**
 * In-memory Sandbox for unit tests. Nothing is executed: each exec() is
 * answered by a handler that sees the request and the box's files, and
 * returns what isolate would have reported.
 */

export interface FakeFile {
  data: Buffer;
  mode: number;
}

export interface FakeRun {
  meta?: Partial<IsolateMeta>;
  stdout?: string | Buffer;
  stderr?: string;
  outputLimitExceeded?: boolean;
  /** Files the "program" leaves behind (a compiler's output). */
  files?: Record<string, { data: string | Buffer; mode?: number }>;
}

/**
 * A handler sees the box it is running in, and may CHANGE it: that is how a
 * test models a box that is not what the worker thinks it is — a stale box
 * left by a crashed worker, a file the toolchain removed. (Phase 10f: the
 * plug-pull drill found the worker calling a missing source file a student's
 * compile error, and the regression test needs a box that lost its source.)
 */
export type FakeHandler = (request: ExecRequest, box: Map<string, FakeFile>) => FakeRun;

/**
 * What a fake interactive pair did (Phase 12l). A handler answers for BOTH
 * sides at once, because the thing under test is the conversation: who
 * exited how, how it was stopped, and what each side reported.
 */
export interface FakePair {
  solution?: { meta?: Partial<IsolateMeta>; stderr?: string; bytes?: number };
  interactor?: { meta?: Partial<IsolateMeta>; stderr?: string; bytes?: number };
  stopped?: InteractiveStop;
  /** The conversation, as the worker's relay would have recorded it. */
  transcript?: string;
}

export type FakePairHandler = (request: InteractivePairRequest) => FakePair;

export const OK_META: IsolateMeta = {
  status: null,
  timeSec: 0.012,
  wallSec: 0.02,
  maxRssKb: 3_000,
  cgMemKb: 3_500,
  cgOomKilled: false,
  exitCode: 0,
  exitSignal: null,
  killed: false,
  message: null,
};

function captured(content: Buffer, capBytes: number): CapturedOutput {
  return {
    head: content.subarray(0, capBytes),
    tail: content.subarray(Math.max(0, content.length - 2048)),
    bytes: content.length,
  };
}

export class FakeSandbox implements Sandbox {
  readonly boxes = new Map<BoxRole, Map<string, FakeFile>>();
  readonly log: string[] = [];
  readonly writes: { role: BoxRole; name: string; data: Buffer; mode: number }[] = [];
  readonly execs: ExecRequest[] = [];
  readonly pairs: InteractivePairRequest[] = [];
  /** Set by a test that judges an interactive problem. */
  pairHandler: FakePairHandler | null = null;

  constructor(private readonly handler: FakeHandler) {}

  private box(role: BoxRole): Map<string, FakeFile> {
    const box = this.boxes.get(role);
    if (!box) throw new Error(`fake: ${role} box not initialised`);
    return box;
  }

  async init(role: BoxRole): Promise<void> {
    this.log.push(`init ${role}`);
    this.boxes.set(role, new Map());
  }

  async writeFile(role: BoxRole, name: string, data: Buffer | string, mode: number): Promise<void> {
    assertBoxFileName(name);
    const box = this.box(role);
    if (box.has(name)) throw new Error(`fake: ${name} already exists in ${role} (writes are exclusive)`);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    box.set(name, { data: bytes, mode });
    this.writes.push({ role, name, data: bytes, mode });
    this.log.push(`write ${role} ${name} ${mode.toString(8)}`);
  }

  async readFile(role: BoxRole, name: string, maxBytes: number): Promise<Buffer> {
    const file = this.box(role).get(name);
    if (!file) throw new Error(`fake: no ${name} in ${role}`);
    if (file.data.length > maxBytes) throw new Error(`fake: ${name} too large`);
    return file.data;
  }

  async listFiles(role: BoxRole): Promise<SandboxFileInfo[]> {
    return [...this.box(role).entries()]
      .map(([name, f]) => ({ name, size: f.data.length, mode: f.mode }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async unlink(role: BoxRole, name: string): Promise<void> {
    this.boxes.get(role)?.delete(name);
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    this.execs.push(request);
    this.log.push(`exec ${request.role}`);
    const box = this.box(request.role);
    const run = this.handler(request, box);
    for (const [name, f] of Object.entries(run.files ?? {})) {
      box.set(name, { data: Buffer.from(f.data), mode: f.mode ?? 0o644 });
    }
    const stdout = Buffer.from(run.stdout ?? "");
    const stderr = Buffer.from(run.stderr ?? "", "utf8");
    box.set(request.stdout, { data: stdout, mode: 0o644 });
    box.set(request.stderr, { data: stderr, mode: 0o644 });
    return {
      meta: { ...OK_META, ...run.meta },
      stdout: captured(stdout, request.stdoutCapBytes),
      stderr: captured(stderr, request.stderrCapBytes),
      outputLimitExceeded:
        run.outputLimitExceeded ?? (request.outputLimitBytes !== null && stdout.length > request.outputLimitBytes),
    };
  }

  async execPair(request: InteractivePairRequest): Promise<InteractivePairResult> {
    this.pairs.push(request);
    this.log.push(`execPair ${request.solution.role}+${request.interactor.role}`);
    if (!this.pairHandler) throw new Error("fake: execPair called with no pairHandler");
    const answer = this.pairHandler(request);
    const side = (
      role: "solution" | "interactor",
      given: FakePair["solution"],
    ): InteractivePairResult["solution"] => {
      const stderr = Buffer.from(given?.stderr ?? "", "utf8");
      this.box(request[role].role).set(request[role].stderr, { data: stderr, mode: 0o644 });
      return {
        meta: { ...OK_META, ...given?.meta },
        stderr: captured(stderr, request[role].stderrCapBytes),
        bytes: given?.bytes ?? 0,
      };
    };
    return {
      solution: side("solution", answer.solution),
      interactor: side("interactor", answer.interactor),
      stopped: answer.stopped ?? "none",
      transcript: Buffer.from(answer.transcript ?? "", "utf8").subarray(0, request.transcriptBytes),
    };
  }

  async cleanup(role: BoxRole): Promise<void> {
    this.log.push(`cleanup ${role}`);
    this.boxes.delete(role);
  }
}
