import { describe, expect, it } from "vitest";
import {
  applyJudgedSubmission,
  isRejectedAttempt,
  type AttemptState,
  type JudgedContestSubmission,
} from "../src/contest-attempt";
import { ICPC_PENALTY_MINUTES } from "../src/contest-scoring";
import { VERDICTS, type Verdict } from "../src/verdict";

const unsolved = (wrongAttempts = 0, points = 0): AttemptState => ({
  wrongAttempts,
  points,
  solvedAtMinutes: null,
});
const solved = (at = 10, wrongAttempts = 0, points = 0): AttemptState => ({
  wrongAttempts,
  points,
  solvedAtMinutes: at,
});
const judged = (partial: Partial<JudgedContestSubmission> = {}): JudgedContestSubmission => ({
  verdict: "AC",
  minutesFromStart: 30,
  score: 0,
  submissionId: "sub-1",
  ...partial,
});

describe("isRejectedAttempt", () => {
  it("AC is not a rejection", () => {
    expect(isRejectedAttempt("AC")).toBe(false);
  });

  it("IE is never a rejection — an internal error is our failure", () => {
    expect(isRejectedAttempt("IE")).toBe(false);
  });

  it("SKIPPED is not a whole-submission rejection", () => {
    expect(isRejectedAttempt("SKIPPED")).toBe(false);
  });

  it.each(["WA", "TLE", "MLE", "RE", "CE", "OLE", "PARTIAL"] as const)("%s is a rejection", (verdict) => {
    expect(isRejectedAttempt(verdict)).toBe(true);
  });

  it("classifies every verdict the platform has (no verdict is forgotten)", () => {
    for (const verdict of VERDICTS) {
      expect(typeof isRejectedAttempt(verdict as Verdict)).toBe("boolean");
    }
    const rejections = VERDICTS.filter((v) => isRejectedAttempt(v as Verdict));
    expect(rejections).toHaveLength(VERDICTS.length - 3);
  });
});

describe("ICPC", () => {
  it("the first accepted submission solves it, with no prior rejections", () => {
    const change = applyJudgedSubmission("ICPC", unsolved(), judged({ minutesFromStart: 42 }));
    expect(change).toEqual({
      wrongAttemptsDelta: 0,
      solve: { solvedAtMinutes: 42, penaltyMinutes: 42, bestSubmissionId: "sub-1" },
    });
  });

  it("penalty is the solve minute plus 20 per earlier rejection", () => {
    const change = applyJudgedSubmission("ICPC", unsolved(3), judged({ minutesFromStart: 15 }));
    expect(change.solve?.penaltyMinutes).toBe(15 + 3 * ICPC_PENALTY_MINUTES);
  });

  it("a solve at minute 0 with no rejections carries no penalty", () => {
    const change = applyJudgedSubmission("ICPC", unsolved(), judged({ minutesFromStart: 0 }));
    expect(change.solve?.penaltyMinutes).toBe(0);
  });

  it("a rejection on an unsolved problem counts one attempt and no solve", () => {
    const change = applyJudgedSubmission("ICPC", unsolved(1), judged({ verdict: "WA" }));
    expect(change).toEqual({ wrongAttemptsDelta: 1 });
  });

  it("an internal error costs nothing at all", () => {
    expect(applyJudgedSubmission("ICPC", unsolved(2), judged({ verdict: "IE" }))).toEqual({
      wrongAttemptsDelta: 0,
    });
  });

  it("a compile error counts as a rejected submission", () => {
    expect(applyJudgedSubmission("ICPC", unsolved(), judged({ verdict: "CE" })).wrongAttemptsDelta).toBe(1);
  });

  it("a second accepted submission cannot re-solve or re-penalise", () => {
    const change = applyJudgedSubmission("ICPC", solved(10), judged({ minutesFromStart: 90 }));
    expect(change).toEqual({ wrongAttemptsDelta: 0 });
    expect(change.solve).toBeUndefined();
  });

  it("a rejection AFTER the solve is not penalised (the solve is final)", () => {
    const change = applyJudgedSubmission("ICPC", solved(10, 1), judged({ verdict: "WA", minutesFromStart: 95 }));
    expect(change).toEqual({ wrongAttemptsDelta: 0 });
  });

  it("ignores the judge's score entirely", () => {
    const change = applyJudgedSubmission("ICPC", unsolved(), judged({ score: 55 }));
    expect(change.points).toBeUndefined();
  });

  it("the documented sequence: WA, WA, AC at minute 50 → penalty 90", () => {
    let state = unsolved();
    for (const verdict of ["WA", "WA"] as const) {
      const change = applyJudgedSubmission("ICPC", state, judged({ verdict }));
      state = { ...state, wrongAttempts: state.wrongAttempts + change.wrongAttemptsDelta };
    }
    expect(state.wrongAttempts).toBe(2);
    const final = applyJudgedSubmission("ICPC", state, judged({ minutesFromStart: 50 }));
    expect(final.solve?.penaltyMinutes).toBe(50 + 2 * ICPC_PENALTY_MINUTES);
  });
});

describe("SUBTASK", () => {
  it("a better score replaces the best, and names its submission", () => {
    const change = applyJudgedSubmission(
      "SUBTASK",
      unsolved(0, 40),
      judged({ verdict: "PARTIAL", score: 70, submissionId: "sub-9" }),
    );
    expect(change.points).toBe(70);
    expect(change.bestSubmissionId).toBe("sub-9");
  });

  it("a worse score leaves the best alone", () => {
    const change = applyJudgedSubmission("SUBTASK", unsolved(0, 70), judged({ verdict: "PARTIAL", score: 30 }));
    expect(change.points).toBeUndefined();
    expect(change.bestSubmissionId).toBeUndefined();
  });

  it("an equal score does not churn the row", () => {
    const change = applyJudgedSubmission("SUBTASK", unsolved(0, 70), judged({ verdict: "PARTIAL", score: 70 }));
    expect(change.points).toBeUndefined();
  });

  it("an accepted submission marks the solve and carries no penalty", () => {
    const change = applyJudgedSubmission(
      "SUBTASK",
      unsolved(0, 50),
      judged({ verdict: "AC", score: 100, minutesFromStart: 25 }),
    );
    expect(change.points).toBe(100);
    expect(change.solve).toEqual({ solvedAtMinutes: 25, penaltyMinutes: 0, bestSubmissionId: "sub-1" });
  });

  it("still counts rejected attempts, for the attempt record", () => {
    expect(applyJudgedSubmission("SUBTASK", unsolved(), judged({ verdict: "WA" })).wrongAttemptsDelta).toBe(1);
  });

  it("a partial score after a solve can still raise the best", () => {
    const change = applyJudgedSubmission(
      "SUBTASK",
      solved(20, 0, 60),
      judged({ verdict: "PARTIAL", score: 80, submissionId: "sub-later" }),
    );
    expect(change.points).toBe(80);
    expect(change.bestSubmissionId).toBe("sub-later");
    expect(change.solve, "the solve itself is final").toBeUndefined();
  });

  it("an internal error never changes the score", () => {
    expect(applyJudgedSubmission("SUBTASK", unsolved(0, 10), judged({ verdict: "IE", score: 99 }))).toEqual({
      wrongAttemptsDelta: 0,
    });
  });
});
