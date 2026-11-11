-- Phase 4 foundation fix-up 2. 20261010100000_phase4_admin_authoring and
-- 20261010100050_phase4_foundation_fixes are already applied, so they stay
-- as they are; every change goes here. Prisma models none of this (CHECKs,
-- triggers, functions), so schema.prisma and the migrate-diff drift check
-- are unchanged.
--
-- Every guard function, guard trigger and hand-written CHECK below is listed
-- in packages/db/test/support/guard-catalog.ts: frozen-coverage.test.ts
-- (static) checks that no migration drops, disables or weakens them, and
-- guard-state.db.test.ts checks the live database. governance-invariants
-- .test.ts exercises each rule (allowed and refused paths).
--
-- Every refusal raises ERRCODE check_violation (SQLSTATE 23514).
--
-- Clock rules. Prisma fills @default(now()) from the application clock, so
-- a time window checked at INSERT allows 5 minutes either side of the
-- database clock, statement_timestamp(). The columns are timestamp(3)
-- holding UTC wall-clock time (20261010000000_session_timezone_utc), so
-- every comparison uses statement_timestamp() AT TIME ZONE 'UTC'.

-- ── admin: an Accommodation is created as an open REQUESTED request ──
-- An INSERT carries no decision, grant or revoke fields. "Approve now" by a
-- SUPER_ADMIN is an INSERT as REQUESTED followed, in the same transaction,
-- by the UPDATE that approves it. supersedesId, when set, names another
-- accommodation of the same student (never the row itself).
CREATE OR REPLACE FUNCTION recx_refuse_accommodation_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."status" <> 'REQUESTED' THEN
    RAISE EXCEPTION 'Accommodation % must be created REQUESTED, not % (approve it with a separate UPDATE)', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."approvedBySuperAdminId" IS NOT NULL OR NEW."grantedAt" IS NOT NULL OR NEW."decidedById" IS NOT NULL
     OR NEW."decidedAt" IS NOT NULL OR NEW."decisionNote" IS NOT NULL
     OR NEW."revokedById" IS NOT NULL OR NEW."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Accommodation % must be created as an open request (no decision, grant or revoke fields)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."supersedesId" IS NOT NULL THEN
    IF NEW."supersedesId" = NEW."id" THEN
      RAISE EXCEPTION 'Accommodation % cannot supersede itself', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "public"."Accommodation" p
                    WHERE p."id" = NEW."supersedesId" AND p."userId" = NEW."userId") THEN
      RAISE EXCEPTION 'Accommodation %: supersedesId must name another accommodation of the same student', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Accommodation_insert_requested"
  BEFORE INSERT ON "public"."Accommodation"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_accommodation_insert();

-- ── admin: Accommodation attribution is consistent with its status ──
--   REQUESTED                       no decision or grant fields;
--   APPROVED, REVOKED, SUPERSEDED   approvedBySuperAdminId, grantedAt,
--                                   decidedById and decidedAt;
--   REJECTED, WITHDRAWN             decidedById and decidedAt, and no
--                                   approver. WITHDRAWN records who closed
--                                   the request: withdrawAccommodation may be
--                                   run by the requester or by a SUPER_ADMIN
--                                   (admin-cohorts.md §6), so, like REJECTED,
--                                   the row names that person and the time;
--   REVOKED                         revokedAt and revokedById, which are NULL
--                                   on every other status.
-- grantedAt stays limited to the granted statuses
-- (Accommodation_granted_status_check, 20261010100050).
ALTER TABLE "public"."Accommodation"
  ADD CONSTRAINT "Accommodation_requested_undecided_check"
    CHECK ("status" <> 'REQUESTED'
      OR ("approvedBySuperAdminId" IS NULL AND "grantedAt" IS NULL AND "decidedById" IS NULL
          AND "decidedAt" IS NULL AND "decisionNote" IS NULL)),
  ADD CONSTRAINT "Accommodation_granted_attribution_check"
    CHECK ("status" NOT IN ('APPROVED', 'REVOKED', 'SUPERSEDED')
      OR ("approvedBySuperAdminId" IS NOT NULL AND "grantedAt" IS NOT NULL
          AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)),
  ADD CONSTRAINT "Accommodation_closed_attribution_check"
    CHECK ("status" NOT IN ('REJECTED', 'WITHDRAWN')
      OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "approvedBySuperAdminId" IS NULL)),
  ADD CONSTRAINT "Accommodation_revoke_pair_check"
    CHECK ((("status" = 'REVOKED') = ("revokedAt" IS NOT NULL))
       AND (("status" = 'REVOKED') = ("revokedById" IS NOT NULL)));

