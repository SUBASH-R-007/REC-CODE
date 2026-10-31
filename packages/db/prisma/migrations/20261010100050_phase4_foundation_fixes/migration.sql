-- Phase 4 foundation fix-up. 20261010100000_phase4_admin_authoring is
-- already applied, so it stays as it is; every change goes here. Prisma
-- models none of this (CHECKs, triggers, functions), so the schema and the
-- migrate-diff drift check are unchanged. Every guard function and trigger
-- below is listed in packages/db/test/frozen-coverage.test.ts (it must keep
-- its RAISE EXCEPTION and is never dropped or disabled by a migration), and
-- packages/db/test/governance-invariants.test.ts exercises each rule.
--
-- Every refusal raises ERRCODE check_violation (SQLSTATE 23514), like the
-- frozen-version fences. DB tests that delete these rows must disable the
-- row triggers inside ONE transaction and re-enable them before it commits
-- (see the teardown in governance-invariants.test.ts).

-- ── governance: a decided PrivilegedOperation names its decider ──
-- APPROVED, EXECUTING, EXECUTED, FAILED and REJECTED are reached only by a
-- decision. CANCELLED (by the requester) and EXPIRED (by the sweep) may stay
-- without a decider; PENDING never has one (see the INSERT and UPDATE guards).
ALTER TABLE "public"."PrivilegedOperation"
  ADD CONSTRAINT "PrivilegedOperation_decided_check"
    CHECK ("status" NOT IN ('APPROVED', 'EXECUTING', 'EXECUTED', 'FAILED', 'REJECTED') OR "decidedById" IS NOT NULL);

-- ── governance: PrivilegedOperation lifecycle (replaces the request-only guard) ──
-- Same trigger (PrivilegedOperation_request_immutable, BEFORE UPDATE OR
-- DELETE); the function now also enforces:
--   * the request fields (and id) never change; a row is never deleted;
--   * the status machine
--       PENDING   -> APPROVED | REJECTED | CANCELLED | EXPIRED
--       APPROVED  -> EXECUTING
--       EXECUTING -> EXECUTED | FAILED
--     and EXECUTED, FAILED, REJECTED, CANCELLED and EXPIRED are final;
--   * the decision (decidedById, decidedAt, breakGlass, decisionNote) is
--     written only by the update that moves the row out of PENDING, and is
--     final once decidedById is set (a break-glass self-approval can never be
--     relabelled as a two-person one);
--   * the bookkeeping columns move only with their transitions:
--       executionStartedAt      set once, by APPROVED -> EXECUTING;
--       executedAt              set once, by EXECUTING -> EXECUTED | FAILED;
--       result, error           set by EXECUTING -> EXECUTED | FAILED;
--       artifactAvailableUntil  set once, by EXECUTING -> EXECUTED;
--       artifactDownloads       only increases, only while EXECUTED.
CREATE OR REPLACE FUNCTION recx_refuse_privileged_request_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PrivilegedOperation % cannot be deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW."id", NEW."kind", NEW."payload", NEW."payloadSha256", NEW."summary", NEW."affectedCount",
      NEW."reason", NEW."requestedById", NEW."requestedAt", NEW."expiresAt")
     IS DISTINCT FROM
     (OLD."id", OLD."kind", OLD."payload", OLD."payloadSha256", OLD."summary", OLD."affectedCount",
      OLD."reason", OLD."requestedById", OLD."requestedAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'PrivilegedOperation % request fields are immutable', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" IN ('EXECUTED', 'FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED') THEN
      RAISE EXCEPTION 'PrivilegedOperation % is % (final): its status never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'))
         OR (OLD."status" = 'APPROVED' AND NEW."status" = 'EXECUTING')
         OR (OLD."status" = 'EXECUTING' AND NEW."status" IN ('EXECUTED', 'FAILED'))) THEN
      RAISE EXCEPTION 'PrivilegedOperation % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (NEW."decidedById", NEW."decidedAt", NEW."breakGlass", NEW."decisionNote")
     IS DISTINCT FROM
     (OLD."decidedById", OLD."decidedAt", OLD."breakGlass", OLD."decisionNote") THEN
    IF OLD."decidedById" IS NOT NULL THEN
      RAISE EXCEPTION 'PrivilegedOperation % was decided: the decision is final', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (OLD."status" = 'PENDING' AND NEW."status" <> 'PENDING') THEN
      RAISE EXCEPTION 'PrivilegedOperation %: the decision is written only by the update that leaves PENDING', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."executionStartedAt" IS DISTINCT FROM OLD."executionStartedAt"
     AND NOT (OLD."executionStartedAt" IS NULL AND OLD."status" = 'APPROVED' AND NEW."status" = 'EXECUTING') THEN
    RAISE EXCEPTION 'PrivilegedOperation %: executionStartedAt is set once, by APPROVED to EXECUTING', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."executedAt" IS DISTINCT FROM OLD."executedAt"
     AND NOT (OLD."executedAt" IS NULL AND OLD."status" = 'EXECUTING' AND NEW."status" IN ('EXECUTED', 'FAILED')) THEN
    RAISE EXCEPTION 'PrivilegedOperation %: executedAt is set once, by EXECUTING to EXECUTED or FAILED', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW."result", NEW."error") IS DISTINCT FROM (OLD."result", OLD."error")
     AND NOT (OLD."status" = 'EXECUTING' AND NEW."status" IN ('EXECUTED', 'FAILED')) THEN
    RAISE EXCEPTION 'PrivilegedOperation %: result and error are written only by EXECUTING to EXECUTED or FAILED', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."artifactAvailableUntil" IS DISTINCT FROM OLD."artifactAvailableUntil"
     AND NOT (OLD."artifactAvailableUntil" IS NULL AND OLD."status" = 'EXECUTING' AND NEW."status" = 'EXECUTED') THEN
    RAISE EXCEPTION 'PrivilegedOperation %: artifactAvailableUntil is set once, by EXECUTING to EXECUTED', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."artifactDownloads" IS DISTINCT FROM OLD."artifactDownloads"
     AND NOT (OLD."status" = 'EXECUTED' AND NEW."status" = 'EXECUTED' AND NEW."artifactDownloads" > OLD."artifactDownloads") THEN
    RAISE EXCEPTION 'PrivilegedOperation %: artifactDownloads only increases, and only while EXECUTED', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── governance: a PrivilegedOperation is created as an undecided PENDING request ──
