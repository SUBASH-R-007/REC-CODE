import { describe, expect, it } from "vitest";
import { LIMITS } from "@recx/shared";
import { PermanentJudgeError } from "../src/errors";
import { silentLogger } from "../src/logger";
import { DEADLOCK_MESSAGE, interpretInteractive, type SolutionRunFacts } from "../src/judge/interactive";
import { effectiveCompareMode } from "../src/judge/plan";
import { runJob } from "../src/judge/run-job";
import type { IsolateMeta } from "../src/sandbox/types";
import { FakeSandbox, OK_META, type FakePair, type FakeRun } from "./support/fake-sandbox";
import { buildJob } from "./support/jobs";

/**
 * Interactive problems (Phase 12l).
 *
 * The thing this file is really about is the PRECEDENCE: in a conversation
 * both programs can fail at once, and the second failure is usually caused
 * by the first — an interactor that exits on a wrong answer leaves the
 * solution writing into a closed pipe, and a solution killed for time
 * leaves the interactor reading from one. Every case below is a pair of
 * failures with one right answer.
 */

const meta = (over: Partial<IsolateMeta> = {}): IsolateMeta => ({ ...OK_META, ...over });

const clean: SolutionRunFacts = {
  verdict: null,
  timeMs: 12,
  memoryKb: 3_000,
  exitCode: 0,
  signal: null,
  outputLimitExceeded: false,
};

function judge(input: {
  solution?: Partial<SolutionRunFacts>;
  solutionMeta?: Partial<IsolateMeta>;
  interactorMeta?: Partial<IsolateMeta>;
  report?: string;
  stopped?: "none" | "solution-output" | "interactor-output" | "idle" | "aborted";
}) {
  return interpretInteractive({
    solution: { ...clean, ...input.solution },
    solutionMeta: meta(input.solutionMeta),
    interactorMeta: meta(input.interactorMeta),
    interactorReport: input.report ?? "",
    stopped: input.stopped ?? "none",
  });
}

