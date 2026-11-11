import { describe, expect, it } from "vitest";
import {
  SELF_CHECK_FIXTURES,
  evaluateFixture,
  summarizeSelfCheck,
  type FixtureObservation,
  type SelfCheckFixture,
} from "../src/selfcheck/fixtures";

const byId = (id: string): SelfCheckFixture => {
  const f = SELF_CHECK_FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`no fixture ${id}`);
  return f;
};

/** A passing observation for each fixture, from its asserted expectation. */
function passingObservation(f: SelfCheckFixture): FixtureObservation {
  if (f.expect.kind === "safe") {
    const obs: FixtureObservation = { verdict: "AC", stdout: "SAFE\n" };
    if (f.requireHostClean) obs.hostResidue = { boxUidProcesses: 0, cgroupPopulated: false };
    return obs;
  }
  const obs: FixtureObservation = { verdict: f.expect.verdict, stdout: "", idle: f.expect.idle ?? false };
  if (f.requireHostClean) obs.hostResidue = { boxUidProcesses: 0, cgroupPopulated: false };
  return obs;
}

describe("the twelve adversarial fixtures", () => {
  it("are exactly twelve, with unique ids and the attacks the suite names", () => {
    expect(SELF_CHECK_FIXTURES).toHaveLength(12);
    const ids = SELF_CHECK_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(12);
    for (const expected of [
      "fork-bomb",
      "output-flood",
      "memory-4gb",
      "fallocate-10gb",
      "network",
      "etc-shadow",
      "ptrace",
      "proc-environ",
      "setuid-root",
      "sleep-3h",
      "io-uring",
      "cross-box",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it("every fixture's own passing observation evaluates to ok", () => {
    for (const fixture of SELF_CHECK_FIXTURES) {
      expect(evaluateFixture(fixture, passingObservation(fixture)), fixture.id).toMatchObject({ ok: true });
    }
  });

  it("maps the right expectation to each fixture", () => {
    expect(byId("fork-bomb").expect).toEqual({ kind: "verdict", verdict: "RE" });
    expect(byId("output-flood").expect).toEqual({ kind: "verdict", verdict: "OLE" });
    expect(byId("memory-4gb").expect).toEqual({ kind: "verdict", verdict: "MLE" });
    expect(byId("sleep-3h").expect).toEqual({ kind: "verdict", verdict: "TLE", idle: true });
    for (const safe of ["fallocate-10gb", "network", "etc-shadow", "ptrace", "proc-environ", "setuid-root", "io-uring", "cross-box"]) {
      expect(byId(safe).expect).toEqual({ kind: "safe" });
    }
  });
});

describe("evaluateFixture", () => {
  it("fails any fixture that prints BREACH, even with the right verdict", () => {
    const r = evaluateFixture(byId("network"), { verdict: "AC", stdout: "BREACH\n" });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/BREACH/);
  });

  it("requires SAFE output and a clean exit for a safe fixture", () => {
    expect(evaluateFixture(byId("etc-shadow"), { verdict: "AC", stdout: "nothing\n" }).ok).toBe(false);
    expect(evaluateFixture(byId("etc-shadow"), { verdict: "RE", stdout: "SAFE\n" }).ok).toBe(false);
    expect(evaluateFixture(byId("etc-shadow"), { verdict: "AC", stdout: "SAFE\n" }).ok).toBe(true);
  });

  it("requires the exact resource verdict for a verdict fixture", () => {
    expect(evaluateFixture(byId("memory-4gb"), { verdict: "RE", stdout: "" }).ok).toBe(false);
    expect(evaluateFixture(byId("memory-4gb"), { verdict: "MLE", stdout: "" }).ok).toBe(true);
    expect(evaluateFixture(byId("output-flood"), { verdict: "TLE", stdout: "" }).ok).toBe(false);
    expect(evaluateFixture(byId("output-flood"), { verdict: "OLE", stdout: "" }).ok).toBe(true);
  });

  it("requires the idle flag for the wall-clock TLE fixture", () => {
    expect(evaluateFixture(byId("sleep-3h"), { verdict: "TLE", stdout: "", idle: false }).ok).toBe(false);
    expect(evaluateFixture(byId("sleep-3h"), { verdict: "TLE", stdout: "", idle: true }).ok).toBe(true);
  });

  it("requires the host to be clean for the fork bomb (no stray box-uid process, cgroup gone)", () => {
    const base: FixtureObservation = { verdict: "RE", stdout: "" };
    expect(evaluateFixture(byId("fork-bomb"), base).ok).toBe(false); // residue not checked
    expect(evaluateFixture(byId("fork-bomb"), { ...base, hostResidue: { boxUidProcesses: 1, cgroupPopulated: false } }).ok).toBe(false);
    expect(evaluateFixture(byId("fork-bomb"), { ...base, hostResidue: { boxUidProcesses: 0, cgroupPopulated: true } }).ok).toBe(false);
    expect(evaluateFixture(byId("fork-bomb"), { ...base, hostResidue: { boxUidProcesses: 0, cgroupPopulated: false } }).ok).toBe(true);
  });
});

describe("summarizeSelfCheck", () => {
  it("is ok only when every fixture passed, and lists each failure", () => {
    const at = "2026-10-10T00:00:00.000Z";
    const allPass = SELF_CHECK_FIXTURES.map((f) => evaluateFixture(f, passingObservation(f)));
    expect(summarizeSelfCheck(allPass, at)).toEqual({ ok: true, at, failures: [] });

    const withFailure = [...allPass];
    withFailure[0] = { id: "fork-bomb", ok: false, reason: "printed BREACH" };
    const summary = summarizeSelfCheck(withFailure, at);
    expect(summary.ok).toBe(false);
    expect(summary.failures).toEqual(["fork-bomb: printed BREACH"]);
  });
});
