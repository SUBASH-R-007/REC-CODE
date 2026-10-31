import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Writing and reading editor snapshots (Phase 6c) — `src/lib/exam/snapshots.ts`.
 *
 * The diff arithmetic itself is proved in `packages/shared/test/exam-snapshot.test.ts`
 * (including a 200-round randomised round-trip). What is tested here is the
 * set of decisions this layer makes around it, each of which is a trade-off:
 * when NOT to store, when to store whole rather than as a delta, and what the
 * save-state pill is told — because "Saved" when nothing was saved is the one
 * thing an exam UI must never say.
 */

const ATTEMPT = "att_1";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const h = vi.hoisted(() => ({
  count: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    attemptSnapshot: { count: h.count, findFirst: h.findFirst, findMany: h.findMany, create: h.create },
  },
}));

const { writeSnapshot, readSnapshotTimeline } = await import("@/lib/exam/snapshots");
const { MAX_SNAPSHOTS_PER_ATTEMPT, SNAPSHOT_MAX_BYTES, diffLines, serialiseLinePatch } = await import("@recx/shared");

const STARTED = new Date("2026-10-19T10:00:00.000Z");
const NOW = new Date(STARTED.getTime() + 600_000);

const guard = {
  ok: true as const,
  attempt: { id: ATTEMPT, startedAt: STARTED } as never,
  status: "IN_PROGRESS" as never,
  msRemaining: 1,
  now: NOW,
  sessionNotice: null as never,
  sessionId: "sess_1",
};

const input = (over: Partial<Parameters<typeof writeSnapshot>[1]> = {}) => ({
  questionId: "q1",
  language: "cpp20",
  source: "int main(){}\n",
  trigger: "TICK" as const,
  atMs: 5_000,
  ...over,
});

/** What the create() call was given. */
const created = () => (h.create.mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined)?.data ?? {};

beforeEach(() => {
  vi.clearAllMocks();
  h.count.mockResolvedValue(0);
  h.findFirst.mockResolvedValue(null);
  h.findMany.mockResolvedValue([]);
  h.create.mockResolvedValue({ id: "snap_1" });
});

