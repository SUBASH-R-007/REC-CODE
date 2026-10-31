import { describe, expect, it } from "vitest";
import { JUDGE_LANES, LANE_ALLOCATION, type JudgeLane } from "@recx/shared";
import {
  laneBudget,
  pickLane,
  runReservedSlots,
  servedLanes,
  type AllocatorPolicyState,
  type LaneBusy,
} from "../src/allocator";

const zero = (): Record<JudgeLane, number> => ({ ASSESSMENT: 0, CONTEST: 0, RUN: 0, PRACTICE: 0, REJUDGE: 0 });
const sum = (busy: LaneBusy) => JUDGE_LANES.reduce((t, l) => t + busy[l], 0);

function state(partial: Partial<AllocatorPolicyState> & Pick<AllocatorPolicyState, "slots" | "allowedLanes">): AllocatorPolicyState {
  return {
    busy: zero(),
    waiting: zero(),
    lastActiveAt: zero(),
    assessmentDepth: 0,
    now: 1_000_000,
    ...partial,
  };
}

/** Pull repeatedly from an empty node with the given lanes all saturated with work. */
function fillFromEmpty(
  slots: number,
  allowedLanes: readonly JudgeLane[],
  waitingLanes: readonly JudgeLane[],
  assessmentDepth = 10,
): { busy: Record<JudgeLane, number>; invariantsHeld: boolean } {
  const busy = zero();
  const waiting = zero();
  for (const lane of waitingLanes) waiting[lane] = 999;
  const runReserved = runReservedSlots(slots, allowedLanes.includes("RUN"), allowedLanes.some((l) => l !== "RUN"));
  let invariantsHeld = true;
  for (;;) {
    const lane = pickLane(state({ slots, allowedLanes, busy, waiting, assessmentDepth }));
    if (lane === null) break;
    busy[lane] += 1;
    // RUN always has its reserved slots available: non-run busy never passes slots - runReserved.
    if (sum(busy) - busy.RUN > slots - runReserved) invariantsHeld = false;
    if (sum(busy) > slots) invariantsHeld = false;
  }
  return { busy, invariantsHeld };
}

describe("runReservedSlots", () => {
  it("reserves 2 on a node with ≥ 3 slots, 1 on a smaller one, 0 when RUN is not served", () => {
    expect(runReservedSlots(10, true, true)).toBe(2);
    expect(runReservedSlots(3, true, true)).toBe(2);
    expect(runReservedSlots(2, true, true)).toBe(1);
    expect(runReservedSlots(1, true, true)).toBe(0); // 1-slot dev node: leaves the slot for the other lane
    expect(runReservedSlots(1, true, false)).toBe(1); // run-only 1-slot node
    expect(runReservedSlots(10, false, true)).toBe(0);
  });
});

describe("laneBudget", () => {
  it("caps each lane by its share and floors practice at 25 %", () => {
    const b = laneBudget(10, [...JUDGE_LANES], 0);
    expect(b.cap.ASSESSMENT).toBe(6); // 60 %
    expect(b.cap.CONTEST).toBe(5); // 50 %
    expect(b.cap.REJUDGE).toBe(2); // 20 %
    expect(b.runReserved).toBe(2);
    expect(b.practiceFloor).toBe(3); // ceil(2.5)
    expect(b.cap.RUN).toBe(10);
    expect(b.cap.PRACTICE).toBe(10);
  });

  it("drops the rejudge cap to 0 while the assessment backlog exceeds the threshold", () => {
    const above = LANE_ALLOCATION.REJUDGE.pauseWhenAssessmentDepthAbove + 1;
    expect(laneBudget(10, [...JUDGE_LANES], above).cap.REJUDGE).toBe(0);
    expect(laneBudget(10, [...JUDGE_LANES], LANE_ALLOCATION.REJUDGE.pauseWhenAssessmentDepthAbove).cap.REJUDGE).toBe(2);
  });

  it("lifts the cap for a single-purpose node so it is never throttled into wasting capacity", () => {
    expect(laneBudget(10, ["REJUDGE"], 0).cap.REJUDGE).toBe(10);
    expect(laneBudget(8, ["ASSESSMENT"], 0).cap.ASSESSMENT).toBe(8);
  });
});

