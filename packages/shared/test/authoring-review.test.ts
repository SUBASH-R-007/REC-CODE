import { describe, expect, it } from "vitest";
import { REVIEW_ACTIONS, REVIEW_STAGES, planReviewTransition, reviewStageOf } from "../src/authoring/review";

const NOW = new Date("2026-10-10T05:00:00.000Z");

describe("reviewStageOf", () => {
  const problem = { status: "PUBLISHED" as const, liveVersionId: "live" };

  it("derives DRAFT, IN_REVIEW and APPROVED from an unfrozen version", () => {
    expect(reviewStageOf({ id: "v", status: "DRAFT", approvedAt: null, frozenAt: null }, problem)).toBe("DRAFT");
    expect(reviewStageOf({ id: "v", status: "IN_REVIEW", approvedAt: null, frozenAt: null }, problem)).toBe("IN_REVIEW");
    expect(reviewStageOf({ id: "v", status: "IN_REVIEW", approvedAt: NOW, frozenAt: null }, problem)).toBe("APPROVED");
    expect(reviewStageOf({ id: "v", status: "IN_REVIEW", approvedAt: NOW.toISOString(), frozenAt: null }, problem)).toBe("APPROVED");
  });

  it("derives PUBLISHED, SUPERSEDED and RETIRED from a frozen version", () => {
    expect(reviewStageOf({ id: "live", status: "PUBLISHED", approvedAt: NOW, frozenAt: NOW }, problem)).toBe("PUBLISHED");
    expect(reviewStageOf({ id: "old", status: "PUBLISHED", approvedAt: NOW, frozenAt: NOW }, problem)).toBe("SUPERSEDED");
    const retired = { status: "RETIRED" as const, liveVersionId: "live" };
    expect(reviewStageOf({ id: "live", status: "PUBLISHED", approvedAt: NOW, frozenAt: NOW }, retired)).toBe("RETIRED");
    expect(reviewStageOf({ id: "old", status: "PUBLISHED", approvedAt: null, frozenAt: NOW }, retired)).toBe("SUPERSEDED");
  });
});

describe("planReviewTransition", () => {
  const table: Record<string, Record<string, string | null>> = {
    SUBMIT: { DRAFT: "IN_REVIEW" },
    WITHDRAW: { IN_REVIEW: "DRAFT", APPROVED: "DRAFT" },
    RETURN: { IN_REVIEW: "DRAFT", APPROVED: "DRAFT" },
    APPROVE: { IN_REVIEW: "APPROVED" },
    REVOKE: { APPROVED: "IN_REVIEW" },
    PUBLISH: { APPROVED: "PUBLISHED" },
    RETIRE: { PUBLISHED: "RETIRED" },
  };

  it("allows exactly the lifecycle DRAFT → IN_REVIEW → APPROVED → PUBLISHED → RETIRED and its returns", () => {
    for (const action of REVIEW_ACTIONS) {
      for (const stage of REVIEW_STAGES) {
        const expected = table[action]?.[stage] ?? null;
        const plan = planReviewTransition(stage, action);
        if (expected) expect(plan, `${action} from ${stage}`).toEqual({ ok: true, next: expected });
        else expect(plan.ok, `${action} from ${stage}`).toBe(false);
      }
    }
  });

  it("explains a refusal in words", () => {
    const plan = planReviewTransition("DRAFT", "APPROVE");
    expect(plan).toMatchObject({ ok: false });
    if (!plan.ok) expect(plan.reason).toMatch(/cannot approve a revision that is draft; it must be in review/);
    const publish = planReviewTransition("IN_REVIEW", "PUBLISH");
    if (!publish.ok) expect(publish.reason).toMatch(/must be approved/);
  });
});
