import { afterEach, describe, expect, it, vi } from "vitest";
import { displayCount, inExamBrowser } from "@/lib/exam/client/exam-browser-bridge";

/**
 * What the exam page may ask REC Exam Browser (Phase 14d).
 *
 * The bridge is optional by design: the same page runs in an ordinary
 * browser for every other proctor mode, so the rules worth testing are all
 * about what happens when it is NOT there, or is there and lying.
 */

const setBridge = (value: unknown) => {
  (globalThis as unknown as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { recxExamBrowser?: unknown }).recxExamBrowser = value;
};

afterEach(() => {
  delete (globalThis as unknown as { recxExamBrowser?: unknown }).recxExamBrowser;
});

describe("noticing the exam browser", () => {
  it("says no when nothing is on the window", () => {
    setBridge(undefined);
    expect(inExamBrowser()).toBe(false);
  });

  it("says no to something shaped wrongly", () => {
    /**
     * A page can put anything on `window`, including an object called
     * `recxExamBrowser`. The bridge is only believed when its functions
     * are there, and even then what it returns is checked below.
     */
    for (const impostor of [{}, { displays: 2 }, { displays: () => 2 }, "yes", 1]) {
      setBridge(impostor);
      expect(inExamBrowser(), JSON.stringify(impostor)).toBe(false);
    }
  });

  it("says yes to the real shape", () => {
    setBridge({ displays: async () => 1, version: async () => "1.0.0", finish: () => undefined });
    expect(inExamBrowser()).toBe(true);
  });
});

describe("counting displays", () => {
  it("returns null with no bridge, so the caller falls back rather than guessing", async () => {
    setBridge(undefined);
    expect(await displayCount()).toBeNull();
  });

  it("returns what the application says", async () => {
    setBridge({ displays: async () => 3, version: async () => "1.0.0", finish: () => undefined });
    expect(await displayCount()).toBe(3);
  });

  it("returns null rather than a guess when the answer is not a count", async () => {
    for (const answer of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      setBridge({ displays: async () => answer, version: async () => "1.0.0", finish: () => undefined });
      expect(await displayCount(), String(answer)).toBeNull();
    }
  });

  it("survives a bridge that throws", async () => {
    setBridge({
      displays: async () => {
        throw new Error("no");
      },
      version: async () => "1.0.0",
      finish: () => undefined,
    });
    expect(await displayCount()).toBeNull();
  });

  it("floors a fractional answer rather than reporting half a screen", async () => {
    setBridge({ displays: async () => 2.7, version: async () => "1.0.0", finish: () => undefined });
    expect(await displayCount()).toBe(2);
  });
});

describe("what it is not", () => {
  it("exposes nothing that could carry the sitting key", () => {
    /**
     * The preload is reachable by the page, and the page is the one place
     * a candidate can run their own JavaScript. The key lives in the
     * application's main process; this module must not grow a way to ask
     * for it.
     */
    const api = { displays: async () => 1, version: async () => "1.0.0", finish: () => undefined };
    setBridge(api);
    expect(Object.keys(api).sort()).toEqual(["displays", "finish", "version"]);
    expect(vi.isMockFunction(displayCount)).toBe(false);
  });
});