describe("pickLane — basics", () => {
  it("returns null when there is no free slot", () => {
    expect(pickLane(state({ slots: 2, allowedLanes: ["PRACTICE"], busy: { ...zero(), PRACTICE: 2 }, waiting: { ...zero(), PRACTICE: 5 } }))).toBeNull();
  });

  it("returns null when no allowed lane has waiting work", () => {
    expect(pickLane(state({ slots: 4, allowedLanes: ["PRACTICE", "RUN"], waiting: zero() }))).toBeNull();
  });

  it("never pulls a lane the heartbeat did not allow (ASSESSMENT/CONTEST withheld)", () => {
    const s = state({
      slots: 4,
      allowedLanes: ["RUN", "PRACTICE"],
      waiting: { ...zero(), ASSESSMENT: 9, CONTEST: 9, RUN: 9, PRACTICE: 9, REJUDGE: 9 },
    });
    const pulled = new Set<JudgeLane>();
    const busy = zero();
    for (;;) {
      const lane = pickLane({ ...s, busy });
      if (!lane) break;
      pulled.add(lane);
      busy[lane] += 1;
    }
    expect(pulled.has("ASSESSMENT")).toBe(false);
    expect(pulled.has("CONTEST")).toBe(false);
    expect(pulled.has("REJUDGE")).toBe(false);
  });

  it("honours LANE_PRIORITY among eligible lanes above the practice floor", () => {
    // Practice already at its floor on a 10-slot node (floor 3); highest priority wins.
    const s = state({
      slots: 10,
      allowedLanes: [...JUDGE_LANES],
      busy: { ...zero(), PRACTICE: 3 },
      waiting: { ASSESSMENT: 9, CONTEST: 9, RUN: 9, PRACTICE: 9, REJUDGE: 9 },
      assessmentDepth: 5,
    });
    expect(pickLane(s)).toBe("ASSESSMENT");
  });
});

describe("pickLane — guarantees under a saturating mix", () => {
  it("RUN always has 2 slots available and practice reaches its 25 % floor (10 slots, all lanes)", () => {
    const { busy, invariantsHeld } = fillFromEmpty(10, [...JUDGE_LANES], [...JUDGE_LANES]);
    expect(invariantsHeld).toBe(true);
    expect(sum(busy)).toBe(10);
    expect(busy.PRACTICE).toBeGreaterThanOrEqual(3); // ≥ 25 %
    expect(busy.RUN).toBe(2); // its reservation
    expect(busy.ASSESSMENT).toBeLessThanOrEqual(6); // ≤ 60 %
    expect(busy.CONTEST).toBeLessThanOrEqual(5); // ≤ 50 %
    expect(busy.REJUDGE).toBeLessThanOrEqual(2); // ≤ 20 %
  });

  it("practice is never starved below 25 % whenever it has waiting jobs, across node sizes", () => {
    for (const slots of [4, 5, 8, 10, 16, 20]) {
      const { busy, invariantsHeld } = fillFromEmpty(slots, [...JUDGE_LANES], [...JUDGE_LANES]);
      expect(invariantsHeld, `invariants at ${slots} slots`).toBe(true);
      expect(busy.PRACTICE, `practice floor at ${slots} slots`).toBeGreaterThanOrEqual(Math.ceil(0.25 * slots));
    }
  });

  it("REJUDGE drops to 0 while the assessment queue depth exceeds 50 (even with no assessment competing)", () => {
    const paused = fillFromEmpty(10, ["REJUDGE", "PRACTICE", "RUN"], ["REJUDGE"], 51);
    expect(paused.busy.REJUDGE).toBe(0);
    // Below the threshold the same node does run rejudges (nothing higher-priority has work).
    const active = fillFromEmpty(10, ["REJUDGE", "PRACTICE", "RUN"], ["REJUDGE"], 0);
    expect(active.busy.REJUDGE).toBeGreaterThan(0);
    expect(active.busy.REJUDGE).toBeLessThanOrEqual(2); // ≤ 20 %
  });

  it("REJUDGE never exceeds 20 % of slots under a sustained all-lane mix", () => {
    const { busy } = fillFromEmpty(20, [...JUDGE_LANES], [...JUDGE_LANES]);
    expect(busy.REJUDGE).toBeLessThanOrEqual(Math.floor(0.2 * 20));
  });

  it("ASSESSMENT stays at or below 60 % even when it is the only high-priority lane with work", () => {
    const { busy, invariantsHeld } = fillFromEmpty(10, [...JUDGE_LANES], ["ASSESSMENT"]);
    expect(invariantsHeld).toBe(true);
    expect(busy.ASSESSMENT).toBeLessThanOrEqual(6);
    // The rest of the node stays free for RUN's reservation; nothing else had work.
    expect(sum(busy) - busy.ASSESSMENT).toBe(0);
  });

  it("gives CONTEST its share when assessment has drained and RUN is not flooding", () => {
    const { busy } = fillFromEmpty(10, [...JUDGE_LANES], ["CONTEST", "PRACTICE", "REJUDGE"]);
    expect(busy.CONTEST).toBeGreaterThan(0);
    expect(busy.CONTEST).toBeLessThanOrEqual(5);
    expect(busy.PRACTICE).toBeGreaterThanOrEqual(3);
    // RUN has no work here, so its reserved slots stay free rather than going to a lower lane.
    expect(sum(busy)).toBe(10 - 2);
  });
});

