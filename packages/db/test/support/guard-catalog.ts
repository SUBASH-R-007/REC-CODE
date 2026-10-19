import { FROZEN_CHILD_MODELS } from "../../src/frozen";

/**
 * The database guards every migration must keep: guard functions, guard
 * triggers, hand-written CHECK constraints and the partial unique indexes
 * Prisma cannot model. frozen-coverage.test.ts checks the migration SQL
 * against this list (static, runs everywhere); guard-state.db.test.ts checks
 * the live database (RECX_DB_TESTS=1). Adding a guard to a migration means
 * adding it here.
 */

// Every guard function (a trigger function that refuses a write).
export const GUARD_FUNCTIONS = [
  // 20261009210810_init
  "recx_refuse_frozen_version_write",
  "recx_refuse_frozen_child_write",
  "recx_refuse_audit_update",
  // 20261010001004_phase3_student_surface
  "recx_refuse_xp_event_change",
  // 20261010100000_phase4_admin_authoring (the first two replaced in 20261010100050, 20261010100080 and 20261010100200)
  "recx_refuse_privileged_request_change",
  "recx_refuse_granted_accommodation_terms",
  "recx_refuse_born_frozen_version",
  "recx_refuse_test_blob_change",
  // 20261010100050_phase4_foundation_fixes (the first and fourth replaced in 20261010100080;
  // the third and fourth in 20261010100200)
  "recx_refuse_privileged_insert",
  "recx_refuse_admin_scope_change",
  "recx_refuse_impersonation_change",
  "recx_refuse_published_announcement_change",
  "recx_refuse_truncate",
  // 20261010100080_phase4_foundation_fixes_2 (the second replaced in 20261010100200)
  "recx_refuse_accommodation_insert",
  "recx_refuse_impersonation_insert",
  "recx_refuse_announcement_insert",
  // 20261019120000_phase5_contests
  "recx_refuse_contest_rating_rewrite",
  "recx_refuse_unfrozen_contest_problem",
  "recx_refuse_rating_change_write",
  // 20261019140000_phase6a_assessments
  "recx_refuse_published_assessment_change",
  "recx_refuse_unfrozen_assessment_problem",
  "recx_refuse_lab_session_without_allowlist",
] as const;
export type GuardFunction = (typeof GUARD_FUNCTIONS)[number];

/** Tables whose TRUNCATE is refused by a `<Table>_no_truncate` statement trigger. */
export const TRUNCATE_GUARDED: readonly string[] = [
  // 20261010100050_phase4_foundation_fixes
  "PrivilegedOperation",
  "Accommodation",
  "AdminScope",
  "ImpersonationSession",
  "ProblemVersion",
  ...[...FROZEN_CHILD_MODELS].sort(),
  "TestBlob",
  // 20261010100080_phase4_foundation_fixes_2
  "XpEvent",
  "AuditLog",
  "Announcement",
  // 20261019120000_phase5_contests
  "Contest",
  "ContestProblemAttempt",
  "ContestStanding",
  "RatingChange",
  // 20261019140000_phase6a_assessments
  "Assessment",
  "ExamSession",
];

export interface GuardTrigger {
  name: string;
  /** "BEFORE <EVENT> [OR <EVENT> …]", in the order the migration writes it. */
  timing: string;
  table: string;
  fn: GuardFunction;
  level: "ROW" | "STATEMENT";
  /** The only WHEN clause a guard trigger may have; absent = no WHEN clause at all. */
  when?: string;
}

