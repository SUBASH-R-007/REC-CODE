import { beforeEach, describe, expect, it, vi } from "vitest";
import { SQL_LIMITS, SQL_REFUSALS } from "@recx/shared";

/**
 * The submit boundary of a SQL question (Phase 12k, slice 4).
 *
 * Every refusal here is checked BEFORE the transaction that writes the
 * row, which is what the `$transaction` mock below asserts: a query the
 * sandbox would refuse anyway should cost a student nothing — no
 * submission row, no daily cap, no wait for a verdict to read a sentence
 * the server could have said at once.
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
    // The happy path marks the queued row DISPATCHED and touches the user.
    submission: { updateMany: vi.fn(async () => ({ count: 1 })) },
    runRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
    user: { update: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/auth/guards", () => ({ requireActionUser: h.user }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: vi.fn(async () => true) }));

const { submitSolution, runCode } = await import("@/server/actions/judge");

const QUERY = "SELECT id, name FROM students ORDER BY id";

function sqlProblem(ioMode = "SQL") {
  h.problem.mockResolvedValue({
    id: "prob_sql",
    status: "PUBLISHED",
    liveVersion: { id: "ver_1", ioMode, functionSignature: null, maxEditedLines: null },
  });
  h.config.mockResolvedValue({ id: "cfg_sql" });
  h.count.mockResolvedValue(2);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.user.mockResolvedValue({ id: "user_1" });
  h.transaction.mockImplementation(async () => {
    throw new Error("nothing should be written for a refused submission");
  });
});

describe("submitSolution — a SQL question", () => {
  it("refuses more than one statement without writing anything", async () => {
    sqlProblem();
    const result = await submitSolution({ slug: "every-student", language: "sql17", source: `${QUERY}; DROP TABLE students;` });
    expect(result).toEqual({ ok: false, error: SQL_REFUSALS.multiple });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("refuses a query longer than the SQL cap", async () => {
    sqlProblem();
    const result = await submitSolution({
      slug: "every-student",
      language: "sql17",
      source: `-- ${"x".repeat(SQL_LIMITS.submissionBytes)}\n${QUERY}`,
    });
    expect(result).toEqual({ ok: false, error: SQL_REFUSALS.tooLong });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("refuses a programming language, and refuses SQL everywhere else", async () => {
    sqlProblem();
    const asCpp = await submitSolution({ slug: "every-student", language: "cpp20", source: "int main(){}" });
    expect(asCpp.ok).toBe(false);
    if (!asCpp.ok) expect(asCpp.error).toContain("answered with a SQL query");

    sqlProblem("STDIN");
    const asSql = await submitSolution({ slug: "two-sum", language: "sql17", source: QUERY });
    expect(asSql.ok).toBe(false);
    if (!asSql.ok) expect(asSql.error).toContain("SQL is only for a SQL problem");
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("lets an ordinary one-statement query through to the row", async () => {
    sqlProblem();
    h.transaction.mockResolvedValue("sub_1");
    const result = await submitSolution({ slug: "every-student", language: "sql17", source: QUERY });
    expect(result.ok).toBe(true);
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });

  it("leaves a semicolon that ends the one statement alone", async () => {
    sqlProblem();
    h.transaction.mockResolvedValue("sub_1");
    expect((await submitSolution({ slug: "every-student", language: "sql17", source: `${QUERY};` })).ok).toBe(true);
  });
});

describe("runCode — a SQL question", () => {
  it("refuses custom input, because the dataset IS the input", async () => {
    sqlProblem();
    const result = await runCode({ slug: "every-student", language: "sql17", source: QUERY, customInput: "1 2 3" });
    expect(result).toEqual({ ok: false, error: SQL_REFUSALS.customInput });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("says so plainly when the question has no sample dataset", async () => {
    sqlProblem();
    h.count.mockResolvedValue(0);
    const result = await runCode({ slug: "every-student", language: "sql17", source: QUERY, customInput: null });
    expect(result).toEqual({ ok: false, error: SQL_REFUSALS.noSampleCase });
  });

  it("runs a query against the sample datasets", async () => {
    sqlProblem();
    h.transaction.mockResolvedValue("run_1");
    const result = await runCode({ slug: "every-student", language: "sql17", source: QUERY, customInput: null });
    expect(result.ok).toBe(true);
  });
});
