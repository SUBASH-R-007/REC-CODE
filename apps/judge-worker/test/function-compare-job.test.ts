import { describe, expect, it } from "vitest";
import type { FunctionSignature, JudgeJobSpec } from "@recx/shared";
import { EMPTY_OUTPUT_REASON, EXTRA_OUTPUT_REASON } from "@recx/shared/harness";
import { PermanentJudgeError } from "../src/errors";
import { NOT_UTF8_MESSAGE, runJob } from "../src/judge/run-job";
import { silentLogger } from "../src/logger";
import { FakeSandbox, type FakeHandler, type FakeRun } from "./support/fake-sandbox";
import { buildJob, type BuiltJob, type TestCaseInput } from "./support/jobs";

/**
 * FUNCTION-mode output on the worker's real job path (FakeSandbox): every
 * comparator is decoded and compared structurally (protocol 3), CUSTOM_CHECKER
 * output is canonicalised before the checker sees it, and the reason a test
 * failed reaches visible tests and validation jobs only.
 */

const sig = (patch: Partial<FunctionSignature>): FunctionSignature => ({
  className: "Solution",
  methodName: "solve",
  params: [{ name: "s", type: "string" }],
  returns: "string",
  comparator: "EXACT",
  mutatedParam: null,
  ...patch,
});

function fnJob(signature: FunctionSignature, cases: TestCaseInput[], extra: Partial<Parameters<typeof buildJob>[0]> = {}): BuiltJob {
  return buildJob({
    ioMode: "FUNCTION",
    functionSignature: signature,
    compareMode: signature.comparator === "CUSTOM_CHECKER" ? "CHECKER" : "TOKEN",
    stopOnFirstFailure: false,
    scoringMode: "PER_TEST",
    source: "class Solution {};",
    cases,
    ...extra,
  });
}

/** The program prints `outputs[k]` for the k-th test (by input content). */
function printing(job: BuiltJob, outputs: (string | Buffer)[], checker?: (output: string) => number): FakeHandler {
  return (req, box): FakeRun => {
    if (req.role === "compile") {
      if (box.has("checker.cpp")) return { files: { checker: { data: "\x7fELF checker", mode: 0o755 } } };
      return { files: { main: { data: "\x7fELF main", mode: 0o755 } } };
    }
    if (req.role === "checker") {
      const output = box.get("output.txt")!.data.toString();
      const code = checker ? checker(output) : 0;
      return { meta: { status: code === 0 ? null : "RE", exitCode: code }, stderr: code === 0 ? "ok fine\n" : `wrong ${output.trim()}\n` };
    }
    const input = box.get("input.txt")!.data;
    const k = job.spec.tests.findIndex((t) => job.blobs.get(t.input.sha256)!.equals(input));
    return { stdout: outputs[k]! };
  };
}

async function judge(job: BuiltJob | { spec: JudgeJobSpec; blobs: Map<string, Buffer> }, handler: FakeHandler) {
  const sandbox = new FakeSandbox(handler);
  const outcome = await runJob(job.spec, {
    sandbox,
    blobs: { get: async (ref) => job.blobs.get(ref.sha256)! },
    progress: () => {},
    logger: silentLogger(),
  });
  return { outcome, sandbox };
}

