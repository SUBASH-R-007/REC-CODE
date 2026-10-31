import type { JudgeJobSpec, TestResult, Verdict } from "@recx/shared";
import { InfraError, PermanentJudgeError } from "../errors";
import { aggregate, compileErrorOutcome } from "../judge/aggregate";
import { executeTests, planJob } from "../judge/plan";
import { defaultLanguages } from "../toolchains";
import type { DriverInfo, JudgeDriver, JudgeIO, JudgeOutcome } from "./types";

/**
 * MOCK JUDGE — for Windows development of the web app only.
 *
 * It executes nothing. Verdicts are fabricated, deterministically, from
 * fixture markers in the submitted source:
 *
 *   RECX_MOCK:WA@3       test index 3 (0-based, as in results) gets WA; with
 *                        ICPC stop-on-first-failure the rest are SKIPPED
 *   RECX_MOCK:TLE@1      likewise for TLE / MLE / RE / OLE
 *   RECX_MOCK:PARTIAL@2  test 2 earns half its points (as a testlib checker's
 *                        partial credit would)
 *   RECX_MOCK:CE         a fabricated compile error, no tests
 *   RECX_MOCK:IE         a simulated infrastructure failure (exercises release + retry)
 *
 * Without a marker every test is AC with fixed fake times. Scoring is the real
 * one (src/judge/plan.ts + aggregate.ts): subtasks, dependencies and
 * PER_TEST points behave exactly as on a real node, and a spec no node could
 * judge is refused permanently, as on a real node — INTERACTIVE among them
 * (Phase 12l): a real node judges one, and this driver cannot, because the
 * thing that decides the verdict is a conversation with the author's
 * interactor. A fake AC on an interactive problem would teach a developer
 * nothing and would look exactly like the real thing. A loud
 * banner is printed on every job, and src/boot.ts refuses to start this
 * driver when NODE_ENV=production.
 */

export const MOCK_BANNER = [
  "##################################################################",
  "##                                                              ##",
  "##   MOCK JUDGE — NO CODE IS EXECUTED — VERDICTS ARE FAKE       ##",
  "##   RECX_DRIVER=mock is for Windows UI development only.       ##",
  "##                                                              ##",
  "##################################################################",
].join("\n");

const FAKE_TIME_MS = 7;
const FAKE_MEMORY_KB = 4096;
const MOCK_NOTE = "Mock judge: fabricated result — no code was executed.";

type FailingVerdict = Extract<Verdict, "WA" | "TLE" | "MLE" | "RE" | "OLE" | "PARTIAL">;

export type MockMarker = { kind: "test"; verdict: FailingVerdict; index: number } | { kind: "CE" } | { kind: "IE" };

export function parseMockMarker(source: string): MockMarker | null {
  const match = /RECX_MOCK:(?:(WA|TLE|MLE|RE|OLE|PARTIAL)@(\d{1,4})|(CE|IE)\b)/.exec(source);
  if (!match) return null;
  if (match[3] === "CE") return { kind: "CE" };
  if (match[3] === "IE") return { kind: "IE" };
  return { kind: "test", verdict: match[1] as FailingVerdict, index: Number(match[2]) };
}

export interface MockJudgeDriverOptions {
  /** Where the banner goes (stderr by default). */
  write?: (text: string) => void;
}

export class MockJudgeDriver implements JudgeDriver {
  readonly name = "mock" as const;
  private readonly write: (text: string) => void;

  constructor(options: MockJudgeDriverOptions = {}) {
    this.write = options.write ?? ((text) => process.stderr.write(text));
  }

  async info(): Promise<DriverInfo> {
    return { driver: "mock", version: "mock", languages: defaultLanguages() };
  }

  async judge(spec: JudgeJobSpec, io: JudgeIO): Promise<JudgeOutcome> {
    this.write(`\n${MOCK_BANNER}\n   job: ${spec.kind} ${spec.id} (${spec.language?.key ?? spec.ioMode})\n\n`);
    io.logger.warn({ kind: spec.kind, id: spec.id }, "MOCK JUDGE — NO CODE IS EXECUTED — VERDICTS ARE FAKE");

    const plan = planJob(spec);
    /**
     * Phase 12n. The mock judge fabricates a verdict from a marker in the
     * source — and an output-only submission IS the source, so the marker
     * would be the student's own answer and a fabricated AC would be
     * indistinguishable from a real one. Refused, like an interactive job.
     */
    if (spec.ioMode === "OUTPUT_ONLY") {
      throw new PermanentJudgeError(
        "the mock judge cannot judge an output-only problem: the submission is the answer itself, so there is nothing " +
          "to fabricate a verdict from. Use a Linux node with real isolate.",
      );
    }
    if (plan.compareMode === "INTERACTIVE") {
      throw new PermanentJudgeError(
        "the mock judge cannot judge an interactive problem: its verdict is a conversation with the author's interactor, " +
          "and a fabricated one would be indistinguishable from a real verdict. Use a Linux node with real isolate.",
      );
    }
    const marker = parseMockMarker(spec.source);
    if (marker?.kind === "IE") throw new InfraError("RECX_MOCK:IE — simulated infrastructure failure (mock judge)");

    if (spec.language?.compile) io.progress({ type: "state", state: "COMPILING" });
    if (marker?.kind === "CE") {
      return compileErrorOutcome(
        spec,
        {
          ok: false,
          output: "MOCK JUDGE: fabricated compile error (RECX_MOCK:CE). No compiler ran.",
          timeMs: 0,
          cached: false,
          resourceExceeded: false,
        },
        plan.subtasks,
      );
    }
    const compile = spec.language?.compile ? { ok: true, output: "", timeMs: 0, cached: false, resourceExceeded: false } : null;

    io.progress({ type: "state", state: "RUNNING" });
    const executed = await executeTests(
      spec,
      plan,
      async (test) => {
        const v: Verdict = marker?.kind === "test" && marker.index === test.index ? marker.verdict : "AC";
        const result: TestResult = {
          i: test.index,
          v,
          ms: v === "TLE" ? spec.timeLimitMs : FAKE_TIME_MS,
          kb: v === "MLE" ? spec.memoryLimitKb : FAKE_MEMORY_KB,
          exitCode: v === "RE" ? 1 : v === "AC" || v === "WA" || v === "PARTIAL" ? 0 : null,
          signal: null,
          message: MOCK_NOTE,
        };
        if (test.isSample || test.output === null) {
          // Visible tests echo the expected output on AC so the UI has something real-shaped to show.
          result.stdout =
            v === "AC" && test.output
              ? (await io.blobs.get(test.output)).toString("utf8").slice(0, 4096)
              : "(mock judge: your code was not executed)\n";
          result.stderr = "";
        }
        return { result, fraction: v === "AC" ? 1 : v === "PARTIAL" ? 0.5 : 0 };
      },
      io.progress,
      io.signal,
    );
    return aggregate(spec, executed, compile);
  }
}
