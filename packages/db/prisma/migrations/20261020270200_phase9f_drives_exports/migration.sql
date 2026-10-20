-- Phase 9f: drives, the human eligibility decision, and the signed export.
--
-- SPEC §5 asks for two things that look like features and are really
-- guarantees:
--
--   * eligibility for a drive is "a human decision recorded in the audit
--     log" — so a row must name a person, carry a reason, never change, and
--     exist only alongside an audit entry;
--   * an "HMAC-signed profile/resume export reusing the LMS certificate +
--     /verify pattern" — so a payload, once signed, must be unable to move.
--
-- The honest sentence about the first one, because the design's own review
-- caught the draft overclaiming it: the database cannot tell a human from a
-- job holding a human's id. A NOT NULL actor with a foreign key does not
-- make an automatic decision impossible. What CAN be enforced is that the
-- decision is attributable, reasoned, immutable and AUDITED — and the
-- deferred constraint trigger below is the last of those expressed where no
-- code path can route around it.

-- CreateEnum
-- The tier a drive recruits at. Phase 9b stored the component breakdown as
-- JSON keyed by tier (so one TOPIC_BREADTH entry could carry PRODUCT's and
-- TOP's different per-topic targets) and therefore needed no enum; a drive
-- has exactly one tier, so here the closed set is worth having in the
-- database. enum-parity.test.ts holds it identical to READINESS_TIERS.
CREATE TYPE "public"."ReadinessTier" AS ENUM ('SERVICE', 'PRODUCT', 'TOP');

-- CreateEnum
CREATE TYPE "public"."DriveEligibility" AS ENUM ('ELIGIBLE', 'NOT_ELIGIBLE');

-- CreateEnum
CREATE TYPE "public"."ProfileExportKind" AS ENUM ('PROFILE', 'RESUME');

-- CreateTable
CREATE TABLE "public"."PlacementDrive" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "companyName" TEXT NOT NULL,
    "tier" "public"."ReadinessTier" NOT NULL,
    "driveOn" DATE NOT NULL,
    -- 0-100 on the NORMALISED figure (score as a percentage of what was
    -- measurable), never on the raw score. With mockInterviewScore unsourced
    -- no TOP score can exceed 85, so a raw bar of 70 would fail a cohort for
    -- a component nobody has built.
    "thresholdScore" INTEGER,
    "eligibleBatchYear" INTEGER,
    "eligibleDepartmentCodes" TEXT[],
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "PlacementDrive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DriveEligibilityDecision" (
    "id" TEXT NOT NULL,
    "driveId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decision" "public"."DriveEligibility" NOT NULL,
    "reason" TEXT NOT NULL,
    "decidedById" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- The readiness the decision was taken against, as a day: the figures
    -- move nightly, and "they were under the bar" has to mean "under it on
    -- the day somebody looked".
    "readinessComputedOn" DATE,

    CONSTRAINT "DriveEligibilityDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProfileExport" (
    -- The public verification code IS the primary key: 24 url-safe
    -- characters, minted from a CSPRNG. There is no sequential id a visitor
    -- could walk.
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "public"."ProfileExportKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "rulesVersion" INTEGER NOT NULL,
    "signature" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'HMAC-SHA256',
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "ProfileExport_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "PlacementDrive_driveOn_tier_idx" ON "public"."PlacementDrive"("driveOn" DESC, "tier");

-- CreateIndex
CREATE UNIQUE INDEX "DriveEligibilityDecision_driveId_userId_key" ON "public"."DriveEligibilityDecision"("driveId", "userId");

-- CreateIndex
CREATE INDEX "DriveEligibilityDecision_driveId_decision_idx" ON "public"."DriveEligibilityDecision"("driveId", "decision");

-- CreateIndex
CREATE INDEX "DriveEligibilityDecision_userId_decidedAt_idx" ON "public"."DriveEligibilityDecision"("userId", "decidedAt" DESC);

-- CreateIndex
CREATE INDEX "ProfileExport_userId_issuedAt_idx" ON "public"."ProfileExport"("userId", "issuedAt" DESC);

-- AddForeignKey
ALTER TABLE "public"."PlacementDrive" ADD CONSTRAINT "PlacementDrive_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlacementDrive" ADD CONSTRAINT "PlacementDrive_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DriveEligibilityDecision" ADD CONSTRAINT "DriveEligibilityDecision_driveId_fkey" FOREIGN KEY ("driveId") REFERENCES "public"."PlacementDrive"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DriveEligibilityDecision" ADD CONSTRAINT "DriveEligibilityDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- NOT NULL plus a foreign key: the row always names somebody who exists.
ALTER TABLE "public"."DriveEligibilityDecision" ADD CONSTRAINT "DriveEligibilityDecision_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProfileExport" ADD CONSTRAINT "ProfileExport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Invariants: PlacementDrive ──────────────────────────────────────────

ALTER TABLE "public"."PlacementDrive"
  ADD CONSTRAINT "PlacementDrive_company_check"
  CHECK (char_length(btrim("companyName")) >= 2);

ALTER TABLE "public"."PlacementDrive"
  ADD CONSTRAINT "PlacementDrive_threshold_check"
  CHECK (COALESCE("thresholdScore" BETWEEN 0 AND 100, true));

ALTER TABLE "public"."PlacementDrive"
  ADD CONSTRAINT "PlacementDrive_batch_check"
  CHECK (COALESCE("eligibleBatchYear" BETWEEN 1900 AND 2200, true));

-- ── Invariants: DriveEligibilityDecision ────────────────────────────────

-- A decision always says why. Ten characters is not a quality bar; it is the
-- difference between a reason and an empty string, and a student asking
-- months later why they were not put forward deserves the first.
--
-- COALESCE'd: char_length(btrim(NULL)) is NULL and a CHECK that evaluates to
-- NULL is SATISFIED. `reason` is NOT NULL here so it cannot bite, and it is
-- written this way anyway because the trap has been sprung five times in this
-- schema and the shape should be the habit.
ALTER TABLE "public"."DriveEligibilityDecision"
  ADD CONSTRAINT "DriveEligibilityDecision_reason_present"
  CHECK (COALESCE(char_length(btrim("reason")), 0) >= 10);

-- ── Invariants: ProfileExport ───────────────────────────────────────────

ALTER TABLE "public"."ProfileExport"
  ADD CONSTRAINT "ProfileExport_revoke_pair"
  CHECK (("revokedAt" IS NULL) = ("revokedById" IS NULL));

ALTER TABLE "public"."ProfileExport"
  ADD CONSTRAINT "ProfileExport_expiry_after_issue"
  CHECK ("expiresAt" IS NULL OR "expiresAt" > "issuedAt");

ALTER TABLE "public"."ProfileExport"
  ADD CONSTRAINT "ProfileExport_payload_object"
  CHECK (jsonb_typeof("payload") = 'object');

-- 24 url-safe characters, and a non-empty signature. A code shorter than
-- that is guessable; a row with an empty signature is a row the verify page
-- would have to decide about, and there is no good answer.
ALTER TABLE "public"."ProfileExport"
  ADD CONSTRAINT "ProfileExport_code_check"
  CHECK ("code" ~ '^[A-Za-z0-9_-]{24}$' AND char_length("signature") >= 32 AND "rulesVersion" > 0);

-- ── Guards ──────────────────────────────────────────────────────────────

-- A decision is never edited and never deleted.
--
-- Changing a decision is a NEW decision with its own reason, so the record of
-- what was decided and why survives the change. Without this, "we reviewed it
-- and changed our minds" and "we never said that" are the same row.
CREATE OR REPLACE FUNCTION recx_refuse_eligibility_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DriveEligibilityDecision_append_only: a decision is never deleted; record a new one'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'DriveEligibilityDecision_append_only: a decision is never edited; record a new one'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DriveEligibilityDecision_append_only"
  BEFORE UPDATE OR DELETE ON "public"."DriveEligibilityDecision"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_eligibility_change();

-- THE AUDIT GUARANTEE.
--
-- SPEC §5: eligibility is "a human decision recorded in the audit log". This
-- is that sentence expressed where no code path can route around it: a
-- DEFERRED constraint trigger, checked at COMMIT, requiring an AuditLog row
-- for this decision in the same transaction.
--
-- Deferred rather than immediate because the audit chain takes a per-day
-- advisory lock and appends with its own hash link — the decision and its
-- audit row cannot be written in a fixed order without one of them waiting on
-- the other. At commit, both exist or neither does.
--
-- The same shape Phase 8 used for AccountRestriction_requires_event, for the
-- same reason: an invariant that spans two tables is an invariant about the
-- transaction, not about a row.
CREATE OR REPLACE FUNCTION recx_refuse_eligibility_without_audit() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."AuditLog" a
     WHERE a."entityType" = 'DriveEligibilityDecision'
       AND a."entityId" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'DriveEligibilityDecision_requires_audit: no AuditLog row for decision % — eligibility is a human decision recorded in the audit log', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "DriveEligibilityDecision_requires_audit"
  AFTER INSERT ON "public"."DriveEligibilityDecision"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_eligibility_without_audit();

-- A signature over a mutable payload verifies nothing.
--
-- So the payload, the signature, the algorithm, the rules version, the issue
-- time and the owner never change. Only the revocation may be set, and only
-- once: a student withdrawing a link they have already sent is the one state
-- change the row permits, and un-revoking would let somebody re-publish a
-- record the student had pulled back.
CREATE OR REPLACE FUNCTION recx_refuse_profile_export_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ProfileExport_payload_frozen: an export is revoked, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."payload"::text IS DISTINCT FROM OLD."payload"::text
     OR NEW."signature" IS DISTINCT FROM OLD."signature"
     OR NEW."algorithm" IS DISTINCT FROM OLD."algorithm"
     OR NEW."rulesVersion" IS DISTINCT FROM OLD."rulesVersion"
     OR NEW."issuedAt" IS DISTINCT FROM OLD."issuedAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
  THEN
    RAISE EXCEPTION 'ProfileExport_payload_frozen: a signature over a mutable payload verifies nothing'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'ProfileExport_payload_frozen: a withdrawn link stays withdrawn'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProfileExport_payload_frozen"
  BEFORE UPDATE OR DELETE ON "public"."ProfileExport"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_profile_export_change();

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
CREATE TRIGGER "PlacementDrive_no_truncate"
  BEFORE TRUNCATE ON "public"."PlacementDrive"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "DriveEligibilityDecision_no_truncate"
  BEFORE TRUNCATE ON "public"."DriveEligibilityDecision"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "ProfileExport_no_truncate"
  BEFORE TRUNCATE ON "public"."ProfileExport"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
