import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_LIMITS,
  assessmentPolicySchema,
  assessmentWindowSchema,
  FOCUS_LIMIT_ACTIONS,
  LAB_NEEDS_ALLOWLIST_MESSAGE,
  mayAffectPlacement,
  PLACEMENT_PROCTOR_MODE,
  PLACEMENT_REQUIRES_LAB_MESSAGE,
  PROCTOR_MODES,
  requiresCidrAllowlist,
  type ProctorMode,
} from "../src/assessment";

/**
 * THE HARD RULE, at the server boundary (SPEC §5). The database half is
 * `Assessment_placement_requires_lab`, exercised in
 * packages/db/test/assessment-invariants.db.test.ts. Both halves are tested
 * because both exist for a reason: this one produces a sentence an admin can
 * act on, the CHECK makes the rule true of the data.
 */

const policy = (over: Partial<Record<string, unknown>> = {}) => ({
  proctorMode: "NONE" as ProctorMode,
  affectsPlacementEligibility: false,
  durationSec: 3600,
  maxAttempts: 1,
  maxFocusWarnings: 3,
  onLimit: "AUTOSUBMIT" as const,
  strictMode: false,
  ...over,
});

describe("the hard rule", () => {
  it("names exactly one mode, and it is LAB_SUPERVISED", () => {
    expect(PLACEMENT_PROCTOR_MODE).toBe("LAB_SUPERVISED");
  });

  it.each(PROCTOR_MODES.filter((m) => m !== "LAB_SUPERVISED"))(
    "refuses placement eligibility under %s",
    (mode) => {
      const result = assessmentPolicySchema.safeParse(
        policy({ proctorMode: mode, affectsPlacementEligibility: true }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]!.message).toBe(PLACEMENT_REQUIRES_LAB_MESSAGE);
        // Reported on the claim, not on the proctoring: the admin should be
        // told to drop the claim, not nudged into escalating surveillance.
        expect(result.error.issues[0]!.path).toEqual(["affectsPlacementEligibility"]);
      }
    },
  );

  it("refuses it under KIOSK_SEB specifically — SEB is the strongest software lockdown and still not enough", () => {
    expect(mayAffectPlacement("KIOSK_SEB")).toBe(false);
    expect(
      assessmentPolicySchema.safeParse(policy({ proctorMode: "KIOSK_SEB", affectsPlacementEligibility: true }))
        .success,
    ).toBe(false);
  });

  it("allows it under LAB_SUPERVISED", () => {
    expect(mayAffectPlacement("LAB_SUPERVISED")).toBe(true);
    expect(
      assessmentPolicySchema.safeParse(
        policy({ proctorMode: "LAB_SUPERVISED", affectsPlacementEligibility: true }),
      ).success,
    ).toBe(true);
  });

  it.each(PROCTOR_MODES)("allows %s when placement eligibility is off", (mode) => {
    expect(
      assessmentPolicySchema.safeParse(policy({ proctorMode: mode, affectsPlacementEligibility: false })).success,
    ).toBe(true);
  });
});

describe("no automatic voiding is even expressible", () => {
  it("offers exactly autosubmit and flag-only", () => {
    expect(FOCUS_LIMIT_ACTIONS).toEqual(["AUTOSUBMIT", "FLAG_ONLY"]);
  });

  it.each(["VOID", "VOIDED", "PENALISE", "TERMINATE", "ZERO"])("refuses onLimit %s", (action) => {
    expect(assessmentPolicySchema.safeParse(policy({ onLimit: action })).success).toBe(false);
  });
});

describe("bounds match the database CHECKs", () => {
  it.each([
    ["durationSec", ASSESSMENT_LIMITS.durationSec.min - 1],
    ["durationSec", ASSESSMENT_LIMITS.durationSec.max + 1],
    ["maxAttempts", ASSESSMENT_LIMITS.maxAttempts.min - 1],
    ["maxAttempts", ASSESSMENT_LIMITS.maxAttempts.max + 1],
    ["maxFocusWarnings", ASSESSMENT_LIMITS.maxFocusWarnings.min - 1],
    ["maxFocusWarnings", ASSESSMENT_LIMITS.maxFocusWarnings.max + 1],
  ])("refuses %s = %d", (field, value) => {
    expect(assessmentPolicySchema.safeParse(policy({ [field]: value })).success).toBe(false);
  });

  it.each([
    ["durationSec", ASSESSMENT_LIMITS.durationSec.min],
    ["durationSec", ASSESSMENT_LIMITS.durationSec.max],
    ["maxAttempts", ASSESSMENT_LIMITS.maxAttempts.max],
    ["maxFocusWarnings", ASSESSMENT_LIMITS.maxFocusWarnings.max],
  ])("accepts %s = %d (the boundary is inclusive)", (field, value) => {
    expect(assessmentPolicySchema.safeParse(policy({ [field]: value })).success).toBe(true);
  });

  it("refuses a non-integer duration", () => {
    expect(assessmentPolicySchema.safeParse(policy({ durationSec: 90.5 })).success).toBe(false);
  });
});

describe("the window", () => {
  it("must close after it opens", () => {
    const at = new Date("2026-12-01T10:00:00Z");
    expect(assessmentWindowSchema.safeParse({ opensAt: at, closesAt: at }).success).toBe(false);
    expect(
      assessmentWindowSchema.safeParse({ opensAt: at, closesAt: new Date(at.getTime() + 1) }).success,
    ).toBe(true);
  });
});

describe("the lab allowlist", () => {
  it("is required for a lab sitting and nothing else", () => {
    expect(requiresCidrAllowlist("LAB_SUPERVISED")).toBe(true);
    for (const mode of PROCTOR_MODES.filter((m) => m !== "LAB_SUPERVISED")) {
      expect(requiresCidrAllowlist(mode)).toBe(false);
    }
  });

  it("says why, not just that", () => {
    expect(LAB_NEEDS_ALLOWLIST_MESSAGE).toMatch(/leaves the lab network/i);
  });
});
