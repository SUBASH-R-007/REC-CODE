import { describe, expect, it } from "vitest";
import { EXAM_BROWSER_SIGNALS_PATH, EXAM_BROWSER_SIGNAL_BATCH_MAX } from "@recx/shared/exam-browser";
import { FOCUS_NOISE_MS, SIGNAL_QUEUE_MAX, SignalQueue } from "../src/signals";

/**
 * What this window reports about itself (Phase 15a).
 *
 * The queue is the part that can go wrong quietly. A signal dropped
 * because a flush failed, or a duration measured from the wrong end of a
 * focus loss, produces a timeline that is subtly wrong rather than
 * obviously broken -- and a reviewer deciding whether a candidate left
 * their paper is reading exactly those numbers.
 */

const ORIGIN = "https://code.rec.edu.in";

function harness(options: { readonly fail?: boolean; readonly throws?: boolean } = {}) {
  const posts: Array<{ url: string; body: unknown }> = [];
  const errors: string[] = [];
  let clock = 1_000;
  const queue = new SignalQueue({
    startedAtMs: 1_000,
    now: () => clock,
    origin: () => ORIGIN,
    onError: (name) => errors.push(name),
    sink: {
      post: async (url, body) => {
        if (options.throws) throw new Error("network down");
        posts.push({ url, body: JSON.parse(body) as unknown });
        return !options.fail;
      },
    },
  });
  return {
    queue,
    posts,
    errors,
    advance: (ms: number) => (clock += ms),
    get bodies() {
      return posts.map((p) => (p.body as { signals: unknown[] }).signals);
    },
  };
}

describe("where a signal is stamped", () => {
  it("measures from the window opening, not from a wall clock", async () => {
    const h = harness();
    h.advance(45_000);
    h.queue.note("FULLSCREEN_EXIT");
    await h.queue.flush();
    expect(h.bodies[0]).toEqual([{ kind: "FULLSCREEN_EXIT", atMs: 45_000 }]);
  });

  it("stamps a focus loss where the window went AWAY, not where it came back", async () => {
    /**
     * The difference matters to a reviewer reading a timeline: a
     * candidate who left at minute three for ten minutes did not leave at
     * minute thirteen, and sorting the timeline by the wrong end puts the
     * event after things that happened while they were gone.
     */
    const h = harness();
    h.advance(180_000);
    h.queue.focusLost();
    h.advance(600_000);
    h.queue.focusRestored();
    await h.queue.flush();
    expect(h.bodies[0]).toEqual([{ kind: "FOCUS_LOSS", atMs: 180_000, durationMs: 600_000 }]);
  });

  it("never stamps a negative time, whatever the clock does", async () => {
    const h = harness();
    h.advance(-50_000);
    h.queue.note("FULLSCREEN_EXIT");
    await h.queue.flush();
    expect((h.bodies[0] as Array<{ atMs: number }>)[0]?.atMs).toBe(0);
  });
});

describe("what is not worth reporting", () => {
  it("drops a focus flicker shorter than the noise floor", () => {
    const h = harness();
    h.queue.focusLost();
    h.advance(FOCUS_NOISE_MS - 1);
    h.queue.focusRestored();
    expect(h.queue.queued).toBe(0);
  });

  it("keeps a focus loss at the floor", () => {
    const h = harness();
    h.queue.focusLost();
    h.advance(FOCUS_NOISE_MS);
    h.queue.focusRestored();
    expect(h.queue.queued).toBe(1);
  });

  it("ignores a focus return that follows no loss", () => {
    const h = harness();
    h.queue.focusRestored();
    expect(h.queue.queued).toBe(0);
  });

  it("does not count one blur twice when the window is told twice", () => {
    // Electron fires blur again when the window is pushed back in front,
    // and a second `focusLost` must not reset the clock on the first.
    const h = harness();
    h.queue.focusLost();
    h.advance(5_000);
    h.queue.focusLost();
    h.advance(5_000);
    h.queue.focusRestored();
    expect(h.queue.queued).toBe(1);
  });
});

