import { describe, expect, it } from "vitest";
import { SANDBOX_FORCED_ENV } from "../src/languages";
import { RUN_OUTCOME_RULES, VERDICTS } from "../src/verdict";

/**
 * The per-test classification order published on /judge. The worker's
 * classifyRun() is bound to it by apps/judge-worker/test/verdict-rules.test.ts;
 * these are the list's own invariants.
 */
describe("RUN_OUTCOME_RULES", () => {
  it("has unique ids", () => {
    const ids = RUN_OUTCOME_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names only real verdicts (or null for 'compare the output')", () => {
    for (const rule of RUN_OUTCOME_RULES) {
      if (rule.verdict !== null) expect(VERDICTS).toContain(rule.verdict);
    }
  });

  it("starts with the sandbox failure (IE) and ends with the output comparison", () => {
    expect(RUN_OUTCOME_RULES[0]).toEqual({ id: "sandbox-failure", verdict: "IE" });
    expect(RUN_OUTCOME_RULES[RUN_OUTCOME_RULES.length - 1]).toEqual({ id: "compare", verdict: null });
    expect(RUN_OUTCOME_RULES.filter((r) => r.verdict === null)).toHaveLength(1);
  });

  it("never classifies a run as CE, PARTIAL, SKIPPED, AC or WA (those come from the compile step and scoring)", () => {
    const run = new Set<string | null>(RUN_OUTCOME_RULES.map((r) => r.verdict));
    for (const v of ["CE", "PARTIAL", "SKIPPED", "AC", "WA"] as const) expect(run.has(v)).toBe(false);
  });
});

describe("SANDBOX_FORCED_ENV", () => {
  it("is HOME=/box and LANG=C.UTF-8, frozen", () => {
    expect(SANDBOX_FORCED_ENV).toEqual({ HOME: "/box", LANG: "C.UTF-8" });
    expect(Object.isFrozen(SANDBOX_FORCED_ENV)).toBe(true);
  });
});
