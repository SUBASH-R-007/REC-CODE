import type { CompareMode, IoMode } from "../protocol";
import { functionCompareMode, functionSignatureSchema } from "./signature";

/**
 * "A problem cannot publish without a declared comparator" — the app-side
 * half of the rule (the database half is the CHECK constraints of migration
 * 20261010100100_function_comparator_checks). Pure: the authoring stream's
 * publish and approve gates call it with the version's columns and turn
 * every string it returns into a blocker.
 */
export interface ComparatorDeclaration {
  ioMode: IoMode;
  compareMode: CompareMode;
  /** ProblemVersion.functionSignature (jsonb), unparsed. */
  functionSignature: unknown;
  floatEpsilon: number | null;
  checkerSha256: string | null;
  testlibId: string | null;
}

function epsilonIssue(floatEpsilon: number | null): string | null {
  if (floatEpsilon === null) return null;
  return Number.isFinite(floatEpsilon) && floatEpsilon > 0 && floatEpsilon <= 1
    ? null
    : `The float tolerance must be greater than 0 and at most 1 (got ${floatEpsilon}).`;
}

const CHECKER_MISSING = "A checker problem needs a checker source and a pinned testlib version.";

/** Every reason the version's comparator declaration cannot be published; empty = publishable. */
export function comparatorIssues(v: ComparatorDeclaration): string[] {
  const issues: string[] = [];
  const hasChecker = Boolean(v.checkerSha256) && Boolean(v.testlibId);
  if (v.compareMode === "INTERACTIVE") issues.push("Interactive problems are not available on this judge.");

  if (v.ioMode === "STDIN") {
    if (v.compareMode === "CHECKER" && !hasChecker) issues.push(CHECKER_MISSING);
    if (v.compareMode === "FLOAT") {
      const eps = epsilonIssue(v.floatEpsilon);
      if (eps) issues.push(eps);
    }
    return issues;
  }

  // FUNCTION
  if (v.functionSignature === null || v.functionSignature === undefined) {
    issues.push("A function problem must declare its method signature and comparator.");
    return issues;
  }
  const raw = v.functionSignature as { comparator?: unknown };
  if (typeof raw !== "object" || raw.comparator === undefined || raw.comparator === null) {
    issues.push("The function signature does not declare a comparator: a problem cannot publish without one.");
  }
  const parsed = functionSignatureSchema.safeParse(v.functionSignature);
  if (!parsed.success) {
    const messages = [...new Set(parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)))];
    issues.push(`The function signature is invalid — ${messages.slice(0, 5).join("; ")}`);
    return issues;
  }
  const sig = parsed.data;
  const mirror = functionCompareMode(sig.comparator);
  if ((sig.comparator === "CUSTOM_CHECKER") !== (v.compareMode === "CHECKER")) {
    issues.push(
      sig.comparator === "CUSTOM_CHECKER"
        ? "The CUSTOM_CHECKER comparator needs compare mode CHECKER."
        : `Compare mode CHECKER goes only with the CUSTOM_CHECKER comparator; with ${sig.comparator} set it to ${mirror}.`,
    );
  }
  if (sig.comparator === "CUSTOM_CHECKER" && !hasChecker) issues.push(CHECKER_MISSING);
  if (sig.comparator === "FLOAT_TOLERANCE") {
    const eps = epsilonIssue(v.floatEpsilon);
    if (eps) issues.push(eps);
  }
  return issues;
}