describe("a sitting that ends while the window is away", () => {
  it("still carries the fact that it was away, with the time known so far", async () => {
    const h = harness();
    h.advance(10_000);
    h.queue.focusLost();
    h.advance(30_000);
    h.queue.closeOpenFocusLoss();
    await h.queue.flush();
    expect(h.bodies[0]).toEqual([{ kind: "FOCUS_LOSS", atMs: 10_000, durationMs: 30_000 }]);
  });

  it("does nothing when the window had the focus all along", () => {
    const h = harness();
    h.queue.closeOpenFocusLoss();
    expect(h.queue.queued).toBe(0);
  });
});

describe("how many screens", () => {
  it("reports the count and nothing else about them", async () => {
    /**
     * A number. `docs/PROCTORING.md` section 5 forbids screen capture by
     * name, and the distance between "how many screens" and "what is on
     * them" is the distance between this product and the one it refuses
     * to be.
     */
    const h = harness();
    h.queue.displays(2);
    await h.queue.flush();
    expect(h.bodies[0]).toEqual([{ kind: "MULTI_MONITOR", atMs: 0, displays: 2 }]);
  });
});

describe("delivery", () => {
  it("posts to the signed path on the exam origin", async () => {
    const h = harness();
    h.queue.note("FULLSCREEN_EXIT");
    await h.queue.flush();
    expect(h.posts[0]?.url).toBe(`${ORIGIN}${EXAM_BROWSER_SIGNALS_PATH}`);
  });

  it("sends nothing when there is nothing to send", async () => {
    const h = harness();
    await h.queue.flush();
    expect(h.posts).toHaveLength(0);
  });

  it("keeps a refused batch, in order, for the next flush", async () => {
    const h = harness({ fail: true });
    h.queue.note("FULLSCREEN_EXIT");
    h.advance(1_000);
    h.queue.displays(3);
    await h.queue.flush();
    expect(h.queue.queued, "nothing is lost because the server said no").toBe(2);

    const ok = harness();
    // The same two, in the same order, on a queue that can deliver.
    ok.queue.note("FULLSCREEN_EXIT");
    ok.advance(1_000);
    ok.queue.displays(3);
    await ok.queue.flush();
    expect((ok.bodies[0] as Array<{ kind: string }>).map((s) => s.kind)).toEqual(["FULLSCREEN_EXIT", "MULTI_MONITOR"]);
  });

  it("keeps a batch whose post threw, and records the failure by name only", async () => {
    const h = harness({ throws: true });
    h.queue.note("FULLSCREEN_EXIT");
    await h.queue.flush();
    expect(h.queue.queued).toBe(1);
    expect(h.errors).toEqual(["Error"]);
  });

  it("sends at most one batch's worth at a time", async () => {
    const h = harness();
    for (let i = 0; i < EXAM_BROWSER_SIGNAL_BATCH_MAX + 5; i++) h.queue.note("FULLSCREEN_EXIT");
    await h.queue.flush();
    expect((h.bodies[0] as unknown[]).length).toBe(EXAM_BROWSER_SIGNAL_BATCH_MAX);
    expect(h.queue.queued).toBe(5);
  });

  it("sends nothing before a sitting has an origin", async () => {
    const queue = new SignalQueue({
      startedAtMs: 0,
      now: () => 0,
      origin: () => null,
      sink: { post: async () => true },
    });
    queue.note("FULLSCREEN_EXIT");
    await queue.flush();
    expect(queue.queued, "held, not dropped").toBe(1);
  });
});

describe("the queue cannot grow without limit", () => {
  it("drops the OLDEST past the ceiling, because now matters more than then", () => {
    const h = harness();
    for (let i = 0; i < SIGNAL_QUEUE_MAX + 10; i++) {
      h.advance(1);
      h.queue.displays(i + 1);
    }
    expect(h.queue.queued).toBe(SIGNAL_QUEUE_MAX);
  });

  it("holds the most recent, not the first", async () => {
    const h = harness();
    for (let i = 0; i < SIGNAL_QUEUE_MAX + 1; i++) {
      h.advance(1);
      h.queue.displays(i + 1);
    }
    await h.queue.flush();
    const first = (h.bodies[0] as Array<{ displays: number }>)[0];
    expect(first?.displays, "the very first was dropped").toBe(2);
  });
});
