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
  // 20261019260000_phase8a_calendar
  "recx_refuse_past_calendar_day_change",
  "recx_refuse_leave_terms_change",
  // 20261019260100_phase8b_policy
  "recx_refuse_inactivity_policy_change",
  // 20261019260200_phase8c_restriction
  "recx_refuse_account_status_event_change",
  "recx_refuse_system_disable",
  "recx_refuse_stage_jump",
  "recx_refuse_sweep_with_open_attempt",
  "recx_refuse_restriction_without_event",
  // 20261020270000_phase9b_readiness
  "recx_refuse_snapshot_identity_change",
  "recx_refuse_mentor_assignment_change",
  "recx_refuse_unsuitable_mentor",
  "recx_refuse_placement_export_change",
  "recx_refuse_eligibility_change",
  "recx_refuse_eligibility_without_audit",
  "recx_refuse_profile_export_change",
  // 20261027190048_phase11a_password_reset
  "recx_refuse_password_reset_change",
  // 20261030094500_phase12b_ai_helper
  "recx_refuse_ai_assist_change",
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
  // 20261019250400_phase7d_import
  "AptitudeImport",
  "AptitudeImportRow",
  // 20261019260000_phase8a_calendar
  "CalendarDay",
  "LeaveException",
  // 20261019260100_phase8b_policy
  "InactivityPolicy",
  // 20261019260200_phase8c_restriction
  "AccountRestriction",
  "AccountStatusEvent",
  // 20261020270000_phase9b_readiness
  "ReadinessRun",
  "ReadinessSnapshot",
  "MentorAssignment",
  // 20261020270100_phase9e_placement_export
  "PlacementExport",
  // 20261020270200_phase9f_drives_exports
  "PlacementDrive",
  "DriveEligibilityDecision",
  "ProfileExport",
  // 20261030094500_phase12b_ai_helper
  "AiAssist",
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
  /**
   * The columns an `UPDATE OF` clause limits this guard to.
   *
   * Absent means the guard sees EVERY write, which is what a guard normally
   * must do — a guard limited to some columns is a guard that misses writes
   * to the others, and the live fence refuses one by default.
   *
   * It is listed, with a reason, only where the limit is the point: a role
   * check that fired on the end-of-assignment write would refuse an ordinary
   * close, and one that fired on every edit would read the mentor's User row
   * on writes that cannot change it. Naming the columns here means widening
   * or narrowing them fails the fence rather than passing silently.
   */
  updateOf?: readonly string[];
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
  /**
   * 20261019260000_phase8a_calendar. A past calendar day is frozen because
   * Phase 8c evidence rows cite days BY DATE: editing one rewrites the
   * explanation of a decision already taken. Today and the future stay
   * editable — a calendar is planned and revised ahead, which is the point of
   * having one — so the guard tests the date rather than carrying a WHEN
   * clause (a WHEN clause here would be frozen at trigger-creation time,
   * which is the opposite of what "past" means).
   */
  { name: "CalendarDay_past_immutable", timing: "BEFORE UPDATE OR DELETE", table: "CalendarDay", fn: "recx_refuse_past_calendar_day_change", level: "ROW" },
  /**
   * The TERMS of a leave, not only its status. A leave approved for three
   * days in October and later widened to three weeks in November would
   * retroactively excuse an absence nobody approved — and the evidence row
   * citing it would still cite it.
   */
  { name: "LeaveException_terms_immutable", timing: "BEFORE UPDATE", table: "LeaveException", fn: "recx_refuse_leave_terms_change", level: "ROW" },
  /**
   * 20261019260100_phase8b_policy. Every column but `isActive` is frozen and
   * DELETE is refused outright, because a Phase 8c event cites
   * `policyVersion` as the rules it was decided under. If the cited row could
   * be edited the evidence would quietly become a lie — the strongest
   * possible version of "the system disabled me and nobody can say why".
   */
  { name: "InactivityPolicy_version_immutable", timing: "BEFORE UPDATE OR DELETE", table: "InactivityPolicy", fn: "recx_refuse_inactivity_policy_change", level: "ROW" },
  /**
   * 20261019260200_phase8c_restriction. The status history is what an appeal
   * reads, so it is append-only in the same shape as XpEvent: `notifiedAt`
   * moves from NULL to a value exactly once (the job has to record that it
   * told somebody), and nothing else ever changes.
   */
  { name: "AccountStatusEvent_append_only", timing: "BEFORE UPDATE OR DELETE", table: "AccountStatusEvent", fn: "recx_refuse_account_status_event_change", level: "ROW" },
  /**
   * §0's "no account is hard-disabled by a cron job", expressed where no code
   * path can route around it: a sweep row reaching DISABLED is refused unless
   * the policy version it cites has autoDisableEnabled. With the shipped
   * default (false) the DATABASE refuses it — a future job, a future
   * migration and a future psql session all hit the same refusal.
   */
  { name: "AccountStatusEvent_system_disable_opt_in", timing: "BEFORE INSERT", table: "AccountStatusEvent", fn: "recx_refuse_system_disable", level: "ROW" },
  /** One rung per escalation; a drop to NONE is always allowed. */
  { name: "AccountStatusEvent_single_step", timing: "BEFORE INSERT", table: "AccountStatusEvent", fn: "recx_refuse_stage_jump", level: "ROW" },
  /** Never escalate a student who is sitting an assessment right now. */
  { name: "AccountStatusEvent_no_sweep_mid_attempt", timing: "BEFORE INSERT", table: "AccountStatusEvent", fn: "recx_refuse_sweep_with_open_attempt", level: "ROW" },
  /**
   * 20261020270000_phase9b_readiness. A snapshot is RECOMPUTED, never
   * edited: the nightly job may overwrite the computed columns for the same
   * (student, day), but the row never moves to another student or another
   * day and `rulesVersion` never goes backwards — a row whose rules version
   * regressed would be a row whose stored components no longer explain its
   * score, which is the one thing the breakdown exists to prevent.
   */
  { name: "ReadinessSnapshot_recompute_only", timing: "BEFORE UPDATE", table: "ReadinessSnapshot", fn: "recx_refuse_snapshot_identity_change", level: "ROW" },
  /** Re-assigning a mentor is an end plus a new row, so the history of who was asked survives it. */
  { name: "MentorAssignment_immutable", timing: "BEFORE UPDATE OR DELETE", table: "MentorAssignment", fn: "recx_refuse_mentor_assignment_change", level: "ROW" },
  /**
   * A PLACEMENT_OFFICER may never be the mentor of record, and neither may a
   * student. SPEC §5's at-risk list exists to route a student AWAY from the
   * analytics surface and towards a person who teaches them, so the person
   * it routes to must not be the one reading the dashboard.
   *
   * The `UPDATE OF "mentorId"` clause is part of the definition this
   * fence pins: a trigger widened to plain UPDATE would fire on every edit
   * (including the end-of-assignment write), and one that lost the column
   * would let a mentorId change slip past.
   */
  {
    name: "MentorAssignment_mentor_is_not_student_or_officer",
    timing: 'BEFORE INSERT OR UPDATE OF "mentorId"',
    table: "MentorAssignment",
    fn: "recx_refuse_unsuitable_mentor",
    level: "ROW",
    // The one catalogued column scope in the database. See `updateOf`.
    updateOf: ["mentorId"],
  },
  /**
   * 20261020270100_phase9e_placement_export. An export record is append-only:
   * one that could be edited after the fact would be a record of nothing,
   * and one that could be deleted would let the person who exported a whole
   * cohort remove the evidence that they did.
   */
  {
    name: "PlacementExport_append_only",
    timing: "BEFORE UPDATE OR DELETE",
    table: "PlacementExport",
    fn: "recx_refuse_placement_export_change",
    level: "ROW",
  },
  /**
   * 20261020270200_phase9f_drives_exports. A decision is never edited and
   * never deleted: changing one is a NEW decision with its own reason, so
   * "we reviewed it and changed our minds" and "we never said that" are not
   * the same row.
   */
  {
    name: "DriveEligibilityDecision_append_only",
    timing: "BEFORE UPDATE OR DELETE",
    table: "DriveEligibilityDecision",
    fn: "recx_refuse_eligibility_change",
    level: "ROW",
  },
  /**
   * A signature over a mutable payload verifies nothing, so everything but
   * the revocation is frozen — and the revocation may be set once, because
   * un-revoking would let somebody re-publish a record the student had
   * pulled back.
   */
  {
    name: "ProfileExport_payload_frozen",
    timing: "BEFORE UPDATE OR DELETE",
    table: "ProfileExport",
    fn: "recx_refuse_profile_export_change",
    level: "ROW",
  },
  ...TRUNCATE_GUARDED.map(
    (t): GuardTrigger => ({ name: `${t}_no_truncate`, timing: "BEFORE TRUNCATE", table: t, fn: "recx_refuse_truncate", level: "STATEMENT" }),
  ),
  { name: "PasswordReset_spend_once", timing: "BEFORE UPDATE", table: "PasswordReset", fn: "recx_refuse_password_reset_change", level: "ROW" },
  /**
   * An AI answer is what makes a later solve ASSISTED, and ASSISTED is what
   * keeps that solve out of the unassisted evidence readiness is built on.
   * A row that could be edited or deleted would let the XP and the readiness
   * number resting on it be re-written after the fact.
   */
  { name: "AiAssist_append_only", timing: "BEFORE UPDATE OR DELETE", table: "AiAssist", fn: "recx_refuse_ai_assist_change", level: "ROW" },
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
   * 20261019260200_phase8c_restriction. A CONSTRAINT trigger, DEFERRABLE
   * INITIALLY DEFERRED and with an UPDATE OF clause, so it does not fit the
   * GUARD_TRIGGERS shape — but it DOES raise, and it is the thing that makes
   * "every automatic decision carries its evidence" true of the state and not
   * only of the history: a stage set by hand with no event does not commit.
   * `DEFERRED_CONSTRAINT_TRIGGERS` below pins its definition.
   */
  { name: "AccountRestriction_requires_event", table: "AccountRestriction" },

  /**
   * 20261020270200_phase9f_drives_exports. The same animal, for the same
   * reason: SPEC §5 says eligibility is "a human decision recorded in the
   * audit log", and this is that sentence where no code path can route
   * around it — at COMMIT, the decision and its AuditLog row either both
   * exist or neither does. Deferred because the audit chain takes a per-day
   * advisory lock and appends with its own hash link, so the two writes
   * cannot be ordered without one waiting on the other.
   */
  { name: "DriveEligibilityDecision_requires_audit", table: "DriveEligibilityDecision" },

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
export const CHECK_CATALOG_THROUGH = "20261101120500_phase12k_sql_checks";

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
  { name: "ActivityDay_aptitude_check", table: "ActivityDay", migration: "20261019250300_phase7c_activity" },
  ...(
    [
      ["AptitudeImport_counts_check", "AptitudeImport"],
      ["AptitudeImport_file_check", "AptitudeImport"],
      ["AptitudeImport_via_check", "AptitudeImport"],
      ["AptitudeImport_finished_check", "AptitudeImport"],
      // A whole-file failure says why, and only a FAILED import has one.
      ["AptitudeImport_error_check", "AptitudeImport"],
      ["AptitudeImportRow_line_check", "AptitudeImportRow"],
      // A FAILED row says why — every reason, as a non-empty list.
      ["AptitudeImportRow_errors_check", "AptitudeImportRow"],
      ["AptitudeImportRow_applied_check", "AptitudeImportRow"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019250400_phase7d_import" })),
  ...(
    [
      ["CalendarDay_label_check", "CalendarDay"],
      ["LeaveException_range_check", "LeaveException"],
      ["LeaveException_reason_check", "LeaveException"],
      ["LeaveException_decision_pair_check", "LeaveException"],
      ["LeaveException_rejection_note_check", "LeaveException"],
      ["LeaveException_two_person_check", "LeaveException"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019260000_phase8a_calendar" })),
  ...(
    [
      ["InactivityPolicy_threshold_order_check", "InactivityPolicy"],
      ["InactivityPolicy_grace_check", "InactivityPolicy"],
      ["InactivityPolicy_min_activity_check", "InactivityPolicy"],
      ["InactivityPolicy_auto_disable_check", "InactivityPolicy"],
      ["InactivityPolicy_scope_check", "InactivityPolicy"],
      ["InactivityPolicy_counts_as_activity_check", "InactivityPolicy"],
      ["InactivityPolicy_parent_email_check", "InactivityPolicy"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019260100_phase8b_policy" })),
  ...(
    [
      ["AccountRestriction_counted_check", "AccountRestriction"],
      ["AccountRestriction_self_cleared_check", "AccountRestriction"],
      ["AccountRestriction_grace_check", "AccountRestriction"],
      ["AccountRestriction_none_check", "AccountRestriction"],
      ["AccountRestriction_owns_status_check", "AccountRestriction"],
      ["AccountRestriction_review_check", "AccountRestriction"],
      ["AccountStatusEvent_change_check", "AccountStatusEvent"],
      ["AccountStatusEvent_evidence_object_check", "AccountStatusEvent"],
      ["AccountStatusEvent_actor_check", "AccountStatusEvent"],
      ["AccountStatusEvent_manual_reason_check", "AccountStatusEvent"],
      ["AccountStatusEvent_system_policy_check", "AccountStatusEvent"],
      ["AccountStatusEvent_evaluation_date_check", "AccountStatusEvent"],
      ["AccountStatusEvent_system_evidence_check", "AccountStatusEvent"],
      ["AccountStatusEvent_clear_evidence_check", "AccountStatusEvent"],
      ["AccountStatusEvent_undisable_check", "AccountStatusEvent"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261019260200_phase8c_restriction" })),
  ...(
    [
      ["ReadinessRun_window_check", "ReadinessRun"],
      ["ReadinessRun_ok_check", "ReadinessRun"],
      ["ReadinessRun_version_check", "ReadinessRun"],
      ["ReadinessRun_stats_check", "ReadinessRun"],
      ["ReadinessSnapshot_score_range", "ReadinessSnapshot"],
      ["ReadinessSnapshot_weight_range", "ReadinessSnapshot"],
      ["ReadinessSnapshot_score_le_available", "ReadinessSnapshot"],
      ["ReadinessSnapshot_null_when_unmeasurable", "ReadinessSnapshot"],
      ["ReadinessSnapshot_breadth_range", "ReadinessSnapshot"],
      ["ReadinessSnapshot_breadth_pairs", "ReadinessSnapshot"],
      ["ReadinessSnapshot_cohort_check", "ReadinessSnapshot"],
      ["ReadinessSnapshot_components_object", "ReadinessSnapshot"],
      ["MentorAssignment_not_self", "MentorAssignment"],
      ["MentorAssignment_end_pair", "MentorAssignment"],
      ["MentorAssignment_reason_check", "MentorAssignment"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261020270000_phase9b_readiness" })),
  ...(
    [
      ["PlacementExport_columns_check", "PlacementExport"],
      ["PlacementExport_sha256_check", "PlacementExport"],
      ["PlacementExport_filters_object", "PlacementExport"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261020270100_phase9e_placement_export" })),
  ...(
    [
      ["PlacementDrive_company_check", "PlacementDrive"],
      ["PlacementDrive_threshold_check", "PlacementDrive"],
      ["PlacementDrive_batch_check", "PlacementDrive"],
      ["DriveEligibilityDecision_reason_present", "DriveEligibilityDecision"],
      ["ProfileExport_revoke_pair", "ProfileExport"],
      ["ProfileExport_expiry_after_issue", "ProfileExport"],
      ["ProfileExport_payload_object", "ProfileExport"],
      ["ProfileExport_code_check", "ProfileExport"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261020270200_phase9f_drives_exports" })),
  ...(
    [
      ["PasswordReset_window_check", "PasswordReset"],
      ["PasswordReset_consumed_check", "PasswordReset"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261027190048_phase11a_password_reset" })),
  // 20261029164131_phase11f_initial_password
  {
    name: "User_must_change_password_check",
    table: "User",
    migration: "20261029164131_phase11f_initial_password",
  },
  // 20261029185421_phase12a_assessment_proctored
  {
    name: "Assessment_proctored_check",
    table: "Assessment",
    migration: "20261029185421_phase12a_assessment_proctored",
  },
  ...(
    [
      // The assistant is a practice tool, said in the data and not only at
      // the boundary; an answer exists exactly when the ask did not fail.
      ["AiAssist_practice_only_check", "AiAssist"],
      ["AiAssist_answer_pair_check", "AiAssist"],
      ["AiAssist_answer_size_check", "AiAssist"],
      ["AiAssist_usage_check", "AiAssist"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261030094500_phase12b_ai_helper" })),
  ...(
    [
      // The schedule is the only explanation a student gets for why a
      // problem is in front of them today, and the product builds that
      // sentence out of these columns.
      ["RevisionCard_stage_check", "RevisionCard"],
      ["RevisionCard_counts_check", "RevisionCard"],
      ["RevisionCard_review_pair_check", "RevisionCard"],
      ["RevisionCard_learned_check", "RevisionCard"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261030150000_phase12c_spaced_revision" })),
  ...(
    [
      // Each of these is something a student or a moderator is TOLD, so a
      // row that breaks it makes the product lie rather than misbehave.
      ["DiscussionPost_hidden_pair_check", "DiscussionPost"],
      ["DiscussionPost_body_size_check", "DiscussionPost"],
      ["DiscussionPost_hidden_reason_size_check", "DiscussionPost"],
      ["DiscussionPost_not_own_parent_check", "DiscussionPost"],
      ["DiscussionPost_shared_code_check", "DiscussionPost"],
      ["DoubtThread_title_size_check", "DoubtThread"],
      ["DoubtThread_body_size_check", "DoubtThread"],
      ["DoubtThread_answered_pair_check", "DoubtThread"],
      ["DoubtReply_body_size_check", "DoubtReply"],
      ["ContentReport_one_target_check", "ContentReport"],
      ["ContentReport_detail_size_check", "ContentReport"],
      ["ContentReport_resolved_pair_check", "ContentReport"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261030170000_phase12d_discussion" })),
  ...(
    [
      // The archive's rows are a public claim about a named company, so
      // each CHECK holds up something a reader is told about one.
      ["InterviewExperience_decided_pair_check", "InterviewExperience"],
      ["InterviewExperience_author_check", "InterviewExperience"],
      ["InterviewExperience_held_check", "InterviewExperience"],
      ["InterviewExperience_rounds_check", "InterviewExperience"],
      ["InterviewExperience_duration_check", "InterviewExperience"],
      ["InterviewExperience_company_name_check", "InterviewExperience"],
      ["InterviewExperience_role_check", "InterviewExperience"],
      ["InterviewExperience_reason_size_check", "InterviewExperience"],
      ["InterviewExperience_round_kinds_check", "InterviewExperience"],
      // Phase 1 created the column; this is the migration that starts
      // moving it, so it is the one that has to say it is a count.
      ["ProblemCompanyTag_frequency_check", "ProblemCompanyTag"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261030200000_phase12e_interview_archive" })),
  ...(
    [
      // The lifecycle written down: a slot's status and its columns are
      // what both people on the page are told, so a row where the two
      // disagree is the product lying to one of them.
      ["MockInterview_candidate_pair_check", "MockInterview"],
      ["MockInterview_timing_check", "MockInterview"],
      ["MockInterview_cancel_pair_check", "MockInterview"],
      ["MockInterview_cancel_reason_size_check", "MockInterview"],
      ["MockInterview_duration_check", "MockInterview"],
      ["MockInterview_feedback_pair_check", "MockInterview"],
      ["MockInterview_rating_range_check", "MockInterview"],
      ["MockInterview_feedback_size_check", "MockInterview"],
      ["MockInterview_not_self_check", "MockInterview"],
      ["MockInterviewSnapshot_source_size_check", "MockInterviewSnapshot"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261031000000_phase12h_mock_interviews" })),
  ...(
    [
      // Nothing here runs code, so these CHECKs carry the weight a judge
      // carries elsewhere: a mark is whole or it does not exist, and a
      // student is never shown half of one.
      ["WrittenPrompt_status_pair_check", "WrittenPrompt"],
      ["WrittenPrompt_title_size_check", "WrittenPrompt"],
      ["WrittenPrompt_body_size_check", "WrittenPrompt"],
      ["WrittenPrompt_time_box_check", "WrittenPrompt"],
      ["WrittenCriterion_weight_check", "WrittenCriterion"],
      ["WrittenCriterion_label_size_check", "WrittenCriterion"],
      ["WrittenCriterion_order_check", "WrittenCriterion"],
      ["WrittenAnswer_body_size_check", "WrittenAnswer"],
      ["WrittenAnswer_submitted_pair_check", "WrittenAnswer"],
      ["WrittenAnswer_graded_pair_check", "WrittenAnswer"],
      ["WrittenAnswer_score_range_check", "WrittenAnswer"],
      ["WrittenAnswer_overall_size_check", "WrittenAnswer"],
      ["WrittenAnswer_hand_back_pair_check", "WrittenAnswer"],
      ["WrittenAnswer_not_self_check", "WrittenAnswer"],
      ["WrittenMark_points_check", "WrittenMark"],
      ["WrittenMark_note_size_check", "WrittenMark"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261101000000_phase12i_written_answers" })),
  ...(
    [
      // Phase 12k. One column answers "which engine judges this?" either
      // way round, and a SQL version carries neither a function signature
      // nor a checker — both would be read by rules that do not apply to a
      // result-set comparison.
      ["ProblemVersion_sql_mode_mirror", "ProblemVersion"],
      ["ProblemVersion_sql_fields_pair", "ProblemVersion"],
      ["ProblemVersion_sql_no_signature", "ProblemVersion"],
      ["ProblemVersion_sql_no_checker", "ProblemVersion"],
    ] as const
  ).map(([name, table]) => ({ name, table, migration: "20261101120500_phase12k_sql_checks" })),
];

/**
 * EXCLUDE constraints. Prisma cannot model one, the drift check cannot see
 * one, and `uncataloguedChecks` does not either — an EXCLUDE is `contype =
 * 'x'`, not `'c'` — so without this list a gist constraint could be dropped
 * by a later migration and every fence would stay green. That is the exact
 * failure mode this file exists to prevent.
 */
export const EXCLUSION_CONSTRAINTS = [
  {
    name: "LeaveException_no_overlapping_approved",
    table: "LeaveException",
    migration: "20261019260000_phase8a_calendar",
    /** The operator classes, in the order the migration writes them. */
    using: "gist",
    /**
     * Each element, written to match BOTH readings: the migration's own SQL
     * and `pg_get_constraintdef`, which renders the same constraint with
     * casts the migration never wrote (`'[]'::text`, `'APPROVED'::"LeaveStatus"`).
     * One catalogue entry serving the static fence and the live one is the
     * point — two spellings of the same rule is how they drift apart.
     */
    elements: [
      String.raw`"?userId"?\s+WITH\s+=`,
      String.raw`daterange\("?startDate"?,\s*"?endDate"?,\s*'\[\]'(?:::text)?\)\s+WITH\s+&&`,
    ],
    where: String.raw`"?status"?\s*=\s*'APPROVED'`,
  },
] as const;

/**
 * CONSTRAINT triggers, which are a different animal from the row triggers in
 * GUARD_TRIGGERS: they fire at COMMIT rather than at statement time, they
 * carry an `UPDATE OF` column list, and their whole usefulness depends on
 * `DEFERRABLE INITIALLY DEFERRED`.
 *
 * That last part is why they need their own fence. If
 * `AccountRestriction_requires_event` lost its DEFERRABLE it would fire
 * immediately — and since the sweep writes the restriction and its event in
 * one transaction, every single write would start failing depending on
 * statement order. Nothing in GUARD_TRIGGERS can express the difference, so
 * nothing in GUARD_TRIGGERS would notice.
 */
export const DEFERRED_CONSTRAINT_TRIGGERS = [
  {
    name: "AccountRestriction_requires_event",
    table: "AccountRestriction",
    migration: "20261019260200_phase8c_restriction",
    fn: "recx_refuse_restriction_without_event",
    /** Events, in the order the migration writes them. */
    timing: String.raw`AFTER\s+INSERT\s+OR\s+UPDATE\s+OF\s+"?stage"?`,
  },
  {
    name: "DriveEligibilityDecision_requires_audit",
    table: "DriveEligibilityDecision",
    migration: "20261020270200_phase9f_drives_exports",
    fn: "recx_refuse_eligibility_without_audit",
    /**
     * INSERT only, and no UPDATE OF clause: the row is append-only, so
     * there is no update for this one to police. If it ever gained an
     * UPDATE event that would mean the append-only guard had been
     * weakened, and this fence would say so.
     */
    timing: String.raw`AFTER\s+INSERT`,
  },
] as const;

/**
 * The partial unique indexes Prisma cannot model (the drift check cannot see
 * them either).
 *
 * Each names the migration that creates it, so a detector handed a SUBSET of
 * the migrations can tell "this index is missing" from "this index belongs to
 * a migration you did not give me" — without that, every self-test over one
 * phase's migrations fails the moment a later phase adds an index.
 */
export const PARTIAL_UNIQUE_INDEXES = [
  {
    name: "AdminScope_active_grant_key",
    table: "AdminScope",
    migration: "20261010100000_phase4_admin_authoring",
    columns: ["adminId", "departmentCode", "batchYear"],
    nullsNotDistinct: true,
    where: String.raw`"revokedAt"\s+IS\s+NULL`,
  },
  {
    name: "Accommodation_one_approved_per_user",
    table: "Accommodation",
    migration: "20261010100000_phase4_admin_authoring",
    columns: ["userId"],
    nullsNotDistinct: false,
    where: String.raw`"status"\s*=\s*'APPROVED'`,
  },
  {
    name: "Accommodation_one_open_request_per_user",
    table: "Accommodation",
    migration: "20261010100000_phase4_admin_authoring",
    columns: ["userId"],
    nullsNotDistinct: false,
    where: String.raw`"status"\s*=\s*'REQUESTED'`,
  },
  /**
   * 20261019260100_phase8b_policy. On EXPRESSIONS, not columns, so that two
   * GLOBAL policies collide: a plain unique index treats them as distinct
   * because NULL <> NULL, and `resolveInactivityPolicy()` would stop being
   * single-valued. `columnsPattern` exists for exactly this: there are no
   * column names here to quote.
   */
  {
    name: "InactivityPolicy_active_scope_key",
    table: "InactivityPolicy",
    migration: "20261019260100_phase8b_policy",
    columns: ["batchYear", "departmentCode"],
    columnsPattern: String.raw`\(\s*COALESCE\(\s*"?batchYear"?\s*,\s*[^)]+\)\s*,\s*COALESCE\(\s*"?departmentCode"?\s*,\s*[^)]+\)\s*\)`,
    nullsNotDistinct: false,
    where: String.raw`"?isActive"?`,
  },
  /**
   * 20261019260200_phase8c_restriction. Idempotence per campus day, scoped to
   * the SWEEP — which is what lets a student escalated at 02:00 who solves a
   * problem at 09:00 have both rows. An index without the source predicate
   * would make the clear collide with the escalation and the day's history
   * would be whichever won.
   */
  {
    name: "AccountStatusEvent_sweep_once_per_day",
    table: "AccountStatusEvent",
    migration: "20261019260200_phase8c_restriction",
    columns: ["userId", "evaluationDate"],
    nullsNotDistinct: false,
    where: String.raw`"?source"?\s*=\s*'INACTIVITY_SWEEP'`,
  },
  /**
   * 20261020270000_phase9b_readiness. Exactly one LIVE mentor per mentee.
   * Two is not a representable state: a list that routed to both would have
   * each of them assume the other had spoken to the student.
   */
  {
    name: "MentorAssignment_one_active_per_mentee",
    table: "MentorAssignment",
    migration: "20261020270000_phase9b_readiness",
    columns: ["menteeId"],
    nullsNotDistinct: false,
    where: String.raw`"?endedAt"?\s+IS\s+NULL`,
  },
] as const;
