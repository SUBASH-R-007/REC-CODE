import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, type JudgeJobSpec, type ProgressEvent } from "@recx/shared";
import { buildHarness } from "@recx/shared/harness";
import { TWO_SUM } from "@recx/shared/samples/two-sum";
import { CompileCache } from "../src/compile-cache";
import { assertJudgeable } from "../src/drivers/isolate";
import { InfraError, PermanentJudgeError } from "../src/errors";
import { COMPILE_RESOURCE_MESSAGE, runJob } from "../src/judge/run-job";
import { silentLogger } from "../src/logger";
import { FakeSandbox, type FakeHandler, type FakeRun } from "./support/fake-sandbox";
import { buildJob, twoSumJob, type BuiltJob } from "./support/jobs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function compileCache(): CompileCache {
  const dir = mkdtempSync(path.join(os.tmpdir(), "recjudge-runjob-cc-"));
  dirs.push(dir);
  return new CompileCache({ dir });
}

/** "a b" → a+b, the toy program the fake sandbox "runs". */
const ADDER_CASES = [
  { input: "1 2\n", output: "3\n", isSample: true },
  { input: "2 2\n", output: "4\n" },
  { input: "5 5\n", output: "10\n" },
  { input: "1 1\n", output: "2\n" },
];

function adder(wrongOn: string | null): FakeHandler {
  return (req, box) => {
    if (req.role === "compile") return { files: { main: { data: "\x7fELF fake", mode: 0o755 } } };
    const input = box.get("input.txt")!.data.toString();
    const [a, c] = input.trim().split(/\s+/).map(Number) as [number, number];
    return { stdout: input === wrongOn ? `${a + c + 1}\n` : `${a + c}\n`, stderr: "debug line\n" };
  };
}

async function judge(job: BuiltJob, handler: FakeHandler, cache: CompileCache | null = null) {
  const sandbox = new FakeSandbox(handler);
  const events: ProgressEvent[] = [];
  const outcome = await runJob(job.spec, {
    sandbox,
    blobs: {
      get: async (ref) => {
        const data = job.blobs.get(ref.sha256);
        if (!data) throw new Error("unknown blob");
        return data;
      },
    },
    progress: (e) => events.push(e),
    logger: silentLogger(),
    compileCache: cache,
  });
  return { outcome, sandbox, events };
}

describe("runJob — ICPC", () => {
  it("stops at the first failure and marks the remaining tests SKIPPED", async () => {
    const job = buildJob({ cases: ADDER_CASES });
    const { outcome, sandbox, events } = await judge(job, adder("5 5\n"));

    expect(outcome.verdict).toBe("WA");
    expect(outcome.firstFailedIndex).toBe(2);
    expect(outcome.tests.map((t) => t.v)).toEqual(["AC", "AC", "WA", "SKIPPED"]);
    expect(outcome).toMatchObject({ passedCases: 2, totalCases: 4, score: 0 });
    expect(outcome.compile).toMatchObject({ ok: true, cached: false, resourceExceeded: false });

    // One compile, three runs, each in a fresh box; the skipped test never ran.
    expect(sandbox.execs.filter((e) => e.role === "compile")).toHaveLength(1);
    expect(sandbox.execs.filter((e) => e.role === "run")).toHaveLength(3);
    expect(sandbox.log.filter((l) => l === "init run")).toHaveLength(3);
    expect(sandbox.log.at(-1)).toBe("cleanup run");
    expect(sandbox.log).toContain("cleanup compile");

    expect(events).toEqual([
      { type: "state", state: "COMPILING" },
      { type: "state", state: "RUNNING" },
      { type: "test", i: 0, v: "AC", done: 1, total: 4 },
      { type: "test", i: 1, v: "AC", done: 2, total: 4 },
      { type: "test", i: 2, v: "WA", done: 3, total: 4 },
    ]);
  });

  it("stages the binary 0755 and the input 0444, and never puts expected output in a box", async () => {
    const job = buildJob({ cases: ADDER_CASES });
    const { sandbox } = await judge(job, adder(null));
    const runWrites = sandbox.writes.filter((w) => w.role === "run");
    expect(runWrites.filter((w) => w.name === "main").every((w) => w.mode === 0o755)).toBe(true);
    expect(runWrites.filter((w) => w.name === "input.txt").every((w) => w.mode === 0o444)).toBe(true);

    const expectedOutputs = ADDER_CASES.map((c) => Buffer.from(c.output));
    for (const write of sandbox.writes) {
      for (const expected of expectedOutputs) expect(write.data.equals(expected)).toBe(false);
    }
  });

  it("gives samples their stdout and stderr, and hidden tests neither", async () => {
    const { outcome } = await judge(buildJob({ cases: ADDER_CASES }), adder(null));
    expect(outcome.verdict).toBe("AC");
    expect(outcome.score).toBe(1);
    const [sample, ...hidden] = outcome.tests;
    expect(sample).toMatchObject({ i: 0, v: "AC", stdout: "3\n", stderr: "debug line" });
    for (const t of hidden) {
      expect(t).not.toHaveProperty("stdout");
      expect(t).not.toHaveProperty("stderr");
    }
  });

  it("caps sample stdout at the per-test detail size", async () => {
    const big = "x".repeat(LIMITS.detail.perTestBytes * 3);
    const job = buildJob({ cases: [{ input: "1\n", output: `${big}\n`, isSample: true }] });
    const { outcome } = await judge(job, (req) => (req.role === "compile" ? {} : { stdout: `${big}\n` }));
    expect(outcome.tests[0]!.v).toBe("AC");
    expect(Buffer.byteLength(outcome.tests[0]!.stdout!)).toBeLessThanOrEqual(LIMITS.detail.perTestBytes);
  });

  it("reports the idle flag on a wall-clock TLE", async () => {
    const job = buildJob({ cases: ADDER_CASES });
    const { outcome } = await judge(job, (req) =>
      req.role === "compile" ? {} : { meta: { status: "TO", timeSec: 0.02, wallSec: 7.1, exitCode: null } },
    );
    expect(outcome.verdict).toBe("TLE");
    expect(outcome.tests[0]).toMatchObject({ v: "TLE", idle: true });
  });

  it("stops a run that prints past the early output trip → OLE", async () => {
    const job = buildJob({ cases: ADDER_CASES });
    const flood = "9".repeat(2 * 1024 * 1024);
    const { outcome } = await judge(job, (req) => (req.role === "compile" ? {} : { stdout: flood }));
    expect(outcome.verdict).toBe("OLE");
    expect(outcome.tests[0]!.stdout!.length).toBeLessThanOrEqual(LIMITS.detail.perTestBytes);
  });
});