-- ── admin: Accommodation identity, decisions and supersession ──
-- Same trigger (Accommodation_granted_terms_immutable, BEFORE UPDATE OR
-- DELETE); the function now enforces:
--   * id, userId, requestedById and requestedAt never change;
--   * the status machine (unchanged)
--       REQUESTED -> APPROVED | REJECTED | WITHDRAWN
--       APPROVED  -> REVOKED | SUPERSEDED
--     and REJECTED, WITHDRAWN, REVOKED and SUPERSEDED are final;
--   * APPROVED -> SUPERSEDED needs its successor at that moment: a REQUESTED
--     accommodation of the same student whose supersedesId is this row. So
--     a supersede runs, in ONE transaction: (1) the successor exists as
--     REQUESTED (for "approve now", INSERT it now); (2) the old row goes
--     APPROVED -> SUPERSEDED; (3) the successor goes REQUESTED -> APPROVED.
--     The partial unique index Accommodation_one_approved_per_user is not
--     deferrable, so (3) before (2) fails with unique_violation;
--   * once the row it supersedes is SUPERSEDED, a REQUESTED successor keeps
--     its supersedesId, is never deleted and leaves REQUESTED only for
--     APPROVED (a superseded grant always has its replacement);
--   * the decision (decidedById, decidedAt, decisionNote,
--     approvedBySuperAdminId, grantedAt) is written only by the update that
--     leaves REQUESTED; the decision and revoke fields are set once and then
--     final, so a revoke reason goes to the audit row, never to decisionNote;
--   * a changed supersedesId names another accommodation of the same student;
--   * once grantedAt is set the terms, the grant, supersedesId and
--     documentFileId never change and the row is never deleted; a row never
--     granted may be deleted (unless it is the successor above).
CREATE OR REPLACE FUNCTION recx_refuse_granted_accommodation_terms() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."grantedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Accommodation % was granted and cannot be deleted', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."supersedesId" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "public"."Accommodation" p WHERE p."id" = OLD."supersedesId" AND p."status" = 'SUPERSEDED') THEN
      RAISE EXCEPTION 'Accommodation % replaces a SUPERSEDED accommodation and cannot be deleted', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF (NEW."id", NEW."userId", NEW."requestedById", NEW."requestedAt")
     IS DISTINCT FROM
     (OLD."id", OLD."userId", OLD."requestedById", OLD."requestedAt") THEN
    RAISE EXCEPTION 'Accommodation %: id, userId, requestedById and requestedAt never change', OLD."id"
      USING ERRCODE = 'check_violation';
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

  IF OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED'
     AND NOT EXISTS (SELECT 1 FROM "public"."Accommodation" s
                      WHERE s."supersedesId" = OLD."id" AND s."userId" = OLD."userId" AND s."status" = 'REQUESTED') THEN
    RAISE EXCEPTION 'Accommodation % cannot move from APPROVED to SUPERSEDED without its successor (a REQUESTED accommodation of the same student with this supersedesId)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" = 'REQUESTED' AND OLD."supersedesId" IS NOT NULL
     AND (NEW."status" NOT IN ('REQUESTED', 'APPROVED') OR NEW."supersedesId" IS DISTINCT FROM OLD."supersedesId")
     AND EXISTS (SELECT 1 FROM "public"."Accommodation" p WHERE p."id" = OLD."supersedesId" AND p."status" = 'SUPERSEDED') THEN
    RAISE EXCEPTION 'Accommodation % replaces a SUPERSEDED accommodation: it keeps its supersedesId and can only be approved', OLD."id"
      USING ERRCODE = 'check_violation';
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

  IF (NEW."decidedById", NEW."decidedAt", NEW."decisionNote", NEW."approvedBySuperAdminId", NEW."grantedAt")
     IS DISTINCT FROM
     (OLD."decidedById", OLD."decidedAt", OLD."decisionNote", OLD."approvedBySuperAdminId", OLD."grantedAt")
     AND NOT (OLD."status" = 'REQUESTED' AND NEW."status" <> 'REQUESTED') THEN
    RAISE EXCEPTION 'Accommodation %: the decision is written only by the update that leaves REQUESTED', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."supersedesId" IS NOT NULL AND NEW."supersedesId" IS DISTINCT FROM OLD."supersedesId" THEN
    IF NEW."supersedesId" = NEW."id" THEN
      RAISE EXCEPTION 'Accommodation % cannot supersede itself', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "public"."Accommodation" p
                    WHERE p."id" = NEW."supersedesId" AND p."userId" = NEW."userId") THEN
      RAISE EXCEPTION 'Accommodation %: supersedesId must name another accommodation of the same student', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD."grantedAt" IS NOT NULL
     AND (NEW."userId", NEW."kinds", NEW."exemptSignals", NEW."extraTimePercent", NEW."extraTimeMinutes",
          NEW."allowBreaks", NEW."breakMinutes", NEW."fontScalePercent", NEW."allowScribe", NEW."highContrast",
          NEW."reason", NEW."validUntil", NEW."grantedAt", NEW."approvedBySuperAdminId", NEW."supersedesId",
          NEW."documentFileId")
         IS DISTINCT FROM
         (OLD."userId", OLD."kinds", OLD."exemptSignals", OLD."extraTimePercent", OLD."extraTimeMinutes",
          OLD."allowBreaks", OLD."breakMinutes", OLD."fontScalePercent", OLD."allowScribe", OLD."highContrast",
          OLD."reason", OLD."validUntil", OLD."grantedAt", OLD."approvedBySuperAdminId", OLD."supersedesId",
          OLD."documentFileId") THEN
    RAISE EXCEPTION 'Accommodation % was granted: its terms are immutable (request a superseding accommodation)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── governance: ImpersonationSession starts now and ends after it starts ──