describe("pickLane — practice floor reservation protects practice", () => {
  it("pulls practice into a slot reserved for it even under higher-priority pressure", () => {
    // 10 slots, run at its 2, assessment filling the rest; practice has work but is at 0.
    // The reservation keeps a slot free for practice, and the policy fills it with practice.
    const s = state({
      slots: 10,
      allowedLanes: [...JUDGE_LANES],
      busy: { ...zero(), RUN: 2, ASSESSMENT: 5 },
      waiting: { ASSESSMENT: 9, CONTEST: 9, RUN: 9, PRACTICE: 9, REJUDGE: 9 },
      assessmentDepth: 5,
    });
    // nonRunBusy = 7, slots-runReserved = 8 → one non-run slot left; practice is below its floor → it wins it.
    expect(pickLane(s)).toBe("PRACTICE");
  });

  it("releases the practice floor after 2 s idle so an idle lane does not waste capacity", () => {
    // RUN (uncapped) competes; practice has NO waiting jobs but was recently active.
    // 10 slots, RUN at 7; practice floor is 3. nonPractice = 7, slots - floor = 7 → the
    // reservation holds the last 3 slots for practice until it goes idle.
    const base = {
      slots: 10,
      allowedLanes: ["RUN", "PRACTICE"] as JudgeLane[],
      busy: { ...zero(), RUN: 7 },
      waiting: { ...zero(), RUN: 9, PRACTICE: 0 },
    };
    // Active 1 s ago (inside the 2 s window): the floor is still reserved, so RUN is held off.
    const recent = pickLane(state({ ...base, lastActiveAt: { ...zero(), PRACTICE: 1_000_000 - 1_000 }, now: 1_000_000 }));
    expect(recent).toBeNull();
    // Idle past the window: the reservation releases and RUN takes the slot.
    const stale = pickLane(state({ ...base, lastActiveAt: { ...zero(), PRACTICE: 1_000_000 - LANE_ALLOCATION.softReservationIdleMs - 1 }, now: 1_000_000 }));
    expect(stale).toBe("RUN");
  });
});

describe("servedLanes", () => {
  it("maps RECX_QUEUES names to lanes", () => {
    expect(servedLanes(["judge-practice", "judge-run"])).toEqual(["RUN", "PRACTICE"]);
    expect(servedLanes(["judge-assessment", "judge-contest", "judge-rejudge"])).toEqual(["ASSESSMENT", "CONTEST", "REJUDGE"]);
    expect(servedLanes(["not-a-queue"])).toEqual([]);
  });
});
