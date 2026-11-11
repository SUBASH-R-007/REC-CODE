-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('STUDENT', 'TA_MENTOR', 'ADMIN', 'PLACEMENT_OFFICER', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "public"."AccountStatus" AS ENUM ('ACTIVE', 'SOFT_RESTRICTED', 'DISABLED', 'GRADUATED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "public"."Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');

-- CreateEnum
CREATE TYPE "public"."ProblemStatus" AS ENUM ('DRAFT', 'IN_REVIEW', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "public"."IoMode" AS ENUM ('STDIN', 'FUNCTION');

-- CreateEnum
CREATE TYPE "public"."Verdict" AS ENUM ('AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'OLE', 'PARTIAL', 'SKIPPED', 'IE');

-- CreateEnum
CREATE TYPE "public"."SubmissionStatus" AS ENUM ('QUEUED', 'JUDGING', 'DONE', 'INTERNAL_ERROR', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."JudgeState" AS ENUM ('PENDING', 'DISPATCHED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."JudgeLane" AS ENUM ('ASSESSMENT', 'CONTEST', 'RUN', 'PRACTICE', 'REJUDGE');

-- CreateEnum
CREATE TYPE "public"."SubmissionOrigin" AS ENUM ('PRACTICE', 'CONTEST', 'ASSESSMENT', 'CUSTOM_RUN');

-- CreateEnum
CREATE TYPE "public"."ScoringMode" AS ENUM ('ICPC', 'SUBTASK', 'PER_TEST');

-- CreateEnum
CREATE TYPE "public"."CompareMode" AS ENUM ('EXACT', 'TOKEN', 'FLOAT', 'CHECKER', 'INTERACTIVE');

-- CreateEnum
CREATE TYPE "public"."JudgeNodeStatus" AS ENUM ('ONLINE', 'DRAINING', 'OFFLINE', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "public"."AuditSensitivity" AS ENUM ('NORMAL', 'SENSITIVE', 'SECURITY');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "lmsUserId" TEXT,
    "collegeId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "role" "public"."Role" NOT NULL DEFAULT 'STUDENT',
    "status" "public"."AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "passwordHash" TEXT,
    "batchYear" INTEGER,
    "departmentCode" TEXT,
    "section" TEXT,
    "lastActiveAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "targetUserId" TEXT,
    "sensitivity" "public"."AuditSensitivity" NOT NULL DEFAULT 'NORMAL',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ipHash" TEXT,
    "chainDay" TEXT NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Problem" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "displayCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "difficulty" "public"."Difficulty" NOT NULL,
    "status" "public"."ProblemStatus" NOT NULL DEFAULT 'DRAFT',
    "liveVersionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Problem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProblemVersion" (
    "id" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "public"."ProblemStatus" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "difficulty" "public"."Difficulty" NOT NULL,
    "statementMd" TEXT NOT NULL,
    "constraints" JSONB NOT NULL DEFAULT '[]',
    "ioMode" "public"."IoMode" NOT NULL,
    "functionSignature" JSONB,
    "compareMode" "public"."CompareMode" NOT NULL DEFAULT 'TOKEN',
    "floatEpsilon" DOUBLE PRECISION,
    "scoringMode" "public"."ScoringMode" NOT NULL DEFAULT 'ICPC',
    "stopOnFirstFailure" BOOLEAN NOT NULL DEFAULT true,
    "timeLimitMs" INTEGER NOT NULL,
    "memoryLimitKb" INTEGER NOT NULL DEFAULT 262144,
    "checkerSha256" TEXT,
    "bundleKey" TEXT,
    "manifestSha256" TEXT,
    "frozenAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProblemVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TestCase" (
    "id" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "isSample" BOOLEAN NOT NULL DEFAULT false,
    "inputSha256" TEXT NOT NULL,
    "outputSha256" TEXT NOT NULL,
    "points" INTEGER,
    "subtaskIndex" INTEGER,

    CONSTRAINT "TestCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TestBlob" (
    "id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "inline" TEXT,
    "storageKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestBlob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StarterCode" (
    "id" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "code" TEXT NOT NULL,

    CONSTRAINT "StarterCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReferenceSolution" (
    "id" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "label" TEXT,
    "source" TEXT NOT NULL,
    "expectedVerdict" "public"."Verdict" NOT NULL,
    "measuredMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceSolution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."LanguageConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "toolchainId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "runtime" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "LanguageConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Submission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "languageConfigId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "origin" "public"."SubmissionOrigin" NOT NULL DEFAULT 'PRACTICE',
    "lane" "public"."JudgeLane" NOT NULL DEFAULT 'PRACTICE',
    "status" "public"."SubmissionStatus" NOT NULL DEFAULT 'QUEUED',
    "judgeState" "public"."JudgeState" NOT NULL DEFAULT 'PENDING',
    "verdict" "public"."Verdict",
    "score" DOUBLE PRECISION,
    "testResults" JSONB,
    "passedCases" INTEGER NOT NULL DEFAULT 0,
    "totalCases" INTEGER NOT NULL DEFAULT 0,
    "maxTimeMs" INTEGER,
    "maxMemoryKb" INTEGER,
    "firstFailedIndex" INTEGER,
    "compileOutput" TEXT,
    "sourceSha256" TEXT NOT NULL,
    "sourceBytes" INTEGER NOT NULL,
    "contestId" TEXT,
    "assessmentAttemptId" TEXT,
    "claimedByNodeId" TEXT,
    "claimToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "judgeNodeId" TEXT,
    "calibrationScore" DOUBLE PRECISION,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "judgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SubmissionSource" (
    "submissionId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "SubmissionSource_pkey" PRIMARY KEY ("submissionId")
);

-- CreateTable
CREATE TABLE "public"."SubmissionTestDetail" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "testIndex" INTEGER NOT NULL,
    "input" TEXT,
    "expected" TEXT,
    "stdout" TEXT,
    "stderr" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubmissionTestDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RunRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "languageConfigId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "customInput" TEXT,
    "status" "public"."SubmissionStatus" NOT NULL DEFAULT 'QUEUED',
    "judgeState" "public"."JudgeState" NOT NULL DEFAULT 'PENDING',
    "verdict" "public"."Verdict",
    "result" JSONB,
    "compileOutput" TEXT,
    "claimedByNodeId" TEXT,
    "claimToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "judgeNodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "judgedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RunRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."JudgeNode" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "workerVersion" TEXT NOT NULL DEFAULT '',
    "isolateVersion" TEXT NOT NULL DEFAULT '',
    "driver" TEXT NOT NULL DEFAULT 'isolate',
    "languages" JSONB NOT NULL DEFAULT '[]',
    "slots" INTEGER NOT NULL DEFAULT 0,
    "busySlots" INTEGER NOT NULL DEFAULT 0,
    "calibrationScore" DOUBLE PRECISION,
    "status" "public"."JudgeNodeStatus" NOT NULL DEFAULT 'OFFLINE',
    "consecutiveIe" INTEGER NOT NULL DEFAULT 0,
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastSelfCheckAt" TIMESTAMP(3),
    "selfCheckOk" BOOLEAN,
    "selfCheckFailures" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgeNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatformTheme" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "presetKey" TEXT NOT NULL DEFAULT 'rec-purple',
    "brandSeed" TEXT NOT NULL DEFAULT '#6d28d9',
    "accentSeed" TEXT NOT NULL DEFAULT '#b45309',
    "radius" TEXT NOT NULL DEFAULT '0.75rem',
    "palette" JSONB NOT NULL,
    "css" TEXT NOT NULL,
    "paletteVersion" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PlatformTheme_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_lmsUserId_key" ON "public"."User"("lmsUserId");

-- CreateIndex
CREATE UNIQUE INDEX "User_collegeId_key" ON "public"."User"("collegeId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_handle_key" ON "public"."User"("handle");

-- CreateIndex
CREATE INDEX "User_status_lastActiveAt_idx" ON "public"."User"("status", "lastActiveAt");

-- CreateIndex
CREATE INDEX "User_batchYear_departmentCode_section_idx" ON "public"."User"("batchYear", "departmentCode", "section");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "public"."Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "public"."Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "public"."Session"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetUserId_createdAt_idx" ON "public"."AuditLog"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_sensitivity_createdAt_idx" ON "public"."AuditLog"("sensitivity", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_chainDay_id_idx" ON "public"."AuditLog"("chainDay", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Problem_slug_key" ON "public"."Problem"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Problem_displayCode_key" ON "public"."Problem"("displayCode");

-- CreateIndex
CREATE UNIQUE INDEX "Problem_liveVersionId_key" ON "public"."Problem"("liveVersionId");

-- CreateIndex
CREATE INDEX "Problem_status_difficulty_displayCode_idx" ON "public"."Problem"("status", "difficulty", "displayCode");

-- CreateIndex
CREATE UNIQUE INDEX "ProblemVersion_problemId_revision_key" ON "public"."ProblemVersion"("problemId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "TestCase_problemVersionId_index_key" ON "public"."TestCase"("problemVersionId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "TestBlob_sha256_key" ON "public"."TestBlob"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "StarterCode_problemVersionId_language_key" ON "public"."StarterCode"("problemVersionId", "language");

-- CreateIndex
CREATE INDEX "ReferenceSolution_problemVersionId_idx" ON "public"."ReferenceSolution"("problemVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "LanguageConfig_key_toolchainId_key" ON "public"."LanguageConfig"("key", "toolchainId");

-- CreateIndex
CREATE INDEX "Submission_userId_createdAt_idx" ON "public"."Submission"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Submission_userId_problemId_createdAt_idx" ON "public"."Submission"("userId", "problemId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Submission_problemId_verdict_createdAt_idx" ON "public"."Submission"("problemId", "verdict", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Submission_contestId_userId_problemId_idx" ON "public"."Submission"("contestId", "userId", "problemId");

-- CreateIndex
CREATE INDEX "Submission_assessmentAttemptId_problemVersionId_createdAt_idx" ON "public"."Submission"("assessmentAttemptId", "problemVersionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Submission_judgeState_queuedAt_idx" ON "public"."Submission"("judgeState", "queuedAt");

-- CreateIndex
CREATE INDEX "Submission_status_leaseExpiresAt_idx" ON "public"."Submission"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "Submission_sourceSha256_idx" ON "public"."Submission"("sourceSha256");

-- CreateIndex
CREATE INDEX "Submission_createdAt_idx" ON "public"."Submission"("createdAt");

-- CreateIndex
CREATE INDEX "SubmissionTestDetail_createdAt_idx" ON "public"."SubmissionTestDetail"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionTestDetail_submissionId_testIndex_key" ON "public"."SubmissionTestDetail"("submissionId", "testIndex");

-- CreateIndex
CREATE INDEX "RunRequest_userId_createdAt_idx" ON "public"."RunRequest"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RunRequest_status_leaseExpiresAt_idx" ON "public"."RunRequest"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "RunRequest_expiresAt_idx" ON "public"."RunRequest"("expiresAt");

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Problem" ADD CONSTRAINT "Problem_liveVersionId_fkey" FOREIGN KEY ("liveVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProblemVersion" ADD CONSTRAINT "ProblemVersion_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TestCase" ADD CONSTRAINT "TestCase_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TestCase" ADD CONSTRAINT "TestCase_inputSha256_fkey" FOREIGN KEY ("inputSha256") REFERENCES "public"."TestBlob"("sha256") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TestCase" ADD CONSTRAINT "TestCase_outputSha256_fkey" FOREIGN KEY ("outputSha256") REFERENCES "public"."TestBlob"("sha256") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StarterCode" ADD CONSTRAINT "StarterCode_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReferenceSolution" ADD CONSTRAINT "ReferenceSolution_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Submission" ADD CONSTRAINT "Submission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Submission" ADD CONSTRAINT "Submission_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Submission" ADD CONSTRAINT "Submission_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Submission" ADD CONSTRAINT "Submission_languageConfigId_fkey" FOREIGN KEY ("languageConfigId") REFERENCES "public"."LanguageConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SubmissionSource" ADD CONSTRAINT "SubmissionSource_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "public"."Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SubmissionTestDetail" ADD CONSTRAINT "SubmissionTestDetail_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "public"."Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RunRequest" ADD CONSTRAINT "RunRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RunRequest" ADD CONSTRAINT "RunRequest_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RunRequest" ADD CONSTRAINT "RunRequest_languageConfigId_fkey" FOREIGN KEY ("languageConfigId") REFERENCES "public"."LanguageConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────
-- Hand-written: constraints and fences Prisma cannot express.
-- ────────────────────────────────────────────────────────────────────────

-- Source is capped at 256 KB (zod enforces the same before enqueue).
ALTER TABLE "public"."SubmissionSource"
  ADD CONSTRAINT "SubmissionSource_source_size_check" CHECK (octet_length("source") <= 262144);

-- Run requests: source cap and custom stdin cap (64 KB).
ALTER TABLE "public"."RunRequest"
  ADD CONSTRAINT "RunRequest_source_size_check" CHECK (octet_length("source") <= 262144),
  ADD CONSTRAINT "RunRequest_custom_input_size_check" CHECK ("customInput" IS NULL OR octet_length("customInput") <= 65536);

-- Inline test blobs are at most 64 KB; larger blobs live in object storage.
ALTER TABLE "public"."TestBlob"
  ADD CONSTRAINT "TestBlob_inline_size_check" CHECK ("inline" IS NULL OR octet_length("inline") <= 65536),
  ADD CONSTRAINT "TestBlob_has_content_check" CHECK ("inline" IS NOT NULL OR "storageKey" IS NOT NULL);

-- Frozen problem versions are immutable (second fence behind the repository
-- guard in packages/db/src/frozen.ts). The publish transition — setting
-- frozenAt on a version whose frozenAt is null — is the only permitted write.
CREATE OR REPLACE FUNCTION recx_refuse_frozen_version_write() RETURNS trigger AS $$
BEGIN
  IF OLD."frozenAt" IS NOT NULL THEN
    RAISE EXCEPTION 'ProblemVersion % is frozen and immutable', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ProblemVersion_frozen_guard"
  BEFORE UPDATE OR DELETE ON "public"."ProblemVersion"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_frozen_version_write();

CREATE OR REPLACE FUNCTION recx_refuse_frozen_child_write() RETURNS trigger AS $$
DECLARE
  version_id text;
  frozen timestamp(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    version_id := NEW."problemVersionId";
  ELSE
    version_id := OLD."problemVersionId";
  END IF;
  SELECT "frozenAt" INTO frozen FROM "public"."ProblemVersion" WHERE "id" = version_id;
  IF frozen IS NOT NULL THEN
    RAISE EXCEPTION '% of frozen ProblemVersion % is immutable', TG_TABLE_NAME, version_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."problemVersionId" IS DISTINCT FROM OLD."problemVersionId" THEN
    SELECT "frozenAt" INTO frozen FROM "public"."ProblemVersion" WHERE "id" = NEW."problemVersionId";
    IF frozen IS NOT NULL THEN
      RAISE EXCEPTION '% cannot be moved into frozen ProblemVersion %', TG_TABLE_NAME, NEW."problemVersionId"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TestCase_frozen_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."TestCase"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_frozen_child_write();
CREATE TRIGGER "StarterCode_frozen_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."StarterCode"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_frozen_child_write();
CREATE TRIGGER "ReferenceSolution_frozen_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."ReferenceSolution"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_frozen_child_write();

-- Audit rows are never edited (the hash chain would break anyway; this makes
-- the attempt fail loudly instead of silently). Retention deletes are allowed.
CREATE OR REPLACE FUNCTION recx_refuse_audit_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog rows are append-only' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE ON "public"."AuditLog"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_audit_update();
