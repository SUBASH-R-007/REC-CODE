import { describe, expect, it } from "vitest";
import { FUNCTION_COMPARATOR_DESCRIPTIONS, FUNCTION_COMPARATORS } from "@recx/shared";
import { TWO_SUM } from "@recx/shared/samples/two-sum";
import { waNote, WA_NOTES } from "@/components/workspace/result-view";
import { functionComparatorOf, toStudentView, type SubmissionViewSource } from "@/lib/judge/view";

/**
 * Protocol 3: FUNCTION output is compared structurally by the version's
 * comparator, so the "why Wrong Answer?" note follows the comparator, never
 * the token-comparison text of compareMode.
 */

const source = (functionSignature: unknown, compareMode: SubmissionViewSource["compareMode"] = "TOKEN"): SubmissionViewSource => ({
  kind: "submission",
  id: "sub_1",
  status: "DONE",
  verdict: "WA",
  language: "cpp20",
  languageLabel: "C++20",
  compileOutput: null,
  createdAt: new Date("2026-10-10T00:00:00Z"),
  judgedAt: new Date("2026-10-10T00:00:01Z"),
  samples: [],
  passedCases: 0,
  totalCases: 1,
  maxTimeMs: 1,
  maxMemoryKb: 1,
  testResults: [{ i: 0, v: "WA", ms: 1, kb: 1 }],
  details: [],
  compareMode,
  functionSignature,
});

describe("functionComparatorOf", () => {
  it("reads a known comparator from the stored signature, else null", () => {
    expect(functionComparatorOf(TWO_SUM.signature)).toBe("EXACT");
    for (const c of FUNCTION_COMPARATORS) expect(functionComparatorOf({ comparator: c })).toBe(c);
    expect(functionComparatorOf(null)).toBeNull();
    expect(functionComparatorOf({ comparator: "FUZZY" })).toBeNull();
    expect(functionComparatorOf("EXACT")).toBeNull();
  });
});

describe("the Wrong Answer note", () => {
  it("follows the comparator for FUNCTION problems", () => {
    const view = toStudentView(source({ ...TWO_SUM.signature, comparator: "SET_EQUAL" }));
    expect(view.functionComparator).toBe("SET_EQUAL");
    expect(waNote(view)).toBe(FUNCTION_COMPARATOR_DESCRIPTIONS.SET_EQUAL.student);
    expect(waNote(view)).not.toBe(WA_NOTES.TOKEN);
  });

  it("follows the compare mode for STDIN problems", () => {
    const view = toStudentView(source(null, "EXACT"));
    expect(view.functionComparator).toBeNull();
    expect(waNote(view)).toBe(WA_NOTES.EXACT);
  });
});