/** Every guard trigger, with the definition it must keep. */
export const GUARD_TRIGGERS: readonly GuardTrigger[] = [
  { name: "ProblemVersion_frozen_guard", timing: "BEFORE UPDATE OR DELETE", table: "ProblemVersion", fn: "recx_refuse_frozen_version_write", level: "ROW" },
  ...[...FROZEN_CHILD_MODELS].sort().map(
    (m): GuardTrigger => ({
      name: `${m}_frozen_guard`,
      timing: "BEFORE INSERT OR UPDATE OR DELETE",
      table: m,
      fn: "recx_refuse_frozen_child_write",
      level: "ROW",
    }),
  ),
  { name: "AuditLog_append_only", timing: "BEFORE UPDATE", table: "AuditLog", fn: "recx_refuse_audit_update", level: "ROW" },
  { name: "XpEvent_append_only", timing: "BEFORE UPDATE OR DELETE", table: "XpEvent", fn: "recx_refuse_xp_event_change", level: "ROW" },
  {
    name: "PrivilegedOperation_request_immutable",
    timing: "BEFORE UPDATE OR DELETE",
    table: "PrivilegedOperation",
    fn: "recx_refuse_privileged_request_change",
    level: "ROW",
  },
  { name: "PrivilegedOperation_insert_pending", timing: "BEFORE INSERT", table: "PrivilegedOperation", fn: "recx_refuse_privileged_insert", level: "ROW" },
  {
    name: "Accommodation_granted_terms_immutable",
    timing: "BEFORE UPDATE OR DELETE",
    table: "Accommodation",
    fn: "recx_refuse_granted_accommodation_terms",
    level: "ROW",
  },
  { name: "Accommodation_insert_requested", timing: "BEFORE INSERT", table: "Accommodation", fn: "recx_refuse_accommodation_insert", level: "ROW" },
  {
    name: "ProblemVersion_born_frozen_guard",
    timing: "BEFORE INSERT",
    table: "ProblemVersion",
    fn: "recx_refuse_born_frozen_version",
    level: "ROW",
    when: 'NEW."frozenAt" IS NOT NULL',
  },
  { name: "TestBlob_immutable", timing: "BEFORE UPDATE", table: "TestBlob", fn: "recx_refuse_test_blob_change", level: "ROW" },
  { name: "AdminScope_grant_immutable", timing: "BEFORE UPDATE OR DELETE", table: "AdminScope", fn: "recx_refuse_admin_scope_change", level: "ROW" },
  {
    name: "ImpersonationSession_immutable",
    timing: "BEFORE UPDATE OR DELETE",
    table: "ImpersonationSession",
    fn: "recx_refuse_impersonation_change",
    level: "ROW",
  },
  {
    name: "ImpersonationSession_insert_window",
    timing: "BEFORE INSERT",
    table: "ImpersonationSession",
    fn: "recx_refuse_impersonation_insert",
    level: "ROW",
  },
  {
    name: "Announcement_published_immutable",
    timing: "BEFORE UPDATE OR DELETE",
    table: "Announcement",
    fn: "recx_refuse_published_announcement_change",
    level: "ROW",
  },
  { name: "Announcement_insert_draft", timing: "BEFORE INSERT", table: "Announcement", fn: "recx_refuse_announcement_insert", level: "ROW" },
  // 20261019120000_phase5_contests
  {
    name: "Contest_rating_once",
    timing: "BEFORE UPDATE",
    table: "Contest",
    fn: "recx_refuse_contest_rating_rewrite",
    level: "ROW",
  },
  {
    name: "ContestProblem_frozen_version",
    timing: "BEFORE INSERT OR UPDATE",
    table: "ContestProblem",
    fn: "recx_refuse_unfrozen_contest_problem",
    level: "ROW",
  },
  {
    name: "RatingChange_append_only",
    timing: "BEFORE UPDATE OR DELETE",
    table: "RatingChange",
    fn: "recx_refuse_rating_change_write",
    level: "ROW",
  },
  // 20261019140000_phase6a_assessments
  {
    name: "Assessment_published_immutable",
    timing: "BEFORE UPDATE OR DELETE",
    table: "Assessment",
    fn: "recx_refuse_published_assessment_change",
    level: "ROW",
  },
  {
    name: "AssessmentProblem_frozen_version",
    timing: "BEFORE INSERT OR UPDATE",
    table: "AssessmentProblem",
    fn: "recx_refuse_unfrozen_assessment_problem",
    level: "ROW",
  },
  {
    name: "ExamSession_lab_allowlist",
    timing: "BEFORE INSERT OR UPDATE",
    table: "ExamSession",
    fn: "recx_refuse_lab_session_without_allowlist",
    level: "ROW",
  },
  ...TRUNCATE_GUARDED.map(
    (t): GuardTrigger => ({ name: `${t}_no_truncate`, timing: "BEFORE TRUNCATE", table: t, fn: "recx_refuse_truncate", level: "STATEMENT" }),
  ),
];

