import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_LANGUAGE_KEY, ANSWER_REFUSALS } from "@recx/shared";

/**
 * The submit boundary of an output-only problem (Phase 12n, slice 1).
 *
 * Two rules, both pairings: an output-only problem is answered with an
 * answer file and nothing else, and no other problem accepts one — a text
 * answer judged as a program would be a compile error nobody could
 * explain. And there is nothing to RUN: the answer is the submission, and
 * the one case it would run against is the one it is judged against.
 */

const h = vi.hoisted(() => ({
  problem: vi.fn(),
  config: vi.fn(),
  count: vi.fn(),
  starter: vi.fn(),
  transaction: vi.fn(),
  user: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    problem: { findUnique: h.problem },
    languageConfig: { findFirst: h.config },
    testCase: { count: h.count },
    starterCode: { findUnique: h.starter },
    $transaction: h.transaction,
    submission: { updateMany: vi.fn(async () => ({ count: 1 })) },
    runRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    user: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/auth/guards", () => ({ requireActionUser: h.user }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: vi.fn(async () => true) }));

const { submitSolution, runCode } = await import("@/server/actions/judge");

function problemOf(ioMode: string) {
  h.problem.mockResolvedValue({
    id: "prob_answer",
    status: "PUBLISHED",
    liveVersion: { id: "ver_1", ioMode, compareMode: "TOKEN", functionSignature: null, maxEditedLines: null },
  });
  h.config.mockResolvedValue({ id: "cfg_answer" });
  h.count.mockResolvedValue(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.user.mockResolvedValue({ id: "user_1" });
  h.transaction.mockImplementation(async () => {
    throw new Error("nothing should be written for a refused submission");
  });
});

describe("submitSolution — an output-only problem", () => {
  it("takes the answer itself", async () => {
    problemOf("OUTPUT_ONLY");
    h.transaction.mockResolvedValue("sub_1");
    const result = await submitSolution({ slug: "the-hard-one", language: ANSWER_LANGUAGE_KEY, source: "42\n" });
    expect(result.ok).toBe(true);
  });

  it("refuses a program for it", async () => {
    problemOf("OUTPUT_ONLY");
    const result = await submitSolution({ slug: "the-hard-one", language: "cpp20", source: "int main(){}\n" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("the answer itself, not a program");
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("refuses an answer file for a problem that wants a program", async () => {
    problemOf("STDIN");
    const result = await submitSolution({ slug: "two-sum", language: ANSWER_LANGUAGE_KEY, source: "42\n" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("only for an output-only problem");
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("refuses an answer file for a SQL problem too", async () => {
    problemOf("SQL");
    const result = await submitSolution({ slug: "top-scorers", language: ANSWER_LANGUAGE_KEY, source: "42\n" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("SQL query");
  });

  it("reads no starter: an answer problem has no program to repair", async () => {
    problemOf("OUTPUT_ONLY");
    h.transaction.mockResolvedValue("sub_2");
    await submitSolution({ slug: "the-hard-one", language: ANSWER_LANGUAGE_KEY, source: "42\n" });
    expect(h.starter).not.toHaveBeenCalled();
  });
});

describe("runCode — an output-only problem", () => {
  it("is refused, with the sentence that says why", async () => {
    problemOf("OUTPUT_ONLY");
    const result = await runCode({
      slug: "the-hard-one",
      language: ANSWER_LANGUAGE_KEY,
      source: "42\n",
      customInput: null,
    });
    expect(result).toEqual({ ok: false, error: ANSWER_REFUSALS.noRun });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("is refused with custom input as well", async () => {
    problemOf("OUTPUT_ONLY");
    const result = await runCode({
      slug: "the-hard-one",
      language: ANSWER_LANGUAGE_KEY,
      source: "42\n",
      customInput: "7",
    });
    expect(result.ok).toBe(false);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("leaves an ordinary problem's Run alone", async () => {
    problemOf("STDIN");
    h.transaction.mockResolvedValue("run_1");
    expect((await runCode({ slug: "two-sum", language: "cpp20", source: "int main(){}\n", customInput: null })).ok).toBe(
      true,
    );
  });
});
