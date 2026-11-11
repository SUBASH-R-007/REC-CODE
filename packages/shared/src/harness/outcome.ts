import { worstVerdict, type Verdict } from "../verdict";

/**
 * Whether a reference solution produced its expected verdict — the rule the
 * validation pipeline (apps/web/src/lib/judge/validation.ts) applies to every
 * reference, and the judge worker's golden suite applies on real isolate.
 * Pure, so both sides share one definition.
 */

/** A PARTIAL run's verdict as a deliberately-wrong reference sees it: its worst failing test. */
export function effectiveVerdict(verdict: Verdict, tests: readonly { v: Verdict }[]): Verdict {
  if (verdict !== "PARTIAL") return verdict;
  const failures = tests.map((t) => t.v).filter((v) => v !== "AC" && v !== "SKIPPED" && v !== "PARTIAL");
  return failures.length > 0 ? worstVerdict(failures) : verdict;
}

/** MATCHED when the run produced the reference solution's expected verdict. */
export function validationOutcome(
  expected: Verdict,
  verdict: Verdict,
  tests: readonly { v: Verdict }[],
): "MATCHED" | "MISMATCHED" {
  if (verdict === expected) return "MATCHED";
  if (expected !== "AC" && expected !== "PARTIAL" && effectiveVerdict(verdict, tests) === expected) return "MATCHED";
  return "MISMATCHED";
}
