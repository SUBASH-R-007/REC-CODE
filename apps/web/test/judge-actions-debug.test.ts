import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEBUG_REFUSALS, countEditedLines } from "@recx/shared";

/**
 * The submit boundary of a debugging problem (Phase 12m, slice 1).
 *
 * The edit budget is refused BEFORE the row — which is what the
 * `$transaction` mock asserts — because a submission that cannot be judged
 * on its merits must not cost a student one of their daily submissions,
 * and a Run that quietly judged an over-budget program would teach them
 * that the rule does not apply until it suddenly does.
 *
 * The other half is the language: a debugging problem is answered in the
 * languages its broken program is written in, and typing at one that has
 * none is refused here as well as hidden in the picker.
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

const BROKEN = `#include <iostream>
int main() {
  int n;
  std::cin >> n;
  int sum = 0;
  for (int i = 0; i <= n; i++) sum += i;
  std::cout << sum << std::endl;
}
`;
const FIXED = BROKEN.replace("i <= n", "i < n");
const REWRITTEN = `#include <cstdio>
int main() {
  int n;
  scanf("%d", &n);
  printf("%d\\n", n * (n - 1) / 2);
}
`;

function debugProblem(maxEditedLines: number | null, starter: string | null = BROKEN) {
  h.problem.mockResolvedValue({
    id: "prob_dbg",
    status: "PUBLISHED",
    liveVersion: { id: "ver_1", ioMode: "STDIN", compareMode: "TOKEN", functionSignature: null, maxEditedLines },
  });
  h.config.mockResolvedValue({ id: "cfg_cpp" });
  h.count.mockResolvedValue(2);
  h.starter.mockResolvedValue(starter === null ? null : { code: starter });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.user.mockResolvedValue({ id: "user_1" });
  h.transaction.mockImplementation(async () => {
    throw new Error("nothing should be written for a refused submission");
  });
});

describe("submitSolution — a debugging problem", () => {
  it("takes the one-line fix the question is about", async () => {
    debugProblem(1);
    h.transaction.mockResolvedValue("sub_1");
    expect((await submitSolution({ slug: "fix-the-sum", language: "cpp20", source: FIXED })).ok).toBe(true);
  });

  it("takes the program untouched, which is simply wrong rather than refused", async () => {
    debugProblem(1);
    h.transaction.mockResolvedValue("sub_2");
    // Zero changed lines is within every budget: the verdict is the judge's
    // to give, and it will be WA.
    expect((await submitSolution({ slug: "fix-the-sum", language: "cpp20", source: BROKEN })).ok).toBe(true);
  });

  it("refuses a rewrite, with both numbers, and writes nothing", async () => {
    debugProblem(1);
    const result = await submitSolution({ slug: "fix-the-sum", language: "cpp20", source: REWRITTEN });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(`${countEditedLines(BROKEN, REWRITTEN)} lines`);
      expect(result.error).toContain("allows 1");
      expect(result.error).toContain("Reset");
    }
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("does not charge for re-indenting or spacing the program out", async () => {
    debugProblem(1);
    h.transaction.mockResolvedValue("sub_3");
    const spaced = FIXED.replace(/^ {2}/gm, "      ").replace(/\n/g, "\n\n");
    expect((await submitSolution({ slug: "fix-the-sum", language: "cpp20", source: spaced })).ok).toBe(true);
  });

  it("refuses a language the broken program was not written in", async () => {
    debugProblem(1, null);
    const result = await submitSolution({ slug: "fix-the-sum", language: "py312", source: "print(1)\n" });
    expect(result).toEqual({ ok: false, error: DEBUG_REFUSALS.noProgram });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("leaves an ordinary problem alone — no budget, no starter read, no refusal", async () => {
    debugProblem(null);
    h.transaction.mockResolvedValue("sub_4");
    expect((await submitSolution({ slug: "two-sum", language: "cpp20", source: REWRITTEN })).ok).toBe(true);
    expect(h.starter).not.toHaveBeenCalled();
  });
});

describe("runCode — a debugging problem", () => {
  it("runs the fix against the samples", async () => {
    debugProblem(2);
    h.transaction.mockResolvedValue("run_1");
    expect((await runCode({ slug: "fix-the-sum", language: "cpp20", source: FIXED, customInput: null })).ok).toBe(true);
  });

  it("refuses an over-budget Run too, so the rule is not learned at submit time", async () => {
    debugProblem(1);
    const result = await runCode({ slug: "fix-the-sum", language: "cpp20", source: REWRITTEN, customInput: "5" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("allows 1");
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("still allows custom input: a debugging problem is an ordinary problem to run", async () => {
    debugProblem(1);
    h.transaction.mockResolvedValue("run_2");
    expect((await runCode({ slug: "fix-the-sum", language: "cpp20", source: FIXED, customInput: "5" })).ok).toBe(true);
  });
});
