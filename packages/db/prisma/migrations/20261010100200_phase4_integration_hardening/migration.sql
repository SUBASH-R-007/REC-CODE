-- Phase 4 integration hardening. Every earlier migration is applied, so it
-- stays as it is; every change goes here. Prisma models none of this
-- (CHECKs, trigger functions), so schema.prisma and the migrate-diff drift
-- check are unchanged. No new guard function or guard trigger: the five
-- functions below are replaced in place under their existing triggers.
--
-- Every guard function and hand-written CHECK below is listed in
-- packages/db/test/support/guard-catalog.ts: frozen-coverage.test.ts
-- (static) checks that no migration drops, disables or weakens them, and
-- guard-state.db.test.ts checks the live database. governance-invariants
-- .test.ts exercises each rule, including the two-connection races of the
-- supersede rules.
--
-- Every refusal raises ERRCODE check_violation (SQLSTATE 23514).
--
-- Clock rules (as in 20261010100080): the columns are timestamp(3) holding
-- UTC wall-clock time, so every comparison uses statement_timestamp() AT
-- TIME ZONE 'UTC', with 5 minutes of tolerance for the application clock.

-- ── integration: Accommodation decisions are not dated before the request ──
ALTER TABLE "public"."Accommodation"
  ADD CONSTRAINT "Accommodation_decided_after_request_check"
    CHECK ("decidedAt" IS NULL OR "decidedAt" >= "requestedAt"),
  ADD CONSTRAINT "Accommodation_granted_after_request_check"
    CHECK ("grantedAt" IS NULL OR "grantedAt" >= "requestedAt");

-- ── integration: the Accommodation supersede rules are race-safe ──
-- Same trigger (Accommodation_granted_terms_immutable, BEFORE UPDATE OR
-- DELETE) and the same rules as 20261010100080. What changes: the two
-- supersede rules now LOCK the rows they read, so a concurrent transaction
-- can no longer act on a snapshot the other one is about to change.
--
--   * "successor exists" (APPROVED -> SUPERSEDED): the REQUESTED successor is
--     read FOR SHARE. A concurrent withdraw, reject, unlink or DELETE of that
--     successor must take its row lock, so it waits for this transaction and
--     then sees the predecessor SUPERSEDED (and is refused); a successor that
--     a concurrent transaction is changing is re-read after that transaction
--     ends, so a withdrawn or deleted successor no longer counts.
--   * "successor lock" (a REQUESTED successor leaving REQUESTED for anything
--     but APPROVED, changing its supersedesId, or being deleted): the
--     predecessor is read FOR SHARE whatever its status. A concurrent
--     APPROVED -> SUPERSEDED of the predecessor must take its row lock, so it
--     waits for this transaction and then finds no REQUESTED successor (and
--     is refused); a predecessor that a concurrent transaction is
--     superseding is re-read after that transaction ends.
--
-- Without the locks both of these interleavings committed (verified on
-- 20261010100080 with two sessions):
--   r1/r2  T1 supersedes A (its successor B is REQUESTED); before T1 commits,
--          T2 withdraws or deletes B (it still sees A APPROVED): A ends
--          SUPERSEDED with no successor;
--   r3     T1 withdraws B; before T1 commits, T2 supersedes A (it still sees
--          B REQUESTED): the same end state.
-- With the locks the second transaction waits for the first and is then
-- refused. Opposite-order lock waits may instead end in a deadlock, where
-- Postgres aborts one transaction (40P01) and the other commits; either way
-- the end state is consistent.
CREATE OR REPLACE FUNCTION recx_refuse_granted_accommodation_terms() RETURNS trigger AS $$
DECLARE
  predecessor_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."grantedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Accommodation % was granted and cannot be deleted', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."supersedesId" IS NOT NULL THEN
      SELECT p."status"::text INTO predecessor_status
        FROM "public"."Accommodation" p
       WHERE p."id" = OLD."supersedesId"
         FOR SHARE;
      IF predecessor_status = 'SUPERSEDED' THEN
        RAISE EXCEPTION 'Accommodation % replaces a SUPERSEDED accommodation and cannot be deleted', OLD."id"
          USING ERRCODE = 'check_violation';
      END IF;
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

  IF OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED' THEN
    PERFORM 1
       FROM "public"."Accommodation" s
      WHERE s."supersedesId" = OLD."id" AND s."userId" = OLD."userId" AND s."status" = 'REQUESTED'
        FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Accommodation % cannot move from APPROVED to SUPERSEDED without its successor (a REQUESTED accommodation of the same student with this supersedesId)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD."status" = 'REQUESTED' AND OLD."supersedesId" IS NOT NULL
     AND (NEW."status" NOT IN ('REQUESTED', 'APPROVED') OR NEW."supersedesId" IS DISTINCT FROM OLD."supersedesId") THEN
    SELECT p."status"::text INTO predecessor_status
      FROM "public"."Accommodation" p
     WHERE p."id" = OLD."supersedesId"
       FOR SHARE;
    IF predecessor_status = 'SUPERSEDED' THEN
      RAISE EXCEPTION 'Accommodation % replaces a SUPERSEDED accommodation: it keeps its supersedesId and can only be approved', OLD."id"
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