describe("what an interactive case is judged as", () => {
  it("is what the interactor said when both programs behaved", () => {
    const ok = judge({ interactorMeta: { exitCode: 0 }, report: "guessed in 7 queries" });
    expect(ok).toEqual({
      kind: "judged",
      judgement: { verdict: "AC", fraction: 1, report: "guessed in 7 queries" },
    });
    expect(judge({ interactorMeta: { exitCode: 1 }, report: "too many queries" })).toMatchObject({
      judgement: { verdict: "WA", fraction: 0 },
    });
    // testlib's presentation error, which this platform has no verdict for.
    expect(judge({ interactorMeta: { exitCode: 2 } })).toMatchObject({ judgement: { verdict: "WA" } });
    // _pc(40): forty per cent of the case's points.
    expect(judge({ interactorMeta: { exitCode: 56 } })).toMatchObject({
      judgement: { verdict: "PARTIAL", fraction: 0.4 },
    });
  });

  it("is the student's own time or memory failure before anything the interactor said", () => {
    // The interactor exits 1 because the conversation ended mid-query: that
    // is the consequence of the TLE, not a wrong answer.
    expect(judge({ solution: { verdict: "TLE" }, interactorMeta: { exitCode: 1 } })).toEqual({
      kind: "judged",
      judgement: { verdict: "TLE", fraction: 0 },
    });
    expect(judge({ solution: { verdict: "MLE" }, interactorMeta: { exitCode: 1 } })).toMatchObject({
      judgement: { verdict: "MLE" },
    });
  });

  it("is OLE when the solution floods the interactor", () => {
    expect(judge({ stopped: "solution-output", interactorMeta: { exitCode: 3 } })).toEqual({
      kind: "judged",
      judgement: { verdict: "OLE", fraction: 0 },
    });
    expect(judge({ solution: { outputLimitExceeded: true } })).toMatchObject({ judgement: { verdict: "OLE" } });
  });

  it("is TLE with a sentence when both sides went quiet", () => {
    const deadlock = judge({ stopped: "idle" });
    expect(deadlock).toEqual({
      kind: "judged",
      judgement: { verdict: "TLE", fraction: 0, message: DEADLOCK_MESSAGE },
    });
    // The sentence says what to do about it, because the cause is almost
    // always the same one.
    expect(DEADLOCK_MESSAGE).toContain("flush");
    expect(DEADLOCK_MESSAGE).toContain(`${LIMITS.interactive.idleMs / 1000} seconds`);
  });

  it("is the interactor's WA rather than the solution's SIGPIPE", () => {
    /**
     * The order that matters most. An interactor that has decided "wrong
     * answer" exits; the solution then writes into a closed pipe and dies
     * of SIGPIPE. Reporting RE there would blame the student for the
     * interactor's own, correct, decision.
     */
    const verdict = judge({
      solution: { verdict: "RE", signal: "SIGPIPE", exitCode: null },
      solutionMeta: { status: "SG", exitSignal: 13 },
      interactorMeta: { exitCode: 1 },
      report: "the number is outside the range you claimed",
    });
    expect(verdict).toMatchObject({ judgement: { verdict: "WA", report: "the number is outside the range you claimed" } });
  });

  it("is RE when the solution crashed of its own accord, even if the interactor said WA", () => {
    /**
     * The other half of the SIGPIPE rule, and the integration suite is
     * what found it: a program that segfaults mid-conversation has a bug of
     * its own, and the interactor's "wrong answer" is only what it
     * concluded from the silence that followed. Reporting WA would hide a
     * crash behind a verdict about the answer.
     */
    const verdict = judge({
      solution: { verdict: "RE", signal: "SIGSEGV", exitCode: null },
      solutionMeta: { status: "SG", exitSignal: 11 },
      interactorMeta: { exitCode: 1 },
      report: "the conversation ended early",
    });
    expect(verdict).toEqual({ kind: "judged", judgement: { verdict: "RE", fraction: 0 } });

    // A non-zero exit is the same thing without a signal.
    expect(
      judge({ solution: { verdict: "RE", exitCode: 3 }, interactorMeta: { exitCode: 1 } }),
    ).toMatchObject({ judgement: { verdict: "RE" } });
  });

  it("is RE when the solution crashed and the interactor decided nothing", () => {
    expect(
      judge({
        solution: { verdict: "RE", exitCode: 1 },
        // An interactor that read EOF and gave up quietly: exit 0 would be
        // a claim the answer was right, so testlib's own FAIL path is what
        // an author writes. Here it exits 3 with a message.
        interactorMeta: { exitCode: 3 },
        report: "the solution closed the conversation",
      }),
    ).toMatchObject({ kind: "fail" });
    // Even an interactor that said "ok": a program that crashed on its way
    // out crashed, and a student told AC would be told the wrong thing.
    expect(judge({ solution: { verdict: "RE", exitCode: 1 }, interactorMeta: { exitCode: 0 } })).toMatchObject({
      judgement: { verdict: "RE" },
    });
  });

  it("is a permanent failure when the interactor is the broken one", () => {
    for (const over of [
      { interactorMeta: { exitCode: 3 }, report: "jury data is inconsistent" },
      { interactorMeta: { status: "TO" as const } },
      { interactorMeta: { cgOomKilled: true } },
      { interactorMeta: { status: "SG" as const, exitSignal: 11 } },
      { interactorMeta: { exitCode: 200 } },
      { stopped: "interactor-output" as const },
    ]) {
      const outcome = judge(over);
      expect(outcome.kind, JSON.stringify(over)).toBe("fail");
      if (outcome.kind === "fail") expect(outcome.reason).toContain("interactor");
    }
  });

  it("is an infrastructure failure when isolate itself failed, on either side", () => {
    expect(judge({ solutionMeta: { status: "XX", message: "cg error" } })).toMatchObject({ kind: "infra" });
    expect(judge({ interactorMeta: { status: "XX", message: "cg error" } })).toMatchObject({ kind: "infra" });
  });

  it("never calls a broken interactor a wrong answer", () => {
    // The one mistake that would silently mark correct students wrong.
    const outcome = judge({ interactorMeta: { exitCode: 3 }, report: "assertion failed" });
    expect(outcome.kind).toBe("fail");
  });
});

describe("the comparison an interactive job asks for", () => {
  it("is available for a STDIN problem", () => {
    expect(effectiveCompareMode({ compareMode: "INTERACTIVE", ioMode: "STDIN", functionSignature: null })).toBe(
      "INTERACTIVE",
    );
  });

  it("is refused for a FUNCTION problem, whose answer is a return value", () => {
    expect(() =>
      effectiveCompareMode({ compareMode: "INTERACTIVE", ioMode: "FUNCTION", functionSignature: null }),
    ).toThrow(/needs a STDIN problem/);
  });
});

