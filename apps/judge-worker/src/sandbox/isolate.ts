import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir, rm, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { LIMITS, SANDBOX_FORCED_ENV, TOOLCHAIN_ID_PATTERN, TOOLCHAIN_ROOT } from "@recx/shared";
import { InfraError, errorMessage } from "../errors";
import { sandboxInitFailed } from "../metrics";
import { watchdogMs } from "../judge/limits";
import type { Logger } from "../logger";
import { isMetaEmpty, parseIsolateMeta } from "./meta";
import { watchOutputSize } from "./output-watch";
import {
  assertBoxFileName,
  type BoxRole,
  type CapturedOutput,
  type ExecRequest,
  type ExecResult,
  type InteractivePairRequest,
  type InteractivePairResult,
  type InteractiveSide,
  type InteractiveSideResult,
  type InteractiveStop,
  type Sandbox,
  type SandboxFileInfo,
  type SandboxLimits,
} from "./types";

/**
 * IOI isolate 2.7 behind the Sandbox interface.
 *
 * Every isolate command line comes from buildIsolateArgv() — one pure
 * function, unit-tested for every language and box role. What it will never
 * emit, whatever it is given: --share-net (the box gets a fresh network
 * namespace with only a down loopback), --full-env, --mem / -m (RLIMIT_AS
 * breaks the JVM, Go and Node before main()), --inherit-fds, --special-files,
 * --tty-hack. No option or configuration key can switch any of them on.
 *
 * Layered containment, not a claim of perfection: the box sees only its own
 * /box, read-only /usr /lib /lib64 /bin, a synthetic /etc, its own /proc
 * (hidepid=2), /dev without recursion, and the job's own toolchain
 * directories. It runs as uid 60000+box in its own cgroup, mount, pid, ipc
 * and network namespaces. No sandbox can be proven impossible to escape; the
 * judge host therefore also holds no credentials worth taking.
 */

/** Bound into every box. The synthetic /etc and the toolchains are added per call. */
const FIXED_DIR_RULES = ["--dir=box=./box:rw", "--dir=/usr", "--dir=/lib", "--dir=/lib64:maybe", "--dir=/bin"] as const;

const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Set by the sandbox itself; a language cannot override them (published on /judge). */
const FORCED_ENV = SANDBOX_FORCED_ENV;

export type IsolateArgvOptions =
  | { action: "init" | "cleanup"; boxId: number }
  | {
      action: "run";
      boxId: number;
      /** Absolute path outside the box. */
      metaFile: string;
      syntheticEtc: string;
      toolchainIds: readonly string[];
      env: Readonly<Record<string, string>>;
      limits: SandboxLimits;
      stdin: string | null;
      /**
       * A file inside the box, or null to leave the program's stdout as the
       * one isolate inherited — a pipe held by the worker, for an
       * interactive pair (Phase 12l). The banned flag that keeps EVERY
       * descriptor open is not involved and stays banned (the list at the
       * top of this file, and test/argv.test.ts): this is isolate's own
       * treatment of the three standard streams, which it hands to the
       * sandboxed program while closing everything else.
       */
      stdout: string | null;
      stderr: string;
      argv: readonly string[];
    };

function fail(message: string): never {
  throw new InfraError(`isolate argv: ${message}`);
}

function assertInt(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) fail(`${name}=${value} outside ${min}..${max}`);
}

function assertNoControl(name: string, value: string): void {
  if (/[\0\n\r]/.test(value)) fail(`${name} contains a control character`);
}

