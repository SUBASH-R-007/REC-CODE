import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatResponseSchema, JUDGE_LANES, LIMITS, SENSITIVE_LANES } from "@recx/shared";
import {
  allowUnhardenedNodes,
  CALIBRATION_STALE_AFTER_MS,
  calibrationDeviation,
  lanesFor,
  median,
  nextNodeStatus,
  sensitiveLaneEligibility,
  type NodeHealth,
} from "@/lib/judge/lanes";

const NOW = new Date("2026-10-10T06:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** A healthy node: calibrated and self-checked 10 minutes ago, hardened. */
function health(overrides: Partial<NodeHealth> = {}): NodeHealth {
  return {
    calibrationScore: 1000,
    calibratedAt: minutesAgo(10),
    selfCheckOk: true,
    lastSelfCheckAt: minutesAgo(10),
    hostHardened: true,
    ...overrides,
  };
}

function decide(h: NodeHealth, others: (number | null)[] = [], allowUnhardened = false, driver?: string) {
  return sensitiveLaneEligibility({ health: h, otherOnlineScores: others, now: NOW, allowUnhardened, driver });
}

describe("median", () => {
  it("handles odd, even, single and empty lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNull();
  });

  it("does not reorder its input", () => {
    const values = [3, 1, 2];
    median(values);
    expect(values).toEqual([3, 1, 2]);
  });

  it("measures relative deviation", () => {
    expect(calibrationDeviation(1100, 1000)).toBeCloseTo(0.1);
    expect(calibrationDeviation(900, 1000)).toBeCloseTo(0.1);
  });
});

describe("sensitive-lane eligibility", () => {
  it("grants a healthy node that is alone in the fleet (it is its own median)", () => {
    expect(decide(health())).toEqual({ sensitiveLanesOk: true, restrictions: [] });
  });

  it("grants a node within 10 % of the fleet median", () => {
    // fleet = [950, 1000, 1040, 1050] → median 1020; |1050 − 1020| / 1020 ≈ 2.9 %
    expect(decide(health({ calibrationScore: 1050 }), [950, 1000, 1040]).sensitiveLanesOk).toBe(true);
  });

  it("withholds a node more than 10 % off the median (slower or faster)", () => {
    // fleet = [1000, 1000, 1000, 800] → median 1000; 20 % off
    const slow = decide(health({ calibrationScore: 800 }), [1000, 1000, 1000]);
    expect(slow.sensitiveLanesOk).toBe(false);
    expect(slow.restrictions.join(" ")).toMatch(/deviates 20\.0% from the fleet median 1000\.0/);
    const fast = decide(health({ calibrationScore: 1250 }), [1000, 1000, 1000]);
    expect(fast.sensitiveLanesOk).toBe(false);
  });

  it("treats exactly the maximum deviation as acceptable", () => {
    // fleet = [1000, 1000, 1100] → median 1000; exactly 10 %
    const result = decide(health({ calibrationScore: 1100 }), [1000, 1000]);
    expect(calibrationDeviation(1100, 1000)).toBeLessThanOrEqual(LIMITS.calibration.maxDeviation + 1e-12);
    expect(result.sensitiveLanesOk).toBe(true);
  });

  it("includes the node itself in the median and ignores missing scores of others", () => {
    // others [1000, null] → fleet [1000, 1080] → median 1040; 1080 is 3.8 % off
    expect(decide(health({ calibrationScore: 1080 }), [1000, null]).sensitiveLanesOk).toBe(true);
  });

  it("withholds a node with no calibration", () => {
    for (const h of [health({ calibrationScore: null }), health({ calibratedAt: null }), health({ calibrationScore: 0 })]) {
      const result = decide(h);
      expect(result.sensitiveLanesOk).toBe(false);
      expect(result.restrictions[0]).toMatch(/calibration missing/);
    }
  });

  it("withholds a node whose calibration is older than 6.5 h", () => {
    expect(CALIBRATION_STALE_AFTER_MS).toBe(6.5 * 3_600_000);
    expect(decide(health({ calibratedAt: minutesAgo(6.5 * 60 - 1) })).sensitiveLanesOk).toBe(true);
    const stale = decide(health({ calibratedAt: minutesAgo(6.5 * 60 + 1) }));
    expect(stale.sensitiveLanesOk).toBe(false);
    expect(stale.restrictions[0]).toMatch(/calibration is stale/);
  });

  it("withholds a node whose self-check failed, is missing, or is stale", () => {
    expect(decide(health({ selfCheckOk: false })).restrictions).toContain("self-check failed");
    expect(decide(health({ selfCheckOk: null })).restrictions).toContain("self-check not reported yet");
    expect(decide(health({ lastSelfCheckAt: null })).restrictions).toContain("self-check not reported yet");
    const staleMs = LIMITS.selfCheck.staleAfterMs;
    expect(decide(health({ lastSelfCheckAt: new Date(NOW.getTime() - staleMs) })).sensitiveLanesOk).toBe(true);
    const stale = decide(health({ lastSelfCheckAt: new Date(NOW.getTime() - staleMs - 1) }));
    expect(stale.sensitiveLanesOk).toBe(false);
    expect(stale.restrictions[0]).toMatch(/self-check is stale/);
  });

  it("withholds an unhardened or unverified host unless the development override applies", () => {
    expect(decide(health({ hostHardened: false })).restrictions).toEqual(["host hardening check failed"]);
    expect(decide(health({ hostHardened: null })).restrictions).toEqual(["host hardening not verified yet"]);
    expect(decide(health({ hostHardened: false }), [], true).sensitiveLanesOk).toBe(true);
    expect(decide(health({ hostHardened: null }), [], true).sensitiveLanesOk).toBe(true);
  });

  it("reports every reason at once", () => {
    const result = decide(health({ calibrationScore: null, selfCheckOk: false, hostHardened: false }));
    expect(result.restrictions).toHaveLength(3);
  });
});