CREATE OR REPLACE FUNCTION recx_refuse_privileged_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'PrivilegedOperation % must be created PENDING, not %', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decidedById" IS NOT NULL OR NEW."decidedAt" IS NOT NULL OR NEW."decisionNote" IS NOT NULL
     OR NEW."breakGlass" OR NEW."executionStartedAt" IS NOT NULL OR NEW."executedAt" IS NOT NULL
     OR NEW."result" IS NOT NULL OR NEW."error" IS NOT NULL OR NEW."artifactAvailableUntil" IS NOT NULL
     OR NEW."artifactDownloads" <> 0 THEN
    RAISE EXCEPTION 'PrivilegedOperation % must be created as an undecided request (no decision or execution fields)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PrivilegedOperation_insert_pending"
  BEFORE INSERT ON "public"."PrivilegedOperation"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_privileged_insert();

-- ── admin: AdminScope grants are immutable; a revoke is final; never deleted ──
-- adminId, departmentCode, batchYear, reason, grantedById and createdAt
-- never change (re-scoping = revoke + a new grant). revokedAt and
-- revokedById are written together (CHECK) and only once (NULL to a value).
ALTER TABLE "public"."AdminScope"
  ADD CONSTRAINT "AdminScope_revoke_pair_check"
    CHECK (("revokedAt" IS NULL) = ("revokedById" IS NULL));

CREATE OR REPLACE FUNCTION recx_refuse_admin_scope_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AdminScope % is never deleted (revoke it: set revokedAt and revokedById)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."adminId", NEW."departmentCode", NEW."batchYear", NEW."reason", NEW."grantedById", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."id", OLD."adminId", OLD."departmentCode", OLD."batchYear", OLD."reason", OLD."grantedById", OLD."createdAt") THEN
    RAISE EXCEPTION 'AdminScope % grant fields are immutable (revoke it and grant a new scope)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."revokedAt" IS NOT NULL OR OLD."revokedById" IS NOT NULL)
     AND (NEW."revokedAt", NEW."revokedById") IS DISTINCT FROM (OLD."revokedAt", OLD."revokedById") THEN
    RAISE EXCEPTION 'AdminScope % was revoked: the revocation is final', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AdminScope_grant_immutable"
  BEFORE UPDATE OR DELETE ON "public"."AdminScope"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_admin_scope_change();

-- ── admin: Accommodation status machine, final decisions, frozen supersession ──
-- grantedAt exists only on a granted row (APPROVED, REVOKED, SUPERSEDED).
ALTER TABLE "public"."Accommodation"
  ADD CONSTRAINT "Accommodation_granted_status_check"
    CHECK ("grantedAt" IS NULL OR "status" IN ('APPROVED', 'REVOKED', 'SUPERSEDED'));