/** The one place an isolate command line is assembled. Pure: no I/O. */
export function buildIsolateArgv(options: IsolateArgvOptions): string[] {
  assertInt("box id", options.boxId, 0, 999);
  const head = ["--cg", `--box-id=${options.boxId}`];
  if (options.action !== "run") return [...head, options.action === "init" ? "--init" : "--cleanup"];

  const { limits } = options;
  if (!path.posix.isAbsolute(options.metaFile)) fail("meta file must be an absolute path");
  assertNoControl("meta file", options.metaFile);
  if (!path.posix.isAbsolute(options.syntheticEtc)) fail("synthetic /etc must be an absolute path");
  assertNoControl("synthetic /etc", options.syntheticEtc);

  // Toolchains: plain directory names under /opt/toolchains, nothing else.
  const toolchainIds = [...new Set(options.toolchainIds)];
  for (const id of toolchainIds) {
    if (!TOOLCHAIN_ID_PATTERN.test(id)) fail(`illegal toolchain id ${JSON.stringify(id)}`);
  }
  const toolchainDirs = toolchainIds.map((id) => `${TOOLCHAIN_ROOT}/${id}`);

  // The program: "./name" inside the box, or a binary inside one of this job's toolchains.
  const program = options.argv[0];
  if (program === undefined) fail("empty command");
  if (options.argv.some((arg) => arg.includes("\0"))) fail("an argument contains NUL");
  if (program.startsWith("./")) {
    try {
      assertBoxFileName(program.slice(2));
    } catch {
      fail(`illegal program ${JSON.stringify(program)}`);
    }
  } else if (
    !toolchainDirs.some((dir) => program.startsWith(`${dir}/`)) ||
    program.split("/").includes("..")
  ) {
    fail(`program ${JSON.stringify(program)} is not inside this job's toolchains`);
  }

  // Environment: the language's variables (PATH among them), then HOME and LANG.
  if (!options.env.PATH) fail("the language environment has no PATH");
  const env: [string, string][] = [];
  for (const [key, value] of Object.entries(options.env)) {
    if (!ENV_KEY.test(key) || key.startsWith("LD_")) fail(`illegal environment variable ${JSON.stringify(key)}`);
    assertNoControl(`env ${key}`, value);
    if (key in FORCED_ENV) continue;
    env.push([key, value]);
  }
  env.push(...Object.entries(FORCED_ENV));

  for (const name of [...(options.stdout ? [options.stdout] : []), options.stderr, ...(options.stdin ? [options.stdin] : [])]) {
    try {
      assertBoxFileName(name);
    } catch {
      fail(`illegal redirect ${JSON.stringify(name)}`);
    }
  }

  const maxCpuMs = Math.max(LIMITS.cpuTime.ceilingMs, LIMITS.compile.cpuSecSlow * 1000);
  const maxWallSec = Math.max(LIMITS.wallTime.ceilingSec, LIMITS.compile.wallSecSlow);
  assertInt("cpu ms", limits.cpuMs, 1, maxCpuMs);
  assertInt("wall s", limits.wallSec, 1, maxWallSec);
  assertInt("memory kb", limits.memoryKb, 1024, Math.max(LIMITS.memory.ceilingKb, LIMITS.compile.memoryKb));
  assertInt("stack kb", limits.stackKb, 1, limits.memoryKb);
  assertInt("processes", limits.processes, 1, LIMITS.processes.ceiling);
  assertInt("open files", limits.openFiles, 16, LIMITS.openFiles.ceiling);
  assertInt("fsize kb", limits.fsizeKb, 1, LIMITS.outputFile.ceilingKb);

  return [
    ...head,
    `--meta=${options.metaFile}`,
    "-D",
    ...FIXED_DIR_RULES,
    `--dir=/etc=${options.syntheticEtc}`,
    "--dir=/proc=proc:fs",
    "--dir=/dev=/dev:dev:norec",
    ...toolchainDirs.map((dir) => `--dir=${dir}`),
    `--time=${(limits.cpuMs / 1000).toFixed(3)}`,
    `--extra-time=${LIMITS.extraTimeSec}`,
    `--wall-time=${limits.wallSec}`,
    `--cg-mem=${limits.memoryKb}`,
    `--stack=${limits.stackKb}`,
    `--processes=${limits.processes}`,
    `--open-files=${limits.openFiles}`,
    `--fsize=${limits.fsizeKb}`,
    `--core=${LIMITS.coreDumpKb}`,
    ...env.map(([key, value]) => `--env=${key}=${value}`),
    ...(options.stdin ? [`--stdin=${options.stdin}`] : []),
    ...(options.stdout ? [`--stdout=${options.stdout}`] : []),
    `--stderr=${options.stderr}`,
    "--run",
    "--",
    ...options.argv,
  ];
}

// ── IsolateSandbox ────────────────────────────────────────────────────────

/** isolate itself gets no inherited environment: the node token never reaches it. */
const ISOLATE_ENV = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
const TAIL_BYTES = 2048;
/** O_NOFOLLOW is POSIX-only; on Windows this module is never executed. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export interface IsolateSandboxOptions {
  /** Absolute path of the isolate binary. */
  isolateBin: string;
  boxIds: Record<BoxRole, number>;
  syntheticEtc: string;
  /** Directory for meta files, outside every box. */
  metaDir: string;
  logger: Logger;
  pollMs?: number;
}

