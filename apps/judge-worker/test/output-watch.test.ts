import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@recx/shared";
import { watchOutputSize } from "../src/sandbox/output-watch";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("watchOutputSize — the early output trip", () => {
  it("polls every 200 ms by default", () => {
    expect(LIMITS.earlyOle.pollMs).toBe(200);
  });

  it("trips within one poll interval of passing the cap, and only once", async () => {
    let size = 0;
    const trips: number[] = [];
    const start = Date.now();
    const stop = watchOutputSize({ size: async () => size, limitBytes: 1_000_000, onExceeded: () => trips.push(Date.now() - start) });

    size = 900_000;
    await vi.advanceTimersByTimeAsync(1_030); // several polls under the cap
    expect(trips).toEqual([]);

    size = 1_000_001; // passes the cap 30 ms after a poll
    const exceededAt = Date.now() - start;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(trips).toHaveLength(1);
    expect(trips[0]! - exceededAt).toBeLessThanOrEqual(LIMITS.earlyOle.pollMs);
    expect(trips[0]! - exceededAt).toBeLessThan(1_000);

    size = 5_000_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(trips).toHaveLength(1);
    stop();
  });

  it("exactly the cap is within it", async () => {
    let tripped = false;
    const stop = watchOutputSize({ size: async () => 1_000, limitBytes: 1_000, pollMs: 200, onExceeded: () => (tripped = true) });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(tripped).toBe(false);
    stop();
  });

  it("ignores a failing size probe and keeps polling", async () => {
    let calls = 0;
    let tripped = false;
    const stop = watchOutputSize({
      size: async () => {
        calls++;
        if (calls < 3) throw new Error("EBADF");
        return 10_000;
      },
      limitBytes: 100,
      pollMs: 200,
      onExceeded: () => (tripped = true),
    });
    await vi.advanceTimersByTimeAsync(700);
    expect(tripped).toBe(true);
    stop();
  });

  it("never overlaps polls, and stops when told", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let tripped = false;
    const stop = watchOutputSize({
      size: () =>
        new Promise<number>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setTimeout(() => {
            inFlight--;
            resolve(0);
          }, 450);
        }),
      limitBytes: 100,
      pollMs: 200,
      onExceeded: () => (tripped = true),
    });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(maxInFlight).toBe(1);
    stop();
    const stopped = watchOutputSize({ size: async () => 1_000, limitBytes: 1, pollMs: 200, onExceeded: () => (tripped = true) });
    stopped();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tripped).toBe(false);
  });
});
