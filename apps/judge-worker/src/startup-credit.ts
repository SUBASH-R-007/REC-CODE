import { LANGUAGE_CATALOG, LIMITS, type LanguageKey, type LanguageRuntime } from "@recx/shared";
import { errorMessage } from "./errors";
import type { Logger } from "./logger";
import type { Sandbox } from "./sandbox/types";
import { median } from "./calibration";
import { compileProgram, nativeRunLimits, runProgram } from "./selfcheck/exec";

/**
 * Startup credit: for every installed language, compile a hello-world once and
 * run it LIMITS.startupCredit.runs times in the sandbox, reporting the median
 * CPU ms per language (startupMs in the heartbeat). The web app adds this to a
 * problem's per-language time limit at claim time, so a managed runtime's fixed
 * interpreter / JIT warm-up is not charged against the student's solve time.
 */

/** Smallest program that exercises the whole compile + start path for each language. */
const HELLO: Readonly<Partial<Record<LanguageKey, string>>> = {
  c17: '#include <stdio.h>\nint main(void){printf("ok\\n");return 0;}\n',
  cpp17: '#include <cstdio>\nint main(){std::printf("ok\\n");return 0;}\n',
  cpp20: '#include <cstdio>\nint main(){std::printf("ok\\n");return 0;}\n',
  java21: 'public class Main{public static void main(String[] a){System.out.println("ok");}}\n',
  py312: 'print("ok")\n',
  pypy310: 'print("ok")\n',
  node22: 'console.log("ok");\n',
  go123: 'package main\nimport "fmt"\nfunc main(){fmt.Println("ok")}\n',
  kotlin20: 'fun main(){println("ok")}\n',
  rust180: 'fn main(){println!("ok");}\n',
};

export function helloWorldFor(language: LanguageRuntime): string | null {
  return HELLO[language.key] ?? null;
}

export interface StartupCreditOptions {
  sandbox: Sandbox;
  languages: readonly LanguageKey[];
  logger: Logger;
  runs?: number;
  signal?: AbortSignal;
}

/** Median CPU ms per language; a language that fails to build or run is left out. */
export async function measureStartupCredit(options: StartupCreditOptions): Promise<Partial<Record<LanguageKey, number>>> {
  const { sandbox, logger } = options;
  const runs = options.runs ?? LIMITS.startupCredit.runs;
  const result: Partial<Record<LanguageKey, number>> = {};
  for (const key of options.languages) {
    if (options.signal?.aborted) break;
    const language = LANGUAGE_CATALOG[key];
    const source = helloWorldFor(language);
    if (source === null) continue;
    try {
      const artifacts = await compileProgram(sandbox, language, source);
      const limits = nativeRunLimits({ cpuMs: Math.min(LIMITS.cpuTime.ceilingMs, 10_000), memoryKb: LIMITS.memory.defaultKb, processes: language.processes, openFiles: language.openFiles });
      const samples: number[] = [];
      for (let i = 0; i < runs; i++) {
        if (options.signal?.aborted) break;
        const run = await runProgram(sandbox, language, artifacts, { limits, ...(options.signal ? { signal: options.signal } : {}) });
        if (run.verdict !== "AC") {
          logger.warn({ language: key, run: i, verdict: run.verdict }, "startup-credit run did not finish cleanly");
          continue;
        }
        samples.push(run.timeMs);
      }
      if (samples.length > 0) result[key] = Math.round(median(samples));
    } catch (error) {
      logger.warn({ language: key, err: errorMessage(error) }, "startup-credit measurement failed for a language");
    }
  }
  logger.info({ startupMs: result }, "startup credit measured");
  return result;
}
