import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  EXAM_BROWSER_SIGNAL_BATCH_MAX,
  EXAM_BROWSER_SIGNAL_SITTING_MAX,
} from "@recx/shared/exam-browser";
import { ATTEMPT_AT_MS_GRACE_MS } from "@recx/shared";

/**
 * Attested signals from the exam browser (Phase 15a).
 *
 * Two things are being pinned, and the second is the one that would be
 * easy to get wrong in a way nobody noticed for a term.
 *
 * The first is the ordinary one: nothing from the request reaches the
 * database unclamped or unvalidated.
 *
 * The second is that these rows move NO counter. `blurEventCount` and
 * `fullscreenExitCount` drive the focus-warning policy, which can end a
 * candidate's paper. The page reports the same alt-tab, so if the
 * browser's report were counted too, every assessment's configured limit
 * would quietly halve -- a candidate given three warnings would get one
 * and a half. A test is the only thing standing between that and a hall.
 */

const state = vi.hoisted(() => ({
  attempt: null as null | { id: string; startedAt: Date | null },
  existing: 0,
  created: [] as Array<Record<string, unknown>>,
  findArgs: null as unknown,
}));

const forbidden = (name: string) => () => {
  throw new Error(`exam-browser signals must not call ${name}`);
};

vi.mock("@/lib/db", () => ({
  db: {
    assessmentAttempt: {
      findFirst: async (args: unknown) => {
        state.findArgs = args;
        return state.attempt;
      },
      /**
       * The invariant, enforced by making the call impossible rather than
       * by asserting it was not made. `blurEventCount` and
       * `fullscreenExitCount` drive the focus-warning policy, which can
       * end a paper; the page already reports the same alt-tab, so a
       * second witness counting it too would quietly halve every
       * assessment's configured limit.
       */
      update: forbidden("assessmentAttempt.update"),
      updateMany: forbidden("assessmentAttempt.updateMany"),
    },
    proctorEvent: {
      count: async () => state.existing,
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        state.created.push(...data);
        return { count: data.length };
      },
    },
  },
}));

const { recordExamBrowserSignals, signalTargetOf, examBrowserSignalBatchSchema } = await import(
  "@/lib/exam/exam-browser-signals"
);

const NOW = new Date("2027-03-01T10:30:00.000Z");
const STARTED = new Date("2027-03-01T10:00:00.000Z");
const TARGET = { attemptId: "att_1", sittingId: "sit_1", elapsedMs: 30 * 60_000 };

beforeEach(() => {
  state.attempt = { id: "att_1", startedAt: STARTED };
  state.existing = 0;
  state.created = [];
  state.findArgs = null;
});

describe("which sitting may speak", () => {
  it("resolves the live attempt the sitting is bound to", async () => {
    expect(await signalTargetOf("sit_1", NOW)).toEqual({
      attemptId: "att_1",
      sittingId: "sit_1",
      elapsedMs: 30 * 60_000,
    });
  });

  it("asks only for an attempt in progress whose sitting has not ended", async () => {
    /**
     * A finished paper takes no more evidence, and a sitting that has
     * been ended -- by submission, by the sweep, or by an invigilator --
     * has had its key revoked. Both conditions belong in the query rather
     * than in a check afterwards, so there is no window between them.
     */
    await signalTargetOf("sit_1", NOW);
    const where = (state.findArgs as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      examBrowserSittingId: "sit_1",
      status: "IN_PROGRESS",
      examBrowserSitting: { endedAt: null },
    });
  });

  it("refuses an empty or absurd sitting id without asking the database", async () => {
    state.findArgs = null;
    expect(await signalTargetOf("", NOW)).toBeNull();
    expect(await signalTargetOf("s".repeat(65), NOW)).toBeNull();
    expect(state.findArgs, "no query was made").toBeNull();
  });

  it("refuses when nothing is bound", async () => {
    state.attempt = null;
    expect(await signalTargetOf("sit_1", NOW)).toBeNull();
  });

  it("refuses an attempt that somehow has no start time", async () => {
    state.attempt = { id: "att_1", startedAt: null };
    expect(await signalTargetOf("sit_1", NOW)).toBeNull();
  });

  it("never reports a negative elapsed time, whatever the clocks say", async () => {
    state.attempt = { id: "att_1", startedAt: new Date(NOW.getTime() + 60_000) };
    expect((await signalTargetOf("sit_1", NOW))?.elapsedMs).toBe(0);
  });
});

