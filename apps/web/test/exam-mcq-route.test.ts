import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/exam/[attemptId]/mcq — recording one multiple-choice answer
 * (Phase 12r).
 *
 * "Save and next is enough" was the brief, and this is the whole of it:
 * no judge, no compile, an index and an upsert. Which makes the rules
 * worth pinning the ones about what a browser is allowed to claim —
 * because an MCQ answer is the one piece of exam work a candidate's own
 * page could forge outright if the server took its word for anything.
 */

const ATTEMPT = "att_1";
const MCQ = "m1";

const h = vi.hoisted(() => ({
  requireActionUser: vi.fn(),
  guard: vi.fn(),
  endAttemptSession: vi.fn(),
  layoutOf: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "session-token" }) }) }));
vi.mock("@/lib/auth/guards", () => ({ requireActionUser: h.requireActionUser }));
vi.mock("@/lib/db", () => ({
  db: {
    session: { findUnique: async () => ({ id: "sess_1" }) },
    assessmentMcqAnswer: { upsert: h.upsert },
  },
}));
vi.mock("@/lib/exam/attempt", () => ({ guardAttempt: h.guard, endAttemptSession: h.endAttemptSession }));
vi.mock("@/lib/exam/layout", () => ({ attemptLayoutOf: h.layoutOf }));

const { POST } = await import("@/app/api/exam/[attemptId]/mcq/route");

const call = (body: unknown) =>
  POST(
    new Request(`http://localhost:3100/api/exam/${ATTEMPT}/mcq`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ attemptId: ATTEMPT }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.requireActionUser.mockResolvedValue({ id: "user_1" });
  h.guard.mockResolvedValue({
    ok: true,
    attempt: { id: ATTEMPT, assessmentId: "asm_1", startedAt: new Date(), layout: {} },
    status: "IN_PROGRESS",
    msRemaining: 600_000,
    now: new Date(),
    sessionNotice: null,
    sessionId: "sess_1",
  });
  // Four options, shuffled for this candidate.
  h.layoutOf.mockReturnValue({
    v: 2,
    questions: [],
    mcqs: [{ mcqId: MCQ, sourcePosition: 1, points: 2, optionOrder: [2, 0, 3, 1] }],
  });
  h.upsert.mockResolvedValue({});
});

describe("recording a multiple-choice answer", () => {
  it("stores the position the candidate clicked", async () => {
    const res = await call({ mcqId: MCQ, chosenIndex: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, chosenIndex: 2 });
    expect(h.upsert.mock.calls[0]?.[0]).toMatchObject({
      create: { attemptId: ATTEMPT, mcqId: MCQ, chosenIndex: 2 },
      update: { chosenIndex: 2 },
    });
  });

  it("lets a candidate change their mind, which is what an upsert is for", async () => {
    // Ticking a box is not filing a submission. A paper that refused a
    // change of mind would be a worse paper.
    await call({ mcqId: MCQ, chosenIndex: 0 });
    await call({ mcqId: MCQ, chosenIndex: 3 });
    expect(h.upsert).toHaveBeenCalledTimes(2);
    expect(h.upsert.mock.calls[1]?.[0]?.update).toEqual({ chosenIndex: 3 });
  });

  it("refuses a question that is not on this candidate's paper", async () => {
    const res = await call({ mcqId: "m_elsewhere", chosenIndex: 0 });
    expect(res.status).toBe(404);
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("refuses an option the paper did not show them", async () => {
    // Four options, so index 4 does not exist. Taken from the LAYOUT, not
    // from the request, which is the only copy a browser cannot edit.
    const res = await call({ mcqId: MCQ, chosenIndex: 4 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not one of the options");
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("refuses a malformed answer rather than storing a guess", async () => {
    for (const body of [
      { mcqId: MCQ },
      { mcqId: MCQ, chosenIndex: -1 },
      { mcqId: MCQ, chosenIndex: 1.5 },
      { mcqId: MCQ, chosenIndex: 99 },
      { mcqId: "", chosenIndex: 0 },
      { mcqId: MCQ, chosenIndex: 0, extra: true },
    ]) {
      const res = await call(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("answers 409 with the revoke reason when the sitting is over", async () => {
    h.guard.mockResolvedValue({ ok: false, reason: "submitted", message: "This sitting has been submitted." });
    const res = await call({ mcqId: MCQ, chosenIndex: 0 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ revokeReason: "submitted" });
    expect(h.endAttemptSession).toHaveBeenCalledWith(ATTEMPT, "submitted");
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("refuses a paper that holds no MCQs at all", async () => {
    // A v1 layout: there is nothing here to answer.
    h.layoutOf.mockReturnValue({ v: 1, questions: [] });
    const res = await call({ mcqId: MCQ, chosenIndex: 0 });
    expect(res.status).toBe(404);
  });
});