describe("runJob — compile errors", () => {
  it("FUNCTION mode CE: diagnostics point at solution.cpp with the student's own line, no host paths", async () => {
    const source = TWO_SUM_BROKEN;
    const build = buildHarness("cpp20", TWO_SUM.signature, source);
    const line = build.userStartLine + 3; // the student's line 4
    const stderr = [
      `main.cpp: In member function 'std::vector<int> Solution::twoSum(std::vector<int>&, long long int)':`,
      `main.cpp:${line}:24: error: expected ',' or ';' before 'for'`,
      `  ${line} |         int count = 0`,
      `      |                        ^`,
      `In file included from /opt/toolchains/gcc-13.2.0/include/c++/13.2.0/vector:66,`,
      `                 from /box/main.cpp:1:`,
      `main.cpp:${build.userStartLine + build.userLineCount + 40}:5: note: in generated code`,
    ].join("\n");
    const job = twoSumJob("cpp20", source);
    const { outcome, sandbox } = await judge(job, (req) =>
      req.role === "compile" ? { meta: { status: "RE", exitCode: 1, message: "Exited with error status 1" }, stderr } : {},
    );

    expect(outcome.verdict).toBe("CE");
    expect(outcome.score).toBe(0);
    expect(outcome.tests).toEqual([]);
    expect(outcome.totalCases).toBe(14);
    expect(outcome.compile).toMatchObject({ ok: false, resourceExceeded: false });
    const output = outcome.compile!.output;
    expect(output).toContain("solution.cpp:4:24: error: expected ',' or ';' before 'for'");
    expect(output).toContain("solution.cpp: In member function");
    expect(output).toMatch(/^\s*4 \| {9}int count = 0$/m);
    // A note located in generated code is dropped, and so is the include chain.
    expect(output).not.toContain("in generated code");
    expect(output).not.toContain("In file included from");
    expect(output).not.toContain("/box/");
    expect(output).not.toContain("/opt/toolchains/");
    expect(output).not.toMatch(/\bmain\.cpp\b/);

    // Nothing runs after a CE.
    expect(sandbox.log.some((l) => l.endsWith(" run"))).toBe(false);
    // The harness, not the bare student code, was compiled.
    const compiled = sandbox.writes.find((w) => w.role === "compile" && w.name === "main.cpp")!;
    expect(compiled.data.toString()).toBe(build.source);
  });

  it("a compile killed by the caps is CE 'compilation exceeded resource limits'", async () => {
    const { outcome } = await judge(buildJob({ cases: ADDER_CASES }), (req) =>
      req.role === "compile" ? { meta: { status: "TO", timeSec: 10.4, exitCode: null }, stderr: "partial" } : {},
    );
    expect(outcome.verdict).toBe("CE");
    expect(outcome.compile).toMatchObject({ ok: false, output: COMPILE_RESOURCE_MESSAGE, resourceExceeded: true, timeMs: 10_400 });
  });

  it("a compile that failed with no source in the box is INFRASTRUCTURE, not CE", async () => {
    /**
     * Phase 10f, and it is a bug the plug-pull drill found rather than a
     * hypothetical: `kill -9` on a worker leaves its isolate boxes
     * allocated, the restarted worker's `--init` does not give it a usable
     * box, and the compile step then ran against an EMPTY box. Python said
     * `FileNotFoundError: 'solution.py'`, which classified as a compile
     * error — so six students' correct programs were recorded as CE
     * (docs/RUNBOOK.md §3).
     *
     * A wrong verdict shown to a student is the one failure this platform
     * must not have. If the source is not in the box, the box is broken:
     * InfraError, the lease is released, the job is retried on a healthy
     * node, and three consecutive releases drain this one.
     */
    const job = buildJob({ language: "py312", source: "print(1)\n", cases: ADDER_CASES });
    await expect(
      judge(job, (req, box) => {
        if (req.role !== "compile") return {};
        // The box lost the source: exactly what a stale box looks like.
        // py312 compiles `main.py` (the catalogue's sourceFile); the
        // traceback below names the file the interpreter was pointed at.
        box.delete("main.py");
        return {
          meta: { status: "RE", exitCode: 1, message: "Exited with error status 1" },
          stderr: "Traceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file or directory: 'solution.py'",
        };
      }),
    ).rejects.toBeInstanceOf(InfraError);
  });

  it("a compile that failed WITH its source in the box is still CE", async () => {
    // The other side of the rule: a student's real compile error must still
    // reach them, so the guard may never swallow one.
    const job = buildJob({ language: "py312", source: "print(1\n", cases: ADDER_CASES });
    const { outcome } = await judge(job, (req) =>
      req.role === "compile"
        ? { meta: { status: "RE", exitCode: 1, message: "Exited with error status 1" }, stderr: "SyntaxError: '(' was never closed" }
        : {},
    );
    expect(outcome.verdict).toBe("CE");
    expect(outcome.compile!.output).toContain("SyntaxError");
  });

  it("isolate XX while compiling is an infrastructure failure", async () => {
    await expect(
      judge(buildJob({ cases: ADDER_CASES }), (req) =>
        req.role === "compile" ? { meta: { status: "XX", message: "clone failed" } } : {},
      ),
    ).rejects.toBeInstanceOf(InfraError);
  });
});