describe("what reaches the database", () => {
  const record = (signals: Array<Record<string, unknown>>) =>
    recordExamBrowserSignals({ target: TARGET, signals: signals as never, now: NOW });

  it("writes the browser as the source, and never a clientSeq", async () => {
    /**
     * The database says the same thing:
     * CHECK (("source" = 'CLIENT') = ("clientSeq" IS NOT NULL)). These
     * are not part of the page's monotonic sequence, and a gap in that
     * sequence means SEQUENCE_GAP and must go on meaning it.
     */
    await record([{ kind: "FULLSCREEN_EXIT", atMs: 1_000 }]);
    expect(state.created[0]).toMatchObject({ source: "EXAM_BROWSER", clientSeq: null, attemptId: "att_1" });
  });

  it("clamps a time the candidate's machine made up", async () => {
    /**
     * 90 minutes into a 30-minute attempt. The machine is the
     * candidate's; the only honest use for its clock is ordering. The
     * ceiling is the shared one the page's events get -- elapsed plus
     * `ATTEMPT_AT_MS_GRACE_MS`, which exists because a clock a few
     * seconds fast is a clock, not a claim.
     */
    await record([{ kind: "FULLSCREEN_EXIT", atMs: 90 * 60_000 }]);
    expect((state.created[0] as { atMs: number }).atMs).toBe(TARGET.elapsedMs + ATTEMPT_AT_MS_GRACE_MS);
  });

  it("keeps the display count as a number and nothing else", async () => {
    await record([{ kind: "MULTI_MONITOR", atMs: 10, displays: 3 }]);
    expect(state.created[0]).toMatchObject({ kind: "MULTI_MONITOR", meta: { displays: 3 } });
  });

  it("writes no meta at all when there is nothing to say", async () => {
    await record([{ kind: "FULLSCREEN_EXIT", atMs: 10 }]);
    expect((state.created[0] as { meta: unknown }).meta).toEqual({});
  });

  it("drops a focus flicker, the same way the page's events are dropped", async () => {
    const result = await record([{ kind: "FOCUS_LOSS", atMs: 10, durationMs: 100 }]);
    expect(result).toMatchObject({ recorded: 0, dropped: 1 });
    expect(state.created).toHaveLength(0);
  });

  it("grades a long absence higher than a short one, the same way the page's are graded", async () => {
    await record([
      { kind: "FOCUS_LOSS", atMs: 10, durationMs: 30_000 },
      { kind: "FOCUS_LOSS", atMs: 20, durationMs: 300_000 },
      { kind: "FULLSCREEN_EXIT", atMs: 30 },
      { kind: "MULTI_MONITOR", atMs: 40, displays: 2 },
    ]);
    expect(state.created.map((r) => r.severity)).toEqual(["LOW", "MEDIUM", "LOW", "INFO"]);
  });
});

describe("the ceiling", () => {
  it("stops a sitting that has said too much, and says it stopped", async () => {
    state.existing = EXAM_BROWSER_SIGNAL_SITTING_MAX;
    const result = await recordExamBrowserSignals({
      target: TARGET,
      signals: [{ kind: "FULLSCREEN_EXIT", atMs: 1 }],
      now: NOW,
    });
    expect(result).toMatchObject({ recorded: 0, dropped: 1, ceilingReached: true });
    expect(state.created).toHaveLength(0);
  });

  it("lets through only what is left of the allowance", async () => {
    state.existing = EXAM_BROWSER_SIGNAL_SITTING_MAX - 2;
    const result = await recordExamBrowserSignals({
      target: TARGET,
      signals: [
        { kind: "FULLSCREEN_EXIT", atMs: 1 },
        { kind: "FULLSCREEN_EXIT", atMs: 2 },
        { kind: "FULLSCREEN_EXIT", atMs: 3 },
      ],
      now: NOW,
    });
    expect(result).toMatchObject({ recorded: 2, dropped: 1 });
  });
});