-- ── integration: a PrivilegedOperation decision is not dated in the future ──
-- Same trigger (PrivilegedOperation_request_immutable, BEFORE UPDATE OR
-- DELETE); the function from 20261010100080 is unchanged except for one
-- clock rule: the UPDATE that writes the decision (the only one that may,
-- the one leaving PENDING) may not date decidedAt more than 5 minutes after
-- the database clock. decidedAt >= requestedAt stays a CHECK
-- (PrivilegedOperation_decided_after_request_check), and requestedAt is
-- itself within 5 minutes of the clock at INSERT, so the approve path's
-- GREATEST(statement_timestamp(), "requestedAt") always passes.
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
    IF NEW."decidedAt" > (statement_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes' THEN
      RAISE EXCEPTION 'PrivilegedOperation %: decidedAt may not be more than 5 minutes after the database clock', OLD."id"
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

-- ── integration: an Announcement draft has no recipients; id and author are fixed ──
-- recipientCount is written by the publish UPDATE (together with
-- publishedAt and publishedById), so a draft always counts 0 (CHECK).
-- Same trigger (Announcement_published_immutable, BEFORE UPDATE OR DELETE);
-- the function from 20261010100080 now also refuses any change of id
-- (Notification rows reference it) or createdById, draft or published.
ALTER TABLE "public"."Announcement"
  ADD CONSTRAINT "Announcement_draft_recipients_check"
    CHECK ("publishedAt" IS NOT NULL OR "recipientCount" = 0);

CREATE OR REPLACE FUNCTION recx_refuse_published_announcement_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Announcement % was published and cannot be deleted (archive it instead)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW."id", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."createdById") THEN
    RAISE EXCEPTION 'Announcement %: id and createdById never change', OLD."id"
      USING ERRCODE = 'check_violation';
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

-- ── integration: an ImpersonationSession is created open and not ended in the future ──
-- Same triggers (ImpersonationSession_insert_window, BEFORE INSERT;
-- ImpersonationSession_immutable, BEFORE UPDATE OR DELETE). An INSERT
-- carries no endedAt or endReason (a session is ended by the one UPDATE
-- that closes it), and that UPDATE may not date endedAt more than 5 minutes
-- after the database clock. startedAt is within 5 minutes of the clock at
-- INSERT, so the close path's GREATEST(now(), "startedAt") always passes.
CREATE OR REPLACE FUNCTION recx_refuse_impersonation_insert() RETURNS trigger AS $$
BEGIN
  IF NEW."startedAt" < (statement_timestamp() AT TIME ZONE 'UTC') - interval '5 minutes'
     OR NEW."startedAt" > (statement_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes' THEN
    RAISE EXCEPTION 'ImpersonationSession %: startedAt must be within 5 minutes of the database clock', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."endedAt" IS NOT NULL OR NEW."endReason" IS NOT NULL THEN
    RAISE EXCEPTION 'ImpersonationSession % must be created open (no endedAt or endReason)', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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
  IF NEW."endedAt" IS DISTINCT FROM OLD."endedAt"
     AND NEW."endedAt" > (statement_timestamp() AT TIME ZONE 'UTC') + interval '5 minutes' THEN
    RAISE EXCEPTION 'ImpersonationSession %: endedAt may not be more than 5 minutes after the database clock', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
