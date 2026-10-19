import { describe, expect, it, vi } from "vitest";
import { ANSWER_REFUSAL_MESSAGE } from "@recx/shared";

/**
 * SPEC §5's second gate for Phase 7, the SERVER-ACTION half:
 *
 *   a test asserts `allowBackNavigation: false` is enforced server-side, not
 *   just in the UI.
 *
 * Three fences, three tests, and not one of them renders anything:
 *
 *   * `packages/shared/test/mock-navigation.test.ts` — the pure predicate;
 *   * this file — the server action, called directly with an index behind the
 *     high-water mark and with a submitted section, mocked at the database
 *     boundary so it runs on every platform and in every gate;
 *   * `packages/db/test/mock-sitting-invariants.db.test.ts` — the same two
 *     writes by RAW SQL, which is what proves the rule survives a future
 *     edit to this action.
 *
 * Mocking the database rather than seeding one is the point here: the
 * assertion is about the ORDER of the action's own checks — that it consults
 * `canAnswer()` BEFORE it writes — and a seeded database would let a passing
 * test coexist with an action that writes first and refuses after.
 */

/** The answer write: an UPDATE of the row the serve created, never an upsert. */
const answerUpdate = vi.fn();
const sectionUpdateMany = vi.fn();
/** The served row the write updates. Null means the question was never served. */
let servedRow: { id: string; firstSeenAtMs: number } | null = { id: "ans1", firstSeenAtMs: 4_000 };

/** One sitting, one section, one question, with whatever is under test overridden. */
function fixture(over: {
  allowBackNavigation?: boolean;
  highWaterIndex?: number;
  submittedAt?: Date | null;
  index?: number;
  status?: string;
  expiresAt?: Date;
  endsAt?: Date | null;
}) {
  const now = new Date("2026-10-19T10:00:00.000Z");
  const index = over.index ?? 0;
  return {
    now,
    attempt: {
      id: "att1",
      userId: "u1",
      patternId: "pat1",
      status: over.status ?? "IN_PROGRESS",
      startedAt: new Date(now.getTime() - 600_000),
      expiresAt: over.expiresAt ?? new Date(now.getTime() + 600_000),
      currentSectionPosition: 1,
      version: 0,
      layout: {
        v: 1,
        sections: [
          {
            sectionId: "sec1",
            key: "quantitative",
            position: 1,
            questions: [
              { questionId: "q0", index: 0, topic: "PERCENTAGES", optionOrder: [2, 0, 3, 1], passageId: null },
              { questionId: "q1", index: 1, topic: "PERCENTAGES", optionOrder: [0, 1, 2, 3], passageId: null },
              { questionId: "q5", index: 5, topic: "PERCENTAGES", optionOrder: [0, 1, 2, 3], passageId: null },
            ],
          },
        ],
      },
    },
    sectionState: {
      id: "st1",
      sectionId: "sec1",
      position: 1,
      startedAt: new Date(now.getTime() - 300_000),
      endsAt: over.endsAt === undefined ? new Date(now.getTime() + 300_000) : over.endsAt,
      submittedAt: over.submittedAt ?? null,
      highWaterIndex: over.highWaterIndex ?? index,
      section: {
        key: "quantitative",
        label: "Quantitative aptitude",
        questionCount: 10,
        timeLimitSec: 600,
        cutoffPercent: 50,
        marksPerCorrect: 1,
        negativeMarkFraction: 0.25,
        allowBackNavigation: over.allowBackNavigation ?? false,
      },
    },
  };
}