describe("what the payload may contain", () => {
  const parse = (value: unknown) => examBrowserSignalBatchSchema.safeParse(value);

  it("accepts the three kinds the browser is allowed to report", () => {
    for (const kind of ["FOCUS_LOSS", "FULLSCREEN_EXIT", "MULTI_MONITOR"]) {
      expect(parse({ signals: [{ kind, atMs: 0 }] }).success, kind).toBe(true);
    }
  });

  it("refuses a kind the browser has no business claiming", () => {
    /**
     * The reason the list is closed. An endpoint that took any kind would
     * be an endpoint that could write INVIGILATOR_NOTE -- a human's
     * judgement, forged by a machine.
     */
    for (const kind of ["INVIGILATOR_NOTE", "EXTERNAL_PASTE", "SNAPSHOT_JUMP", "HEARTBEAT_GAP", "nonsense"]) {
      expect(parse({ signals: [{ kind, atMs: 0 }] }).success, kind).toBe(false);
    }
  });

  it("refuses an empty batch and one that is too long", () => {
    expect(parse({ signals: [] }).success).toBe(false);
    const many = Array.from({ length: EXAM_BROWSER_SIGNAL_BATCH_MAX + 1 }, () => ({
      kind: "FULLSCREEN_EXIT",
      atMs: 0,
    }));
    expect(parse({ signals: many }).success).toBe(false);
  });

  it("refuses times that are negative, fractional or beyond a day", () => {
    for (const atMs of [-1, 1.5, 24 * 60 * 60_000 + 1]) {
      expect(parse({ signals: [{ kind: "FULLSCREEN_EXIT", atMs }] }).success, String(atMs)).toBe(false);
    }
  });

  it("refuses a display count that is not a plausible number of screens", () => {
    for (const displays of [0, -1, 65, 2.5]) {
      expect(
        parse({ signals: [{ kind: "MULTI_MONITOR", atMs: 0, displays }] }).success,
        String(displays),
      ).toBe(false);
    }
  });

  it("refuses anything that is not the shape at all", () => {
    for (const value of [null, "signals", 7, {}, { signals: "FOCUS_LOSS" }, { signals: [null] }]) {
      expect(parse(value).success, JSON.stringify(value) ?? "undefined").toBe(false);
    }
  });
});

describe("what these signals must never do", () => {
  it("moves no counter, however many of them arrive", async () => {
    /**
     * The mock throws on any attempt to write the attempt row, so this
     * passes only while nothing here touches one. If a later change
     * wants a counter to move, it has to delete this test and argue for
     * it -- which is the point: the page reports the same alt-tab, and
     * counting both would mean a candidate allowed three warnings got
     * one and a half, in a hall, with no way to tell why.
     */
    const result = await recordExamBrowserSignals({
      target: TARGET,
      signals: [
        { kind: "FOCUS_LOSS", atMs: 1, durationMs: 300_000 },
        { kind: "FOCUS_LOSS", atMs: 2, durationMs: 300_000 },
        { kind: "FULLSCREEN_EXIT", atMs: 3 },
        { kind: "FULLSCREEN_EXIT", atMs: 4 },
        { kind: "MULTI_MONITOR", atMs: 5, displays: 2 },
      ],
      now: NOW,
    });
    expect(result.recorded).toBe(5);
  });

  it("writes nothing at all when every signal is noise", async () => {
    // No empty createMany either: an empty insert is a round trip that
    // buys nothing, and on a flapping machine it is a round trip every
    // fifteen seconds for the length of a paper.
    const result = await recordExamBrowserSignals({
      target: TARGET,
      signals: [{ kind: "FOCUS_LOSS", atMs: 1, durationMs: 10 }],
      now: NOW,
    });
    expect(result).toMatchObject({ recorded: 0, dropped: 1 });
    expect(state.created).toHaveLength(0);
  });
});
