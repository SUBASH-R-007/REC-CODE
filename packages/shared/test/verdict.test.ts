import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_VERDICTS,
  isVerdict,
  Verdict,
  VERDICT_CODE,
  VERDICT_LABEL,
  VERDICT_PRECEDENCE,
  VERDICTS,
  worstVerdict,
} from "../src/verdict";

describe("worstVerdict", () => {
  it.each([
    [["AC", "AC"], "AC"],
    [["AC", "WA"], "WA"],
    [["WA", "TLE"], "TLE"],
    [["TLE", "OLE"], "OLE"],
    [["OLE", "MLE"], "MLE"],
    [["MLE", "RE"], "RE"],
    [["RE", "CE"], "CE"],
    [["CE", "IE"], "IE"],
    [["AC", "SKIPPED"], "SKIPPED"],
    [["SKIPPED", "PARTIAL"], "PARTIAL"],
    [["PARTIAL", "WA"], "WA"],
    [["AC", "WA", "TLE", "RE", "AC"], "RE"],
    [["AC", "AC", "AC", "IE"], "IE"],
  ] as Array<[Verdict[], Verdict]>)("worstVerdict(%j) = %s", (verdicts, expected) => {
    expect(worstVerdict(verdicts)).toBe(expected);
    expect(worstVerdict([...verdicts].reverse())).toBe(expected);
  });

  it("follows VERDICT_PRECEDENCE for every pair", () => {
    VERDICT_PRECEDENCE.forEach((worse, i) => {
      for (const better of VERDICT_PRECEDENCE.slice(i + 1)) {
        expect(worstVerdict([better, worse])).toBe(worse);
      }
    });
  });

  it("ranks IE first and AC last", () => {
    expect(VERDICT_PRECEDENCE[0]).toBe("IE");
    expect(VERDICT_PRECEDENCE[VERDICT_PRECEDENCE.length - 1]).toBe("AC");
  });
});

describe("verdict vocabulary", () => {
  it("VERDICT_PRECEDENCE is a permutation of VERDICTS", () => {
    expect([...VERDICT_PRECEDENCE].sort()).toEqual([...VERDICTS].sort());
  });

  it("every verdict and pending state has a label and a code", () => {
    for (const v of [...VERDICTS, "QUEUED", "RUNNING"] as const) {
      expect(VERDICT_LABEL[v].length).toBeGreaterThan(0);
      expect(VERDICT_CODE[v].length).toBeGreaterThan(0);
    }
    for (const v of VERDICTS) expect(VERDICT_CODE[v]).toBe(v);
    expect(Object.keys(VERDICT_LABEL).sort()).toEqual([...VERDICTS, "QUEUED", "RUNNING"].sort());
  });

  it("has no separate presentation-error verdict", () => {
    expect(isVerdict("PE")).toBe(false);
  });

  it("isVerdict accepts exactly the vocabulary", () => {
    for (const v of VERDICTS) expect(isVerdict(v)).toBe(true);
    for (const v of ["QUEUED", "RUNNING", "ac", "", null, 1]) expect(isVerdict(v)).toBe(false);
  });

  it("the Verdict object maps each code to itself and is frozen", () => {
    for (const v of VERDICTS) expect(Verdict[v]).toBe(v);
    expect(Object.isFrozen(Verdict)).toBe(true);
  });

  it("every verdict except IE is deterministic (never retried)", () => {
    expect([...DETERMINISTIC_VERDICTS].sort()).toEqual(VERDICTS.filter((v) => v !== "IE").sort());
  });
});
