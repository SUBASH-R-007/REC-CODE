import { describe, expect, it } from "vitest";
import {
  ANSWER_REFUSAL_MESSAGE,
  ANSWER_REFUSAL_REASONS,
  canAdvanceSection,
  canAnswer,
  canTransitionMock,
  FINALISED_MOCK_STATUSES,
  isFinalisedMock,
  nextServableIndex,
  servableIndexes,
  type AnswerContext,
} from "../src/mock-navigation";
import { MOCK_ATTEMPT_STATUSES } from "../src/mock-pattern";

/**
 * SPEC §5's second gate for this phase: "a test asserts
 * allowBackNavigation: false is enforced server-side, not just in the UI."
 *
 * This is the pure half. The server-action half is in
 * apps/web/test/aptitude-navigation.test.ts and the raw-SQL half is in
 * packages/db/test/mock-sitting-invariants.db.test.ts. Nothing in any of the
 * three renders anything.
 */

const context = (over: Partial<AnswerContext> = {}): AnswerContext => ({
  status: "IN_PROGRESS",
  attemptExpired: false,
  allowBackNavigation: true,
  index: 0,
  highWaterIndex: 0,
  sectionSubmittedAt: null,
  sectionEnded: false,
  ...over,
});

const reasonOf = (ctx: AnswerContext) => {
  const decision = canAnswer(ctx);
  return decision.allowed ? null : decision.reason;
};

describe("allowBackNavigation: false", () => {
  it("refuses a question behind the high-water mark", () => {
    expect(reasonOf(context({ allowBackNavigation: false, index: 2, highWaterIndex: 5 }))).toBe("no_back_navigation");
  });

  it("allows the question the candidate is on", () => {
    // `index === highWaterIndex` is the question in front of them, and it
    // stays editable until they move on. Refusing it would mean a candidate
    // could not change their mind about the question they are looking at.
    expect(canAnswer(context({ allowBackNavigation: false, index: 5, highWaterIndex: 5 })).allowed).toBe(true);
  });

  it("allows any earlier question when back navigation IS allowed", () => {
    expect(canAnswer(context({ allowBackNavigation: true, index: 0, highWaterIndex: 9 })).allowed).toBe(true);
  });

  it("refuses a question beyond what the server has served, either way", () => {
    for (const allowBackNavigation of [true, false]) {
      expect(reasonOf(context({ allowBackNavigation, index: 6, highWaterIndex: 5 }))).toBe("not_yet_served");
    }
  });
});

describe("a closed section", () => {
  it("refuses a write once it is submitted", () => {
    expect(reasonOf(context({ sectionSubmittedAt: new Date() }))).toBe("section_closed");
  });

  it("refuses a write once its clock has run out", () => {
    expect(reasonOf(context({ sectionEnded: true }))).toBe("section_closed");
  });

  it("refuses a submitted section even with back navigation on", () => {
    // docs/OPEN-QUESTIONS.md: back navigation is WITHIN the current section.
    // A section timer a candidate can re-enter is not a section timer.
    expect(reasonOf(context({ allowBackNavigation: true, sectionSubmittedAt: new Date(), index: 0, highWaterIndex: 3 }))).toBe(
      "section_closed",
    );
  });
});

describe("the order of the refusals", () => {
  it("tells a candidate whose time ran out that, not that they cannot go back", () => {
    // The first true thing is the most useful one; a refusal naming the wrong
    // cause reads as a bug.
    expect(
      reasonOf(context({ attemptExpired: true, allowBackNavigation: false, index: 0, highWaterIndex: 5 })),
    ).toBe("attempt_expired");
  });

  it("tells a candidate whose sitting is over that first of all", () => {
    expect(reasonOf(context({ status: "SUBMITTED", attemptExpired: true, sectionEnded: true }))).toBe(
      "attempt_finished",
    );
  });

  it("prefers a closed section to an out-of-range index", () => {
    expect(reasonOf(context({ sectionEnded: true, index: 99, highWaterIndex: 0 }))).toBe("section_closed");
  });
});

describe("every refusal has words a candidate can act on", () => {
  it("covers the whole closed set", () => {
    expect(Object.keys(ANSWER_REFUSAL_MESSAGE).sort()).toEqual([...ANSWER_REFUSAL_REASONS].sort());
  });

  it("never blames the candidate, and says their work is safe where it is", () => {
    for (const reason of ["section_closed", "attempt_expired"] as const) {
      expect(ANSWER_REFUSAL_MESSAGE[reason]).toMatch(/saved and scored/);
    }
    // And the back-navigation refusal points at where they were told.
    expect(ANSWER_REFUSAL_MESSAGE.no_back_navigation).toMatch(/cover page before you start/);
  });
});