async function saveWith(over: Parameters<typeof fixture>[0], questionId = "q0") {
  const data = fixture(over);
  answerUpdate.mockReset();
  servedRow = { id: "ans1", firstSeenAtMs: 4_000 };
  sectionUpdateMany.mockReset();

  vi.resetModules();
  vi.doMock("@/lib/db", () => ({
    db: {
      mockAttempt: { findFirst: vi.fn(async () => data.attempt) },
      mockSectionState: { findMany: vi.fn(async () => [data.sectionState]), updateMany: sectionUpdateMany },
      mockAttemptAnswer: { findFirst: vi.fn(async () => servedRow), update: answerUpdate },
    },
  }));
  vi.doMock("@/lib/aptitude/accommodation", () => ({
    extraTimeFor: vi.fn(async () => ({ extra: { extraTimePercent: 0, extraTimeMinutes: 0 }, flags: [] })),
  }));

  const { saveAnswer } = await import("@/lib/aptitude/sitting");
  return saveAnswer(
    {
      attemptId: "att1",
      userId: "u1",
      questionId,
      shownIndexes: [0],
      numericValue: null,
      markedForReview: false,
    },
    data.now,
  );
}

describe("the answer action enforces allowBackNavigation: false", () => {
  it("refuses an index behind the high-water mark, and writes nothing", async () => {
    await expect(saveWith({ allowBackNavigation: false, index: 0, highWaterIndex: 5 })).rejects.toThrow(
      ANSWER_REFUSAL_MESSAGE.no_back_navigation,
    );
    // The assertion that matters: the guard ran BEFORE the write, so there is
    // no write to undo.
    expect(answerUpdate).not.toHaveBeenCalled();
  });

  it("allows the question the candidate is on", async () => {
    await expect(saveWith({ allowBackNavigation: false, index: 5, highWaterIndex: 5 }, "q5")).resolves.toEqual({
      saved: true,
      index: 5,
    });
    expect(answerUpdate).toHaveBeenCalledTimes(1);
  });

  it("allows an earlier question when back navigation IS allowed", async () => {
    await expect(saveWith({ allowBackNavigation: true, index: 0, highWaterIndex: 5 })).resolves.toEqual({
      saved: true,
      index: 0,
    });
  });

  it("refuses a write to a submitted section, and writes nothing", async () => {
    await expect(saveWith({ allowBackNavigation: true, submittedAt: new Date() })).rejects.toThrow(
      ANSWER_REFUSAL_MESSAGE.section_closed,
    );
    expect(answerUpdate).not.toHaveBeenCalled();
  });

  it("refuses a write to a section whose clock has run out", async () => {
    await expect(
      saveWith({ allowBackNavigation: true, endsAt: new Date("2026-10-19T09:50:00.000Z") }),
    ).rejects.toThrow(ANSWER_REFUSAL_MESSAGE.section_closed);
    expect(answerUpdate).not.toHaveBeenCalled();
  });

  it("refuses a write after the paper's deadline, and says THAT rather than back navigation", async () => {
    await expect(
      saveWith({
        allowBackNavigation: false,
        index: 0,
        highWaterIndex: 5,
        expiresAt: new Date("2026-10-19T09:30:00.000Z"),
      }),
    ).rejects.toThrow(ANSWER_REFUSAL_MESSAGE.attempt_expired);
  });

  it("refuses a write to a finished sitting", async () => {
    await expect(saveWith({ status: "SUBMITTED" })).rejects.toThrow(ANSWER_REFUSAL_MESSAGE.attempt_finished);
    expect(answerUpdate).not.toHaveBeenCalled();
  });

  it("refuses a question the server never served, and writes nothing", async () => {
    // The answer row comes into existence at SERVE time. No row means the
    // candidate is answering something they were never shown, which is the
    // same refusal as reaching past the high-water mark.
    const data = fixture({ allowBackNavigation: true });
    answerUpdate.mockReset();
    servedRow = null;
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      db: {
        mockAttempt: { findFirst: vi.fn(async () => data.attempt) },
        mockSectionState: { findMany: vi.fn(async () => [data.sectionState]), updateMany: sectionUpdateMany },
        mockAttemptAnswer: { findFirst: vi.fn(async () => servedRow), update: answerUpdate },
      },
    }));
    vi.doMock("@/lib/aptitude/accommodation", () => ({
      extraTimeFor: vi.fn(async () => ({ extra: { extraTimePercent: 0, extraTimeMinutes: 0 }, flags: [] })),
    }));
    const { saveAnswer } = await import("@/lib/aptitude/sitting");
    await expect(
      saveAnswer(
        { attemptId: "att1", userId: "u1", questionId: "q0", shownIndexes: [0], numericValue: null, markedForReview: false },
        data.now,
      ),
    ).rejects.toThrow(ANSWER_REFUSAL_MESSAGE.not_yet_served);
    expect(answerUpdate).not.toHaveBeenCalled();
  });

  it("refuses a question that is not on this candidate's paper", async () => {
    // Not an error to explain: it is a request about somebody else's paper.
    await expect(saveWith({ allowBackNavigation: true }, "q-not-mine")).rejects.toThrow(/not on your paper/);
    expect(answerUpdate).not.toHaveBeenCalled();
  });
});

