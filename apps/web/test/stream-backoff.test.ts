import { describe, expect, it } from "vitest";
import {
  MAX_POLLS,
  MIN_POLL_DELAY_MS,
  POLL_SCHEDULE_MS,
  canPoll,
  pollDelayMs,
  verdictStreamReducer,
  type VerdictStreamState,
} from "@/hooks/use-verdict-stream";
import type { StudentView } from "@/lib/judge/view";

describe("verdict polling backoff", () => {
  it("follows 2 s, 3 s, 5 s, 5 s, …", () => {
    expect([0, 1, 2, 3, 4, 10].map(pollDelayMs)).toEqual([2_000, 3_000, 5_000, 5_000, 5_000, 5_000]);
  });

  it("is never faster than 2 s, for any attempt number", () => {
    expect(MIN_POLL_DELAY_MS).toBe(2_000);
    for (const delay of POLL_SCHEDULE_MS) expect(delay).toBeGreaterThanOrEqual(2_000);
    for (let attempt = -5; attempt <= MAX_POLLS + 50; attempt++) {
      expect(pollDelayMs(attempt)).toBeGreaterThanOrEqual(2_000);
    }
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.5, 1e9]) {
      expect(pollDelayMs(odd)).toBeGreaterThanOrEqual(2_000);
    }
  });

  it("is capped at 60 polls", () => {
    expect(MAX_POLLS).toBe(60);
    let polls = 0;
    while (canPoll(polls)) polls++;
    expect(polls).toBe(60);
    expect(canPoll(60)).toBe(false);
    expect(canPoll(1_000)).toBe(false);
  });

  it("keeps the whole polling window bounded (a few minutes, not forever)", () => {
    let total = 0;
    for (let n = 0; n < MAX_POLLS; n++) total += pollDelayMs(n);
    // 2 + 3 + 58 × 5 seconds.
    expect(total).toBe(295_000);
  });
});

describe("verdict stream reducer — live events", () => {
  const live: VerdictStreamState = { view: null, progress: null, phase: "live", error: null };
  const run = (...events: unknown[]) =>
    events.reduce<VerdictStreamState>((state, event) => verdictStreamReducer(state, { type: "progress", event }), live);

  it("tracks state and per-test verdicts", () => {
    const s = run(
      { type: "state", state: "COMPILING" },
      { type: "test", i: 0, v: "AC", done: 1, total: 3 },
      { type: "test", i: 1, v: "WA", done: 2, total: 3 },
    );
    expect(s.progress).toMatchObject({ state: "RUNNING", done: 2, total: 3 });
    expect(s.progress?.tests).toEqual([
      { i: 0, v: "AC" },
      { i: 1, v: "WA" },
    ]);
    expect(s.progress?.subtasks).toEqual([]);
  });

  it("shows subtask verdicts while judging, ordered by subtask, latest event per subtask", () => {
    const s = run(
      { type: "state", state: "RUNNING" },
      { type: "test", i: 0, v: "AC", done: 1, total: 6 },
      { type: "subtask", index: 1, v: "SKIPPED" },
      { type: "subtask", index: 0, v: "AC" },
      { type: "subtask", index: 0, v: "WA" },
    );
    expect(s.progress?.subtasks).toEqual([
      { index: 0, v: "WA" },
      { index: 1, v: "SKIPPED" },
    ]);
    // Test progress is kept alongside.
    expect(s.progress?.tests).toEqual([{ i: 0, v: "AC" }]);
    expect(s.progress?.total).toBe(6);
  });

  it("ignores malformed events and anything after a terminal snapshot", () => {
    expect(run({ type: "subtask", index: "x", v: "AC" }).progress).toBeNull();
    expect(run({ type: "subtask", index: 0, v: "NOT_A_VERDICT" }).progress).toBeNull();
    expect(run({ type: "nope" }).progress).toBeNull();
    const terminal = verdictStreamReducer(live, {
      type: "snapshot",
      view: { kind: "submission", terminal: true, display: "AC" } as unknown as StudentView,
    });
    const after = verdictStreamReducer(terminal, { type: "progress", event: { type: "subtask", index: 0, v: "AC" } });
    expect(after.progress).toBeNull();
  });
});