describe("which question comes next", () => {
  it("moves forward and stops at the end of the section", () => {
    expect(nextServableIndex({ index: 0, questionCount: 3, allowBackNavigation: true, highWaterIndex: 0 })).toBe(1);
    expect(nextServableIndex({ index: 2, questionCount: 3, allowBackNavigation: true, highWaterIndex: 2 })).toBeNull();
  });

  it("never moves backwards when back navigation is off", () => {
    // A candidate who jumped to the high-water mark cannot be sent back by
    // asking for "next" from an earlier index.
    expect(nextServableIndex({ index: 1, questionCount: 10, allowBackNavigation: false, highWaterIndex: 7 })).toBe(7);
  });

  it("lists every reachable index with back navigation on", () => {
    expect(servableIndexes({ questionCount: 10, allowBackNavigation: true, highWaterIndex: 3 })).toEqual([0, 1, 2, 3]);
  });

  it("lists only the current question with it off", () => {
    expect(servableIndexes({ questionCount: 10, allowBackNavigation: false, highWaterIndex: 3 })).toEqual([3]);
  });

  it("lists nothing before the first question is served", () => {
    expect(servableIndexes({ questionCount: 0, allowBackNavigation: true, highWaterIndex: 0 })).toEqual([]);
  });

  it("never lists past the end of the section", () => {
    expect(servableIndexes({ questionCount: 3, allowBackNavigation: false, highWaterIndex: 9 })).toEqual([2]);
  });
});

describe("advancing a section", () => {
  it("is allowed while the paper is live and another section follows", () => {
    expect(canAdvanceSection({ status: "IN_PROGRESS", attemptExpired: false, hasNextSection: true }).allowed).toBe(true);
  });

  it("is allowed with questions left unanswered", () => {
    // A candidate who wants to move on is entitled to, and a blank costs them
    // nothing extra.
    expect(canAdvanceSection({ status: "IN_PROGRESS", attemptExpired: false, hasNextSection: true })).toEqual({
      allowed: true,
    });
  });

  it("is refused after the last section, and after the paper ends", () => {
    expect(canAdvanceSection({ status: "IN_PROGRESS", attemptExpired: false, hasNextSection: false }).allowed).toBe(
      false,
    );
    expect(canAdvanceSection({ status: "IN_PROGRESS", attemptExpired: true, hasNextSection: true }).reason).toBe(
      "attempt_expired",
    );
    expect(canAdvanceSection({ status: "SUBMITTED", attemptExpired: false, hasNextSection: true }).reason).toBe(
      "attempt_finished",
    );
  });
});

describe("the attempt status machine", () => {
  it("lets a sitting in progress finish in each of the three ways", () => {
    expect(canTransitionMock("IN_PROGRESS", "SUBMITTED")).toBe(true);
    expect(canTransitionMock("IN_PROGRESS", "AUTO_SUBMITTED")).toBe(true);
    expect(canTransitionMock("IN_PROGRESS", "ABANDONED")).toBe(true);
  });

  it("makes every finished state terminal", () => {
    // A finished sitting never restarts: its answers have been scored and its
    // XP written, and an XpEvent is permanent.
    for (const from of MOCK_ATTEMPT_STATUSES.filter((s) => s !== "IN_PROGRESS")) {
      for (const to of MOCK_ATTEMPT_STATUSES.filter((s) => s !== from)) {
        expect(canTransitionMock(from, to), `${from} → ${to}`).toBe(false);
      }
    }
  });

  it("treats a no-op as allowed, so an idempotent retry is not a violation", () => {
    for (const status of MOCK_ATTEMPT_STATUSES) expect(canTransitionMock(status, status)).toBe(true);
  });

  it("has no voiding transition to make, because the enum has no such value", () => {
    expect(MOCK_ATTEMPT_STATUSES).not.toContain("VOIDED");
    expect(MOCK_ATTEMPT_STATUSES).not.toContain("TERMINATED");
  });

  it("knows which statuses mean scored", () => {
    expect(FINALISED_MOCK_STATUSES).toEqual(["SUBMITTED", "AUTO_SUBMITTED"]);
    expect(isFinalisedMock("SUBMITTED")).toBe(true);
    expect(isFinalisedMock("AUTO_SUBMITTED")).toBe(true);
    // Abandoned is finished but NOT scored: nothing was finalised, so no
    // result and no XP.
    expect(isFinalisedMock("ABANDONED")).toBe(false);
    expect(isFinalisedMock("IN_PROGRESS")).toBe(false);
  });
});
