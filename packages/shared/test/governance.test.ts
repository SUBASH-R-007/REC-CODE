import { describe, expect, it } from "vitest";
import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  RETENTION_SETTING_KEY,
  SCHEDULER_JOB_NAMES,
  effectiveFeatureFlags,
  retentionSettingSchema,
} from "../src/index";

describe("feature flags", () => {
  it("default when nothing is stored, or the value is malformed", () => {
    const defaults = Object.fromEntries(FEATURE_FLAG_KEYS.map((k) => [k, FEATURE_FLAGS[k].default]));
    expect(effectiveFeatureFlags(undefined)).toEqual(defaults);
    expect(effectiveFeatureFlags(null)).toEqual(defaults);
    expect(effectiveFeatureFlags("on")).toEqual(defaults);
    expect(effectiveFeatureFlags([true])).toEqual(defaults);
  });

  it("use stored booleans, ignore unknown keys and non-boolean values", () => {
    expect(effectiveFeatureFlags({ impersonation: false, breakGlassSelfApproval: "no", rogue: true })).toEqual({
      impersonation: false,
      breakGlassSelfApproval: true,
    });
  });

  it("is a closed registry of the two governance kill switches, frozen", () => {
    expect(FEATURE_FLAG_KEYS).toEqual(["impersonation", "breakGlassSelfApproval"]);
    expect(Object.isFrozen(effectiveFeatureFlags({}))).toBe(true);
  });
});

describe("retention setting", () => {
  it("keeps the scheduler's key", () => {
    expect(RETENTION_SETTING_KEY).toBe("retention");
  });

  it("accepts the old shape and the new legal-hold fields, passing other keys through", () => {
    expect(retentionSettingSchema.parse({ legalHold: true })).toEqual({ legalHold: true });
    expect(
      retentionSettingSchema.parse({
        legalHold: false,
        legalHoldReason: "Audit by the university",
        legalHoldChangedAt: "2026-10-10T08:00:00.000Z",
        legalHoldChangedById: "user_1",
        perTable: { x: 1 },
      }),
    ).toMatchObject({ legalHold: false, perTable: { x: 1 } });
  });

  it("refuses a non-boolean hold or a non-ISO timestamp", () => {
    expect(retentionSettingSchema.safeParse({ legalHold: "yes" }).success).toBe(false);
    expect(retentionSettingSchema.safeParse({ legalHoldChangedAt: "yesterday" }).success).toBe(false);
  });
});

describe("scheduler jobs", () => {
  it("lists the jobs /super/jobs reports on", () => {
    expect(SCHEDULER_JOB_NAMES).toEqual([
      "reconciler",
      "dailyChallenge",
      "leaderboardFreeze",
      "outbox",
      "governance",
      // Phase 5: the only writer of ContestStanding.rank.
      "contestRank",
      // Phase 6b: auto-submit at the deadline and the 45-second presence
      // sweep. The only automatic action in the system runs here.
      "attemptSweep",
      // Phase 6e: the 72-hour review SLA and the 7-day appeal deadline, both
      // of which resolve in the student's favour.
      "integritySla",
      // Phase 7c: finalise a mock whose deadline has passed — the only path
      // to AUTO_SUBMITTED — and restate each pattern's cohort statistics
      // nightly, which is what decides whether the mock XP percentile term is
      // meaningful yet.
      "mockSweep",
      // Phase 8c: the inactivity sweep. A DRY RUN in this slice — it counts,
      // applies the holdbacks and reports, and writes nothing to User,
      // AccountRestriction or AccountStatusEvent. It appears here so
      // /super/jobs shows it and a tick that stops running is visible, which
      // is the point of shipping the dry run first.
      "inactivitySweep",
    ]);
  });
});
