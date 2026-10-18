import { describe, expect, it } from "vitest";
import {
  canFreeze,
  compareStandings,
  contestDurationMinutes,
  freezeStartsAt,
  ICPC_PENALTY_MINUTES,
  isFrozen,
  minutesFromStart,
  rankStandings,
  scoreParticipant,
  standingsTieKey,
  virtualWindow,
  type AttemptRecord,
  type ContestWindow,
  type ScoredParticipant,
} from "../src/contest-scoring";

const at = (iso: string) => new Date(iso);

function window_(startsAt: string, endsAt: string, freezeMinutes = 30): ContestWindow {
  return { startsAt: at(startsAt), endsAt: at(endsAt), freezeMinutes };
}

function attempt(partial: Partial<AttemptRecord> & { contestProblemId: string }): AttemptRecord {
  return { wrongAttempts: 0, solvedAtMinutes: null, points: 0, ...partial };
}

describe("ICPC scoring", () => {
  it("counts one point per solved problem", () => {
    const r = scoreParticipant(
      "u1",
      [
        attempt({ contestProblemId: "A", solvedAtMinutes: 10 }),
        attempt({ contestProblemId: "B", solvedAtMinutes: 40 }),
        attempt({ contestProblemId: "C" }),
      ],
      "ICPC",
    );
    expect(r.score).toBe(2);
    expect(r.solved).toBe(2);
  });

  it("penalty is solve time plus 20 per rejected attempt before the solve", () => {
    const r = scoreParticipant(
      "u1",
      [attempt({ contestProblemId: "A", solvedAtMinutes: 15, wrongAttempts: 2 })],
      "ICPC",
    );
    expect(r.penalty).toBe(15 + 2 * ICPC_PENALTY_MINUTES);
  });

  it("a rejected submission on a problem never solved costs nothing", () => {
    const r = scoreParticipant(
      "u1",
      [
        attempt({ contestProblemId: "A", solvedAtMinutes: 20 }),
        attempt({ contestProblemId: "B", wrongAttempts: 9 }),
      ],
      "ICPC",
    );
    expect(r.score).toBe(1);
    expect(r.penalty).toBe(20);
  });

  it("solving at minute 0 with no wrong attempts costs no penalty", () => {
    const r = scoreParticipant("u1", [attempt({ contestProblemId: "A", solvedAtMinutes: 0 })], "ICPC");
    expect(r.penalty).toBe(0);
  });

  it("tracks the last accepted time, not the first", () => {
    const r = scoreParticipant(
      "u1",
      [
        attempt({ contestProblemId: "A", solvedAtMinutes: 55 }),
        attempt({ contestProblemId: "B", solvedAtMinutes: 12 }),
      ],
      "ICPC",
    );
    expect(r.lastAcceptedMinutes).toBe(55);
  });

  it("is null for a participant who solved nothing", () => {
    const r = scoreParticipant("u1", [attempt({ contestProblemId: "A", wrongAttempts: 3 })], "ICPC");
    expect(r).toMatchObject({ score: 0, penalty: 0, solved: 0, lastAcceptedMinutes: null });
  });

  it("ignores problem points entirely", () => {
    const r = scoreParticipant(
      "u1",
      [attempt({ contestProblemId: "A", solvedAtMinutes: 5, points: 100 })],
      "ICPC",
    );
    expect(r.score).toBe(1);
  });
});

describe("SUBTASK scoring", () => {
  it("sums the points the judge awarded, partial credit included", () => {
    const r = scoreParticipant(
      "u1",
      [
        attempt({ contestProblemId: "A", solvedAtMinutes: 10, points: 100 }),
        attempt({ contestProblemId: "B", points: 35 }),
        attempt({ contestProblemId: "C", points: 0, wrongAttempts: 4 }),
      ],
      "SUBTASK",
    );
    expect(r.score).toBe(135);
  });

  it("carries no penalty", () => {
    const r = scoreParticipant(
      "u1",
      [attempt({ contestProblemId: "A", solvedAtMinutes: 50, wrongAttempts: 5, points: 60 })],
      "SUBTASK",
    );
    expect(r.penalty).toBe(0);
  });

  it("still reports solved count and last accepted time", () => {
    const r = scoreParticipant(
      "u1",
      [attempt({ contestProblemId: "A", solvedAtMinutes: 30, points: 100 })],
      "SUBTASK",
    );
    expect(r.solved).toBe(1);
    expect(r.lastAcceptedMinutes).toBe(30);
  });
});

