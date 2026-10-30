import { describe, expect, it } from "vitest";
import { SELF_CHECK_CASES, runSelfCheck } from "../src/selfcheck";
import type { SandboxLike } from "../src/judge";
import type { QueryOutcome } from "../src/sandbox";

/**
 * The self-check, against a fake sandbox: what it reports when the cluster
 * stops refusing something.
 *
 * The suite itself runs against a real cluster in `sandbox.db.test.ts`;
 * what is tested here is that a loosened grant is REPORTED rather than
 * passed over, because the fleet uses this to withhold the sensitive lanes.
 */

const EMPTY: QueryOutcome = { kind: "ok", ms: 1, result: { columns: [], rows: [] } };

/** A sandbox that answers each case the way a correctly locked-down one does. */
function goodSandbox(): SandboxLike {
  return {
    runCase: async ({ source }) => {
      const testCase = SELF_CHECK_CASES.find((c) => c.sql === source);
      if (!testCase) throw new Error(`unexpected statement: ${source}`);
      switch (testCase.expect) {
        case "ok":
          return testCase.name === "reads its own dataset"
            ? { kind: "ok", ms: 2, result: { columns: ["id", "name"], rows: [["1", "Asha"]] } }
            : EMPTY;
        case "timeout":
          return { kind: "timeout", ms: 5_000 };
        default:
          return { kind: "refused", code: "42501", ms: 1, message: "permission denied" };
      }
    },
  };
}

describe("the self-check", () => {
  it("passes when every statement is answered the way it must be", async () => {
    const result = await runSelfCheck(goodSandbox(), () => new Date("2026-11-01T10:00:00.000Z"));
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.ranAt.toISOString()).toBe("2026-11-01T10:00:00.000Z");
  });

  it("covers the things a student will actually try", async () => {
    const names = SELF_CHECK_CASES.map((c) => c.name);
    for (const expected of [
      "cannot write",
      "cannot create a table",
      "cannot create a temporary table",
      "cannot run two statements",
      "cannot read a file",
      "cannot read the role table",
      "cannot copy from a program",
      "cannot change its own role",
      "is stopped when it spins",
    ]) {
      expect(names, expected).toContain(expected);
    }
    // Every case says why it exists, because the reason is what a human
    // reads when it fails.
    for (const testCase of SELF_CHECK_CASES) expect(testCase.because.length).toBeGreaterThan(20);
  });

  it("reports a write that was allowed, with the reason attached", async () => {
    const sandbox: SandboxLike = {
      runCase: async ({ source }) =>
        source.startsWith("DELETE") ? { kind: "ok", ms: 1, result: { columns: [], rows: [] } } : goodSandbox().runCase({ setup: "", source, maxRows: 10 }),
    };
    const result = await runSelfCheck(sandbox);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("cannot write");
    expect(result.failures[0]).toContain("expected refused, got ok");
    expect(result.failures[0]).toContain("READ ONLY");
  });

  it("reports a query that was never stopped", async () => {
    const sandbox: SandboxLike = {
      runCase: async ({ source }) =>
        source.includes("generate_series")
          ? { kind: "ok", ms: 30_000, result: { columns: ["count"], rows: [["1"]] } }
          : goodSandbox().runCase({ setup: "", source, maxRows: 10 }),
    };
    const result = await runSelfCheck(sandbox);
    expect(result.failures.join(" ")).toContain("is stopped when it spins");
    expect(result.failures.join(" ")).toContain("statement_timeout");
  });

  it("reports another job's schema being visible, which is the worst case here", async () => {
    const sandbox: SandboxLike = {
      runCase: async ({ source }) =>
        source.includes("information_schema")
          ? { kind: "ok", ms: 1, result: { columns: ["table_schema"], rows: [["job_other"]] } }
          : goodSandbox().runCase({ setup: "", source, maxRows: 10 }),
    };
    const result = await runSelfCheck(sandbox);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain("another job's schema is visible");
  });

  it("reports a sandbox that threw rather than answering", async () => {
    const sandbox: SandboxLike = {
      runCase: async () => {
        throw new Error("the cluster is gone");
      },
    };
    const result = await runSelfCheck(sandbox);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(SELF_CHECK_CASES.length);
    expect(result.failures[0]).toContain("the sandbox threw");
  });
});
