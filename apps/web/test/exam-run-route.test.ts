import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/exam/[attemptId]/run — running the samples during a sitting
 * (Phase 12q, slice 5).
 *
 * The thing this guards is the gap the route closes. A candidate used to
 * have an editor, a clock and a Submit button, and no way to find out
 * whether their program compiled; Submit was the first time anybody found
 * out, which in a proctored exam is the worst possible moment. So the
 * refusals matter as much as the happy path: each one is a sentence a
 * candidate reads with a clock running, and "that run could not be
 * started" with no reason is the same dead end as having no Run at all.
 *
 * Two rules here are integrity rules, not conveniences, and both are
 * asserted below: the question and its VERSION come from the attempt's own
 * layout rather than from the request, and the snapshot is written BEFORE
 * anything is queued.
 */

const ATTEMPT = "att_1";
const QUESTION = "q_1";
const VERSION = "ver_pinned";

const h = vi.hoisted(() => ({
  requireActionUser: vi.fn(),
  guard: vi.fn(),
  endAttemptSession: vi.fn(),
  layoutOf: vi.fn(),
  paperLanguage: vi.fn(),
  writeSnapshot: vi.fn(),
  enqueue: vi.fn(),
  version: vi.fn(),
  config: vi.fn(),
  runCount: vi.fn(),
  runCreate: vi.fn(),
  runUpdateMany: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "session-token" }) }) }));
vi.mock("@/lib/auth/guards", () => ({ requireActionUser: h.requireActionUser }));
vi.mock("@/lib/db", () => ({
  db: {
    session: { findUnique: async () => ({ id: "sess_1" }) },
    problemVersion: { findUnique: h.version },
    languageConfig: { findFirst: h.config },
    runRequest: { count: h.runCount, create: h.runCreate, updateMany: h.runUpdateMany },
  },
}));
vi.mock("@/lib/exam/attempt", () => ({ guardAttempt: h.guard, endAttemptSession: h.endAttemptSession }));
vi.mock("@/lib/exam/layout", () => ({ attemptLayoutOf: h.layoutOf }));
vi.mock("@/lib/exam/language", () => ({ examPaperLanguage: h.paperLanguage }));
vi.mock("@/lib/exam/snapshots", () => ({ writeSnapshot: h.writeSnapshot }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: h.enqueue }));

const { POST } = await import("@/app/api/exam/[attemptId]/run/route");

