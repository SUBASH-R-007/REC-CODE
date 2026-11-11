import { describe, expect, it } from "vitest";
import {
  PROBLEM_REPORT_CORRECTNESS_REASONS,
  PROBLEM_REPORT_DECISION_MESSAGE,
  PROBLEM_REPORT_LIMITS,
  PROBLEM_REPORT_REASONS,
  PROBLEM_REPORT_REASON_LABEL,
  isCorrectnessReport,
  problemHeldMessage,
  problemReportDecisionProblem,
} from "../src/problem-report";

/**
 * The rules a defect report has to obey (Phase 16a), away from a database.
 *
 * The one worth the file is `problemReportDecisionProblem`: it is the rule
 * the form and the action both ask, and the `ProblemReport_decision_check`
 * CHECK is the same rule in SQL. Three places saying the same thing is only
 * safe while something proves they agree, and this is the pure half of that.
 */

describe("every reason is a sentence a student could have written", () => {
  it("labels all of them", () => {
    for (const reason of PROBLEM_REPORT_REASONS) {
      const label = PROBLEM_REPORT_REASON_LABEL[reason];
      expect(label, reason).toBeTruthy();
      // A category name ("WRONG_EXPECTED_OUTPUT") is not a sentence.
      expect(label).not.toMatch(/_/);
      expect(label[0]).toBe(label[0]?.toUpperCase());
    }
  });

  it("marks the three that are a claim of wrongness, and not the others", () => {
    expect([...PROBLEM_REPORT_CORRECTNESS_REASONS].sort()).toEqual(
      ["MISSING_CONSTRAINT", "STATEMENT_CONTRADICTS_SAMPLES", "WRONG_EXPECTED_OUTPUT"].sort(),
    );
    expect(isCorrectnessReport("WRONG_EXPECTED_OUTPUT")).toBe(true);
    // Unclear is not wrong. A queue that sorted them together would put the
    // sentence somebody found confusing above the test case that is costing
    // students marks.
    expect(isCorrectnessReport("STATEMENT_UNCLEAR")).toBe(false);
    expect(isCorrectnessReport("LIMITS_TOO_TIGHT")).toBe(false);
    expect(isCorrectnessReport("OTHER")).toBe(false);
  });
});

describe("a decision carries its sentence", () => {
  const base = { status: "UPHELD" as const, resolution: "Case 3 was wrong; revision 4 fixes it.", hold: false, holdReason: null };

  it("accepts an upheld report with an answer and no hold", () => {
    expect(problemReportDecisionProblem(base)).toBeNull();
  });

  it("accepts a dismissal with an answer", () => {
    expect(problemReportDecisionProblem({ ...base, status: "DISMISSED" })).toBeNull();
  });

  it("refuses a decision with no answer, and with only whitespace", () => {
    expect(problemReportDecisionProblem({ ...base, resolution: "" })).toBe("resolution-missing");
    expect(problemReportDecisionProblem({ ...base, resolution: "   \n  " })).toBe("resolution-missing");
  });

  it("refuses an answer longer than the column allows", () => {
    const tooLong = "x".repeat(PROBLEM_REPORT_LIMITS.resolution + 1);
    expect(problemReportDecisionProblem({ ...base, resolution: tooLong })).toBe("resolution-too-long");
    // Exactly at the limit is fine: an off-by-one here is a refused submit
    // the author cannot explain.
    expect(problemReportDecisionProblem({ ...base, resolution: "x".repeat(PROBLEM_REPORT_LIMITS.resolution) })).toBeNull();
  });

  it("refuses a hold with no reason", () => {
    expect(problemReportDecisionProblem({ ...base, hold: true, holdReason: null })).toBe("hold-reason-missing");
    expect(problemReportDecisionProblem({ ...base, hold: true, holdReason: "  " })).toBe("hold-reason-missing");
  });

  it("refuses a hold reason longer than the column allows", () => {
    expect(
      problemReportDecisionProblem({ ...base, hold: true, holdReason: "y".repeat(PROBLEM_REPORT_LIMITS.holdReason + 1) }),
    ).toBe("hold-reason-too-long");
  });

  it("refuses a hold on a dismissed report", () => {
    // The combination the database refuses too: a problem is only withheld
    // when somebody agreed there is something wrong with it.
    expect(problemReportDecisionProblem({ ...base, status: "DISMISSED", hold: true, holdReason: "case 3" })).toBe(
      "hold-without-upholding",
    );
  });

  it("has a message for every problem it can return", () => {
    const problems = [
      problemReportDecisionProblem({ ...base, resolution: "" }),
      problemReportDecisionProblem({ ...base, resolution: "x".repeat(PROBLEM_REPORT_LIMITS.resolution + 1) }),
      problemReportDecisionProblem({ ...base, hold: true, holdReason: null }),
      problemReportDecisionProblem({ ...base, hold: true, holdReason: "y".repeat(PROBLEM_REPORT_LIMITS.holdReason + 1) }),
      problemReportDecisionProblem({ ...base, status: "DISMISSED", hold: true, holdReason: "case 3" }),
    ];
    for (const problem of problems) {
      expect(problem).not.toBeNull();
      expect(PROBLEM_REPORT_DECISION_MESSAGE[problem!]).toBeTruthy();
    }
    expect(Object.keys(PROBLEM_REPORT_DECISION_MESSAGE).sort()).toEqual([...new Set(problems as string[])].sort());
  });
});

describe("the sentence an examiner reads", () => {
  it("quotes the reason the hold was given", () => {
    expect(problemHeldMessage("case 3 expects 7")).toContain("case 3 expects 7");
  });

  it("says so rather than trailing off when the reason is empty", () => {
    // Unreachable through the action (the CHECK requires a reason), and the
    // trigger's message uses coalesce, so this is the shape a direct SQL
    // write could produce. "withheld: ." is worse than saying nothing was
    // recorded.
    expect(problemHeldMessage("   ")).toContain("no reason was recorded");
  });
});
