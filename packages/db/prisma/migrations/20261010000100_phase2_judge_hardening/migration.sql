-- CreateEnum
CREATE TYPE "public"."SubtaskAggregation" AS ENUM ('MIN', 'SUM_FRACTION');

-- CreateEnum
CREATE TYPE "public"."ValidationOutcome" AS ENUM ('PENDING', 'MATCHED', 'MISMATCHED', 'FAILED');

-- AlterTable
ALTER TABLE "public"."JudgeNode" ADD COLUMN     "calibratedAt" TIMESTAMP(3),
ADD COLUMN     "hardeningFailures" JSONB,
ADD COLUMN     "hostHardened" BOOLEAN,
ADD COLUMN     "laneRestrictions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "sensitiveLanesOk" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "startupMs" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "public"."ProblemVersion" ADD COLUMN     "testlibId" TEXT;

-- AlterTable
ALTER TABLE "public"."Submission" ADD COLUMN     "cpuMs" INTEGER,
ADD COLUMN     "maxScore" DOUBLE PRECISION,
ADD COLUMN     "subtaskResults" JSONB;

-- CreateTable
CREATE TABLE "public"."Subtask" (
    "id" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "aggregation" "public"."SubtaskAggregation" NOT NULL DEFAULT 'MIN',
    "dependsOn" INTEGER[] DEFAULT ARRAY[]::INTEGER[],

    CONSTRAINT "Subtask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProblemLanguageLimit" (
    "id" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "timeLimitMs" INTEGER NOT NULL,
    "memoryLimitKb" INTEGER NOT NULL,
    "measuredModelMs" INTEGER,
    "measuredOnGeneration" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProblemLanguageLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ValidationRun" (
    "id" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "referenceSolutionId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "languageConfigId" TEXT NOT NULL,
    "status" "public"."SubmissionStatus" NOT NULL DEFAULT 'QUEUED',
    "judgeState" "public"."JudgeState" NOT NULL DEFAULT 'PENDING',
    "verdict" "public"."Verdict",
    "outcome" "public"."ValidationOutcome" NOT NULL DEFAULT 'PENDING',
    "measuredMs" INTEGER,
    "testResults" JSONB,
    "compileOutput" TEXT,
    "claimedByNodeId" TEXT,
    "claimToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "judgeNodeId" TEXT,
    "calibrationScore" DOUBLE PRECISION,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "judgedAt" TIMESTAMP(3),

    CONSTRAINT "ValidationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserJudgeUsage" (
    "userId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "submissions" INTEGER NOT NULL DEFAULT 0,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "cpuMs" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserJudgeUsage_pkey" PRIMARY KEY ("userId","day")
);

-- CreateTable
CREATE TABLE "public"."JudgeQuotaOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "practicePerDay" INTEGER,
    "runsPerHour" INTEGER,
    "cpuMinutesPerDay" INTEGER,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JudgeQuotaOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Subtask_problemVersionId_index_key" ON "public"."Subtask"("problemVersionId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "ProblemLanguageLimit_problemVersionId_language_key" ON "public"."ProblemLanguageLimit"("problemVersionId", "language");

-- CreateIndex
CREATE INDEX "ValidationRun_problemVersionId_createdAt_idx" ON "public"."ValidationRun"("problemVersionId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ValidationRun_status_leaseExpiresAt_idx" ON "public"."ValidationRun"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX "JudgeQuotaOverride_userId_createdAt_idx" ON "public"."JudgeQuotaOverride"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "public"."Subtask" ADD CONSTRAINT "Subtask_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProblemLanguageLimit" ADD CONSTRAINT "ProblemLanguageLimit_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ValidationRun" ADD CONSTRAINT "ValidationRun_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ValidationRun" ADD CONSTRAINT "ValidationRun_referenceSolutionId_fkey" FOREIGN KEY ("referenceSolutionId") REFERENCES "public"."ReferenceSolution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ValidationRun" ADD CONSTRAINT "ValidationRun_languageConfigId_fkey" FOREIGN KEY ("languageConfigId") REFERENCES "public"."LanguageConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserJudgeUsage" ADD CONSTRAINT "UserJudgeUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."JudgeQuotaOverride" ADD CONSTRAINT "JudgeQuotaOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────
-- Hand-written: Subtask and ProblemLanguageLimit are children of a
-- ProblemVersion and are frozen with it (same trigger as TestCase et al.).
-- ────────────────────────────────────────────────────────────────────────
CREATE TRIGGER "Subtask_frozen_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."Subtask"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_frozen_child_write();
CREATE TRIGGER "ProblemLanguageLimit_frozen_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."ProblemLanguageLimit"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_frozen_child_write();

-- Usage counters never go negative.
ALTER TABLE "public"."UserJudgeUsage"
  ADD CONSTRAINT "UserJudgeUsage_nonnegative_check"
  CHECK ("submissions" >= 0 AND "runs" >= 0 AND "cpuMs" >= 0);
