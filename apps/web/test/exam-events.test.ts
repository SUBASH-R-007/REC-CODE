import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Client telemetry ingestion (Phase 6c) — `src/lib/exam/events.ts` and the
 * route that fronts it.
 *
 * Two gate items live here:
 *
 *   5. "a focus-loss event is persisted server-side BEFORE the overlay is
 *      dismissible" — so the warning number and the overlay's wording come
 *      back from the server, after the row is committed, and the client has
 *      nothing to compose for itself;
 *   9. "a SCREEN_READER accommodation exempts the focus signals" — and
 *      exempts them from COUNTING, not merely from acting, or the sitting
 *      still ends at warning three.
 *
 * Plus the standing rule: nothing here may reach a penalty. The strongest
 * thing this code path can do is auto-submit and leave a record for a human.
 */

const ATTEMPT = "att_1";
const USER = "user_1";
const SHA = "a".repeat(64);

const h = vi.hoisted(() => ({
  count: vi.fn(),
  createMany: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    proctorEvent: { count: h.count, createMany: h.createMany },
    assessmentAttempt: { updateMany: h.updateMany },
    $transaction: h.transaction,
  },
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));

const { ingestProctorEvents } = await import("@/lib/exam/events");
const { MAX_RAW_EVENTS_PER_ATTEMPT } = await import("@recx/shared");

const STARTED = new Date("2026-10-19T10:00:00.000Z");
const NOW = new Date(STARTED.getTime() + 600_000);

function attemptRow(over: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT,
    userId: USER,
    assessmentId: "a1",
    status: "IN_PROGRESS",
    startedAt: STARTED,
    expiresAt: new Date(STARTED.getTime() + 3_600_000),
    pausedMs: 0,
    accommodationFlags: [] as string[],
    blurEventCount: 0,
    fullscreenExitCount: 0,
    pasteEventCount: 0,
    version: 5,
    integrityScore: 100,
    ...over,
  };
}

function guardOf(attempt: Record<string, unknown>) {
  return {
    ok: true as const,
    attempt: attempt as never,
    status: attempt.status as never,
    msRemaining: 1,
    now: NOW,
    sessionNotice: null as never,
    sessionId: "sess_1",
  };
}

const POLICY = { maxFocusWarnings: 3, onLimit: "AUTOSUBMIT" as const };

/** The rows the ingest tried to write, from the mocked createMany. */
function writtenRows(): Array<Record<string, unknown>> {
  const call = h.createMany.mock.calls[0];
  return call ? ((call[0] as { data: Array<Record<string, unknown>> }).data ?? []) : [];
}

function counterWrite(): Record<string, unknown> {
  return (h.updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined)?.data ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  h.count.mockResolvedValue(0);
  h.createMany.mockResolvedValue({ count: 1 });
  h.updateMany.mockResolvedValue({ count: 1 });
  // The real $transaction takes an array of prepared promises; the mock just
  // resolves them, which is enough to observe what was prepared.
  h.transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
});