describe("runJob — languages and modes", () => {
  it("Python: syntax check in the compile box, then main.py staged in each run box", async () => {
    const job = buildJob({ language: "py312", source: "print(sum(map(int, input().split())))\n", cases: ADDER_CASES });
    const { outcome, sandbox } = await judge(job, (req, box) => {
      if (req.role === "compile") return {};
      expect(box.has("main.py")).toBe(true);
      const [a, c] = box.get("input.txt")!.data.toString().trim().split(" ").map(Number) as [number, number];
      return { stdout: `${a + c}\n` };
    });
    expect(outcome.verdict).toBe("AC");
    expect(sandbox.writes.filter((w) => w.role === "run" && w.name === "main.py")).toHaveLength(4);
    // The compile box's capture files are not artifacts.
    expect(sandbox.writes.some((w) => w.role === "run" && w.name.startsWith("compile."))).toBe(false);
  });

  it("a language without a compile step never opens a compile box", async () => {
    const job = buildJob({ language: "pypy310", source: "print(3)\n", cases: [ADDER_CASES[0]!] });
    const { outcome, sandbox } = await judge(job, () => ({ stdout: "3\n" }));
    expect(outcome.verdict).toBe("AC");
    expect(outcome.compile).toBeNull();
    expect(sandbox.log.some((l) => l.includes("compile"))).toBe(false);
  });

  it("FUNCTION mode Python: runtime tracebacks are remapped for visible tests", async () => {
    const source = "class Solution:\n    def twoSum(self, nums, target):\n        return nums[99]\n";
    const build = buildHarness("py312", TWO_SUM.signature, source);
    const job = twoSumJob("py312", source);
    const traceback = [
      "Traceback (most recent call last):",
      `  File "/box/main.py", line ${build.userStartLine + build.userLineCount + 30}, in <module>`,
      "    _recx_main()",
      `  File "/box/main.py", line ${build.userStartLine + 2}, in twoSum`,
      "    return nums[99]",
      "IndexError: list index out of range",
    ].join("\n");
    const { outcome } = await judge(job, (req) =>
      req.role === "compile" ? {} : { meta: { status: "RE", exitCode: 1 }, stderr: traceback },
    );
    expect(outcome.verdict).toBe("RE");
    expect(outcome.firstFailedIndex).toBe(0);
    const stderr = outcome.tests[0]!.stderr!;
    expect(stderr).toContain('File "solution.py", line 3, in twoSum');
    expect(stderr).toContain("IndexError: list index out of range");
    expect(stderr).not.toContain("/box/");
    expect(stderr).not.toContain("_recx_main");
  });

  it("a custom run (no expected output) returns stdout up to the run cap and is not compared", async () => {
    const job = buildJob({ kind: "run", cases: [{ input: "4 5\n", output: null }] });
    const { outcome } = await judge(job, adder(null));
    expect(outcome.verdict).toBe("AC");
    expect(outcome.score).toBeNull();
    expect(outcome.tests[0]).toMatchObject({ v: "AC", stdout: "9\n" });
    expect(outcome.tests[0]!.message).toMatch(/no expected output/);
  });

  it("PER_TEST: every test runs and the score is the points earned, out of all points", async () => {
    const cases = ADDER_CASES.map((c, i) => ({ ...c, points: [10, 20, 30, 40][i]! }));
    const job = buildJob({ cases, scoringMode: "PER_TEST", stopOnFirstFailure: false });
    const { outcome } = await judge(job, (req, box) => {
      if (req.role === "compile") return {};
      const input = box.get("input.txt")!.data.toString();
      const [a, c] = input.trim().split(" ").map(Number) as [number, number];
      return input === "2 2\n" || input === "1 1\n" ? { stdout: "0\n" } : { stdout: `${a + c}\n` };
    });
    expect(outcome.tests.map((t) => t.v)).toEqual(["AC", "WA", "AC", "WA"]);
    expect(outcome.score).toBe(40);
    expect(outcome.maxScore).toBe(100);
    expect(outcome.verdict).toBe("PARTIAL");
    expect(outcome.firstFailedIndex).toBe(1);
    expect(outcome.cpuMs).toBe(4 * 12);
  });

  it("SUBTASK: a subtask whose dependency failed is SKIPPED and its tests never reach a box", async () => {
    const cases = [
      { input: "1 2\n", output: "3\n", subtask: 0 },
      { input: "2 2\n", output: "4\n", subtask: 0 },
      { input: "5 5\n", output: "10\n", subtask: 1 },
      { input: "1 1\n", output: "2\n", subtask: 2 },
    ];
    const job = buildJob({
      cases,
      scoringMode: "SUBTASK",
      subtasks: [
        { index: 0, points: 30, aggregation: "MIN", dependsOn: [] },
        { index: 1, points: 30, aggregation: "MIN", dependsOn: [0] },
        { index: 2, points: 40, aggregation: "SUM_FRACTION", dependsOn: [] },
      ],
    });
    const { outcome, sandbox, events } = await judge(job, adder("2 2\n"));
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 40, maxScore: 100 });
    expect(outcome.subtasks).toEqual([
      { index: 0, earned: 0, max: 30, verdict: "WA" },
      { index: 1, earned: 0, max: 30, verdict: "SKIPPED" },
      { index: 2, earned: 40, max: 40, verdict: "AC" },
    ]);
    expect(outcome.tests.map((t) => t.v)).toEqual(["AC", "WA", "SKIPPED", "AC"]);
    const ranInputs = sandbox.writes.filter((w) => w.role === "run" && w.name === "input.txt").map((w) => w.data.toString());
    expect(ranInputs).toEqual(["1 2\n", "2 2\n", "1 1\n"]);
    expect(events.filter((e) => e.type === "subtask")).toEqual([
      { type: "subtask", index: 0, v: "WA" },
      { type: "subtask", index: 1, v: "SKIPPED" },
      { type: "subtask", index: 2, v: "AC" },
    ]);
  });
});

