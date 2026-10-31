import { z } from "zod";

/**
 * Super-admin governance constants shared by apps/web and apps/scheduler.
 * Cross-process contracts only: no I/O, no Prisma, no secrets.
 */

// ── Retention (PlatformSetting "retention") ─────────────────────────────

/** PlatformSetting key whose value `{ legalHold: true }` suspends every purge. */
export const RETENTION_SETTING_KEY = "retention";

/**
 * Other keys pass through (later phases may add per-table overrides). Only
 * `legalHold` changes behaviour; the other three fields record who set it,
 * when (ISO string) and why.
 */
export const retentionSettingSchema = z
  .object({
    legalHold: z.boolean().optional(),
    legalHoldReason: z.string().max(500).optional(),
    legalHoldChangedAt: z.string().datetime().optional(),
    legalHoldChangedById: z.string().max(64).optional(),
  })
  .passthrough();
export type RetentionSetting = z.infer<typeof retentionSettingSchema>;

// ── Feature flags (PlatformSetting "flags") ─────────────────────────────

export const FLAGS_SETTING_KEY = "flags";

/** The closed flag registry: only the two governance kill switches. */
export const FEATURE_FLAGS = {
  impersonation: {
    default: true,
    label: "Impersonation",
    description: "Super-admins may start a read-only, 15-minute impersonation.",
  },
  breakGlassSelfApproval: {
    default: true,
    label: "Break-glass self-approval",
    description:
      "A super-admin may self-approve a privileged operation; SECURITY-audited and emailed to every super-admin.",
  },
} as const;
export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as FeatureFlagKey[];

export const featureFlagsSettingSchema = z.record(z.string(), z.boolean());

/**
 * Effective flag values for a stored setting. Unknown keys are ignored; a
 * missing or malformed value (or a non-boolean entry) falls back to the
 * registry default for that flag.
 */
export function effectiveFeatureFlags(value: unknown): Readonly<Record<FeatureFlagKey, boolean>> {
  const out = {} as Record<FeatureFlagKey, boolean>;
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  for (const key of FEATURE_FLAG_KEYS) {
    const stored = record[key];
    out[key] = typeof stored === "boolean" ? stored : FEATURE_FLAGS[key].default;
  }
  return Object.freeze(out);
}

// ── Limits ──────────────────────────────────────────────────────────────

export const IMPERSONATION_MAX_MS = 15 * 60_000;
export const IMPERSONATION_REASON_MIN = 20;
export const IMPERSONATION_REASON_MAX = 500;
export const PRIVILEGED_APPROVAL_TTL_MS = 24 * 3_600_000;
export const PRIVILEGED_EXECUTION_STALE_MS = 15 * 60_000;
export const BREAK_GLASS_JUSTIFICATION_MIN = 20;
export const BULK_STATUS_DIRECT_MAX = 25;
export const BULK_STATUS_MAX = 5_000;
export const GLOBAL_REJUDGE_MAX = 25_000;
export const PII_EXPORT_WINDOW_MS = 24 * 3_600_000;
export const PII_EXPORT_MAX_DOWNLOADS = 3;
/** A PII export names its accounts at request time; at most this many (narrow the filter beyond it). */
export const PII_EXPORT_MAX_ACCOUNTS = 10_000;

// ── Email outbox and scheduler jobs ─────────────────────────────────────

/** Outbox kinds starting with this prefix are security mail (a failed delivery is SECURITY-audited). */
export const SECURITY_EMAIL_KIND_PREFIX = "security.";
export const MAIL_TRANSPORTS = ["smtp", "log", "disabled"] as const;
export type MailTransportName = (typeof MAIL_TRANSPORTS)[number];

/**
 * How often the contest rank job re-ranks a live board (SPEC §4e: "rank is
 * recomputed by ONE job every 15 seconds"). The scheduler loop ticks every
 * RECONCILER_INTERVAL_MS, so the job itself enforces this cadence.
 */
export const CONTEST_RANK_INTERVAL_MS = 15_000;

export const SCHEDULER_JOB_NAMES = [
  "reconciler",
  "dailyChallenge",
  "leaderboardFreeze",
  "outbox",
  "governance",
  "contestRank",
  "attemptSweep",
  "integritySla",
  "mockSweep",
  "inactivitySweep",
  "readinessSnapshot",
] as const;
export type SchedulerJobName = (typeof SCHEDULER_JOB_NAMES)[number];