describe("the standings order", () => {
  const row = (userId: string, score: number, penalty: number, last: number | null): ScoredParticipant => ({
    userId,
    score,
    penalty,
    lastAcceptedMinutes: last,
    solved: score,
  });

  it("ICPC: score desc, then penalty asc, then earlier last-accepted", () => {
    const field = [
      row("c", 2, 100, 80),
      row("a", 3, 200, 90),
      row("b", 2, 40, 70),
      row("d", 2, 40, 50),
    ];
    expect(rankStandings(field, "ICPC").map((r) => r.userId)).toEqual(["a", "d", "b", "c"]);
  });

  it("SUBTASK: score desc, then earlier last-accepted; penalty is ignored", () => {
    const field = [row("a", 100, 999, 80), row("b", 100, 0, 40), row("c", 150, 999, 95)];
    expect(rankStandings(field, "SUBTASK").map((r) => r.userId)).toEqual(["c", "b", "a"]);
  });

  it("a participant who solved nothing sorts last", () => {
    const field = [row("a", 0, 0, null), row("b", 1, 10, 10)];
    expect(rankStandings(field, "ICPC").map((r) => r.userId)).toEqual(["b", "a"]);
  });

  it("gives tied participants the same rank (1, 2, 2, 4)", () => {
    const field = [row("a", 3, 10, 10), row("b", 2, 20, 20), row("c", 2, 20, 20), row("d", 1, 30, 30)];
    expect(rankStandings(field, "ICPC").map((r) => r.rank)).toEqual([1, 2, 2, 4]);
  });

  it("is total and stable: the id breaks a complete tie, both directions", () => {
    const a = row("a", 2, 20, 20);
    const b = row("b", 2, 20, 20);
    expect(compareStandings(a, b, "ICPC")).toBeLessThan(0);
    expect(compareStandings(b, a, "ICPC")).toBeGreaterThan(0);
    expect(compareStandings(a, a, "ICPC")).toBe(0);
  });

  it("the tie key ignores the id, so an id-only difference still shares a rank", () => {
    const a = row("a", 2, 20, 20);
    const b = row("b", 2, 20, 20);
    expect(standingsTieKey(a, "ICPC")).toBe(standingsTieKey(b, "ICPC"));
    expect(rankStandings([a, b], "ICPC").map((r) => r.rank)).toEqual([1, 1]);
  });

  it("the SUBTASK tie key ignores penalty", () => {
    expect(standingsTieKey(row("a", 100, 5, 10), "SUBTASK")).toBe(standingsTieKey(row("b", 100, 900, 10), "SUBTASK"));
  });

  it("reorders the input without mutating it", () => {
    const field = [row("z", 1, 10, 10), row("a", 9, 10, 10)];
    const before = field.map((r) => r.userId);
    rankStandings(field, "ICPC");
    expect(field.map((r) => r.userId)).toEqual(before);
  });

  it("is idempotent — ranking a ranked field changes nothing", () => {
    const field = [row("a", 3, 10, 10), row("b", 2, 20, 20), row("c", 2, 20, 20)];
    const once = rankStandings(field, "ICPC");
    expect(rankStandings(once, "ICPC")).toEqual(once);
  });

  it("an empty field ranks to nothing", () => {
    expect(rankStandings([], "ICPC")).toEqual([]);
  });
});

