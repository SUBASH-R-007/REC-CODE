import { describe, expect, it, vi } from "vitest";
import { ANSWER_LANGUAGE_KEY, JUDGE_PROTOCOL_VERSION, judgeJobSpecSchema, type JudgeJobSpec } from "@recx/shared";
import { runJob } from "../src/judge/run-job";
import { planJob } from "../src/judge/plan";
import { MockJudgeDriver } from "../src/drivers/mock";
import { silentLogger } from "../src/logger";

/**
 * An output-only job in the worker (Phase 12n, slice 1).
 *
 * The one isolate job with no program: nothing is compiled, no run box is
 * created, and the student's submitted text is compared with the expected
 * answer — or handed to the author's checker in its box. These tests prove
 * both halves of "no program": that the comparison happens, and that no
 * sandbox role but the checker's is ever touched.
 */

const sha = (n: number) => String(n).padStart(64, "0");

function answerSpec(over: Partial<JudgeJobSpec> = {}): JudgeJobSpec {
  return judgeJobSpecSchema.parse({
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: "submission",
    id: "sub_answer",
    lane: "PRACTICE",
    claimToken: "token-token-token",
    attempt: 1,
    language: null,
    source: "42\n",
    ioMode: "OUTPUT_ONLY",
    functionSignature: null,
    compareMode: "TOKEN",
    floatEpsilon: null,
    scoringMode: "ICPC",
    stopOnFirstFailure: true,
    timeLimitMs: 2000,
    memoryLimitKb: 262_144,
    tests: [
      {
        index: 0,
        isSample: true,
        input: { sha256: sha(1), sizeBytes: 8 },
        output: { sha256: sha(2), sizeBytes: 3 },
        points: null,
        subtask: null,
      },
    ],
    ...over,
  });
}

/** A sandbox that records every role it is asked for. */
function recordingSandbox() {
  const roles: string[] = [];
  return {
    roles,
    sandbox: {
      init: vi.fn(async (role: string) => {
        roles.push(role);
      }),
      cleanup: vi.fn(async () => {}),
      writeFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => Buffer.alloc(0)),
      listFiles: vi.fn(async () => []),
      unlink: vi.fn(async () => {}),
      exec: vi.fn(async () => {
        throw new Error("nothing should be executed for a text comparison");
      }),
      execPair: vi.fn(async () => {
        throw new Error("nothing should be executed for a text comparison");
      }),
    },
  };
}

const blobs = (expected: string, input = "the data\n") => ({
  get: async (ref: { sha256: string }) => Buffer.from(ref.sha256 === sha(2) ? expected : input, "utf8"),
});

const context = (expected: string, sandbox: ReturnType<typeof recordingSandbox>["sandbox"]) => ({
  sandbox: sandbox as never,
  blobs: blobs(expected),
  progress: () => {},
  logger: silentLogger(),
});

describe("the protocol's own rule", () => {
  it("accepts an output-only spec with no runtime", () => {
    expect(answerSpec().language).toBeNull();
  });

  it("refuses an output-only spec that carries one, and a program spec that does not", () => {
    const withRuntime = judgeJobSpecSchema.safeParse({
      ...answerSpec(),
      language: { key: "cpp20", label: "C++20", toolchainId: "gcc-13.2.0" },
    });
    expect(withRuntime.success).toBe(false);
    const withoutRuntime = judgeJobSpecSchema.safeParse({ ...answerSpec(), ioMode: "STDIN" });
    expect(withoutRuntime.success).toBe(false);
    if (!withoutRuntime.success) {
      expect(withoutRuntime.error.issues.some((i) => i.path.includes("language"))).toBe(true);
    }
  });

  it("plans without asking for a runtime", () => {
    const plan = planJob(answerSpec());
    expect(plan.compareMode).toBe("TOKEN");
    expect(plan.checker).toBeNull();
    expect(plan.functionCompare).toBeNull();
  });
});

describe("judging an answer", () => {
  it("is AC when the text matches, and no box is ever created", async () => {
    const { sandbox, roles } = recordingSandbox();
    const outcome = await runJob(answerSpec(), context("42\n", sandbox));
    expect(outcome.verdict).toBe("AC");
    expect(roles).toEqual([]);
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("is WA when it does not", async () => {
    const { sandbox } = recordingSandbox();
    const outcome = await runJob(answerSpec({ source: "41\n" }), context("42\n", sandbox));
    expect(outcome.verdict).toBe("WA");
    expect(outcome.tests[0]?.v).toBe("WA");
  });

  it("compares by the problem's rule: TOKEN forgives the whitespace EXACT does not", async () => {
    const { sandbox } = recordingSandbox();
    const spaced = "  42  \n\n";
    expect((await runJob(answerSpec({ source: spaced }), context("42\n", sandbox))).verdict).toBe("AC");
    expect(
      (await runJob(answerSpec({ source: spaced, compareMode: "EXACT" }), context("42\n", sandbox))).verdict,
    ).toBe("WA");
  });

  it("reports no time and no memory, because nothing ran", async () => {
    const { sandbox } = recordingSandbox();
    const outcome = await runJob(answerSpec(), context("42\n", sandbox));
    expect(outcome.tests[0]?.ms).toBe(0);
    expect(outcome.tests[0]?.kb).toBe(0);
    expect(outcome.compile).toBeNull();
  });

  it("hands the student their own answer back, since the case is visible", async () => {
    const { sandbox } = recordingSandbox();
    const outcome = await runJob(answerSpec({ source: "42\n" }), context("42\n", sandbox));
    expect(outcome.tests[0]?.stdout).toBe("42\n");
  });

  it("refuses a job with more than one case, or none, permanently", async () => {
    const { sandbox } = recordingSandbox();
    const two = answerSpec({
      tests: [
        { index: 0, isSample: true, input: { sha256: sha(1), sizeBytes: 8 }, output: { sha256: sha(2), sizeBytes: 3 }, points: null, subtask: null },
        { index: 1, isSample: true, input: { sha256: sha(3), sizeBytes: 8 }, output: { sha256: sha(4), sizeBytes: 3 }, points: null, subtask: null },
      ],
    });
    await expect(runJob(two, context("42\n", sandbox))).rejects.toThrow(/exactly one case/);
  });

  it("refuses a case with no expected answer: there would be nothing to compare", async () => {
    const { sandbox } = recordingSandbox();
    const open = answerSpec({
      tests: [{ index: 0, isSample: true, input: { sha256: sha(1), sizeBytes: 8 }, output: null, points: null, subtask: null }],
    });
    await expect(runJob(open, context("42\n", sandbox))).rejects.toThrow(/no expected answer/);
  });
});

describe("the mock judge", () => {
  it("refuses an output-only job rather than fabricating a verdict", async () => {
    const driver = new MockJudgeDriver({ write: () => {} });
    await expect(
      driver.judge(answerSpec(), { progress: () => {}, logger: silentLogger(), blobs: blobs("42\n") } as never),
    ).rejects.toThrow(/the submission is the answer itself/);
  });
});

describe("the language key", () => {
  it("is the one a submission carries, and not a toolchain", () => {
    expect(ANSWER_LANGUAGE_KEY).toBe("answer1");
  });
});