-- Same trigger (Accommodation_granted_terms_immutable, BEFORE UPDATE OR
-- DELETE); the function now also enforces:
--   * the status machine
--       REQUESTED -> APPROVED | REJECTED | WITHDRAWN
--       APPROVED  -> REVOKED | SUPERSEDED
--     and REJECTED, WITHDRAWN, REVOKED and SUPERSEDED are final;
--   * the decision fields (approvedBySuperAdminId, grantedAt, decidedById,
--     decidedAt, decisionNote, revokedById, revokedAt) are set once: once
--     non-null they never change;
--   * once grantedAt is set the terms, the grant and supersedesId never
--     change, and the row is never deleted (unchanged from 20261010100000).
-- Supersede order (admin-cohorts.md §6): the partial unique index
-- Accommodation_one_approved_per_user is not deferrable, so in ONE
-- transaction the old row goes APPROVED -> SUPERSEDED first, then the new
-- row (REQUESTED with supersedesId, or an INSERT for approveNow) becomes
-- APPROVED. Both steps are allowed here; the reverse order is refused by the
-- index (unique_violation).
CREATE OR REPLACE FUNCTION recx_refuse_granted_accommodation_terms() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."grantedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Accommodation % was granted and cannot be deleted', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF OLD."status" IN ('REJECTED', 'WITHDRAWN', 'REVOKED', 'SUPERSEDED') THEN
      RAISE EXCEPTION 'Accommodation % is % (final): its status never changes', OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT ((OLD."status" = 'REQUESTED' AND NEW."status" IN ('APPROVED', 'REJECTED', 'WITHDRAWN'))
         OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('REVOKED', 'SUPERSEDED'))) THEN
      RAISE EXCEPTION 'Accommodation % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF (OLD."approvedBySuperAdminId" IS NOT NULL AND NEW."approvedBySuperAdminId" IS DISTINCT FROM OLD."approvedBySuperAdminId")
     OR (OLD."grantedAt" IS NOT NULL AND NEW."grantedAt" IS DISTINCT FROM OLD."grantedAt")
     OR (OLD."decidedById" IS NOT NULL AND NEW."decidedById" IS DISTINCT FROM OLD."decidedById")
     OR (OLD."decidedAt" IS NOT NULL AND NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt")
     OR (OLD."decisionNote" IS NOT NULL AND NEW."decisionNote" IS DISTINCT FROM OLD."decisionNote")
     OR (OLD."revokedById" IS NOT NULL AND NEW."revokedById" IS DISTINCT FROM OLD."revokedById")
     OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
    RAISE EXCEPTION 'Accommodation %: decision fields are set once and then final', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."grantedAt" IS NOT NULL
     AND (NEW."userId", NEW."kinds", NEW."exemptSignals", NEW."extraTimePercent", NEW."extraTimeMinutes",
          NEW."allowBreaks", NEW."breakMinutes", NEW."fontScalePercent", NEW."allowScribe", NEW."highContrast",
          NEW."reason", NEW."validUntil", NEW."grantedAt", NEW."approvedBySuperAdminId", NEW."supersedesId")
         IS DISTINCT FROM
         (OLD."userId", OLD."kinds", OLD."exemptSignals", OLD."extraTimePercent", OLD."extraTimeMinutes",
          OLD."allowBreaks", OLD."breakMinutes", OLD."fontScalePercent", OLD."allowScribe", OLD."highContrast",
          OLD."reason", OLD."validUntil", OLD."grantedAt", OLD."approvedBySuperAdminId", OLD."supersedesId") THEN
    RAISE EXCEPTION 'Accommodation % was granted: its terms are immutable (request a superseding accommodation)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── governance: ImpersonationSession window is immutable; an end is final; never deleted ──
-- endedAt and endReason are written together (CHECK) and only once; the
-- window is fixed at start and must be non-empty (CHECK; the 15-minute
-- bound is ImpersonationSession_box).
ALTER TABLE "public"."ImpersonationSession"
  ADD CONSTRAINT "ImpersonationSession_end_pair_check"
    CHECK (("endedAt" IS NULL) = ("endReason" IS NULL)),
  ADD CONSTRAINT "ImpersonationSession_window_check"
    CHECK ("expiresAt" > "startedAt");

CREATE OR REPLACE FUNCTION recx_refuse_impersonation_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ImpersonationSession % is never deleted (end it: set endedAt and endReason)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."impersonatorId", NEW."targetUserId", NEW."reason", NEW."startedAt", NEW."expiresAt")
     IS DISTINCT FROM
     (OLD."id", OLD."impersonatorId", OLD."targetUserId", OLD."reason", OLD."startedAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'ImpersonationSession % is immutable (start a new impersonation instead)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD."endedAt" IS NOT NULL OR OLD."endReason" IS NOT NULL)
     AND (NEW."endedAt", NEW."endReason") IS DISTINCT FROM (OLD."endedAt", OLD."endReason") THEN
    RAISE EXCEPTION 'ImpersonationSession % has ended: the end is final', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ImpersonationSession_immutable"
  BEFORE UPDATE OR DELETE ON "public"."ImpersonationSession"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_impersonation_change();

-- ── admin: a published Announcement is immutable ──
-- publishedAt, publishedById, archivedAt and archivedById are set once.
-- While publishedAt is NULL (a draft) everything else is editable; the
-- publish UPDATE itself may still set recipientCount. Once published, the
-- text (title, body, tone, link), the audience and recipientCount never
-- change. endsAt, archivedAt/archivedById (once) and updatedAt stay writable.
CREATE OR REPLACE FUNCTION recx_refuse_published_announcement_change() RETURNS trigger AS $$
BEGIN
  IF (OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt")
     OR (OLD."publishedById" IS NOT NULL AND NEW."publishedById" IS DISTINCT FROM OLD."publishedById")
     OR (OLD."archivedAt" IS NOT NULL AND NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt")
     OR (OLD."archivedById" IS NOT NULL AND NEW."archivedById" IS DISTINCT FROM OLD."archivedById") THEN
    RAISE EXCEPTION 'Announcement %: publishedAt, publishedById, archivedAt and archivedById are set once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."publishedAt" IS NOT NULL
     AND (NEW."title", NEW."body", NEW."tone", NEW."link", NEW."audienceBatchYear",
          NEW."audienceDepartmentCode", NEW."audienceSection", NEW."recipientCount")
         IS DISTINCT FROM
         (OLD."title", OLD."body", OLD."tone", OLD."link", OLD."audienceBatchYear",
          OLD."audienceDepartmentCode", OLD."audienceSection", OLD."recipientCount") THEN
    RAISE EXCEPTION 'Announcement % is published: its text and audience are immutable', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Announcement_published_immutable"
  BEFORE UPDATE ON "public"."Announcement"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_published_announcement_change();

-- ── governance + authoring: TRUNCATE is refused on guarded tables ──
-- Row triggers do not fire on TRUNCATE, so each table whose rows are
-- guarded against DELETE also refuses TRUNCATE (statement trigger; it fires
-- for a CASCADE target too). Nothing in the repository truncates these
-- tables (checked with a repo-wide grep on 2026-10-10): ProblemVersion, the
-- frozen children (FROZEN_CHILD_MODELS in packages/db/src/frozen.ts) and
-- TestBlob are covered as well as the four governance tables.
CREATE OR REPLACE FUNCTION recx_refuse_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated: its rows are guarded by triggers', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PrivilegedOperation_no_truncate"
  BEFORE TRUNCATE ON "public"."PrivilegedOperation"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "Accommodation_no_truncate"
  BEFORE TRUNCATE ON "public"."Accommodation"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "AdminScope_no_truncate"
  BEFORE TRUNCATE ON "public"."AdminScope"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "ImpersonationSession_no_truncate"
  BEFORE TRUNCATE ON "public"."ImpersonationSession"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "ProblemVersion_no_truncate"
  BEFORE TRUNCATE ON "public"."ProblemVersion"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "TestCase_no_truncate"
  BEFORE TRUNCATE ON "public"."TestCase"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "StarterCode_no_truncate"
  BEFORE TRUNCATE ON "public"."StarterCode"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "ReferenceSolution_no_truncate"
  BEFORE TRUNCATE ON "public"."ReferenceSolution"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "Subtask_no_truncate"
  BEFORE TRUNCATE ON "public"."Subtask"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "ProblemLanguageLimit_no_truncate"
  BEFORE TRUNCATE ON "public"."ProblemLanguageLimit"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "Hint_no_truncate"
  BEFORE TRUNCATE ON "public"."Hint"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "Editorial_no_truncate"
  BEFORE TRUNCATE ON "public"."Editorial"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "TestBlob_no_truncate"
  BEFORE TRUNCATE ON "public"."TestBlob"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