describe("freeze", () => {
  it("engages for the final 30 minutes of a two-hour contest", () => {
    const w = window_("2026-11-01T10:00:00Z", "2026-11-01T12:00:00Z", 30);
    expect(contestDurationMinutes(w)).toBe(120);
    expect(canFreeze(w)).toBe(true);
    expect(freezeStartsAt(w)?.toISOString()).toBe("2026-11-01T11:30:00.000Z");
    expect(isFrozen(w, at("2026-11-01T11:29:59Z"))).toBe(false);
    expect(isFrozen(w, at("2026-11-01T11:30:00Z"))).toBe(true);
    expect(isFrozen(w, at("2026-11-01T11:59:59Z"))).toBe(true);
  });

  it("lifts the moment the contest ends", () => {
    const w = window_("2026-11-01T10:00:00Z", "2026-11-01T12:00:00Z", 30);
    expect(isFrozen(w, at("2026-11-01T12:00:00Z"))).toBe(false);
    expect(isFrozen(w, at("2026-11-01T13:00:00Z"))).toBe(false);
  });

  it("is not frozen before the contest starts", () => {
    const w = window_("2026-11-01T10:00:00Z", "2026-11-01T12:00:00Z", 30);
    expect(isFrozen(w, at("2026-11-01T09:00:00Z"))).toBe(false);
  });

  it("never freezes a contest shorter than 90 minutes", () => {
    const w = window_("2026-11-01T10:00:00Z", "2026-11-01T11:00:00Z", 30);
    expect(contestDurationMinutes(w)).toBe(60);
    expect(canFreeze(w)).toBe(false);
    expect(freezeStartsAt(w)).toBeNull();
    expect(isFrozen(w, at("2026-11-01T10:59:00Z"))).toBe(false);
  });

  it("freezes a contest of exactly 90 minutes (the boundary is inclusive)", () => {
    const w = window_("2026-11-01T10:00:00Z", "2026-11-01T11:30:00Z", 30);
    expect(canFreeze(w)).toBe(true);
  });

  it("freezeMinutes 0 disables the freeze on a long contest", () => {
    const w = window_("2026-11-01T10:00:00Z", "2026-11-01T13:00:00Z", 0);
    expect(canFreeze(w)).toBe(false);
    expect(isFrozen(w, at("2026-11-01T12:59:00Z"))).toBe(false);
  });

  it("refuses a freeze window that swallows the whole contest", () => {
    const w = window_("2026-11-01T10:00:00Z", "2026-11-01T12:00:00Z", 120);
    expect(canFreeze(w)).toBe(false);
  });
});

describe("minutesFromStart", () => {
  const w = window_("2026-11-01T10:00:00Z", "2026-11-01T12:00:00Z");

  it.each([
    ["2026-11-01T10:00:00Z", 0],
    ["2026-11-01T10:00:59Z", 0],
    ["2026-11-01T10:01:00Z", 1],
    ["2026-11-01T11:59:00Z", 119],
  ])("%s is minute %d (floored)", (iso, minutes) => {
    expect(minutesFromStart(w, at(iso))).toBe(minutes);
  });
});

describe("virtual contests replay the original clock", () => {
  const live = window_("2026-11-01T10:00:00Z", "2026-11-01T12:00:00Z", 30);

  it("keeps the duration and the freeze window, shifted to the virtual start", () => {
    const v = virtualWindow(live, at("2026-12-20T06:30:00Z"));
    expect(contestDurationMinutes(v)).toBe(contestDurationMinutes(live));
    expect(v.endsAt.toISOString()).toBe("2026-12-20T08:30:00.000Z");
    expect(v.freezeMinutes).toBe(30);
  });

  it("so a solve at the same elapsed minute carries the same penalty", () => {
    const v = virtualWindow(live, at("2026-12-20T06:30:00Z"));
    expect(minutesFromStart(v, at("2026-12-20T06:45:00Z"))).toBe(minutesFromStart(live, at("2026-11-01T10:15:00Z")));
  });

  it("and the freeze engages at the same elapsed point", () => {
    const v = virtualWindow(live, at("2026-12-20T06:30:00Z"));
    expect(isFrozen(v, at("2026-12-20T08:00:00Z"))).toBe(true);
    expect(isFrozen(v, at("2026-12-20T07:59:00Z"))).toBe(false);
  });
});