describe("a SQL node's eligibility (Phase 16n)", () => {
  /**
   * Phase 12k refused a SQL node the sensitive lanes whatever it reported,
   * because nothing could interpret a query score. Phase 16n gave the SQL
   * engine a benchmark (`apps/sql-judge/src/calibration.ts`), so rule (a)
   * applies to it exactly as it applies to an isolate node — and there is no
   * special case left in the module under test. These cases are therefore
   * about the ABSENCE of one: a SQL node is judged by the ordinary rules,
   * and says the ordinary things when it fails them.
   */
  /** A SQL node that has not reported a benchmark. */
  const sqlHealth = () => health({ calibrationScore: null, calibratedAt: null });

  it("is eligible once it reports a calibration, like any other node", () => {
    expect(decide(health(), [], false, "postgres")).toEqual({ sensitiveLanesOk: true, restrictions: [] });
  });

  it("is refused when it reports none, in the ordinary words", () => {
    const decision = decide(sqlHealth(), [], false, "postgres");
    expect(decision.sensitiveLanesOk).toBe(false);
    /**
     * "calibration missing", like any other node -- and the SQL JUDGE by
     * name, because that is the process an operator has to go and look at.
     */
    expect(decision.restrictions).toEqual([
      "calibration missing: the SQL judge has not reported a benchmark for this cluster",
    ]);
    /**
     * And NOT the Phase 12k sentence. There is a benchmark now, so "the SQL
     * engine has no calibration benchmark yet" would send an operator
     * looking for a phase that has already happened instead of at the node
     * that is not reporting.
     */
    expect(decision.restrictions.join(" ")).not.toContain("no calibration benchmark yet");
  });

  it("is refused when its score deviates from the fleet, like any other node", () => {
    // The heartbeat route takes the median over nodes of the SAME ENGINE, so
    // these are other SQL nodes' scores in query units.
    const decision = decide(health({ calibrationScore: 500_000 }), [1_200_000, 1_250_000], false, "postgres");
    expect(decision.sensitiveLanesOk).toBe(false);
    expect(decision.restrictions[0]).toMatch(/deviates/);
  });

  it("is refused when its calibration went stale, like any other node", () => {
    const stale = new Date(NOW.getTime() - CALIBRATION_STALE_AFTER_MS - 1);
    expect(decide(health({ calibratedAt: stale }), [], false, "postgres").restrictions[0]).toMatch(
      /calibration is stale/,
    );
  });

  it("still reports its self-check and its cluster hardening", () => {
    const failed = decide(
      health({ calibrationScore: null, calibratedAt: null, selfCheckOk: false, hostHardened: false }),
      [],
      false,
      "postgres",
    );
    expect(failed.restrictions.join(" ")).toContain("self-check failed");
    expect(failed.restrictions.join(" ")).toContain("host hardening check failed");
  });

  it("changes nothing for an isolate node", () => {
    expect(decide(health(), [1000], false, "isolate").sensitiveLanesOk).toBe(true);
    expect(decide(health(), [1000]).sensitiveLanesOk).toBe(true);
  });
});