describe("writeSnapshot", () => {
  it("stores the first snapshot of a question whole", async () => {
    const result = await writeSnapshot(guard, input());
    expect(result).toMatchObject({ stored: true, whole: true, count: 1 });
    expect(created()).toMatchObject({ attemptId: ATTEMPT, questionId: "q1", isDiff: false, trigger: "TICK" });
    expect(created().content).toBe("int main(){}\n");
  });

  it("stores its sha256, so a reconstruction can be checked rather than trusted", async () => {
    const result = await writeSnapshot(guard, input());
    expect(result.contentHash).toBe(sha("int main(){}\n"));
    expect(created().contentHash).toBe(result.contentHash);
  });

  it("clamps the client's offset into the attempt", async () => {
    await writeSnapshot(guard, input({ atMs: 9_999_999 }));
    expect(created().atMs).toBe(605_000);
  });

  it("stores a later snapshot as a delta once a delta is actually smaller", async () => {
    // A realistic file. One edited line in 60 is where deltas pay off, and
    // where a 200-snapshot budget stops costing megabytes per candidate.
    const first = Array.from({ length: 60 }, (_, i) => `  int v${i} = ${i};`).join("\n");
    const second = first.replace("int v30 = 30;", "int v30 = 31;");
    h.findFirst.mockResolvedValue({ contentHash: sha(first) });
    h.findMany.mockResolvedValue([{ content: first, isDiff: false }]);

    const result = await writeSnapshot(guard, input({ source: second }));
    expect(result).toMatchObject({ stored: true, whole: false });
    expect(created().isDiff).toBe(true);
    // And the delta must rebuild the text exactly.
    expect(created().content).toBe(serialiseLinePatch(diffLines(first, second)));
    expect((created().content as string).length).toBeLessThan(second.length);
  });

  it("stores a tiny file whole, because a JSON patch for it is bigger than the file", async () => {
    // Not a special case to apologise for: for a 26-byte file the patch
    // envelope alone exceeds the text, so "whole" IS the smaller option and
    // the writer picks it by measuring rather than by a rule about size.
    const first = "int main(){}\n";
    const second = "int main(){\n  return 0;\n}\n";
    h.findFirst.mockResolvedValue({ contentHash: sha(first) });
    h.findMany.mockResolvedValue([{ content: first, isDiff: false }]);

    const result = await writeSnapshot(guard, input({ source: second }));
    expect(result).toMatchObject({ stored: true, whole: true });
    expect(created().content).toBe(second);
    expect(serialiseLinePatch(diffLines(first, second)).length).toBeGreaterThan(second.length);
  });

  it("does not store an unchanged file — the 30s tick fires while a candidate reads", async () => {
    const source = "int main(){}\n";
    h.findFirst.mockResolvedValue({ contentHash: sha(source) });
    const result = await writeSnapshot(guard, input({ source }));
    expect(result).toMatchObject({ stored: false, reason: "unchanged" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("refuses an oversized snapshot rather than truncating it", async () => {
    // A truncated snapshot is evidence of nothing, and would read as a
    // deletion in the timeline.
    const result = await writeSnapshot(guard, input({ source: "x".repeat(SNAPSHOT_MAX_BYTES + 1) }));
    expect(result).toMatchObject({ stored: false, reason: "too_large" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("measures the size in bytes, not characters", async () => {
    // A file of multi-byte characters just under the character limit is over
    // the byte limit, and Postgres stores bytes.
    const result = await writeSnapshot(guard, input({ source: "é".repeat(SNAPSHOT_MAX_BYTES - 10) }));
    expect(result.reason).toBe("too_large");
  });

  it("stops at the per-attempt cap and says so", async () => {
    h.count.mockResolvedValue(MAX_SNAPSHOTS_PER_ATTEMPT);
    const result = await writeSnapshot(guard, input({ source: "something new\n" }));
    expect(result).toMatchObject({ stored: false, reason: "capped" });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("still stores the one that reaches the cap", async () => {
    h.count.mockResolvedValue(MAX_SNAPSHOTS_PER_ATTEMPT - 1);
    const result = await writeSnapshot(guard, input());
    expect(result.stored).toBe(true);
    expect(result.count).toBe(MAX_SNAPSHOTS_PER_ATTEMPT);
  });

  it("prefers a whole snapshot when the delta would be no smaller", async () => {
    // A complete rewrite. Storing a patch that is longer than the text saves
    // nothing and makes the timeline harder to read.
    const first = "aaa\nbbb\nccc\n";
    const second = "zzz\n";
    h.findFirst.mockResolvedValue({ contentHash: sha(first) });
    h.findMany.mockResolvedValue([{ content: first, isDiff: false }]);
    const result = await writeSnapshot(guard, input({ source: second }));
    expect(result.whole).toBe(true);
    expect(created().content).toBe(second);
  });

  it("re-bases with a whole snapshot when the stored timeline cannot be rebuilt", async () => {
    // A candidate's work must be recorded even if an earlier row is corrupt.
    h.findFirst.mockResolvedValue({ contentHash: sha("whatever") });
    h.findMany.mockResolvedValue([{ content: "not a patch", isDiff: true }]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await writeSnapshot(guard, input({ source: "int x;\n" }));
    expect(result).toMatchObject({ stored: true, whole: true });
    expect(created().isDiff).toBe(false);
  });

  it("diffs against the question's own timeline, not the attempt's", async () => {
    await writeSnapshot(guard, input({ questionId: "q7" }));
    for (const call of [...h.findFirst.mock.calls, ...h.findMany.mock.calls]) {
      expect((call[0] as { where: Record<string, unknown> }).where).toMatchObject({
        attemptId: ATTEMPT,
        questionId: "q7",
      });
    }
  });

  it("records which trigger produced it", async () => {
    for (const trigger of ["TICK", "RUN", "SUBMIT", "PASTE"] as const) {
      vi.clearAllMocks();
      h.count.mockResolvedValue(0);
      h.findFirst.mockResolvedValue(null);
      h.create.mockResolvedValue({ id: "s" });
      await writeSnapshot(guard, input({ trigger }));
      expect(created().trigger).toBe(trigger);
    }
  });
});

describe("readSnapshotTimeline", () => {
  const versions = ["int a;\n", "int a;\nint b;\n", "int a;\nint b;\nint c;\n"];

  it("rebuilds every version and reports each as verified", async () => {
    h.findMany.mockResolvedValue([
      { atMs: 0, trigger: "TICK", language: "cpp20", content: versions[0], contentHash: sha(versions[0]!), isDiff: false },
      {
        atMs: 30_000,
        trigger: "TICK",
        language: "cpp20",
        content: serialiseLinePatch(diffLines(versions[0]!, versions[1]!)),
        contentHash: sha(versions[1]!),
        isDiff: true,
      },
      {
        atMs: 60_000,
        trigger: "SUBMIT",
        language: "cpp20",
        content: serialiseLinePatch(diffLines(versions[1]!, versions[2]!)),
        contentHash: sha(versions[2]!),
        isDiff: true,
      },
    ]);

    const timeline = await readSnapshotTimeline({ attemptId: ATTEMPT, questionId: "q1" });
    expect(timeline.map((v) => v.source)).toEqual(versions);
    expect(timeline.every((v) => v.verified)).toBe(true);
    expect(timeline[2]!.trigger).toBe("SUBMIT");
  });

  it("marks a version whose hash does not match, rather than presenting it as fact", async () => {
    // Shown to a student in their own report and in an appeal: a
    // reconstruction that does not check out must be visibly marked.
    h.findMany.mockResolvedValue([
      { atMs: 0, trigger: "TICK", language: "cpp20", content: "int a;\n", contentHash: sha("something else"), isDiff: false },
    ]);
    const timeline = await readSnapshotTimeline({ attemptId: ATTEMPT, questionId: "q1" });
    expect(timeline[0]!.verified).toBe(false);
    expect(timeline[0]!.source).toBe("int a;\n");
  });

  it("returns nothing for a question with no snapshots", async () => {
    h.findMany.mockResolvedValue([]);
    expect(await readSnapshotTimeline({ attemptId: ATTEMPT, questionId: "q1" })).toEqual([]);
  });

  it("reads oldest first, which is the order a timeline is read in", async () => {
    h.findMany.mockResolvedValue([]);
    await readSnapshotTimeline({ attemptId: ATTEMPT, questionId: "q1" });
    expect((h.findMany.mock.calls[0]![0] as { orderBy: unknown }).orderBy).toEqual([
      { atMs: "asc" },
      { createdAt: "asc" },
    ]);
  });
});