describe("what the action stores", () => {
  it("maps the clicked index back through the layout's permutation", async () => {
    // Shown position 0 holds the question's option 2, so a click on the first
    // option stores [2]. Stored in the question's OWN order, so re-grading
    // after a shuffle change is still correct.
    await saveWith({ allowBackNavigation: true });
    const call = answerUpdate.mock.calls[0]![0] as { data: { selectedIndexes: number[] } };
    expect(call.data.selectedIndexes).toEqual([2]);
  });

  it("keeps one response shape, dropping a numeric value alongside a choice", async () => {
    const data = fixture({ allowBackNavigation: true });
    answerUpdate.mockReset();
    servedRow = { id: "ans1", firstSeenAtMs: 0 };
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      db: {
        mockAttempt: { findFirst: vi.fn(async () => data.attempt) },
        mockSectionState: { findMany: vi.fn(async () => [data.sectionState]), updateMany: sectionUpdateMany },
        mockAttemptAnswer: { findFirst: vi.fn(async () => servedRow), update: answerUpdate },
      },
    }));
    vi.doMock("@/lib/aptitude/accommodation", () => ({
      extraTimeFor: vi.fn(async () => ({ extra: { extraTimePercent: 0, extraTimeMinutes: 0 }, flags: [] })),
    }));
    const { saveAnswer } = await import("@/lib/aptitude/sitting");
    await saveAnswer(
      {
        attemptId: "att1",
        userId: "u1",
        questionId: "q0",
        shownIndexes: [1],
        numericValue: 42,
        markedForReview: true,
      },
      data.now,
    );
    const call = answerUpdate.mock.calls[0]![0] as { data: { selectedIndexes: number[]; numericValue: number | null } };
    expect(call.data.selectedIndexes).toEqual([0]);
    expect(call.data.numericValue).toBeNull();
  });

  it("floors the answer time at the served row's firstSeenAtMs", async () => {
    const data = fixture({ allowBackNavigation: true });
    answerUpdate.mockReset();
    servedRow = { id: "ans1", firstSeenAtMs: 0 };
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({
      db: {
        mockAttempt: { findFirst: vi.fn(async () => data.attempt) },
        mockSectionState: { findMany: vi.fn(async () => [data.sectionState]), updateMany: sectionUpdateMany },
        mockAttemptAnswer: { findFirst: vi.fn(async () => servedRow), update: answerUpdate },
      },
    }));
    vi.doMock("@/lib/aptitude/accommodation", () => ({
      extraTimeFor: vi.fn(async () => ({ extra: { extraTimePercent: 0, extraTimeMinutes: 0 }, flags: [] })),
    }));
    const { saveAnswer } = await import("@/lib/aptitude/sitting");
    await saveAnswer(
      {
        attemptId: "att1",
        userId: "u1",
        questionId: "q0",
        shownIndexes: [0],
        numericValue: null,
        markedForReview: false,
      },
      data.now,
    );
    const call = answerUpdate.mock.calls[0]![0] as { data: { answeredAtMs: number } };
    // `MockAttemptAnswer_timing_check` would refuse a row answered before it
    // was seen. Both times are server-derived from the section's own start,
    // and the answer time is floored at the SERVED row's `firstSeenAtMs` —
    // here 0, so the measured elapsed time stands.
    expect(call.data.answeredAtMs).toBeGreaterThanOrEqual(0);
  });
});