describe("lanes for a node", () => {
  const ok = { sensitiveLanesOk: true, restrictions: [] };
  const withheld = { sensitiveLanesOk: false, restrictions: ["self-check failed"] };

  it("gives an eligible ONLINE node all five lanes", () => {
    expect(lanesFor("ONLINE", ok)).toEqual([...JUDGE_LANES]);
  });

  it("withholds exactly the sensitive lanes", () => {
    const lanes = lanesFor("ONLINE", withheld);
    expect(lanes).toEqual(JUDGE_LANES.filter((l) => !SENSITIVE_LANES.includes(l)));
    expect(lanes).not.toContain("ASSESSMENT");
    expect(lanes).not.toContain("CONTEST");
    expect(lanes).toContain("RUN");
  });

  it("gives a node that is not ONLINE no lane at all", () => {
    for (const status of ["DRAINING", "OFFLINE", "QUARANTINED"] as const) {
      expect(lanesFor(status, ok)).toEqual([]);
    }
  });

  it("produces a valid heartbeat response", () => {
    const parsed = heartbeatResponseSchema.safeParse({
      status: "ONLINE",
      serverTime: NOW.toISOString(),
      lanes: lanesFor("ONLINE", withheld),
      laneRestrictions: withheld.restrictions,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("node status after a heartbeat", () => {
  const ok = { ok: true, at: NOW.toISOString(), failures: [] };
  const failed = { ok: false, at: NOW.toISOString(), failures: ["network reachable from the box"] };
  const hardened = { ok: true, failures: [] };
  const unhardened = { ok: false, failures: ["kernel.unprivileged_userns_clone = 1 (expected 0)"] };

  it("brings an OFFLINE node back ONLINE", () => {
    expect(nextNodeStatus("OFFLINE", { selfCheck: null, hostHardening: null }, false).status).toBe("ONLINE");
    expect(nextNodeStatus("OFFLINE", { selfCheck: ok, hostHardening: hardened }, false).status).toBe("ONLINE");
  });

  it("quarantines on a failed self-check from any state", () => {
    for (const s of ["ONLINE", "OFFLINE", "DRAINING"] as const) {
      expect(nextNodeStatus(s, { selfCheck: failed, hostHardening: hardened }, false)).toEqual({
        status: "QUARANTINED",
        quarantineReason: "self-check failed",
      });
    }
    // Already quarantined: no new reason to audit.
    expect(nextNodeStatus("QUARANTINED", { selfCheck: failed, hostHardening: null }, false)).toEqual({
      status: "QUARANTINED",
      quarantineReason: null,
    });
  });

  it("quarantines a failed hardening check unless the development override applies", () => {
    expect(nextNodeStatus("OFFLINE", { selfCheck: ok, hostHardening: unhardened }, false)).toEqual({
      status: "QUARANTINED",
      quarantineReason: "host hardening check failed",
    });
    expect(nextNodeStatus("OFFLINE", { selfCheck: ok, hostHardening: unhardened }, true).status).toBe("ONLINE");
  });

  it("never lifts admin-set DRAINING or QUARANTINED", () => {
    expect(nextNodeStatus("DRAINING", { selfCheck: ok, hostHardening: hardened }, false).status).toBe("DRAINING");
    expect(nextNodeStatus("QUARANTINED", { selfCheck: ok, hostHardening: hardened }, false).status).toBe("QUARANTINED");
    expect(nextNodeStatus("ONLINE", { selfCheck: null, hostHardening: null }, false).status).toBe("ONLINE");
  });
});

describe("JUDGE_ALLOW_UNHARDENED_NODES", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is off unless set to exactly 'true'", () => {
    expect(allowUnhardenedNodes({ NODE_ENV: "development" })).toBe(false);
    expect(allowUnhardenedNodes({ NODE_ENV: "development", JUDGE_ALLOW_UNHARDENED_NODES: "1" })).toBe(false);
    expect(allowUnhardenedNodes({ NODE_ENV: "development", JUDGE_ALLOW_UNHARDENED_NODES: "true" })).toBe(true);
    expect(allowUnhardenedNodes({ NODE_ENV: "test", JUDGE_ALLOW_UNHARDENED_NODES: "true" })).toBe(true);
  });

  it("is refused (ignored, and logged) in production", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(allowUnhardenedNodes({ NODE_ENV: "production", JUDGE_ALLOW_UNHARDENED_NODES: "true" })).toBe(false);
    expect(allowUnhardenedNodes({ NODE_ENV: "production", JUDGE_ALLOW_UNHARDENED_NODES: "true" })).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/refused in production/);
  });

  it("does not make an unhardened production node eligible", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const allow = allowUnhardenedNodes({ NODE_ENV: "production", JUDGE_ALLOW_UNHARDENED_NODES: "true" });
    expect(decide(health({ hostHardened: false }), [], allow).sensitiveLanesOk).toBe(false);
    expect(nextNodeStatus("OFFLINE", { selfCheck: null, hostHardening: { ok: false, failures: [] } }, allow).status).toBe(
      "QUARANTINED",
    );
  });
});
