import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { earlyOleCapBytes } from "@recx/shared";
import { errorMessage } from "../errors";
import type { Logger } from "../logger";
import type { Sandbox } from "../sandbox/types";
import { C_RUNTIME, compileProgram, nativeRunLimits, runProgram } from "./exec";
import {
  SELF_CHECK_FIXTURES,
  evaluateFixture,
  summarizeSelfCheck,
  type FixtureObservation,
  type FixtureVerdict,
  type SelfCheckFixture,
} from "./fixtures";

const execFileAsync = promisify(execFile);

/**
 * Runs the twelve adversarial fixtures through the REAL sandbox and reports the
 * heartbeat selfCheck {ok, at, failures}. Any deviation quarantines the node
 * (the web sets QUARANTINED) and logs an alert. The fixtures run in a dedicated
 * self-check box range (RECX_SELFCHECK_BOX_BASE) that never collides with a
 * job box, so a self-check can never disturb a submission.
 */

export interface SelfCheckRunnerOptions {
  sandbox: Sandbox;
  /** The self-check run box id (for the host-residue check). */
  runBoxId: number;
  /** isolate first_uid (60000): the box uid is firstUid + runBoxId. */
  firstUid: number;
  logger: Logger;
  signal?: AbortSignal;
  /** Overridable for tests; defaults inspect the real host. */
  residue?: HostResidueProbe;
}

export interface HostResidueProbe {
  boxUidProcesses(uid: number): Promise<number>;
  cgroupPopulated(boxId: number): Promise<boolean>;
}

export interface SelfCheckResult {
  ok: boolean;
  at: string;
  failures: string[];
}

export async function runSelfCheck(options: SelfCheckRunnerOptions): Promise<SelfCheckResult> {
  const residue = options.residue ?? defaultResidueProbe(options.logger);
  const verdicts: FixtureVerdict[] = [];
  for (const fixture of SELF_CHECK_FIXTURES) {
    if (options.signal?.aborted) break;
    verdicts.push(await runFixture(fixture, options, residue));
  }
  const report = summarizeSelfCheck(verdicts, new Date().toISOString());
  if (!report.ok) {
    options.logger.error({ failures: report.failures }, "!!! self-check FAILED: the node is quarantining itself");
  } else {
    options.logger.info({ fixtures: verdicts.length }, "self-check passed");
  }
  return report;
}

async function runFixture(
  fixture: SelfCheckFixture,
  options: SelfCheckRunnerOptions,
  residue: HostResidueProbe,
): Promise<FixtureVerdict> {
  const { sandbox, logger } = options;
  try {
    const artifacts = await compileProgram(sandbox, C_RUNTIME, fixture.source);
    const limits = nativeRunLimits({
      ...(fixture.memoryKb !== undefined ? { memoryKb: fixture.memoryKb } : {}),
      ...(fixture.processes !== undefined ? { processes: fixture.processes } : {}),
      ...(fixture.cpuMs !== undefined ? { cpuMs: fixture.cpuMs } : {}),
    });
    const outputLimitBytes = fixture.expect.kind === "verdict" && fixture.expect.verdict === "OLE" ? earlyOleCapBytes(0) : null;
    const run = await runProgram(sandbox, C_RUNTIME, artifacts, {
      limits,
      outputLimitBytes,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const observation: FixtureObservation = { verdict: run.verdict, stdout: run.stdout, idle: run.idle };
    if (fixture.requireHostClean) {
      observation.hostResidue = {
        boxUidProcesses: await residue.boxUidProcesses(options.firstUid + options.runBoxId),
        cgroupPopulated: await residue.cgroupPopulated(options.runBoxId),
      };
    }
    return evaluateFixture(fixture, observation);
  } catch (error) {
    logger.error({ fixture: fixture.id, err: errorMessage(error) }, "self-check fixture could not run");
    return { id: fixture.id, ok: false, reason: `could not run: ${errorMessage(error)}` };
  }
}

/** Reads the host (Linux). On any read failure it reports "clean" and logs, since the fixture's verdict is the primary signal. */
export function defaultResidueProbe(logger: Logger): HostResidueProbe {
  return {
    async boxUidProcesses(uid: number): Promise<number> {
      try {
        const { stdout } = await execFileAsync("ps", ["-e", "-o", "uid="], { timeout: 5_000 });
        return stdout
          .split("\n")
          .map((line) => Number(line.trim()))
          .filter((value) => Number.isInteger(value) && value === uid).length;
      } catch (error) {
        logger.debug({ err: errorMessage(error) }, "could not enumerate host processes for the residue check");
        return 0;
      }
    },
    async cgroupPopulated(boxId: number): Promise<boolean> {
      try {
        const base = (await readFile("/run/isolate/cgroup", "utf8")).trim();
        const procs = await readFile(`${base}/box-${boxId}/cgroup.procs`, "utf8");
        return procs.trim().length > 0;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") logger.debug({ err: errorMessage(error) }, "could not read the box cgroup for the residue check");
        return false; // cgroup gone (ENOENT) or unreadable: treat as not populated
      }
    },
  };
}