interface SpawnOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export class IsolateSandbox implements Sandbox {
  private readonly roots = new Map<BoxRole, string>();

  constructor(private readonly options: IsolateSandboxOptions) {}

  async init(role: BoxRole): Promise<void> {
    const boxId = this.options.boxIds[role];
    let result = await this.isolate(buildIsolateArgv({ action: "init", boxId }), 30_000);
    if (result.code !== 0) {
      // A stale box (crashed worker, killed run): clean it and try once more.
      await this.isolate(buildIsolateArgv({ action: "cleanup", boxId }), 30_000);
      result = await this.isolate(buildIsolateArgv({ action: "init", boxId }), 30_000);
    }
    const root = result.stdout.trim().split("\n").pop() ?? "";
    if (result.code !== 0 || !path.posix.isAbsolute(root)) {
      /**
       * Phase 10a. Counted AFTER the cleanup-and-retry above, so the metric
       * means "the sandbox could not be made" rather than "a stale box was
       * cleaned" — the second happens routinely after a killed run and would
       * drown the signal. SPEC §10 calls the INTERNAL_ERROR rate the canary
       * for a cgroup misconfiguration after a host upgrade; this is the same
       * canary one layer down.
       */
      sandboxInitFailed();
      throw new InfraError(`isolate --init of box ${boxId} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    this.roots.set(role, root);
  }

  async writeFile(role: BoxRole, name: string, data: Buffer | string, mode: number): Promise<void> {
    assertBoxFileName(name);
    const handle = await open(
      path.join(this.boxDir(role), name),
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(data);
      await handle.chmod(mode); // exact mode, regardless of the umask
    } finally {
      await handle.close();
    }
  }

  async readFile(role: BoxRole, name: string, maxBytes: number): Promise<Buffer> {
    assertBoxFileName(name);
    const handle = await open(path.join(this.boxDir(role), name), fsConstants.O_RDONLY | O_NOFOLLOW);
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new InfraError(`${name} in the ${role} box is not a regular file`);
      if (st.size > maxBytes) throw new InfraError(`${name} in the ${role} box exceeds ${maxBytes} bytes`);
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async listFiles(role: BoxRole): Promise<SandboxFileInfo[]> {
    const dir = this.boxDir(role);
    const files: SandboxFileInfo[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const st = await lstat(path.join(dir, entry.name));
      if (st.isFile()) files.push({ name: entry.name, size: st.size, mode: st.mode & 0o777 });
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  async unlink(role: BoxRole, name: string): Promise<void> {
    assertBoxFileName(name);
    await unlink(path.join(this.boxDir(role), name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    const boxId = this.options.boxIds[request.role];
    const boxDir = this.boxDir(request.role);
    const metaFile = path.join(this.options.metaDir, `box-${boxId}.meta`);
    await rm(metaFile, { force: true });

    // Pre-create the capture files and hold read descriptors on them. isolate
    // opens them O_TRUNC (same inode), so the supervisor can watch stdout grow
    // while the box directory is owned by the box uid, and reads exactly what
    // the program wrote even if it renames or replaces the names afterwards.
    await this.unlink(request.role, request.stdout);
    await this.unlink(request.role, request.stderr);
    await this.writeFile(request.role, request.stdout, "", 0o644);
    await this.writeFile(request.role, request.stderr, "", 0o644);
    const stdoutHandle = await open(path.join(boxDir, request.stdout), fsConstants.O_RDONLY | O_NOFOLLOW);
    const stderrHandle = await open(path.join(boxDir, request.stderr), fsConstants.O_RDONLY | O_NOFOLLOW);

    try {
      const argv = buildIsolateArgv({
        action: "run",
        boxId,
        metaFile,
        syntheticEtc: this.options.syntheticEtc,
        toolchainIds: request.toolchainIds,
        env: request.env,
        limits: request.limits,
        stdin: request.stdin,
        stdout: request.stdout,
        stderr: request.stderr,
        argv: request.argv,
      });

      let outputLimitExceeded = false;
      let aborted = false;
      const outcome = await this.isolate(argv, watchdogMs(request.limits), (child) => {
        const stop = () => {
          if (child.exitCode === null) child.kill("SIGTERM"); // isolate kills the box and exits
        };
        const onAbort = () => {
          aborted = true;
          stop();
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });
        if (request.signal?.aborted) onAbort();

        const unwatch =
          request.outputLimitBytes === null
            ? null
            : watchOutputSize({
                size: async () => (await stdoutHandle.stat()).size,
                limitBytes: request.outputLimitBytes,
                pollMs: this.options.pollMs ?? LIMITS.earlyOle.pollMs,
                onExceeded: () => {
                  outputLimitExceeded = true;
                  stop();
                },
              });
        return () => {
          unwatch?.();
          request.signal?.removeEventListener("abort", onAbort);
        };
      });

      if (aborted) throw new InfraError("run aborted: the worker is shutting down");

      const meta = parseIsolateMeta(await readFile(metaFile, "utf8").catch(() => ""));
      if (isMetaEmpty(meta)) {
        throw new InfraError(
          `isolate produced no meta for box ${boxId} (exit ${outcome.code ?? outcome.signal}): ${outcome.stderr.trim().slice(0, 300)}`,
        );
      }
      const stdout = await capture(stdoutHandle, request.stdoutCapBytes);
      const stderr = await capture(stderrHandle, request.stderrCapBytes);
      if (request.outputLimitBytes !== null && stdout.bytes > request.outputLimitBytes) outputLimitExceeded = true;
      return { meta, stdout, stderr, outputLimitExceeded };
    } finally {
      await stdoutHandle.close().catch(() => undefined);
      await stderrHandle.close().catch(() => undefined);
    }
  }

  /**
   * Two boxes talking to each other, with the worker in the middle
   * (Phase 12l).
   *
   * Each side is an ordinary isolate run with no `--stdin` and no
   * `--stdout`, so the sandboxed program inherits the pipes isolate was
   * given; the worker copies bytes from one to the other. Being in the
   * middle is what makes the three rules of a conversation enforceable at
   * all: a byte cap each way, an idle deadline when both are blocked
   * reading, and a teardown that leaves neither box running.
   *
   * A FIFO pair in a directory bound into both boxes would be faster and
   * would also give the two programs a shared, writable directory — a
   * channel for more than the protocol. They share nothing here.
   */
  async execPair(request: InteractivePairRequest): Promise<InteractivePairResult> {
    const sides = [request.solution, request.interactor] as const;
    interface PreparedSide {
      side: InteractiveSide;
      boxId: number;
      metaFile: string;
      stderrHandle: FileHandle;
      argv: string[];
    }
    const prepared: PreparedSide[] = [];
    for (const side of sides) {
      const boxId = this.options.boxIds[side.role];
      const metaFile = path.join(this.options.metaDir, `box-${boxId}.meta`);
      await rm(metaFile, { force: true });
      await this.unlink(side.role, side.stderr);
      await this.writeFile(side.role, side.stderr, "", 0o644);
      prepared.push({
        side,
        boxId,
        metaFile,
        stderrHandle: await open(path.join(this.boxDir(side.role), side.stderr), fsConstants.O_RDONLY | O_NOFOLLOW),
        argv: buildIsolateArgv({
          action: "run",
          boxId,
          metaFile,
          syntheticEtc: this.options.syntheticEtc,
          toolchainIds: side.toolchainIds,
          env: side.env,
          limits: side.limits,
          stdin: null,
          stdout: null,
          stderr: side.stderr,
          argv: side.argv,
        }),
      });
    }
    const [solution, interactor] = prepared as [PreparedSide, PreparedSide];

    try {
      const timeoutMs = Math.max(
        watchdogMs(request.solution.limits),
        watchdogMs(request.interactor.limits),
      );
      const outcome = await this.relay({
        solution,
        interactor,
        idleMs: request.idleMs,
        timeoutMs,
        transcriptBytes: request.transcriptBytes,
        signal: request.signal,
      });
      if (outcome.stopped === "aborted") throw new InfraError("interactive run aborted: the worker is shutting down");

      const read = async (one: PreparedSide, bytes: number): Promise<InteractiveSideResult> => {
        const meta = parseIsolateMeta(await readFile(one.metaFile, "utf8").catch(() => ""));
        if (isMetaEmpty(meta)) {
          throw new InfraError(
            `isolate produced no meta for box ${one.boxId} (interactive): ${outcome.diagnostics.slice(0, 300)}`,
          );
        }
        return { meta, stderr: await capture(one.stderrHandle, one.side.stderrCapBytes), bytes };
      };
      return {
        solution: await read(solution, outcome.solutionBytes),
        interactor: await read(interactor, outcome.interactorBytes),
        stopped: outcome.stopped,
        transcript: outcome.transcript,
      };
    } finally {
      for (const one of prepared) await one.stderrHandle.close().catch(() => undefined);
    }
  }

  /**
   * Run both isolate processes and copy bytes between them.
   *
   * Ending a side's stdin when the OTHER side exits is what lets a correct
   * conversation finish: a solution that reads until EOF needs the EOF,
   * and an interactor waiting for a line from a program that has exited
   * would otherwise sit there until its own wall limit.
   */
  private relay(input: {
    solution: { argv: string[]; side: InteractiveSide };
    interactor: { argv: string[]; side: InteractiveSide };
    idleMs: number;
    timeoutMs: number;
    transcriptBytes: number;
    signal?: AbortSignal;
  }): Promise<{
    stopped: InteractiveStop;
    solutionBytes: number;
    interactorBytes: number;
    transcript: Buffer;
    diagnostics: string;
  }> {
    return new Promise((resolve, reject) => {
      const spawnSide = (argv: string[]): ChildProcess =>
        spawn(this.options.isolateBin, argv, { stdio: ["pipe", "pipe", "pipe"], env: ISOLATE_ENV });

      let solution: ChildProcess;
      let interactor: ChildProcess;
      try {
        solution = spawnSide(input.solution.argv);
        interactor = spawnSide(input.interactor.argv);
      } catch (error) {
        reject(new InfraError(`cannot run isolate (${this.options.isolateBin}): ${errorMessage(error)}`, { cause: error }));
        return;
      }

      let stopped: InteractiveStop = "none";
      let solutionBytes = 0;
      let interactorBytes = 0;
      let diagnostics = "";
      const transcript = new Transcript(input.transcriptBytes);
      let lastActivity = Date.now();
      let alive = 2;
      let settled = false;

      const note = (chunk: string) => {
        if (diagnostics.length < 16_384) diagnostics += chunk;
      };
      // isolate's OWN stderr (not the box's): its diagnostics if it fails.
      solution.stderr?.setEncoding("utf8").on("data", note);
      interactor.stderr?.setEncoding("utf8").on("data", note);

      const stop = (why: InteractiveStop) => {
        if (stopped === "none") stopped = why;
        // SIGTERM: isolate tears the box down and writes its meta file.
        for (const child of [solution, interactor]) if (child.exitCode === null) child.kill("SIGTERM");
      };

      /** One direction of the conversation. */
      const pipe = (from: ChildProcess, to: ChildProcess, side: InteractiveSide, count: (n: number) => void) => {
        from.stdout?.on("data", (chunk: Buffer) => {
          lastActivity = Date.now();
          count(chunk.length);
          transcript.add(from === solution ? ">" : "<", chunk);
          // EPIPE when the other side has already gone: not an error here,
          // the exit handlers below decide what the conversation meant.
          to.stdin?.write(chunk, () => undefined);
          if (side.outputLimitBytes > 0) {
            const written = from === solution ? solutionBytes : interactorBytes;
            if (written > side.outputLimitBytes) stop(from === solution ? "solution-output" : "interactor-output");
          }
        });
        from.stdout?.on("error", () => undefined);
        to.stdin?.on("error", () => undefined);
      };
      pipe(solution, interactor, input.solution.side, (n) => (solutionBytes += n));
      pipe(interactor, solution, input.interactor.side, (n) => (interactorBytes += n));

      const idle = setInterval(() => {
        if (Date.now() - lastActivity >= input.idleMs) stop("idle");
      }, Math.max(50, Math.min(250, Math.floor(input.idleMs / 4))));

      const watchdog = setTimeout(() => {
        stop("idle");
        for (const child of [solution, interactor]) if (child.exitCode === null) child.kill("SIGKILL");
      }, input.timeoutMs);

      const onAbort = () => stop("aborted");
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) onAbort();

      const finish = () => {
        if (settled) return;
        settled = true;
        clearInterval(idle);
        clearTimeout(watchdog);
        input.signal?.removeEventListener("abort", onAbort);
        resolve({ stopped, solutionBytes, interactorBytes, transcript: transcript.buffer(), diagnostics });
      };

      for (const [child, other] of [
        [solution, interactor],
        [interactor, solution],
      ] as const) {
        child.once("error", (error) => {
          note(`isolate spawn error: ${error.message}\n`);
          stop("none");
          if (--alive === 0) finish();
        });
        child.once("close", () => {
          // The other side learns the conversation is over.
          other.stdin?.end(() => undefined);
          if (--alive === 0) finish();
        });
      }
    });
  }

  async cleanup(role: BoxRole): Promise<void> {
    const boxId = this.options.boxIds[role];
    this.roots.delete(role);
    try {
      const result = await this.isolate(buildIsolateArgv({ action: "cleanup", boxId }), 30_000);
      if (result.code !== 0) {
        this.options.logger.warn({ boxId, stderr: result.stderr.trim().slice(0, 300) }, "isolate --cleanup failed");
      }
    } catch (error) {
      this.options.logger.warn({ boxId, err: errorMessage(error) }, "isolate --cleanup failed");
    }
  }

  private boxDir(role: BoxRole): string {
    const root = this.roots.get(role);
    if (!root) throw new InfraError(`the ${role} box is not initialised`);
    return path.join(root, "box");
  }

  /**
   * Spawn isolate with an empty inherited environment and a watchdog. `attach`
   * may install supervision on the child and returns its own teardown.
   */
  private isolate(
    argv: string[],
    timeoutMs: number,
    attach?: (child: ChildProcess) => () => void,
  ): Promise<SpawnOutcome> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.isolateBin, argv, { stdio: ["ignore", "pipe", "pipe"], env: ISOLATE_ENV });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        if (stdout.length < 16_384) stdout += chunk;
      });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < 16_384) stderr += chunk;
      });
      const detach = attach?.(child);
      let timedOut = false;
      const watchdog = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);

      child.once("error", (error) => {
        clearTimeout(watchdog);
        detach?.();
        reject(new InfraError(`cannot run isolate (${this.options.isolateBin}): ${error.message}`, { cause: error }));
      });
      child.once("close", (code, signal) => {
        clearTimeout(watchdog);
        detach?.();
        if (timedOut) {
          reject(new InfraError(`isolate did not exit within ${timeoutMs} ms (box ${argv[1] ?? "?"})`));
          return;
        }
        resolve({ code, signal, stdout, stderr });
      });
    });
  }
}

/**
 * The conversation of an interactive case, marked by direction (Phase 12l).
 *
 * A chunk is not a line: a program may write half a line, and a reply may
 * arrive before the other half. Lines are therefore assembled per
 * direction and emitted when they are complete, so what a student reads is
 * the dialogue rather than the scheduler's timing. The last, unterminated
 * line of each side is emitted at the end — it is usually the query that
 * never got a reply, which is exactly the interesting one in a deadlock.
 */
class Transcript {
  private readonly lines: string[] = [];
  private readonly partial = new Map<string, string>();
  private bytes = 0;
  private full = false;

  constructor(private readonly capBytes: number) {}

  add(direction: ">" | "<", chunk: Buffer): void {
    if (this.full || this.capBytes <= 0) return;
    const text = (this.partial.get(direction) ?? "") + chunk.toString("utf8");
    const parts = text.split("\n");
    this.partial.set(direction, parts.pop() ?? "");
    for (const line of parts) this.push(`${direction} ${line}`);
  }

  buffer(): Buffer {
    for (const [direction, rest] of this.partial) {
      if (rest.length > 0) this.push(`${direction} ${rest}`);
    }
    this.partial.clear();
    return Buffer.from(this.lines.join("\n"), "utf8");
  }

  private push(line: string): void {
    if (this.full) return;
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (this.bytes + size > this.capBytes) {
      this.lines.push("… (the rest of the conversation is not shown)");
      this.full = true;
      return;
    }
    this.bytes += size;
    this.lines.push(line);
  }
}

/** Head (≤ capBytes) and tail (≤ 2 KiB) of a capture file, read through its descriptor. */
async function capture(handle: FileHandle, capBytes: number): Promise<CapturedOutput> {
  const { size } = await handle.stat();
  const headLength = Math.min(size, capBytes);
  const head = Buffer.alloc(headLength);
  if (headLength > 0) await handle.read(head, 0, headLength, 0);
  const tailLength = Math.min(size, TAIL_BYTES);
  let tail: Buffer;
  if (size <= headLength) {
    tail = head.subarray(head.length - tailLength);
  } else {
    tail = Buffer.alloc(tailLength);
    if (tailLength > 0) await handle.read(tail, 0, tailLength, size - tailLength);
  }
  return { head, tail, bytes: size };
}