function request(body: unknown): Request {
  return new Request(`http://localhost:3100/api/exam/${ATTEMPT}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const call = (body: unknown) => POST(request(body), { params: Promise.resolve({ attemptId: ATTEMPT }) });

const GOOD = { questionId: QUESTION, language: "cpp20", source: "int main(){}\n", atMs: 1_000 };

beforeEach(() => {
  vi.clearAllMocks();
  h.requireActionUser.mockResolvedValue({ id: "user_1" });
  h.guard.mockResolvedValue({
    ok: true,
    attempt: { id: ATTEMPT, assessmentId: "asm_1", startedAt: new Date("2026-10-31T10:00:00.000Z"), layout: {} },
    status: "IN_PROGRESS",
    msRemaining: 600_000,
    now: new Date(),
    sessionNotice: null,
    sessionId: "sess_1",
  });
  h.layoutOf.mockReturnValue({ questions: [{ questionId: QUESTION, problemVersionId: VERSION, sourcePosition: 1, points: 10, seed: 1 }] });
  h.paperLanguage.mockResolvedValue("cpp20");
  h.version.mockResolvedValue({ id: VERSION, _count: { testCases: 2 } });
  h.config.mockResolvedValue({ id: "cfg_1" });
  h.runCount.mockResolvedValue(0);
  h.runCreate.mockResolvedValue({ id: "run_1" });
  h.enqueue.mockResolvedValue(true);
  h.writeSnapshot.mockResolvedValue({ stored: true, whole: true, contentHash: "abc", count: 1 });
});

describe("a sitting's Run", () => {
  it("queues a run of the samples and gives the console its id", async () => {
    const res = await call(GOOD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run_1" });
    expect(h.enqueue).toHaveBeenCalledWith("run", "run_1", "RUN");
  });

  it("runs the samples, never a custom input", async () => {
    // An exam is not the place to go fishing with inputs of your own, and
    // leaving it out removes the question of what a candidate might learn.
    await call({ ...GOOD, customInput: "7\n" });
    expect(h.runCreate).not.toHaveBeenCalled();
    await call(GOOD);
    expect(h.runCreate.mock.calls[0]?.[0]?.data?.customInput).toBeNull();
  });

  it("judges the version the LAYOUT pins, not one the request names", async () => {
    // A sitting is pinned to frozen versions so a problem republished
    // mid-exam cannot change the question.
    await call({ ...GOOD, problemVersionId: "ver_somebody_elses" });
    expect(h.runCreate).not.toHaveBeenCalled();
    await call(GOOD);
    expect(h.runCreate.mock.calls[0]?.[0]?.data?.problemVersionId).toBe(VERSION);
  });

  it("snapshots with trigger RUN before anything is queued", async () => {
    // The trigger the snapshot API has accepted since Phase 6c and that
    // nothing ever sent. The timeline a reviewer reads should show what was
    // in the editor when it was run.
    const order: string[] = [];
    h.writeSnapshot.mockImplementation(async () => {
      order.push("snapshot");
      return { stored: true, whole: true, contentHash: "abc", count: 1 };
    });
    h.runCreate.mockImplementation(async () => {
      order.push("run");
      return { id: "run_1" };
    });
    await call(GOOD);
    expect(order).toEqual(["snapshot", "run"]);
    expect(h.writeSnapshot.mock.calls[0]?.[1]).toMatchObject({ trigger: "RUN", questionId: QUESTION });
  });

  it("refuses a question that is not on this paper", async () => {
    const res = await call({ ...GOOD, questionId: "q_elsewhere" });
    expect(res.status).toBe(404);
    expect(h.writeSnapshot).not.toHaveBeenCalled();
  });

  it("refuses a language the paper is not answered in", async () => {
    const res = await call({ ...GOOD, language: "py312" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("language this paper is answered in");
  });

  it("refuses an empty editor rather than queuing a compile error", async () => {
    const res = await call({ ...GOOD, source: "   \n" });
    expect(res.status).toBe(400);
    expect(h.runCreate).not.toHaveBeenCalled();
  });

  it("says so when the question has no samples to run", async () => {
    h.version.mockResolvedValue({ id: VERSION, _count: { testCases: 0 } });
    const res = await call(GOOD);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("no sample tests");
  });

  it("refuses a second run while one is still going, and says why", async () => {
    // The budget that matters: with it, a sitting of four hundred
    // candidates can add at most four hundred runs to the queue.
    h.runCount.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const res = await call(GOOD);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("still going");
    expect(h.runCreate).not.toHaveBeenCalled();
  });

  it("refuses once this question's run budget is spent", async () => {
    h.runCount.mockResolvedValueOnce(0).mockResolvedValueOnce(40);
    const res = await call(GOOD);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("Submit when you are ready");
  });

  it("answers 409 with the revoke reason when the sitting is over", async () => {
    // The same shape as a snapshot: the client should stop, not retry.
    h.guard.mockResolvedValue({ ok: false, reason: "submitted", message: "This sitting has been submitted." });
    const res = await call(GOOD);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ revokeReason: "submitted" });
    expect(h.endAttemptSession).toHaveBeenCalledWith(ATTEMPT, "submitted");
    expect(h.runCreate).not.toHaveBeenCalled();
  });

  it("leaves the row PENDING when Redis refused it, for the reconciler", async () => {
    h.enqueue.mockResolvedValue(false);
    const res = await call(GOOD);
    expect(res.status).toBe(200);
    expect(h.runUpdateMany).not.toHaveBeenCalled();
  });
});
