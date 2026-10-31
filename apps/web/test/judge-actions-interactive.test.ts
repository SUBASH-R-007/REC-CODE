import { beforeEach, describe, expect, it, vi } from "vitest";
import { INTERACTIVE_REFUSALS } from "@recx/shared";

/**
 * The submit boundary of an interactive problem (Phase 12l, slice 3).
 *
 * One rule, in both halves: a conversation has no input to type, so a Run
 * carrying custom input is refused — before the transaction that writes
 * the row, which is what the `$transaction` mock asserts — and a problem
 * with no sample conversation says so rather than offering custom input as
 * the alternative, which is what an ordinary problem's message does.
 */

const h = vi.hoisted(() => ({
  problem: vi.fn(),
  config: vi.fn(),
  count: vi.fn(),
  transaction: vi.fn(),
  user: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    problem: { findUnique: h.problem },
    languageConfig: { findFirst: h.config },
    testCase: { count: h.count },
    $transaction: h.transaction,
    submission: { updateMany: vi.fn(async () => ({ count: 1 })) },
    runRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    user: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/auth/guards", () => ({ requireActionUser: h.user }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: vi.fn(async () => true) }));

const { submitSolution, runCode } = await import("@/server/actions/judge");

const SOURCE = "int main(){}\n";

function interactiveProblem(compareMode = "INTERACTIVE") {
  h.problem.mockResolvedValue({
    id: "prob_int",
    status: "PUBLISHED",
    liveVersion: { id: "ver_1", ioMode: "STDIN", compareMode, functionSignature: null, maxEditedLines: null },
  });
  h.config.mockResolvedValue({ id: "cfg_cpp" });
  h.count.mockResolvedValue(2);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.user.mockResolvedValue({ id: "user_1" });
  h.transaction.mockImplementation(async () => {
    throw new Error("nothing should be written for a refused run");
  });
});

describe("runCode — an interactive problem", () => {
  it("refuses custom input, because the examiner's replies are the input", async () => {
    interactiveProblem();
    const result = await runCode({ slug: "guess", language: "cpp20", source: SOURCE, customInput: "42" });
    expect(result).toEqual({ ok: false, error: INTERACTIVE_REFUSALS.customInput });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("says so plainly when there is no sample conversation", async () => {
    interactiveProblem();
    h.count.mockResolvedValue(0);
    const result = await runCode({ slug: "guess", language: "cpp20", source: SOURCE, customInput: null });
    expect(result).toEqual({ ok: false, error: INTERACTIVE_REFUSALS.noSampleCase });
    // Not the ordinary message, which offers custom input as the way out.
    if (!result.ok) expect(result.error).not.toContain("custom input instead");
  });

  it("runs against the samples", async () => {
    interactiveProblem();
    h.transaction.mockResolvedValue("run_1");
    expect((await runCode({ slug: "guess", language: "cpp20", source: SOURCE, customInput: null })).ok).toBe(true);
  });

  it("leaves an ordinary problem's custom input alone", async () => {
    interactiveProblem("TOKEN");
    h.transaction.mockResolvedValue("run_2");
    expect((await runCode({ slug: "two-sum", language: "cpp20", source: SOURCE, customInput: "2 3" })).ok).toBe(true);
  });
});

describe("submitSolution — an interactive problem", () => {
  it("is an ordinary submission in an ordinary language", async () => {
    interactiveProblem();
    h.transaction.mockResolvedValue("sub_1");
    expect((await submitSolution({ slug: "guess", language: "cpp20", source: SOURCE })).ok).toBe(true);
  });

  it("still refuses SQL, which is not a language a conversation is written in", async () => {
    interactiveProblem();
    const result = await submitSolution({ slug: "guess", language: "sql17", source: "SELECT 1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("SQL is only for a SQL problem");
  });
});