// ── Through runJob, on the fake sandbox ────────────────────────────────

const GUESS = `#include "testlib.h"
int main(int argc, char* argv[]) { registerInteraction(argc, argv); return 0; }
`;

function interactiveJob(options: { cases?: { isSample?: boolean }[] } = {}) {
  const cases = (options.cases ?? [{ isSample: true }]).map((c, i) => ({
    input: `${i + 1}\n`,
    // An interactive case has no expected output; the empty blob is what
    // the authoring surface stores (DESIGN-interactive.md §2.6).
    output: "",
    isSample: c.isSample ?? false,
  }));
  return buildJob({ language: "cpp20", source: "int main(){}", cases, interactorSource: GUESS });
}

async function judgeThrough(pairAnswer: FakePair, options: { cases?: { isSample?: boolean }[] } = {}) {
  const job = interactiveJob(options);
  const sandbox = new FakeSandbox((request): FakeRun => {
    if (request.role !== "compile") return {};
    // Two compiles reach the compile box: the student's program, and the
    // author's interactor (which is compiled by the checker's own path, so
    // its source and binary carry the checker's names).
    const interactorCompile = request.argv.includes("checker.cpp");
    return interactorCompile
      ? { files: { checker: { data: "interactor binary", mode: 0o755 } } }
      : { files: { solution: { data: "binary", mode: 0o755 } } };
  });
  sandbox.pairHandler = () => pairAnswer;
  const outcome = await runJob(job.spec, {
    sandbox,
    blobs: { get: async (ref) => job.blobs.get(ref.sha256) ?? Buffer.alloc(0) },
    progress: () => undefined,
    logger: silentLogger(),
  });
  return { outcome, sandbox };
}

describe("runJob — an interactive problem", () => {
  it("judges the case by the interactor and shows the conversation for a sample", async () => {
    const { outcome, sandbox } = await judgeThrough({
      interactor: { meta: { exitCode: 0 }, stderr: "found 42 in 6 queries" },
      transcript: "> 50\n< lower\n> 42\n< correct\n",
    });
    expect(outcome.verdict).toBe("AC");
    expect(outcome.tests[0]?.stdout).toBe("> 50\n< lower\n> 42\n< correct\n");
    expect(outcome.tests[0]?.message).toBe("found 42 in 6 queries");
    // No input file is staged in the run box: the case's input is the
    // interactor's hidden data, and it goes to the interactor's box.
    expect(sandbox.writes.filter((w) => w.role === "run").map((w) => w.name)).not.toContain("input.txt");
    expect(sandbox.pairs).toHaveLength(1);
    expect(sandbox.pairs[0]?.transcriptBytes).toBeGreaterThan(0);
  });

  it("tells a hidden case's conversation to nobody", async () => {
    const { outcome, sandbox } = await judgeThrough(
      { interactor: { meta: { exitCode: 1 }, stderr: "wrong number" }, transcript: "> 1\n< lower\n" },
      { cases: [{ isSample: false }] },
    );
    expect(outcome.verdict).toBe("WA");
    const [test] = outcome.tests;
    expect(test?.stdout).toBeUndefined();
    expect(test?.stderr).toBeUndefined();
    // The interactor's own words are not shown either: they describe the
    // hidden data.
    expect(test?.message).toBeUndefined();
    expect(sandbox.pairs[0]?.transcriptBytes).toBe(0);
  });

  it("reports a deadlock as TLE, with the sentence", async () => {
    const { outcome } = await judgeThrough({ stopped: "idle", interactor: { meta: { status: "SG", exitSignal: 15 } } });
    expect(outcome.verdict).toBe("TLE");
    expect(outcome.tests[0]?.message).toBe(DEADLOCK_MESSAGE);
  });

  it("releases the job when the interactor fails", async () => {
    await expect(
      judgeThrough({ interactor: { meta: { exitCode: 3 }, stderr: "jury answer is wrong" } }),
    ).rejects.toBeInstanceOf(PermanentJudgeError);
  });

  it("gives the interactor a fresh box for every case", async () => {
    const { sandbox } = await judgeThrough(
      { interactor: { meta: { exitCode: 0 } } },
      { cases: [{ isSample: true }, { isSample: false }] },
    );
    expect(sandbox.log.filter((l) => l === "init checker")).toHaveLength(2);
    expect(sandbox.log.filter((l) => l === "init run")).toHaveLength(2);
  });
});