describe("FUNCTION structured comparison on the job path", () => {
  it("regression: whitespace inside a string is significant (no false AC), with the reason on the sample only", async () => {
    const job = fnJob(sig({}), [
      { input: '"x"\n', output: '"a b"\n', isSample: true },
      { input: '"y"\n', output: '"a b"\n' },
    ]);
    const { outcome } = await judge(job, printing(job, ['"a  b"\n', '"a  b"\n']));
    expect(outcome.tests.map((t) => t.v)).toEqual(["WA", "WA"]);
    expect(outcome.tests[0]!.message).toBe("The result differs from the expected answer.");
    expect(outcome.tests[1]!.message).toBeUndefined();
  });

  it("accepts any JSON spelling of the right value (whitespace, escapes, 1.0 for 1 under FLOAT_TOLERANCE)", async () => {
    const job = fnJob(sig({ returns: "list<double>", comparator: "FLOAT_TOLERANCE" }), [
      { input: '"x"\n', output: "[1,0.5]\n", isSample: true },
      { input: '"y"\n', output: "[2]\n" },
    ]);
    const { outcome } = await judge(job, printing(job, ["[ 1.0 , 5.0E-1 ]\n", "[2.0000000001]\n"]));
    expect(outcome.verdict).toBe("AC");
  });

  it("explains malformed output — nothing printed, extra prints, invalid UTF-8 — on visible tests", async () => {
    const job = fnJob(sig({}), [
      { input: '"a"\n', output: '"a"\n', isSample: true },
      { input: '"b"\n', output: '"b"\n', isSample: true },
      { input: '"c"\n', output: '"c"\n', isSample: true },
    ]);
    const { outcome } = await judge(job, printing(job, ["", 'debug\n"b"\n', Buffer.from([0x22, 0xff, 0x22, 0x0a])]));
    expect(outcome.tests.map((t) => [t.v, t.message])).toEqual([
      ["WA", EMPTY_OUTPUT_REASON],
      ["WA", EXTRA_OUTPUT_REASON],
      ["WA", NOT_UTF8_MESSAGE],
    ]);
  });

  it("carries the reason on hidden tests of a validation job, never of a submission", async () => {
    const cases = [{ input: '"a"\n', output: '"a"\n' }];
    const validation = fnJob(sig({}), cases, { kind: "validation" });
    const submission = fnJob(sig({}), cases);
    expect((await judge(validation, printing(validation, ["42\n"]))).outcome.tests[0]!.message).toMatch(/not a valid string/);
    expect((await judge(submission, printing(submission, ["42\n"]))).outcome.tests[0]!.message).toBeUndefined();
  });

  it("an expected answer that does not decode is the problem's bug: released permanently", async () => {
    const job = fnJob(sig({ returns: "int" }), [{ input: '"a"\n', output: "one\n" }]);
    await expect(judge(job, printing(job, ["1\n"]))).rejects.toBeInstanceOf(PermanentJudgeError);
  });

  it("IN_PLACE_MUTATION compares the printed parameter; ROWS_ANY_ORDER ignores row order", async () => {
    const inPlace = fnJob(
      sig({ params: [{ name: "a", type: "list<int>" }], returns: "void", comparator: "IN_PLACE_MUTATION", mutatedParam: "a" }),
      [
        { input: "[1,2,3]\n", output: "[3,1,2]\n" },
        { input: "[4,5]\n", output: "[5,4]\n" },
      ],
    );
    const r1 = await judge(inPlace, printing(inPlace, ["[3,1,2]\n", "[4,5]\n"]));
    expect(r1.outcome.tests.map((t) => t.v)).toEqual(["AC", "WA"]);

    const rows = fnJob(sig({ returns: "matrix<int>", comparator: "ROWS_ANY_ORDER" }), [{ input: '"a"\n', output: "[[1,2],[3]]\n" }]);
    expect((await judge(rows, printing(rows, ["[[3],[1,2]]\n"]))).outcome.verdict).toBe("AC");
  });
});

describe("CUSTOM_CHECKER", () => {
  const custom = sig({ returns: "pair<int,int>", comparator: "CUSTOM_CHECKER" });
  const checkerSource = "// checker\n";

  it("hands the checker the canonical output, the input and the jury answer verbatim", async () => {
    const job = fnJob(custom, [{ input: '"x"\n', output: "[0,1]\n", isSample: true }], { checkerSource });
    const { outcome, sandbox } = await judge(job, printing(job, ["  [ 1 ,0 ]  \n"], (out) => (out === "[1,0]\n" ? 0 : 1)));
    expect(outcome.verdict).toBe("AC");
    const staged = (name: string) => sandbox.writes.find((w) => w.role === "checker" && w.name === name)!.data.toString();
    expect(staged("output.txt")).toBe("[1,0]\n");
    expect(staged("input.txt")).toBe('"x"\n');
    expect(staged("answer.txt")).toBe("[0,1]\n");
  });

  it("malformed output is WA and the checker never runs", async () => {
    const job = fnJob(custom, [{ input: '"x"\n', output: "[0,1]\n", isSample: true }], { checkerSource });
    const { outcome, sandbox } = await judge(job, printing(job, ["[0]\n"]));
    expect(outcome.tests[0]).toMatchObject({ v: "WA" });
    expect(outcome.tests[0]!.message).toMatch(/not a valid pair<int,int>/);
    expect(sandbox.execs.some((e) => e.role === "checker")).toBe(false);
  });

  it("the checker's own report stays the message when it rejects a well-formed answer", async () => {
    const job = fnJob(custom, [{ input: '"x"\n', output: "[0,1]\n", isSample: true }], { checkerSource });
    const { outcome } = await judge(job, printing(job, ["[5,5]\n"], () => 1));
    expect(outcome.tests[0]).toMatchObject({ v: "WA", message: "wrong [5,5]" });
  });
});

describe("JVM run flags on the job path", () => {
  it("java21 runs with -Xmx / -Xss sized from the job's memory limit", async () => {
    const job = fnJob(sig({}), [{ input: '"a"\n', output: '"a"\n' }], { language: "java21", memoryLimitKb: 131_072 });
    const { outcome, sandbox } = await judge(job, (req) =>
      req.role === "compile" ? { files: { "Main.class": { data: "cafebabe" } } } : { stdout: '"a"\n' },
    );
    expect(outcome.verdict).toBe("AC");
    const run = sandbox.execs.find((e) => e.role === "run")!;
    expect(run.argv.slice(0, 3)).toEqual([job.spec.language?.run.argv[0], "-Xmx89m", "-Xss128m"]);
  });
});