-- startedAt is within 5 minutes of the database clock at INSERT (no
-- back-dated or future window); an end is never before the start.
ALTER TABLE "public"."ImpersonationSession"
  ADD CONSTRAINT "ImpersonationSession_end_after_start_check"
    CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");

CREATE OR REPLACE FUNCTION recx_refuse_impersonation_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."startedAt" < (statement_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes'
     OR NEW."startedAt" > (statement_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes' THEN
    RAISE EXCEPTION 'ImpersonationSession %: startedAt must be within 5 minutes of the database clock', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ImpersonationSession_insert_window"
  BEFORE INSERT ON "public"."ImpersonationSession"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_impersonation_insert();

-- ── governance: PrivilegedOperation time order and paired fields ──
--   expiresAt > requestedAt (the 24-hour ceiling is PrivilegedOperation_expiry);
--   decidedAt >= requestedAt;
--   decidedById and decidedAt are set together;
--   EXECUTING, EXECUTED and FAILED carry executionStartedAt;
--   EXECUTED and FAILED carry executedAt;
--   an EXECUTED PII_EXPORT carries artifactAvailableUntil;
--   CANCELLED and EXPIRED are closed without a decision: no decider (so no
--   decidedAt either) and no break-glass flag.
-- Every legitimate path of super-governance.md §5 satisfies these: approve,
-- reject and break-glass write decidedById with decidedAt in one UPDATE;
-- cancel (requester) and the expiry sweep write neither; the executor claim
-- writes executionStartedAt; the finishing UPDATE writes executedAt (and,
-- for PII_EXPORT, artifactAvailableUntil); the sweep that fails a stuck
-- EXECUTING row writes executedAt with FAILED.
ALTER TABLE "public"."PrivilegedOperation"
  ADD CONSTRAINT "PrivilegedOperation_expires_after_request_check"
    CHECK ("expiresAt" > "requestedAt"),
  ADD CONSTRAINT "PrivilegedOperation_decided_after_request_check"
    CHECK ("decidedAt" IS NULL OR "decidedAt" >= "requestedAt"),
  ADD CONSTRAINT "PrivilegedOperation_decision_pair_check"
    CHECK (("decidedById" IS NULL) = ("decidedAt" IS NULL)),
  ADD CONSTRAINT "PrivilegedOperation_execution_started_check"
    CHECK ("status" NOT IN ('EXECUTING', 'EXECUTED', 'FAILED') OR "executionStartedAt" IS NOT NULL),
  ADD CONSTRAINT "PrivilegedOperation_executed_check"
    CHECK ("status" NOT IN ('EXECUTED', 'FAILED') OR "executedAt" IS NOT NULL),
  ADD CONSTRAINT "PrivilegedOperation_export_artifact_check"
    CHECK ("kind" <> 'PII_EXPORT' OR "status" <> 'EXECUTED' OR "artifactAvailableUntil" IS NOT NULL),
  ADD CONSTRAINT "PrivilegedOperation_undecided_close_check"
    CHECK ("status" NOT IN ('CANCELLED', 'EXPIRED') OR ("decidedById" IS NULL AND NOT "breakGlass"));

-- ── governance: a PrivilegedOperation request is created now ──
-- Same trigger (PrivilegedOperation_insert_pending, BEFORE INSERT); the
-- function now also requires requestedAt within 5 minutes of the database
-- clock (no back-dated or future-dated request).
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
  IF NEW."requestedAt" < (statement_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes'
     OR NEW."requestedAt" > (statement_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes' THEN
    RAISE EXCEPTION 'PrivilegedOperation %: requestedAt must be within 5 minutes of the database clock', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── governance: a PrivilegedOperation is decided before it expires ──
-- Same trigger (PrivilegedOperation_request_immutable, BEFORE UPDATE OR
-- DELETE); the function from 20261010100050 is unchanged except for two
-- clock rules on the transitions out of PENDING:
--   * PENDING -> APPROVED | REJECTED only while statement_timestamp() <
--     expiresAt (approve, reject and break-glass alike);
--   * PENDING -> EXPIRED only once statement_timestamp() >= expiresAt.
-- APPROVED -> EXECUTING is deliberately not time-limited: expiresAt bounds
-- how long a request may wait for a decision, not its execution. Approve and
-- break-glass execute synchronously right after the decision, and nothing
-- moves an APPROVED row to EXPIRED, so a claim refused a moment after
-- expiresAt would strand an approved operation that no path could finish.
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
    IF OLD."status" = 'PENDING' AND NEW."status" IN ('APPROVED', 'REJECTED')
       AND (statement_timestamp() AT TIME ZONE 'UTC') >= OLD."expiresAt" THEN
      RAISE EXCEPTION 'PrivilegedOperation % expired at %: it can no longer be approved or rejected', OLD."id", OLD."expiresAt"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."status" = 'PENDING' AND NEW."status" = 'EXPIRED'
       AND (statement_timestamp() AT TIME ZONE 'UTC') < OLD."expiresAt" THEN
      RAISE EXCEPTION 'PrivilegedOperation % has not expired yet (expiresAt %)', OLD."id", OLD."expiresAt"
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

-- ── admin: an Announcement is created as an unpublished draft ──
-- No publishedAt, publishedById, archivedAt or archivedById at INSERT, and
-- recipientCount 0: publishing is the UPDATE that fans out notifications.
-- publishedAt and publishedById are set together (CHECK).
ALTER TABLE "public"."Announcement"
  ADD CONSTRAINT "Announcement_publish_pair_check"
    CHECK (("publishedAt" IS NULL) = ("publishedById" IS NULL));

CREATE OR REPLACE FUNCTION recx_refuse_announcement_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."publishedAt" IS NOT NULL OR NEW."publishedById" IS NOT NULL
     OR NEW."archivedAt" IS NOT NULL OR NEW."archivedById" IS NOT NULL
     OR NEW."recipientCount" <> 0 THEN
    RAISE EXCEPTION 'Announcement % must be created as an unpublished draft (no publish or archive fields, recipientCount 0)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Announcement_insert_draft"
  BEFORE INSERT ON "public"."Announcement"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_announcement_insert();

-- ── admin: a published Announcement is never deleted ──
-- Notifications link to it (announcementId) and it is history: archive it
-- instead. A draft (publishedAt NULL) may still be deleted. The UPDATE rules
-- are unchanged from 20261010100050; the trigger now also fires on DELETE,
-- and TRUNCATE is refused like on every other delete-guarded table.
CREATE OR REPLACE FUNCTION recx_refuse_published_announcement_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Announcement % was published and cannot be deleted (archive it instead)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
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

CREATE OR REPLACE TRIGGER "Announcement_published_immutable"
  BEFORE UPDATE OR DELETE ON "public"."Announcement"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_published_announcement_change();

-- ── governance + admin: TRUNCATE is refused on the ledgers and announcements ──
-- Same statement trigger and function as 20261010100050. XpEvent is an
-- append-only ledger (XpEvent_append_only refuses UPDATE and DELETE), and
-- Announcement now refuses DELETE once published. AuditLog refuses UPDATE
-- (AuditLog_append_only) but row DELETE stays allowed on purpose: the
-- retention purge deletes rows older than 3 years that are not under legal
-- hold. TRUNCATE, which would empty the whole log at once, is refused.
-- Nothing in the repository truncates these tables (repo-wide grep,
-- 2026-10-10).
CREATE TRIGGER "XpEvent_no_truncate"
  BEFORE TRUNCATE ON "public"."XpEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "AuditLog_no_truncate"
  BEFORE TRUNCATE ON "public"."AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
CREATE TRIGGER "Announcement_no_truncate"
  BEFORE TRUNCATE ON "public"."Announcement"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