describe("runJob — refuses, permanently, what no node can judge faithfully", () => {
  const untouched = (sandbox: FakeSandbox) => expect(sandbox.log).toEqual([]);

  it.each<[string, Pick<JudgeJobSpec, "compareMode">, RegExp]>([
    ["CHECKER comparison without a checker", { compareMode: "CHECKER" }, /without a checker/],
    // Phase 12l: INTERACTIVE is judgeable now, and refused without the
    // author's interactor for the same reason CHECKER is refused without
    // the checker — nothing on any node could decide the verdict.
    ["INTERACTIVE comparison without an interactor", { compareMode: "INTERACTIVE" }, /without an interactor/],
  ])("%s → PermanentJudgeError before any box is created", async (_name, patch, message) => {
    const job = buildJob({ cases: ADDER_CASES, ...patch });
    const sandbox = new FakeSandbox(() => ({}));
    const run = runJob(job.spec, { sandbox, blobs: { get: async () => Buffer.alloc(0) }, progress: () => {}, logger: silentLogger() });
    await expect(run).rejects.toBeInstanceOf(PermanentJudgeError);
    await expect(run).rejects.toThrow(message);
    untouched(sandbox);
  });

  it("a FUNCTION comparator other than CUSTOM_CHECKER paired with CHECKER → PermanentJudgeError", async () => {
    const job = twoSumJob("cpp20", "class Solution {};");
    const checker = { source: job.spec.tests[0]!.input, language: "cpp20" as const, testlibId: "testlib-0.9.41" };
    const spec = { ...job.spec, compareMode: "CHECKER" as const, checker };
    const sandbox = new FakeSandbox(() => ({}));
    await expect(
      runJob(spec, { sandbox, blobs: { get: async () => Buffer.alloc(0) }, progress: () => {}, logger: silentLogger() }),
    ).rejects.toThrow(/CHECKER goes only with CUSTOM_CHECKER/);
    untouched(sandbox);
  });

  it("SET_EQUAL is judged (protocol 3): any order of the right elements is AC", async () => {
    const job = twoSumJob("cpp20", "class Solution {};", {
      functionSignature: { ...TWO_SUM.signature, comparator: "SET_EQUAL" },
    });
    const expectedFor = (input: Buffer) => {
      const test = job.spec.tests.find((t) => job.blobs.get(t.input.sha256)!.equals(input))!;
      return JSON.parse(job.blobs.get(test.output!.sha256)!.toString()) as number[];
    };
    const { outcome } = await judge(job, (req, box) => {
      if (req.role === "compile") return { files: { main: { data: "\x7fELF", mode: 0o755 } } };
      // The expected pair reversed: wrong under EXACT, right under SET_EQUAL.
      return { stdout: `${JSON.stringify([...expectedFor(box.get("input.txt")!.data)].reverse())}\n` };
    });
    expect(outcome.verdict).toBe("AC");
    expect(outcome.passedCases).toBe(14);
  });

  it("a runtime whose toolchain the catalog does not know → PermanentJudgeError", async () => {
    const job = buildJob({ cases: ADDER_CASES });
    const spec = { ...job.spec, language: { ...job.spec.language!, toolchainId: "gcc-14.9.9" } };
    const sandbox = new FakeSandbox(() => ({}));
    await expect(
      runJob(spec, { sandbox, blobs: { get: async () => Buffer.alloc(0) }, progress: () => {}, logger: silentLogger() }),
    ).rejects.toThrow(/unknown to this judge's language catalog/);
    untouched(sandbox);
  });

  it("isolate XX on a test is an infrastructure failure and the run box is still cleaned up", async () => {
    const job = buildJob({ cases: ADDER_CASES });
    const sandbox = new FakeSandbox((req) => (req.role === "compile" ? {} : { meta: { status: "XX", message: "boom" } }));
    await expect(
      runJob(job.spec, {
        sandbox,
        blobs: { get: async (ref) => job.blobs.get(ref.sha256)! },
        progress: () => {},
        logger: silentLogger(),
      }),
    ).rejects.toMatchObject({ name: "InfraError", permanent: false });
    expect(sandbox.log.at(-1)).toBe("cleanup run");
  });
});

// ── CHECKER ──────────────────────────────────────────────────────────────

/** Problem with many correct answers: given n, print two non-negative integers a b with a + b = n. */
const SPLIT_CASES = [
  { input: "4\n", output: "2 2\n", isSample: true },
  { input: "10\n", output: "5 5\n" },
  { input: "7\n", output: "3 4\n" },
];

interface CheckerScript {
  /** The contestant's answer for n. */
  answer: (n: number) => string;
  /** Override the checker's exit code for n (default: a real a + b = n check). */
  exitFor?: (n: number) => number | null;
  /** The checker does not compile. */
  brokenChecker?: boolean;
}

function splitter(script: CheckerScript): FakeHandler {
  return (req, box): FakeRun => {
    if (req.role === "compile") {
      if (box.has("checker.cpp")) {
        if (script.brokenChecker) {
          return { meta: { status: "RE", exitCode: 1 }, stderr: "/box/checker.cpp:3:1: error: 'ensuref' was not declared in this scope\n" };
        }
        return { files: { checker: { data: "\x7fELF checker", mode: 0o755 } } };
      }
      return { files: { main: { data: "\x7fELF main", mode: 0o755 } } };
    }
    const n = Number(box.get("input.txt")!.data.toString());
    if (req.role === "run") return { stdout: script.answer(n) };
    // The checker box: argv and the three read-only files.
    expect(req.argv).toEqual(["./checker", "input.txt", "output.txt", "answer.txt"]);
    for (const name of ["input.txt", "output.txt", "answer.txt"]) expect(box.get(name)!.mode).toBe(0o444);
    expect(box.get("checker")!.mode).toBe(0o755);
    const forced = script.exitFor?.(n);
    if (forced !== undefined && forced !== null) {
      return { meta: { status: forced === 0 ? null : "RE", exitCode: forced }, stderr: `FAIL forced exit ${forced} for n=${n}\nsecond line\n` };
    }
    const [a, b] = box.get("output.txt")!.data.toString().trim().split(/\s+/).map(Number) as [number, number];
    if (a >= 0 && b >= 0 && a + b === n) return { stderr: `ok ${a} + ${b} = ${n}\n` };
    return { meta: { status: "RE", exitCode: 1 }, stderr: `wrong answer ${a} + ${b} != ${n}\n` };
  };
}

describe("runJob — CHECKER comparison", () => {
  const CHECKER_SOURCE = '#include "testlib.h"\nint main(int argc, char* argv[]) { registerTestlibCmd(argc, argv); quitf(_ok, "ok"); }\n';

  it("accepts two different valid outputs that a token comparison would reject", async () => {
    for (const answer of [(n: number) => `${n} 0\n`, (n: number) => `0 ${n}\n`]) {
      const job = buildJob({ cases: SPLIT_CASES, checkerSource: CHECKER_SOURCE });
      const { outcome, sandbox } = await judge(job, splitter({ answer }));
      expect(outcome.verdict).toBe("AC");
      expect(outcome.tests.map((t) => t.v)).toEqual(["AC", "AC", "AC"]);
      expect(sandbox.execs.filter((e) => e.role === "checker")).toHaveLength(3);
      // A fresh checker box per test, cleaned up at the end with the run box.
      expect(sandbox.log.filter((l) => l === "init checker")).toHaveLength(3);
      expect(sandbox.log.slice(-2)).toEqual(["cleanup checker", "cleanup run"]);
    }
  });

  it("an invalid output is WA (and ICPC stops there)", async () => {
    const job = buildJob({ cases: SPLIT_CASES, checkerSource: CHECKER_SOURCE });
    const { outcome } = await judge(job, splitter({ answer: (n) => (n === 10 ? "5 6\n" : `${n} 0\n`) }));
    expect(outcome).toMatchObject({ verdict: "WA", firstFailedIndex: 1 });
    expect(outcome.tests.map((t) => t.v)).toEqual(["AC", "WA", "SKIPPED"]);
  });

  it("exit 2 (presentation error) is WA — there is no PE verdict", async () => {
    const job = buildJob({ cases: SPLIT_CASES, checkerSource: CHECKER_SOURCE, stopOnFirstFailure: false });
    const { outcome } = await judge(job, splitter({ answer: (n) => `${n} 0\n`, exitFor: (n) => (n === 7 ? 2 : null) }));
    expect(outcome.tests.map((t) => t.v)).toEqual(["AC", "AC", "WA"]);
  });

  it("expected output reaches only the checker box, never the run box", async () => {
    const job = buildJob({ cases: SPLIT_CASES, checkerSource: CHECKER_SOURCE });
    const { sandbox } = await judge(job, splitter({ answer: (n) => `${n} 0\n` }));
    const expected = SPLIT_CASES.map((c) => Buffer.from(c.output));
    const runWrites = sandbox.writes.filter((w) => w.role === "run");
    for (const w of runWrites) for (const e of expected) expect(w.data.equals(e)).toBe(false);
    expect(runWrites.some((w) => w.name === "answer.txt" || w.name === "checker")).toBe(false);
    const answers = sandbox.writes.filter((w) => w.role === "checker" && w.name === "answer.txt").map((w) => w.data.toString());
    expect(answers).toEqual(["2 2\n", "5 5\n", "3 4\n"]);
    // The contestant's output is what the checker reads as output.txt.
    const outputs = sandbox.writes.filter((w) => w.role === "checker" && w.name === "output.txt").map((w) => w.data.toString());
    expect(outputs).toEqual(["4 0\n", "10 0\n", "7 0\n"]);
  });

  it("the checker's report is a message on visible tests only — a hidden test of a submission says nothing about its output", async () => {
    const job = buildJob({ cases: SPLIT_CASES, checkerSource: CHECKER_SOURCE });
    const { outcome } = await judge(job, splitter({ answer: (n) => `${n} 0\n` }));
    expect(outcome.tests[0]).toMatchObject({ v: "AC", message: "ok 4 + 0 = 4", stdout: "4 0\n" });
    for (const t of outcome.tests.slice(1)) {
      expect(t).not.toHaveProperty("message");
      expect(t).not.toHaveProperty("stdout");
    }
  });

  it("a validation job keeps the checker's report on every test (the author needs it)", async () => {
    const job = buildJob({ kind: "validation", cases: SPLIT_CASES, checkerSource: CHECKER_SOURCE, stopOnFirstFailure: false });
    const { outcome } = await judge(job, splitter({ answer: (n) => (n === 10 ? "1 1\n" : `${n} 0\n`) }));
    expect(outcome.tests[1]).toMatchObject({ v: "WA", message: "wrong answer 1 + 1 != 10" });
    expect(outcome.tests[1]).not.toHaveProperty("stdout");
  });

  it("exit 3 (FAIL) is a permanent checker failure carrying its first line, never a WA", async () => {
    const job = buildJob({ cases: SPLIT_CASES, checkerSource: CHECKER_SOURCE });
    const sandbox = new FakeSandbox(splitter({ answer: (n) => `${n} 0\n`, exitFor: (n) => (n === 10 ? 3 : null) }));
    const run = runJob(job.spec, {
      sandbox,
      blobs: { get: async (ref) => job.blobs.get(ref.sha256)! },
      progress: () => {},
      logger: silentLogger(),
    });
    await expect(run).rejects.toBeInstanceOf(PermanentJudgeError);
    await expect(run).rejects.toThrow(/^checker FAIL: FAIL forced exit 3 for n=10$/);
    expect(sandbox.log.slice(-2)).toEqual(["cleanup checker", "cleanup run"]);
  });

  it.each([7, 4, 200])("exit %i is treated as checker FAIL (permanent)", async (code) => {
    const job = buildJob({ cases: SPLIT_CASES, checkerSource: CHECKER_SOURCE });
    await expect(judge(job, splitter({ answer: (n) => `${n} 0\n`, exitFor: () => code }))).rejects.toThrow(PermanentJudgeError);
  });

  it("testlib partial credit (exit 16 + n) earns n/100 of a test's points", async () => {
    const cases = SPLIT_CASES.map((c, i) => ({ ...c, points: [10, 20, 30][i]! }));
    const job = buildJob({ cases, checkerSource: CHECKER_SOURCE, scoringMode: "PER_TEST" });
    const { outcome } = await judge(job, splitter({ answer: (n) => `${n} 0\n`, exitFor: (n) => (n === 10 ? 16 + 50 : n === 7 ? 16 + 100 : null) }));
    expect(outcome.tests.map((t) => t.v)).toEqual(["AC", "PARTIAL", "AC"]);
    expect(outcome).toMatchObject({ verdict: "PARTIAL", score: 10 + 10 + 30, maxScore: 60 });
  });

  it("a checker that does not compile is a permanent failure with the compiler's first error, sanitised", async () => {
    const job = buildJob({ cases: SPLIT_CASES, checkerSource: CHECKER_SOURCE });
    const run = judge(job, splitter({ answer: (n) => `${n} 0\n`, brokenChecker: true }));
    await expect(run).rejects.toBeInstanceOf(PermanentJudgeError);
    await expect(run).rejects.toThrow("checker does not compile: checker.cpp:3:1: error: 'ensuref' was not declared in this scope");
  });

  it("compiles the checker with testlib on the include path, once per node per hour (compile cache)", async () => {
    const cache = compileCache();
    const first = buildJob({ cases: SPLIT_CASES, checkerSource: CHECKER_SOURCE });
    const a = await judge(first, splitter({ answer: (n) => `${n} 0\n` }), cache);
    const checkerCompiles = (s: FakeSandbox) => s.execs.filter((e) => e.role === "compile" && e.argv.includes("checker.cpp"));
    expect(checkerCompiles(a.sandbox)).toHaveLength(1);
    const compileReq = checkerCompiles(a.sandbox)[0]!;
    expect(compileReq.toolchainIds).toEqual(["gcc-13.2.0", "testlib-0.9.41"]);
    expect(compileReq.argv).toEqual(expect.arrayContaining(["-I", "/opt/toolchains/testlib-0.9.41", "-DPC_BASE_EXIT_CODE=16"]));

    const second = buildJob({ cases: SPLIT_CASES, checkerSource: CHECKER_SOURCE, source: "int main(){ /* other */ }" });
    const b = await judge(second, splitter({ answer: (n) => `0 ${n}\n` }), cache);
    expect(checkerCompiles(b.sandbox)).toHaveLength(0);
    expect(b.outcome.verdict).toBe("AC");
  });

  it("a custom-input run of a CHECKER problem needs no checker", async () => {
    const job = buildJob({ kind: "run", cases: [{ input: "9\n", output: null }], checkerSource: CHECKER_SOURCE });
    const { outcome, sandbox } = await judge(job, splitter({ answer: (n) => `${n} 0\n` }));
    expect(outcome.verdict).toBe("AC");
    expect(outcome.tests[0]!.message).toMatch(/no expected output/);
    expect(sandbox.log.some((l) => l.includes("checker"))).toBe(false);
  });
});

// ── Compile cache ────────────────────────────────────────────────────────

describe("runJob — compile cache", () => {
  const compiles = (s: FakeSandbox) => s.execs.filter((e) => e.role === "compile");

  it("Submit after Run of the same code skips the compiler: cached, with the original compile time", async () => {
    const cache = compileCache();
    const source = "int main(){ int a, b; std::cin >> a >> b; std::cout << a + b; }";
    const handler: FakeHandler = (req, box) =>
      req.role === "compile" ? { meta: { timeSec: 0.734 }, files: { main: { data: "\x7fELF adder", mode: 0o755 } } } : adder(null)(req, box);

    const run = await judge(buildJob({ kind: "run", source, cases: [ADDER_CASES[0]!] }), handler, cache);
    expect(compiles(run.sandbox)).toHaveLength(1);
    expect(run.outcome.compile).toMatchObject({ ok: true, cached: false, timeMs: 734 });

    const submit = await judge(buildJob({ source, cases: ADDER_CASES }), handler, cache);
    expect(compiles(submit.sandbox)).toHaveLength(0);
    expect(submit.sandbox.log.some((l) => l.endsWith(" compile"))).toBe(false);
    expect(submit.outcome.compile).toMatchObject({ ok: true, cached: true, timeMs: 734 });
    expect(submit.outcome.verdict).toBe("AC");
    // The cached binary is what runs.
    const staged = submit.sandbox.writes.filter((w) => w.role === "run" && w.name === "main");
    expect(staged).toHaveLength(4);
    expect(staged.every((w) => w.data.toString() === "\x7fELF adder" && w.mode === 0o755)).toBe(true);
    // No COMPILING state on a hit.
    expect(submit.events[0]).toEqual({ type: "state", state: "RUNNING" });
  });

  it("different source, language or harness → a miss", async () => {
    const cache = compileCache();
    await judge(buildJob({ source: "int main(){}", cases: [ADDER_CASES[0]!] }), adder(null), cache);
    const other = await judge(buildJob({ source: "int main(){ }", cases: [ADDER_CASES[0]!] }), adder(null), cache);
    expect(compiles(other.sandbox)).toHaveLength(1);
    const cpp17 = await judge(buildJob({ language: "cpp17", source: "int main(){}", cases: [ADDER_CASES[0]!] }), adder(null), cache);
    expect(compiles(cpp17.sandbox)).toHaveLength(1);
  });

  it("a compile error is never cached", async () => {
    const cache = compileCache();
    const handler: FakeHandler = (req) => (req.role === "compile" ? { meta: { status: "RE", exitCode: 1 }, stderr: "main.cpp:1:1: error: x" } : {});
    for (let i = 0; i < 2; i++) {
      const { outcome, sandbox } = await judge(buildJob({ source: "int main({", cases: ADDER_CASES }), handler, cache);
      expect(outcome).toMatchObject({ verdict: "CE", compile: { cached: false }, maxScore: 1, cpuMs: 0 });
      expect(compiles(sandbox)).toHaveLength(1);
    }
    expect(cache.count).toBe(0);
  });

  it("the syntax-checked Python source is cached like a binary", async () => {
    const cache = compileCache();
    const source = "print(sum(map(int, input().split())))\n";
    const py = (req: Parameters<FakeHandler>[0], box: Parameters<FakeHandler>[1]) => {
      if (req.role === "compile") return {};
      const [a, c] = box.get("input.txt")!.data.toString().trim().split(" ").map(Number) as [number, number];
      return { stdout: `${a + c}\n` };
    };
    await judge(buildJob({ language: "py312", source, cases: ADDER_CASES }), py, cache);
    const again = await judge(buildJob({ language: "py312", source, cases: ADDER_CASES }), py, cache);
    expect(compiles(again.sandbox)).toHaveLength(0);
    expect(again.outcome).toMatchObject({ verdict: "AC", compile: { cached: true } });
    expect(again.sandbox.writes.filter((w) => w.role === "run" && w.name === "main.py")).toHaveLength(4);
  });
});

// ── What this node can judge ─────────────────────────────────────────────

describe("assertJudgeable (IsolateDriver preflight)", () => {
  const everything = () => true;
  const without = (missing: string) => (p: string) => !p.startsWith(missing);

  it("a spec no node could judge is permanent, even where toolchains are missing", () => {
    const job = buildJob({ compareMode: "INTERACTIVE", cases: ADDER_CASES });
    expect(() => assertJudgeable(job.spec, () => false)).toThrow(PermanentJudgeError);
  });

  it("a known toolchain missing on THIS node is retryable", () => {
    const job = buildJob({ language: "py312", cases: ADDER_CASES });
    let error: unknown;
    try {
      assertJudgeable(job.spec, without("/opt/toolchains/cpython-3.12.6"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).permanent).toBe(false);
  });

  it("a CHECKER job on a node without its testlib is retryable: 'testlib toolchain missing on this node'", () => {
    const job = buildJob({ cases: SPLIT_CASES, checkerSource: "int main(){}" });
    expect(() => assertJudgeable(job.spec, everything)).not.toThrow();
    let error: unknown;
    try {
      assertJudgeable(job.spec, without("/opt/toolchains/testlib-0.9.41"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InfraError);
    expect((error as InfraError).permanent).toBe(false);
    expect((error as Error).message).toMatch(/testlib toolchain missing on this node/);
  });
});

const TWO_SUM_BROKEN = `class Solution {
public:
    vector<int> twoSum(vector<int>& nums, long long target) {
        int count = 0
        for (int i = 0; i < (int)nums.size(); ++i) count++;
        return {};
    }
};
`;
