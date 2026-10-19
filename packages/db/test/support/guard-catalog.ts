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
  // 20261019160000_phase6b_attempt_engine
  "recx_refuse_attempt_change",
  "recx_refuse_snapshot_change",
  // 20261019220000_phase6d_containment
  "recx_refuse_excess_device",
  "recx_refuse_device_change",
  "recx_refuse_challenge_reuse",
  // 20261019240000_phase6e_review
  "recx_refuse_integrity_flag_change",
  "recx_refuse_review_change",
  "recx_refuse_appeal_change",
  "recx_refuse_message_change",
  "recx_refuse_termination_change",
  // 20261019250000_phase7a_question_bank
  "recx_refuse_published_question_change",
  // 20261019250200_phase7c_sitting
  "recx_refuse_mock_attempt_change",
  "recx_refuse_section_clock_change",
  "recx_refuse_closed_section_write",
  "recx_refuse_used_pattern_change",
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
  // 20261019160000_phase6b_attempt_engine
  "AssessmentAttempt",
  "AttemptSnapshot",
  // 20261019220000_phase6d_containment
  "DeviceRegistration",
  // 20261019240000_phase6e_review
  "IntegrityFlag",
  "IntegrityReview",
  "IntegrityAppeal",
  "AttemptTermination",
  // 20261019250000_phase7a_question_bank
  "AptitudePassage",
  "AptitudeQuestion",
  // 20261019250100_phase7b_patterns
  "MockPattern",
  "AptitudeSection",
  // 20261019250200_phase7c_sitting
  "MockAttempt",
  "MockSectionState",
  "MockAttemptAnswer",
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
  // 20261019160000_phase6b_attempt_engine
  {
    name: "AssessmentAttempt_machine",
    timing: "BEFORE UPDATE OR DELETE",
    table: "AssessmentAttempt",
    fn: "recx_refuse_attempt_change",
    level: "ROW",
  },
  {
    name: "AttemptSnapshot_append_only",
    timing: "BEFORE UPDATE",
    table: "AttemptSnapshot",
    fn: "recx_refuse_snapshot_change",
    level: "ROW",
  },
  // 20261019220000_phase6d_containment
  {
    name: "DeviceRegistration_device_limit",
    timing: "BEFORE INSERT OR UPDATE",
    table: "DeviceRegistration",
    fn: "recx_refuse_excess_device",
    level: "ROW",
  },
  {
    name: "DeviceRegistration_write_once",
    timing: "BEFORE UPDATE OR DELETE",
    table: "DeviceRegistration",
    fn: "recx_refuse_device_change",
    level: "ROW",
  },
  {
    name: "WebAuthnChallenge_single_use",
    timing: "BEFORE UPDATE",
    table: "WebAuthnChallenge",
    fn: "recx_refuse_challenge_reuse",
    level: "ROW",
  },
  // 20261019240000_phase6e_review
  {
    name: "IntegrityFlag_write_once",
    timing: "BEFORE UPDATE OR DELETE",
    table: "IntegrityFlag",
    fn: "recx_refuse_integrity_flag_change",
    level: "ROW",
  },
  {
    name: "IntegrityReview_append_only",
    timing: "BEFORE UPDATE OR DELETE",
    table: "IntegrityReview",
    fn: "recx_refuse_review_change",
    level: "ROW",
  },
  {
    name: "IntegrityAppeal_write_once",
    timing: "BEFORE UPDATE OR DELETE",
    table: "IntegrityAppeal",
    fn: "recx_refuse_appeal_change",
    level: "ROW",
  },
  {
    name: "InvigilatorMessage_write_once",
    timing: "BEFORE UPDATE OR DELETE",
    table: "InvigilatorMessage",
    fn: "recx_refuse_message_change",
    level: "ROW",
  },
  {
    name: "AttemptTermination_write_once",
    timing: "BEFORE UPDATE OR DELETE",
    table: "AttemptTermination",
    fn: "recx_refuse_termination_change",
    level: "ROW",
  },
  // 20261019250000_phase7a_question_bank
  {
    name: "AptitudeQuestion_published_immutable",
    timing: "BEFORE UPDATE OR DELETE",
    table: "AptitudeQuestion",
    fn: "recx_refuse_published_question_change",
    level: "ROW",
  },
  // 20261019250200_phase7c_sitting
  {
    name: "MockAttempt_written_once",
    timing: "BEFORE UPDATE OR DELETE",
    table: "MockAttempt",
    fn: "recx_refuse_mock_attempt_change",
    level: "ROW",
  },
  {
    name: "MockSectionState_clock_written_once",
    timing: "BEFORE UPDATE",
    table: "MockSectionState",
    fn: "recx_refuse_section_clock_change",
    level: "ROW",
  },
  // SPEC section 5's gate, in the data: allowBackNavigation: false enforced
  // server-side and not just in the UI.
  {
    name: "MockAttemptAnswer_closed_section",
    timing: "BEFORE INSERT OR UPDATE",
    table: "MockAttemptAnswer",
    fn: "recx_refuse_closed_section_write",
    level: "ROW",
  },
  {
    name: "AptitudeSection_pattern_frozen",
    timing: "BEFORE INSERT OR UPDATE OR DELETE",
    table: "AptitudeSection",
    fn: "recx_refuse_used_pattern_change",
    level: "ROW",
  },
  {
    name: "MockPattern_scoring_frozen",
    timing: "BEFORE UPDATE",
    table: "MockPattern",
    fn: "recx_refuse_used_pattern_change",
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
export const OTHER_TRIGGERS_ON_GUARDED_TABLES: ReadonlyArray<{ name: string; table: string }> = [
  /**
   * 20261019250100_phase7b_patterns. The one non-guard trigger in the
   * database: it MAINTAINS MockPattern's denormalised totals rather than
   * refusing a write, so a listing page never aggregates to render (SPEC
   * §4(d)'s rule generalised) and the totals cannot drift from the sections
   * they summarise. It is listed here rather than in GUARD_TRIGGERS because
   * a guard function must raise, and this one never does — `patternTotals()`
   * in @recx/shared is the same arithmetic, and the live invariant test
   * asserts the two agree on all six seeded patterns.
   */
  { name: "AptitudeSection_totals_sync", table: "AptitudeSection" },
];

/** The last migration whose CHECK constraints this list is complete for (later migrations add theirs here). */
export const CHECK_CATALOG_THROUGH = "20261019250200_phase7c_sitting";

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
  ...(
    [
      // ProctorEvent stores event SHAPE only; the size cap and the sha256
      // pattern are the structural half of "never clipboard text".
      ["ProctorEvent_atMs_check", "ProctorEvent"],
      ["ProctorEvent_size_check", "ProctorEvent"],
      ["ProctorEvent_duration_check", "ProctorEvent"],
      ["ProctorEvent_client_seq_check", "ProctorEvent"],
      ["ProctorEvent_client_seq_range_check", "ProctorEvent"],
      ["ProctorEvent_hash_check", "ProctorEvent"],
      ["AssessmentAttempt_number_check", "AssessmentAttempt"],
      ["AssessmentAttempt_window_check", "AssessmentAttempt"],
      ["AssessmentAttempt_paused_check", "AssessmentAttempt"],
      ["AssessmentAttempt_counts_check", "AssessmentAttempt"],
      ["AssessmentAttempt_score_check", "AssessmentAttempt"],
      ["AssessmentAttempt_integrity_check", "AssessmentAttempt"],
      ["AssessmentAttempt_slot_check", "AssessmentAttempt"],
      ["AssessmentAttempt_submitted_check", "AssessmentAttempt"],
      ["AttemptSnapshot_atMs_check", "AttemptSnapshot"],
      ["AttemptSnapshot_content_check", "AttemptSnapshot"],
      ["AttemptSnapshot_hash_check", "AttemptSnapshot"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019160000_phase6b_attempt_engine" })),
  ...(
    [
      // The heartbeat's sequence high-water mark (SEQUENCE_GAP detection).
      ["AssessmentAttempt_client_seq_check", "AssessmentAttempt"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019180000_phase6b_heartbeat" })),
  ...(
    [
      // The per-assessment randomisation secret must be a real secret.
      ["Assessment_seed_secret_check", "Assessment"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019200000_phase6c_seed_secret" })),
  ...(
    [
      // A credential id and a public key are handles, not payloads.
      ["DeviceRegistration_credential_check", "DeviceRegistration"],
      ["DeviceRegistration_public_key_check", "DeviceRegistration"],
      ["DeviceRegistration_aaguid_check", "DeviceRegistration"],
      ["DeviceRegistration_label_check", "DeviceRegistration"],
      ["DeviceRegistration_sign_count_check", "DeviceRegistration"],
      ["DeviceRegistration_loan_check", "DeviceRegistration"],
      ["DeviceRegistration_revoked_check", "DeviceRegistration"],
      ["DeviceRegistration_revoked_after_enrol_check", "DeviceRegistration"],
      ["WebAuthnChallenge_challenge_check", "WebAuthnChallenge"],
      ["WebAuthnChallenge_window_check", "WebAuthnChallenge"],
      ["WebAuthnChallenge_consumed_check", "WebAuthnChallenge"],
      ["AssessmentAttempt_seat_check", "AssessmentAttempt"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019220000_phase6d_containment" })),
  ...(
    [
      // A device is recorded only on a challenge that was actually spent.
      ["WebAuthnChallenge_device_check", "WebAuthnChallenge"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019230000_phase6d_assertion_device" })),
  ...(
    [
      // A flag withholds a result and orders a queue; it carries no score.
      ["IntegrityFlag_points_check", "IntegrityFlag"],
      ["IntegrityFlag_reviewers_check", "IntegrityFlag"],
      ["IntegrityFlag_band_check", "IntegrityFlag"],
      ["IntegrityFlag_deadline_check", "IntegrityFlag"],
      ["IntegrityFlag_resolved_check", "IntegrityFlag"],
      ["IntegrityFlag_withheld_check", "IntegrityFlag"],
      // The mandatory written rationale, with a floor that excludes "ok".
      ["IntegrityReview_rationale_check", "IntegrityReview"],
      ["IntegrityAppeal_reason_check", "IntegrityAppeal"],
      ["IntegrityAppeal_window_check", "IntegrityAppeal"],
      ["IntegrityAppeal_first_check", "IntegrityAppeal"],
      ["IntegrityAppeal_second_check", "IntegrityAppeal"],
      // Two people, and the same person twice is not two people.
      ["IntegrityAppeal_two_person_check", "IntegrityAppeal"],
      ["IntegrityAppeal_order_check", "IntegrityAppeal"],
      ["IntegrityAppeal_resolved_check", "IntegrityAppeal"],
      ["IntegrityAppeal_complete_check", "IntegrityAppeal"],
      ["InvigilatorMessage_body_check", "InvigilatorMessage"],
      ["InvigilatorMessage_ack_check", "InvigilatorMessage"],
      // Terminate takes a second staff member, as a CHECK and not a route.
      ["AttemptTermination_reason_check", "AttemptTermination"],
      ["AttemptTermination_two_person_check", "AttemptTermination"],
      ["AttemptTermination_confirmed_check", "AttemptTermination"],
      ["AttemptTermination_order_check", "AttemptTermination"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019240000_phase6e_review" })),
  ...(
    [
      // A passage shorter than 80 characters is a stem, not a passage.
      ["AptitudePassage_body_check", "AptitudePassage"],
      ["AptitudePassage_word_count_check", "AptitudePassage"],
      ["AptitudePassage_source_note_check", "AptitudePassage"],
      ["AptitudePassage_title_check", "AptitudePassage"],
      ["AptitudePassage_area_topic_check", "AptitudePassage"],
      ["AptitudeQuestion_display_code_check", "AptitudeQuestion"],
      ["AptitudeQuestion_stem_check", "AptitudeQuestion"],
      // SPEC section 5: worked explanations are mandatory, enforced at
      // publish — and enforced where a back-fill script cannot step around it.
      ["AptitudeQuestion_explanation_published", "AptitudeQuestion"],
      ["AptitudeQuestion_explanation_length", "AptitudeQuestion"],
      // A VERBAL question tagged MENSURATION would corrupt every blueprint
      // and every weakness heatmap. The mapping is immutable, so: a CHECK.
      ["AptitudeQuestion_area_topic_check", "AptitudeQuestion"],
      ["AptitudeQuestion_passage_kind", "AptitudeQuestion"],
      ["AptitudeQuestion_choice_shape", "AptitudeQuestion"],
      ["AptitudeQuestion_single_answer", "AptitudeQuestion"],
      ["AptitudeQuestion_multi_answer", "AptitudeQuestion"],
      ["AptitudeQuestion_numeric_shape", "AptitudeQuestion"],
      ["AptitudeQuestion_option_index_check", "AptitudeQuestion"],
      ["AptitudeQuestion_expected_seconds_check", "AptitudeQuestion"],
      ["AptitudeQuestion_content_hash_check", "AptitudeQuestion"],
      ["AptitudeQuestion_status_dates_check", "AptitudeQuestion"],
      ["AptitudeQuestionStat_counts_check", "AptitudeQuestionStat"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019250000_phase7a_question_bank" })),
  ...(
    [
      ["MockPattern_slug_check", "MockPattern"],
      ["MockPattern_source_note_check", "MockPattern"],
      ["MockPattern_description_check", "MockPattern"],
      ["MockPattern_totals_check", "MockPattern"],
      // A published pattern a student can open has a paper behind it, which
      // also refuses deleting the last section of a live one.
      ["MockPattern_published_has_paper", "MockPattern"],
      ["AptitudeSection_position_check", "AptitudeSection"],
      ["AptitudeSection_key_check", "AptitudeSection"],
      ["AptitudeSection_label_check", "AptitudeSection"],
      ["AptitudeSection_count_check", "AptitudeSection"],
      ["AptitudeSection_time_check", "AptitudeSection"],
      // Below twenty seconds a question the timer is the test.
      ["AptitudeSection_pace_check", "AptitudeSection"],
      ["AptitudeSection_cutoff_check", "AptitudeSection"],
      ["AptitudeSection_marks_check", "AptitudeSection"],
      // The negative mark is a fraction, never an absolute mark.
      ["AptitudeSection_negative_check", "AptitudeSection"],
      // The blueprint draws exactly as many questions as the section is long.
      ["AptitudeSection_topic_mix_check", "AptitudeSection"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019250100_phase7b_patterns" })),
  ...(
    [
      ["MockAttempt_window_check", "MockAttempt"],
      ["MockAttempt_number_check", "MockAttempt"],
      ["MockAttempt_section_position_check", "MockAttempt"],
      // totalRaw is NOT floored at zero: the honest total of a negatively
      // marked paper can be negative, and it is percent that is clamped.
      ["MockAttempt_score_check", "MockAttempt"],
      ["MockAttempt_finalised_check", "MockAttempt"],
      ["MockAttempt_version_check", "MockAttempt"],
      ["MockAttempt_layout_check", "MockAttempt"],
      ["MockSectionState_position_check", "MockSectionState"],
      ["MockSectionState_window_check", "MockSectionState"],
      // A section cannot close before it opens.
      ["MockSectionState_started_check", "MockSectionState"],
      ["MockSectionState_index_check", "MockSectionState"],
      ["MockSectionState_counts_check", "MockSectionState"],
      ["MockAttemptAnswer_position_check", "MockAttemptAnswer"],
      ["MockAttemptAnswer_shape_check", "MockAttemptAnswer"],
      ["MockAttemptAnswer_timing_check", "MockAttemptAnswer"],
      ["MockAttemptAnswer_graded_check", "MockAttemptAnswer"],
      // An unanswered question scores exactly zero, never a penalty — stated
      // in the data as well as in gradeAnswer().
      ["MockAttemptAnswer_blank_not_penalised", "MockAttemptAnswer"],
      ["AptitudeUserTopicStat_counts_check", "AptitudeUserTopicStat"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019250200_phase7c_sitting" })),
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