describe("ingestProctorEvents", () => {
  it("records a client event as CLIENT-sourced with its sequence", async () => {
    const result = await ingestProctorEvents(
      guardOf(attemptRow()),
      [{ kind: "EXTERNAL_PASTE", clientSeq: 4, atMs: 5_000, size: 240, hash: SHA }],
      POLICY,
    );
    expect(result.accepted).toBe(1);
    const [row] = writtenRows();
    expect(row).toMatchObject({ attemptId: ATTEMPT, kind: "EXTERNAL_PASTE", source: "CLIENT", clientSeq: 4, hash: SHA });
  });

  it("clamps a claimed offset into the attempt", async () => {
    await ingestProctorEvents(
      guardOf(attemptRow()),
      [{ kind: "COPY", clientSeq: 1, atMs: 9_999_999 }],
      POLICY,
    );
    // Ten minutes elapsed, plus the 5s grace.
    expect(writtenRows()[0]!.atMs).toBe(605_000);
  });

  it("refuses a kind only the server can know", async () => {
    const result = await ingestProctorEvents(
      guardOf(attemptRow()),
      [
        { kind: "HEARTBEAT_GAP", clientSeq: 1, atMs: 0 },
        { kind: "CONCURRENT_SESSION", clientSeq: 2, atMs: 0 },
        { kind: "SNAPSHOT_JUMP", clientSeq: 3, atMs: 0 },
        { kind: "COPY", clientSeq: 4, atMs: 0 },
      ],
      POLICY,
    );
    expect(result.accepted).toBe(1);
    expect(result.dropped).toBe(3);
    expect(writtenRows().map((r) => r.kind)).toEqual(["COPY"]);
  });

  it("drops a focus flicker as UI noise", async () => {
    const result = await ingestProctorEvents(
      guardOf(attemptRow()),
      [{ kind: "FOCUS_LOSS", clientSeq: 1, atMs: 0, durationMs: 400 }],
      POLICY,
    );
    expect(result.accepted).toBe(0);
    expect(result.dropped).toBe(1);
    expect(result.focusWarning).toBeNull();
  });

  it("keeps a focus loss at the threshold", async () => {
    const result = await ingestProctorEvents(
      guardOf(attemptRow()),
      [{ kind: "FOCUS_LOSS", clientSeq: 1, atMs: 0, durationMs: 1_500 }],
      POLICY,
    );
    expect(result.accepted).toBe(1);
    expect(result.focusWarning).not.toBeNull();
  });

  it("moves the counters that match the kinds", async () => {
    await ingestProctorEvents(
      guardOf(attemptRow()),
      [
        { kind: "FOCUS_LOSS", clientSeq: 1, atMs: 0, durationMs: 5_000 },
        { kind: "FULLSCREEN_EXIT", clientSeq: 2, atMs: 0 },
        { kind: "EXTERNAL_PASTE", clientSeq: 3, atMs: 0 },
        { kind: "INTERNAL_PASTE", clientSeq: 4, atMs: 0 },
        { kind: "COPY", clientSeq: 5, atMs: 0 },
      ],
      POLICY,
    );
    expect(counterWrite()).toMatchObject({
      blurEventCount: { increment: 1 },
      fullscreenExitCount: { increment: 1 },
      pasteEventCount: { increment: 2 },
      version: { increment: 1 },
    });
  });

  it("writes conditionally on the version the guard read", async () => {
    await ingestProctorEvents(guardOf(attemptRow({ version: 11 })), [{ kind: "COPY", clientSeq: 1, atMs: 0 }], POLICY);
    expect(h.updateMany.mock.calls[0]![0]).toMatchObject({ where: { id: ATTEMPT, version: 11 } });
  });

  it("commits the rows and the counters in one transaction", async () => {
    await ingestProctorEvents(guardOf(attemptRow()), [{ kind: "COPY", clientSeq: 1, atMs: 0 }], POLICY);
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect((h.transaction.mock.calls[0]![0] as unknown[]).length).toBe(2);
  });

  // ── The overlay's warning ──────────────────────────────────────────────

  it("returns the warning number and the wording from the server", async () => {
    // Gate item 5: the client composes nothing. It cannot know it is warning
    // 2 of 3 until the row is committed and the server says so.
    const result = await ingestProctorEvents(
      guardOf(attemptRow({ blurEventCount: 1 })),
      [{ kind: "FOCUS_LOSS", clientSeq: 1, atMs: 0, durationMs: 4_000 }],
      POLICY,
    );
    expect(result.focusWarning).toMatchObject({ warningNumber: 2, maxWarnings: 3, atLimit: false, action: "WARN" });
    expect(result.focusWarning!.body).toContain("This is warning 2 of 3");
    expect(result.focusWarning!.body).toContain("Your timer is still running.");
  });

  it("counts fullscreen exits towards the same limit as focus losses", async () => {
    const result = await ingestProctorEvents(
      guardOf(attemptRow({ blurEventCount: 1, fullscreenExitCount: 1 })),
      [{ kind: "FULLSCREEN_EXIT", clientSeq: 1, atMs: 0 }],
      POLICY,
    );
    expect(result.focusWarning).toMatchObject({ warningNumber: 3, atLimit: true, action: "AUTOSUBMIT" });
    expect(result.autoSubmit).toBe(true);
  });

  it("only flags at the limit when the policy says FLAG_ONLY", async () => {
    const result = await ingestProctorEvents(
      guardOf(attemptRow({ blurEventCount: 2 })),
      [{ kind: "FOCUS_LOSS", clientSeq: 1, atMs: 0, durationMs: 4_000 }],
      { maxFocusWarnings: 3, onLimit: "FLAG_ONLY" },
    );
    expect(result.focusWarning).toMatchObject({ atLimit: true, action: "FLAG_ONLY" });
    expect(result.autoSubmit).toBe(false);
    expect(result.focusWarning!.body).not.toContain("submitted automatically");
  });

  it("says nothing about warnings for a batch of pastes and copies", async () => {
    const result = await ingestProctorEvents(
      guardOf(attemptRow()),
      [
        { kind: "EXTERNAL_PASTE", clientSeq: 1, atMs: 0, size: 40, hash: SHA },
        { kind: "COPY", clientSeq: 2, atMs: 0 },
        { kind: "CONTEXT_MENU", clientSeq: 3, atMs: 0 },
      ],
      POLICY,
    );
    expect(result.focusWarning).toBeNull();
    expect(result.autoSubmit).toBe(false);
  });

  // ── The accommodation ──────────────────────────────────────────────────

  it("exempts a screen-reader candidate's focus signals from COUNTING", async () => {
    // Gate item 9. Exempting them from acting but still counting them would
    // end the sitting at warning three anyway, which is the bug.
    const result = await ingestProctorEvents(
      guardOf(attemptRow({ accommodationFlags: ["SCREEN_READER"], blurEventCount: 9 })),
      [
        { kind: "FOCUS_LOSS", clientSeq: 1, atMs: 0, durationMs: 30_000 },
        { kind: "FULLSCREEN_EXIT", clientSeq: 2, atMs: 0 },
      ],
      POLICY,
    );
    expect(result.focusWarning).toBeNull();
    expect(result.autoSubmit).toBe(false);
  });

  it("still records an exempt candidate's events, so a reviewer sees the whole timeline", async () => {
    await ingestProctorEvents(
      guardOf(attemptRow({ accommodationFlags: ["SCREEN_READER"] })),
      [{ kind: "FOCUS_LOSS", clientSeq: 1, atMs: 0, durationMs: 30_000 }],
      POLICY,
    );
    expect(writtenRows().map((r) => r.kind)).toEqual(["FOCUS_LOSS"]);
    expect(counterWrite()).toMatchObject({ blurEventCount: { increment: 1 } });
  });

  it("does not exempt a screen-reader candidate's pastes", async () => {
    await ingestProctorEvents(
      guardOf(attemptRow({ accommodationFlags: ["SCREEN_READER"] })),
      [{ kind: "EXTERNAL_PASTE", clientSeq: 1, atMs: 0, size: 900, hash: SHA }],
      POLICY,
    );
    expect(writtenRows()[0]).toMatchObject({ kind: "EXTERNAL_PASTE", severity: "MEDIUM" });
  });

  it("exempts a speech-input candidate's typing bursts from nothing it would have acted on anyway", async () => {
    // CADENCE_BURST and PROGRAMMATIC_INSERT never produced a warning in the
    // first place; the exemption matters to the reviewer's view (6e), and the
    // events are still recorded here.
    await ingestProctorEvents(
      guardOf(attemptRow({ accommodationFlags: ["SPEECH_INPUT"] })),
      [{ kind: "PROGRAMMATIC_INSERT", clientSeq: 1, atMs: 0, chars: 400 }],
      POLICY,
    );
    expect(writtenRows()).toHaveLength(1);
  });

  // ── The raw-row cap ────────────────────────────────────────────────────

  it("stops writing rows at the cap and says so, while the counters keep moving", async () => {
    h.count.mockResolvedValue(MAX_RAW_EVENTS_PER_ATTEMPT);
    const result = await ingestProctorEvents(
      guardOf(attemptRow()),
      [
        { kind: "EXTERNAL_PASTE", clientSeq: 1, atMs: 0 },
        { kind: "COPY", clientSeq: 2, atMs: 0 },
      ],
      POLICY,
    );
    expect(result.aggregatesOnly).toBe(true);
    expect(result.accepted).toBe(0);
    expect(result.dropped).toBe(2);
    expect(h.createMany).not.toHaveBeenCalled();
    expect(counterWrite()).toMatchObject({ pasteEventCount: { increment: 1 } });
  });

  it("writes only as many rows as the remaining budget allows", async () => {
    h.count.mockResolvedValue(MAX_RAW_EVENTS_PER_ATTEMPT - 2);
    const result = await ingestProctorEvents(
      guardOf(attemptRow()),
      Array.from({ length: 5 }, (_, i) => ({ kind: "COPY" as const, clientSeq: i, atMs: 0 })),
      POLICY,
    );
    expect(result.accepted).toBe(2);
    expect(result.dropped).toBe(3);
    expect(result.aggregatesOnly).toBe(false);
  });

  // ── What it must never do ──────────────────────────────────────────────

  it("never writes a score, a flag or an integrity number", async () => {
    await ingestProctorEvents(
      guardOf(attemptRow()),
      [
        { kind: "FOCUS_LOSS", clientSeq: 1, atMs: 0, durationMs: 300_000 },
        { kind: "PROGRAMMATIC_INSERT", clientSeq: 2, atMs: 0, chars: 900 },
        { kind: "EXTERNAL_PASTE", clientSeq: 3, atMs: 0, size: 4_000, hash: SHA },
      ],
      POLICY,
    );
    const data = counterWrite();
    for (const forbidden of ["integrityScore", "totalScore", "status", "submittedAt", "expiresAt"]) {
      expect(data).not.toHaveProperty(forbidden);
    }
  });

  it("stores shape only: no event row carries anything but counts, sizes and a hash", async () => {
    await ingestProctorEvents(
      guardOf(attemptRow()),
      [{ kind: "EXTERNAL_PASTE", clientSeq: 1, atMs: 0, size: 240, hash: SHA, chars: 240, windowMs: 10 }],
      POLICY,
    );
    const row = writtenRows()[0]!;
    expect(Object.keys(row).sort()).toEqual(
      [
        "atMs",
        "attemptId",
        "clientSeq",
        "durationMs",
        "hash",
        "kind",
        "meta",
        "occurredAt",
        "severity",
        "size",
        "source",
      ].sort(),
    );
    expect(JSON.stringify(row.meta)).toBe(JSON.stringify({ chars: 240, windowMs: 10 }));
  });

  it("keeps context-only kinds at INFO, so they cannot order a queue by themselves", async () => {
    await ingestProctorEvents(
      guardOf(attemptRow()),
      [
        { kind: "DEVTOOLS_HEURISTIC", clientSeq: 1, atMs: 0 },
        { kind: "MULTI_MONITOR", clientSeq: 2, atMs: 0 },
        { kind: "CONTEXT_MENU", clientSeq: 3, atMs: 0 },
      ],
      POLICY,
    );
    for (const row of writtenRows()) expect(row.severity).toBe("INFO");
  });

  it("survives losing the counter race without losing the events", async () => {
    h.updateMany.mockResolvedValue({ count: 0 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await ingestProctorEvents(guardOf(attemptRow()), [{ kind: "COPY", clientSeq: 1, atMs: 0 }], POLICY);
    expect(result.accepted).toBe(1);
    expect(h.createMany).toHaveBeenCalled();
  });
});
