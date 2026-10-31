import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { JudgeJobSpec } from "@recx/shared";
import type { CompileCache } from "../compile-cache";
import { boxIdsForSlot } from "../config";
import { assertCheckerToolchainsPresent } from "../judge/checker";
import { planJob } from "../judge/plan";
import { runJob } from "../judge/run-job";
import type { Logger } from "../logger";
import { IsolateSandbox } from "../sandbox/isolate";
import { assertToolchainsPresent, installedLanguages } from "../toolchains";
import type { DriverInfo, JudgeDriver, JudgeIO, JudgeOutcome } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Production driver: IOI isolate 2.7 on Linux (cgroup v2), one run, compile
 * and checker box per slot, with the shared judging logic in src/judge and
 * the node's compile-artifact cache.
 */

export interface IsolateDriverOptions {
  isolateBin: string;
  boxBase: number;
  syntheticEtc: string;
  logger: Logger;
  /** Shared by every slot; absent = every job compiles. */
  compileCache?: CompileCache | null;
}

/** Resolve a command name against PATH (isolate is spawned with an empty environment). */
export function resolveExecutable(command: string, searchPath = process.env.PATH ?? ""): string {
  const candidates = command.includes("/") ? [command] : searchPath.split(path.delimiter).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return path.resolve(candidate);
    } catch {
      // keep looking
    }
  }
  throw new Error(`isolate binary "${command}" not found (RECX_ISOLATE_BIN, PATH=${searchPath})`);
}

/**
 * Before any box: a spec no node could judge is refused permanently
 * (planJob); a toolchain the catalog knows but THIS node lacks — the
 * language's own, the checker's compiler, or the checker's testlib
 * directory — is an ordinary retryable InfraError, so another node can take
 * the job.
 */
export function assertJudgeable(spec: JudgeJobSpec, exists: (p: string) => boolean = existsSync): void {
  const plan = planJob(spec);
  // An output-only job has no runtime, so there are no toolchains to find
  // (the checker's own are checked below, as for any other checker job).
  if (spec.language) assertToolchainsPresent(spec.language, exists);
  if (plan.checker && spec.tests.some((t) => t.output !== null)) assertCheckerToolchainsPresent(plan.checker, exists);
}

export class IsolateDriver implements JudgeDriver {
  readonly name = "isolate" as const;

  private constructor(
    private readonly options: IsolateDriverOptions & { isolatePath: string; metaDir: string; version: string },
  ) {}

  /** Preflight: Linux, isolate present and answering, synthetic /etc in place. */
  static async create(options: IsolateDriverOptions): Promise<IsolateDriver> {
    if (process.platform !== "linux") {
      throw new Error(
        `The isolate driver needs Linux (cgroup v2 + IOI isolate); this is ${process.platform}. ` +
          "On Windows use RECX_DRIVER=mock for UI work, or run the worker in WSL2.",
      );
    }
    const isolatePath = resolveExecutable(options.isolateBin);
    const { stdout } = await execFileAsync(isolatePath, ["--version"], { env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 });
    const version = /isolator\s+(\S+)/.exec(stdout)?.[1] ?? stdout.split("\n")[0]?.trim().slice(0, 64) ?? "unknown";
    if (!existsSync(path.join(options.syntheticEtc, "passwd"))) {
      throw new Error(`synthetic /etc for boxes is missing: ${path.join(options.syntheticEtc, "passwd")} (see infra/judge/install-isolate.sh)`);
    }
    // Meta files live outside every box, private to this worker.
    const metaDir = await mkdtemp(path.join(os.tmpdir(), "recjudge-meta-"));
    await options.compileCache?.init();
    return new IsolateDriver({ ...options, isolatePath, metaDir, version: version.slice(0, 64) });
  }

  async info(): Promise<DriverInfo> {
    return { driver: "isolate", version: this.options.version, languages: installedLanguages() };
  }

  async judge(spec: JudgeJobSpec, io: JudgeIO): Promise<JudgeOutcome> {
    assertJudgeable(spec);
    const sandbox = new IsolateSandbox({
      isolateBin: this.options.isolatePath,
      boxIds: boxIdsForSlot(this.options.boxBase, io.slot),
      syntheticEtc: this.options.syntheticEtc,
      metaDir: this.options.metaDir,
      logger: io.logger,
    });
    return runJob(spec, {
      sandbox,
      blobs: io.blobs,
      progress: io.progress,
      logger: io.logger,
      signal: io.signal,
      compileCache: this.options.compileCache ?? null,
    });
  }
}
