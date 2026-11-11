-- CreateEnum
CREATE TYPE "public"."PrivilegedOperationKind" AS ENUM ('BULK_STATUS_CHANGE', 'SUBMISSION_PURGE', 'GLOBAL_REJUDGE', 'PII_EXPORT', 'PROBLEM_DELETE', 'VERSION_DELETE');

-- CreateEnum
CREATE TYPE "public"."PrivilegedOperationStatus" AS ENUM ('PENDING', 'APPROVED', 'EXECUTING', 'EXECUTED', 'FAILED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."ImpersonationEndReason" AS ENUM ('ENDED', 'EXPIRED', 'SIGNED_OUT', 'REVOKED');

-- CreateEnum
CREATE TYPE "public"."OutboxStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."AccommodationKind" AS ENUM ('SCREEN_READER', 'MAGNIFIER', 'SPEECH_INPUT', 'EXTRA_TIME', 'BREAKS', 'SEPARATE_ROOM');

-- CreateEnum
CREATE TYPE "public"."AccommodationStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'REVOKED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "public"."ProctorEventKind" AS ENUM ('FOCUS_LOSS', 'FULLSCREEN_EXIT', 'EXTERNAL_PASTE', 'INTERNAL_PASTE', 'PROGRAMMATIC_INSERT', 'COPY', 'CUT', 'CONTEXT_MENU', 'CADENCE_BURST', 'IDLE_GAP', 'FIRST_KEYSTROKE', 'WINDOW_RESIZE', 'MULTI_MONITOR', 'DEVTOOLS_HEURISTIC', 'AUTOMATION_HINT', 'NETWORK_DROP', 'HEARTBEAT_GAP', 'IP_CHANGED', 'UA_CHANGED', 'SEQUENCE_GAP', 'CONCURRENT_SESSION', 'SUBMISSION_RATE_ANOMALY', 'CLIENT_SCRIPT_ERROR', 'INVIGILATOR_NOTE');

-- CreateEnum
CREATE TYPE "public"."RosterImportStatus" AS ENUM ('PREVIEWED', 'COMMITTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."AnnouncementTone" AS ENUM ('INFO', 'IMPORTANT');

-- CreateEnum
CREATE TYPE "public"."ContentOrigin" AS ENUM ('FACULTY', 'SENIOR_STUDENT', 'AI_ASSISTED');

-- CreateEnum
CREATE TYPE "public"."ProblemReviewAction" AS ENUM ('SUBMITTED', 'WITHDRAWN', 'RETURNED', 'APPROVED', 'APPROVAL_REVOKED');

-- CreateEnum
CREATE TYPE "public"."ProblemImportStatus" AS ENUM ('PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."ProblemImportRowStatus" AS ENUM ('CREATED', 'NEW_REVISION', 'UNCHANGED', 'FAILED');

-- AlterTable
ALTER TABLE "public"."Notification" ADD COLUMN     "announcementId" TEXT;

-- AlterTable
ALTER TABLE "public"."ProblemVersion" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "editSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "importSha256" TEXT,
ADD COLUMN     "judgeSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastEditedById" TEXT,
ADD COLUMN     "origin" "public"."ContentOrigin" NOT NULL DEFAULT 'FACULTY',
ADD COLUMN     "submittedById" TEXT,
ADD COLUMN     "submittedForReviewAt" TIMESTAMP(3),
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "public"."Session" ADD COLUMN     "impersonationId" TEXT;

-- AlterTable
ALTER TABLE "public"."StudyPlan" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "seedManaged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedById" TEXT;

-- AlterTable
ALTER TABLE "public"."ValidationRun" ADD COLUMN     "judgeSeq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."PrivilegedOperation" (
    "id" TEXT NOT NULL,
    "kind" "public"."PrivilegedOperationKind" NOT NULL,
    "status" "public"."PrivilegedOperationStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "affectedCount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "breakGlass" BOOLEAN NOT NULL DEFAULT false,
    "executionStartedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "result" JSONB,
    "error" TEXT,
    "artifactAvailableUntil" TIMESTAMP(3),
    "artifactDownloads" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PrivilegedOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ImpersonationSession" (
    "id" TEXT NOT NULL,
    "impersonatorId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" "public"."ImpersonationEndReason",

    CONSTRAINT "ImpersonationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EmailOutbox" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "status" "public"."OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "transport" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SchedulerJobStatus" (
    "job" TEXT NOT NULL,
    "instance" TEXT NOT NULL,
    "lastStartedAt" TIMESTAMP(3) NOT NULL,
    "lastFinishedAt" TIMESTAMP(3),
    "lastOk" BOOLEAN NOT NULL,
    "lastError" TEXT,
    "lastReport" JSONB NOT NULL DEFAULT '{}',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchedulerJobStatus_pkey" PRIMARY KEY ("job")
);

-- CreateTable
CREATE TABLE "public"."AdminScope" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "departmentCode" TEXT,
    "batchYear" INTEGER,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "AdminScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Accommodation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "public"."AccommodationStatus" NOT NULL DEFAULT 'REQUESTED',
    "kinds" "public"."AccommodationKind"[],
    "exemptSignals" "public"."ProctorEventKind"[] DEFAULT ARRAY[]::"public"."ProctorEventKind"[],
    "extraTimePercent" INTEGER NOT NULL DEFAULT 0,
    "extraTimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "allowBreaks" BOOLEAN NOT NULL DEFAULT false,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "fontScalePercent" INTEGER NOT NULL DEFAULT 100,
    "allowScribe" BOOLEAN NOT NULL DEFAULT false,
    "highContrast" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "documentFileId" TEXT,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedBySuperAdminId" TEXT,
    "grantedAt" TIMESTAMP(3),
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "revokedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "supersedesId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Accommodation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RosterImport" (
    "id" TEXT NOT NULL,
    "status" "public"."RosterImportStatus" NOT NULL DEFAULT 'PREVIEWED',
    "createdById" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "rows" JSONB,
    "counts" JSONB NOT NULL,
    "diffSha256" TEXT NOT NULL,
    "results" JSONB,
    "resultsSha256" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "committedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RosterImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Announcement" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tone" "public"."AnnouncementTone" NOT NULL DEFAULT 'INFO',
    "link" TEXT,
    "audienceBatchYear" INTEGER,
    "audienceDepartmentCode" TEXT,
    "audienceSection" TEXT,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProblemReview" (
    "id" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "action" "public"."ProblemReviewAction" NOT NULL,
    "actorId" TEXT,
    "comment" TEXT,
    "attestedOriginal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProblemReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProblemImport" (
    "id" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "archiveSha256" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "status" "public"."ProblemImportStatus" NOT NULL DEFAULT 'PROCESSING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "revised" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ProblemImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProblemImportRow" (
    "id" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "entry" TEXT NOT NULL,
    "slug" TEXT,
    "status" "public"."ProblemImportRowStatus" NOT NULL,
    "problemId" TEXT,
    "problemVersionId" TEXT,
    "revision" INTEGER,
    "packageSha256" TEXT,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProblemImportRow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrivilegedOperation_status_expiresAt_idx" ON "public"."PrivilegedOperation"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "PrivilegedOperation_requestedById_requestedAt_idx" ON "public"."PrivilegedOperation"("requestedById", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "PrivilegedOperation_kind_requestedAt_idx" ON "public"."PrivilegedOperation"("kind", "requestedAt" DESC);

-- CreateIndex
CREATE INDEX "ImpersonationSession_impersonatorId_startedAt_idx" ON "public"."ImpersonationSession"("impersonatorId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "ImpersonationSession_targetUserId_startedAt_idx" ON "public"."ImpersonationSession"("targetUserId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "ImpersonationSession_endedAt_expiresAt_idx" ON "public"."ImpersonationSession"("endedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_status_nextAttemptAt_idx" ON "public"."EmailOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "EmailOutbox_entityType_entityId_idx" ON "public"."EmailOutbox"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AdminScope_adminId_revokedAt_idx" ON "public"."AdminScope"("adminId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Accommodation_supersedesId_key" ON "public"."Accommodation"("supersedesId");

-- CreateIndex
CREATE INDEX "Accommodation_userId_status_idx" ON "public"."Accommodation"("userId", "status");

-- CreateIndex
CREATE INDEX "Accommodation_status_validUntil_idx" ON "public"."Accommodation"("status", "validUntil");

-- CreateIndex
CREATE INDEX "RosterImport_createdById_createdAt_idx" ON "public"."RosterImport"("createdById", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RosterImport_status_expiresAt_idx" ON "public"."RosterImport"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "Announcement_publishedAt_idx" ON "public"."Announcement"("publishedAt" DESC);

-- CreateIndex
CREATE INDEX "ProblemReview_problemVersionId_createdAt_idx" ON "public"."ProblemReview"("problemVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "ProblemImport_uploadedById_startedAt_idx" ON "public"."ProblemImport"("uploadedById", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ProblemImportRow_importId_entry_key" ON "public"."ProblemImportRow"("importId", "entry");

-- CreateIndex
CREATE INDEX "Notification_announcementId_readAt_idx" ON "public"."Notification"("announcementId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "Session_impersonationId_key" ON "public"."Session"("impersonationId");

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_impersonationId_fkey" FOREIGN KEY ("impersonationId") REFERENCES "public"."ImpersonationSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "public"."Announcement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AdminScope" ADD CONSTRAINT "AdminScope_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Accommodation" ADD CONSTRAINT "Accommodation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Accommodation" ADD CONSTRAINT "Accommodation_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "public"."Accommodation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProblemReview" ADD CONSTRAINT "ProblemReview_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProblemImportRow" ADD CONSTRAINT "ProblemImportRow_importId_fkey" FOREIGN KEY ("importId") REFERENCES "public"."ProblemImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────
-- Hand-written: constraints and fences Prisma cannot express. Each section
-- names the Phase 4 stream that owns the rule.
-- ────────────────────────────────────────────────────────────────────────

-- ── governance: PrivilegedOperation two-person rule, expiry, immutable request ──
-- Once decided, breakGlass is true exactly when the decider is the requester
-- (a self-approval is only ever an audited break-glass). A request lives at
-- most 24 hours.
ALTER TABLE "public"."PrivilegedOperation"
  ADD CONSTRAINT "PrivilegedOperation_two_person"
    CHECK ("decidedById" IS NULL OR "breakGlass" = ("decidedById" = "requestedById")),
  ADD CONSTRAINT "PrivilegedOperation_expiry"
    CHECK ("expiresAt" <= "requestedAt" + interval '24 hours');

-- The request fields are what the approver approved (payloadSha256): they
-- never change, and an operation row is never deleted.
CREATE OR REPLACE FUNCTION recx_refuse_privileged_request_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'PrivilegedOperation % cannot be deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."kind", NEW."payload", NEW."payloadSha256", NEW."summary", NEW."affectedCount",
      NEW."reason", NEW."requestedById", NEW."requestedAt", NEW."expiresAt")
     IS DISTINCT FROM
     (OLD."kind", OLD."payload", OLD."payloadSha256", OLD."summary", OLD."affectedCount",
      OLD."reason", OLD."requestedById", OLD."requestedAt", OLD."expiresAt") THEN
    RAISE EXCEPTION 'PrivilegedOperation % request fields are immutable', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PrivilegedOperation_request_immutable"
  BEFORE UPDATE OR DELETE ON "public"."PrivilegedOperation"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_privileged_request_change();

-- ── governance: ImpersonationSession box (15 minutes, never yourself) ──
ALTER TABLE "public"."ImpersonationSession"
  ADD CONSTRAINT "ImpersonationSession_box"
    CHECK ("expiresAt" <= "startedAt" + interval '15 minutes'),
  ADD CONSTRAINT "ImpersonationSession_not_self"
    CHECK ("impersonatorId" <> "targetUserId");

-- ── admin: one active AdminScope grant per (admin, department, batch) ──
-- Partial-index decision (Phase 4 foundation): a partial unique index
--   CREATE UNIQUE INDEX … ON "AdminScope" ("adminId","departmentCode","batchYear")
--     NULLS NOT DISTINCT WHERE "revokedAt" IS NULL
-- and the two Accommodation partial uniques below were tested against
-- `prisma migrate diff --from-migrations … --to-schema-datamodel …
-- --shadow-database-url … --exit-code`.
-- Outcome (2026-10-10, Prisma 6.16.2, PostgreSQL 17): CLEAN, exit 0. Prisma
-- does not diff partial indexes, while a control (an extra NON-partial index
-- in a temp copy of the migrations) is reported as drift (exit 2). So the
-- partial unique indexes are kept; the advisory-lock + trigger fallback is
-- not needed. A duplicate active grant fails with unique_violation (Prisma
-- P2002); the grant action may still lock and pre-check for a friendlier
-- message.
CREATE UNIQUE INDEX "AdminScope_active_grant_key" ON "public"."AdminScope" ("adminId", "departmentCode", "batchYear")
  NULLS NOT DISTINCT WHERE "revokedAt" IS NULL;

-- ── admin: at most one APPROVED and one open REQUESTED accommodation per user ──
-- Same drift-check outcome as above (partial unique indexes, kept).
CREATE UNIQUE INDEX "Accommodation_one_approved_per_user" ON "public"."Accommodation" ("userId")
  WHERE "status" = 'APPROVED';
CREATE UNIQUE INDEX "Accommodation_one_open_request_per_user" ON "public"."Accommodation" ("userId")
  WHERE "status" = 'REQUESTED';

-- ── admin: Accommodation bounds and granted-terms immutability ──
ALTER TABLE "public"."Accommodation"
  ADD CONSTRAINT "Accommodation_extra_time_percent_check" CHECK ("extraTimePercent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "Accommodation_extra_time_minutes_check" CHECK ("extraTimeMinutes" BETWEEN 0 AND 240),
  ADD CONSTRAINT "Accommodation_breaks_check"
    CHECK ("breakMinutes" BETWEEN 0 AND 120 AND ("allowBreaks" OR "breakMinutes" = 0)),
  ADD CONSTRAINT "Accommodation_font_scale_check" CHECK ("fontScalePercent" BETWEEN 100 AND 200),
  -- A NULL array (kinds omitted on create) is refused as well as an empty one.
  ADD CONSTRAINT "Accommodation_kinds_nonempty_check" CHECK (COALESCE(cardinality("kinds"), 0) > 0),
  ADD CONSTRAINT "Accommodation_granted_check"
    CHECK ("status" NOT IN ('APPROVED', 'REVOKED', 'SUPERSEDED')
      OR ("approvedBySuperAdminId" IS NOT NULL AND "grantedAt" IS NOT NULL));

-- Granted terms are immutable (same shape as recx_refuse_frozen_version_write
-- in 20261009210810_init): once grantedAt is set, the terms — and the grant
-- itself (grantedAt, approvedBySuperAdminId) — never change, and the row is
-- never deleted. Status, decision, revocation and supersession columns stay
-- writable: a change of terms is a new request that supersedes this one.
CREATE OR REPLACE FUNCTION recx_refuse_granted_accommodation_terms() RETURNS trigger AS $$
BEGIN
  IF OLD."grantedAt" IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Accommodation % was granted and cannot be deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."userId", NEW."kinds", NEW."exemptSignals", NEW."extraTimePercent", NEW."extraTimeMinutes",
      NEW."allowBreaks", NEW."breakMinutes", NEW."fontScalePercent", NEW."allowScribe", NEW."highContrast",
      NEW."reason", NEW."validUntil", NEW."grantedAt", NEW."approvedBySuperAdminId")
     IS DISTINCT FROM
     (OLD."userId", OLD."kinds", OLD."exemptSignals", OLD."extraTimePercent", OLD."extraTimeMinutes",
      OLD."allowBreaks", OLD."breakMinutes", OLD."fontScalePercent", OLD."allowScribe", OLD."highContrast",
      OLD."reason", OLD."validUntil", OLD."grantedAt", OLD."approvedBySuperAdminId") THEN
    RAISE EXCEPTION 'Accommodation % was granted: its terms are immutable (request a superseding accommodation)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Accommodation_granted_terms_immutable"
  BEFORE UPDATE OR DELETE ON "public"."Accommodation"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_granted_accommodation_terms();

-- ── admin: Announcement audience and text bounds ──
ALTER TABLE "public"."Announcement"
  ADD CONSTRAINT "Announcement_section_needs_cohort_check"
    CHECK ("audienceSection" IS NULL OR ("audienceBatchYear" IS NOT NULL AND "audienceDepartmentCode" IS NOT NULL)),
  ADD CONSTRAINT "Announcement_title_len_check" CHECK (char_length("title") BETWEEN 1 AND 120),
  ADD CONSTRAINT "Announcement_body_len_check" CHECK (char_length("body") BETWEEN 1 AND 2000);

-- ── admin: the seeded study plans are seed-managed ──
UPDATE "public"."StudyPlan" SET "seedManaged" = true WHERE "slug" IN ('rec-starter-sheet', 'arrays-hashing-basics');

-- ── authoring: approval state ──
-- APPROVED = IN_REVIEW with approvedAt set; approvedAt survives into PUBLISHED
-- (frozen with the version) and is cleared on any return to DRAFT.
ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_approval_state"
    CHECK ("approvedAt" IS NULL OR "status" IN ('IN_REVIEW', 'PUBLISHED'));

-- ── authoring: a version is never born frozen ──
-- Publish (UPDATE of a version whose frozenAt is null) is the only way a
-- version becomes frozen; the repository guard in packages/db/src/frozen.ts
-- refuses the same create. The existing ProblemVersion_frozen_guard trigger
-- (init migration) refuses EVERY UPDATE once OLD."frozenAt" is set, so the
-- Phase 4 columns above (origin, editSeq, judgeSeq, lastEditedById,
-- updatedAt, submittedForReviewAt, submittedById, approvedAt, approvedById,
-- importSha256) freeze with the version without any change to it. Adding the
-- columns (ALTER TABLE … ADD COLUMN, constant or stable defaults) does not
-- fire row triggers, so frozen rows are not touched.
CREATE OR REPLACE FUNCTION recx_refuse_born_frozen_version() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ProblemVersion % cannot be created frozen; publishing freezes it', NEW."id"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProblemVersion_born_frozen_guard"
  BEFORE INSERT ON "public"."ProblemVersion"
  FOR EACH ROW WHEN (NEW."frozenAt" IS NOT NULL)
  EXECUTE FUNCTION recx_refuse_born_frozen_version();

-- ── authoring: TestBlob content is immutable ──
-- Blob bytes are pinned by sha256: the content columns never change, so a
-- published hidden test can never be rewritten through its blob. A no-op
-- update (ensureTestBlob's upsert of an already registered sha) is allowed.
CREATE OR REPLACE FUNCTION recx_refuse_test_blob_change() RETURNS trigger AS $$
BEGIN
  IF NEW."sha256" IS DISTINCT FROM OLD."sha256" OR NEW."sizeBytes" IS DISTINCT FROM OLD."sizeBytes"
     OR NEW."inline" IS DISTINCT FROM OLD."inline" OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey" THEN
    RAISE EXCEPTION 'TestBlob % is immutable', OLD."sha256"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TestBlob_immutable"
  BEFORE UPDATE ON "public"."TestBlob"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_test_blob_change();

-- ── authoring: frozen children ──
-- No new ProblemVersion child model in Phase 4. ProblemReview references a
-- version but is review history, not version content: it is NOT a frozen
-- child (FROZEN_EXEMPT_MODELS), is cascade-deleted with a deleted draft, and
-- is append-only by convention. ProblemImportRow.problemVersionId is a plain
-- string, not a relation.