/** Every table that has at least one guard trigger. */
export const GUARDED_TABLES: readonly string[] = [...new Set(GUARD_TRIGGERS.map((t) => t.table))].sort();

/**
 * Every trigger the live database may have on a guarded table: the guard
 * triggers, plus any ordinary trigger listed here by name. Today there is
 * none, so a new trigger on a guarded table (say a BEFORE UPDATE
 * "AdminScope_touch" that rewrites NEW before the guard sees it) fails both
 * fences until it is reviewed and listed.
 */
export const OTHER_TRIGGERS_ON_GUARDED_TABLES: ReadonlyArray<{ name: string; table: string }> = [];

/** The last migration whose CHECK constraints this list is complete for (later migrations add theirs here). */
export const CHECK_CATALOG_THROUGH = "20261019140000_phase6a_assessments";

/** Every hand-written CHECK constraint (Prisma generates none), by the migration that creates it. */
export const HAND_WRITTEN_CHECKS: ReadonlyArray<{ name: string; table: string; migration: string }> = [
  ...(
    [
      ["SubmissionSource_source_size_check", "SubmissionSource"],
      ["RunRequest_source_size_check", "RunRequest"],
      ["RunRequest_custom_input_size_check", "RunRequest"],
      ["TestBlob_inline_size_check", "TestBlob"],
      ["TestBlob_has_content_check", "TestBlob"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261009210810_init" })),
  { name: "UserJudgeUsage_nonnegative_check", table: "UserJudgeUsage", migration: "20261010000100_phase2_judge_hardening" },
  ...(
    [
      ["CodeDraft_source_size_check", "CodeDraft"],
      ["Note_content_size_check", "Note"],
      ["Hint_tier_check", "Hint"],
      ["UserProblemStatus_counts_check", "UserProblemStatus"],
      ["StudyPlanEnrollment_counts_check", "StudyPlanEnrollment"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261010001004_phase3_student_surface" })),
  ...(
    [
      ["PrivilegedOperation_two_person", "PrivilegedOperation"],
      ["PrivilegedOperation_expiry", "PrivilegedOperation"],
      ["ImpersonationSession_box", "ImpersonationSession"],
      ["ImpersonationSession_not_self", "ImpersonationSession"],
      ["Accommodation_extra_time_percent_check", "Accommodation"],
      ["Accommodation_extra_time_minutes_check", "Accommodation"],
      ["Accommodation_breaks_check", "Accommodation"],
      ["Accommodation_font_scale_check", "Accommodation"],
      ["Accommodation_kinds_nonempty_check", "Accommodation"],
      ["Accommodation_granted_check", "Accommodation"],
      ["Announcement_section_needs_cohort_check", "Announcement"],
      ["Announcement_title_len_check", "Announcement"],
      ["Announcement_body_len_check", "Announcement"],
      ["ProblemVersion_approval_state", "ProblemVersion"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261010100000_phase4_admin_authoring" })),
  ...(
    [
      ["PrivilegedOperation_decided_check", "PrivilegedOperation"],
      ["AdminScope_revoke_pair_check", "AdminScope"],
      ["Accommodation_granted_status_check", "Accommodation"],
      ["ImpersonationSession_end_pair_check", "ImpersonationSession"],
      ["ImpersonationSession_window_check", "ImpersonationSession"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261010100050_phase4_foundation_fixes" })),
  ...(
    [
      ["Accommodation_requested_undecided_check", "Accommodation"],
      ["Accommodation_granted_attribution_check", "Accommodation"],
      ["Accommodation_closed_attribution_check", "Accommodation"],
      ["Accommodation_revoke_pair_check", "Accommodation"],
      ["ImpersonationSession_end_after_start_check", "ImpersonationSession"],
      ["PrivilegedOperation_expires_after_request_check", "PrivilegedOperation"],
      ["PrivilegedOperation_decided_after_request_check", "PrivilegedOperation"],
      ["PrivilegedOperation_decision_pair_check", "PrivilegedOperation"],
      ["PrivilegedOperation_execution_started_check", "PrivilegedOperation"],
      ["PrivilegedOperation_executed_check", "PrivilegedOperation"],
      ["PrivilegedOperation_export_artifact_check", "PrivilegedOperation"],
      ["PrivilegedOperation_undecided_close_check", "PrivilegedOperation"],
      ["Announcement_publish_pair_check", "Announcement"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261010100080_phase4_foundation_fixes_2" })),
  ...(
    [
      ["ProblemVersion_function_comparator_declared", "ProblemVersion"],
      ["ProblemVersion_function_checker_mirror", "ProblemVersion"],
      ["ProblemVersion_checker_present_when_frozen", "ProblemVersion"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261010100100_function_comparator_checks" })),
  ...(
    [
      ["Accommodation_decided_after_request_check", "Accommodation"],
      ["Accommodation_granted_after_request_check", "Accommodation"],
      ["Announcement_draft_recipients_check", "Announcement"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261010100200_phase4_integration_hardening" })),
  ...(
    [
      // Contest: the window, the 90-minute freeze rule (kept identical to
      // canFreeze() in @recx/shared) and the rated rules.
      ["Contest_window_check", "Contest"],
      ["Contest_freeze_check", "Contest"],
      ["Contest_rated_check", "Contest"],
      ["Contest_rated_min_check", "Contest"],
      ["Contest_rated_participants_check", "Contest"],
      ["Contest_standings_version_check", "Contest"],
      ["Contest_slug_check", "Contest"],
      ["Contest_title_check", "Contest"],
      ["Contest_rules_check", "Contest"],
      ["ContestProblem_points_check", "ContestProblem"],
      ["ContestProblem_index_check", "ContestProblem"],
      ["ContestRegistration_virtual_check", "ContestRegistration"],
      // The authoritative attempt row: a solve names the submission that
      // earned it, and an unsolved problem carries no penalty.
      ["ContestProblemAttempt_counts_check", "ContestProblemAttempt"],
      ["ContestProblemAttempt_points_check", "ContestProblemAttempt"],
      ["ContestProblemAttempt_solved_check", "ContestProblemAttempt"],
      ["ContestProblemAttempt_solved_minutes_check", "ContestProblemAttempt"],
      ["ContestProblemAttempt_unsolved_penalty_check", "ContestProblemAttempt"],
      ["ContestStanding_rank_check", "ContestStanding"],
      ["ContestStanding_values_check", "ContestStanding"],
      // after = before + delta, and |delta| <= RATING_CLAMP.
      ["RatingChange_delta_check", "RatingChange"],
      ["RatingChange_values_check", "RatingChange"],
      ["UserRating_values_check", "UserRating"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019120000_phase5_contests" })),
  ...(
    [
      // THE HARD RULE (SPEC §5): a placement-bearing assessment must be
      // lab-proctored, enforced in the data and not only in the code path.
      ["Assessment_placement_requires_lab", "Assessment"],
      ["Assessment_window_check", "Assessment"],
      ["Assessment_duration_check", "Assessment"],
      ["Assessment_warnings_check", "Assessment"],
      ["Assessment_attempts_check", "Assessment"],
      ["Assessment_title_check", "Assessment"],
      ["Assessment_instructions_check", "Assessment"],
      ["Assessment_slug_check", "Assessment"],
      ["Assessment_audience_check", "Assessment"],
      ["AssessmentProblem_points_check", "AssessmentProblem"],
      ["AssessmentProblem_position_check", "AssessmentProblem"],
      ["ExamSession_window_check", "ExamSession"],
      ["ExamSession_capacity_check", "ExamSession"],
      ["ExamSession_label_check", "ExamSession"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019140000_phase6a_assessments" })),
];

/** The partial unique indexes Prisma cannot model (the drift check cannot see them either). */
export const PARTIAL_UNIQUE_INDEXES = [
  {
    name: "AdminScope_active_grant_key",
    table: "AdminScope",
    columns: ["adminId", "departmentCode", "batchYear"],
    nullsNotDistinct: true,
    where: String.raw`"revokedAt"\s+IS\s+NULL`,
  },
  {
    name: "Accommodation_one_approved_per_user",
    table: "Accommodation",
    columns: ["userId"],
    nullsNotDistinct: false,
    where: String.raw`"status"\s*=\s*'APPROVED'`,
  },
  {
    name: "Accommodation_one_open_request_per_user",
    table: "Accommodation",
    columns: ["userId"],
    nullsNotDistinct: false,
    where: String.raw`"status"\s*=\s*'REQUESTED'`,
  },
] as const;
