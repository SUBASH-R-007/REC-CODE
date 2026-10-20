-- CreateEnum
CREATE TYPE "public"."Topic" AS ENUM ('ARRAYS_HASHING', 'TWO_POINTERS', 'SLIDING_WINDOW', 'STACK_QUEUE', 'BINARY_SEARCH', 'LINKED_LIST', 'TREES', 'HEAPS', 'BACKTRACKING', 'GRAPHS', 'DYNAMIC_PROGRAMMING', 'GREEDY', 'MATH_BITS', 'STRINGS');

-- CreateEnum
CREATE TYPE "public"."ProblemProgress" AS ENUM ('ATTEMPTED', 'SOLVED');

-- CreateEnum
CREATE TYPE "public"."XpPeriod" AS ENUM ('ALL_TIME', 'MONTH', 'WEEK');

-- CreateEnum
CREATE TYPE "public"."XpEventKind" AS ENUM ('SOLVE', 'DAILY_CHALLENGE', 'STREAK_MILESTONE', 'REVISION', 'CONTEST', 'MOCK', 'APTITUDE', 'ADMIN_GRANT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "public"."ProfileVisibility" AS ENUM ('PUBLIC', 'REC_ONLY', 'PRIVATE');

-- CreateEnum
CREATE TYPE "public"."HelpContext" AS ENUM ('PRACTICE', 'CONTEST', 'ASSESSMENT');

-- CreateEnum
CREATE TYPE "public"."StudyPlanKind" AS ENUM ('SHEET', 'TRACK');

-- AlterTable
ALTER TABLE "public"."Problem" ADD COLUMN     "editorialVisibleAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "bio" TEXT,
ADD COLUMN     "editorPrefs" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "leaderboardOptOut" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "visibility" "public"."ProfileVisibility" NOT NULL DEFAULT 'REC_ONLY';

-- CreateTable
CREATE TABLE "public"."ProblemTag" (
    "problemId" TEXT NOT NULL,
    "topic" "public"."Topic" NOT NULL,

    CONSTRAINT "ProblemTag_pkey" PRIMARY KEY ("problemId","topic")
);

-- CreateTable
CREATE TABLE "public"."Company" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "curated" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProblemCompanyTag" (
    "problemId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "frequency" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'CURATED',

    CONSTRAINT "ProblemCompanyTag_pkey" PRIMARY KEY ("problemId","companyId")
);

-- CreateTable
CREATE TABLE "public"."ProblemStat" (
    "problemId" TEXT NOT NULL,
    "submissions" INTEGER NOT NULL DEFAULT 0,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "attempters" INTEGER NOT NULL DEFAULT 0,
    "solvers" INTEGER NOT NULL DEFAULT 0,
    "acceptanceRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProblemStat_pkey" PRIMARY KEY ("problemId")
);

-- CreateTable
CREATE TABLE "public"."UserProblemStatus" (
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "status" "public"."ProblemProgress" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "firstAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastAttemptAt" TIMESTAMP(3) NOT NULL,
    "firstAcceptedAt" TIMESTAMP(3),
    "bestSubmissionId" TEXT,
    "assisted" BOOLEAN NOT NULL DEFAULT false,
    "solvedLanguage" TEXT,
    "activeSecondsToSolve" INTEGER,

    CONSTRAINT "UserProblemStatus_pkey" PRIMARY KEY ("userId","problemId")
);

-- CreateTable
CREATE TABLE "public"."ActivityDay" (
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "submissions" INTEGER NOT NULL DEFAULT 0,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "solved" INTEGER NOT NULL DEFAULT 0,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "xpEasy" INTEGER NOT NULL DEFAULT 0,
    "activeSeconds" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ActivityDay_pkey" PRIMARY KEY ("userId","date")
);

-- CreateTable
CREATE TABLE "public"."UserStats" (
    "userId" TEXT NOT NULL,
    "solvedEasy" INTEGER NOT NULL DEFAULT 0,
    "solvedMedium" INTEGER NOT NULL DEFAULT 0,
    "solvedHard" INTEGER NOT NULL DEFAULT 0,
    "solvedTotal" INTEGER NOT NULL DEFAULT 0,
    "assistedSolves" INTEGER NOT NULL DEFAULT 0,
    "submissions" INTEGER NOT NULL DEFAULT 0,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "longestStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveDate" DATE,
    "xpTotal" INTEGER NOT NULL DEFAULT 0,
    "languageCounts" JSONB NOT NULL DEFAULT '{}',
    "topicSolved" JSONB NOT NULL DEFAULT '{}',
    "topicAssisted" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserStats_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "public"."XpEvent" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "public"."XpEventKind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "rulesVersion" INTEGER NOT NULL,
    "problemId" TEXT,
    "submissionId" TEXT,
    "contestId" TEXT,
    "assessmentId" TEXT,
    "reversesEventId" BIGINT,
    "grantedById" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XpEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."XpBucket" (
    "userId" TEXT NOT NULL,
    "period" "public"."XpPeriod" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "solvedEasy" INTEGER NOT NULL DEFAULT 0,
    "solvedMedium" INTEGER NOT NULL DEFAULT 0,
    "solvedHard" INTEGER NOT NULL DEFAULT 0,
    "batchYear" INTEGER,
    "departmentCode" TEXT,
    "section" TEXT,
    "lastXpAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "public"."LeaderboardSnapshot" (
    "id" TEXT NOT NULL,
    "period" "public"."XpPeriod" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "top" JSONB NOT NULL,
    "frozenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaderboardSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DailyChallenge" (
    "date" DATE NOT NULL,
    "problemId" TEXT NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "DailyChallenge_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "public"."Badge" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Badge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserBadge" (
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBadge_pkey" PRIMARY KEY ("userId","badgeId")
);

-- CreateTable
CREATE TABLE "public"."Hint" (
    "id" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "contentMd" TEXT NOT NULL,

    CONSTRAINT "Hint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Editorial" (
    "id" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "contentMd" TEXT NOT NULL,

    CONSTRAINT "Editorial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."HintReveal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "hintId" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "context" "public"."HelpContext" NOT NULL,
    "revealedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HintReveal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EditorialView" (
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "firstViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditorialView_pkey" PRIMARY KEY ("userId","problemId")
);

-- CreateTable
CREATE TABLE "public"."ProblemActivity" (
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "activeSeconds" INTEGER NOT NULL DEFAULT 0,
    "lastPingAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProblemActivity_pkey" PRIMARY KEY ("userId","problemId")
);

-- CreateTable
CREATE TABLE "public"."StudyPlan" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "public"."StudyPlanKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "itemsTotal" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudyPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StudyPlanSection" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StudyPlanSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StudyPlanItem" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StudyPlanItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."StudyPlanEnrollment" (
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "itemsTotal" INTEGER NOT NULL DEFAULT 0,
    "itemsDone" INTEGER NOT NULL DEFAULT 0,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "StudyPlanEnrollment_pkey" PRIMARY KEY ("userId","planId")
);

-- CreateTable
CREATE TABLE "public"."Bookmark" (
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bookmark_pkey" PRIMARY KEY ("userId","problemId")
);

-- CreateTable
CREATE TABLE "public"."Note" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemId" TEXT,
    "title" TEXT,
    "contentMd" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CodeDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "clientUpdatedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProblemTag_topic_problemId_idx" ON "public"."ProblemTag"("topic", "problemId");

-- CreateIndex
CREATE UNIQUE INDEX "Company_slug_key" ON "public"."Company"("slug");

-- CreateIndex
CREATE INDEX "ProblemCompanyTag_companyId_frequency_idx" ON "public"."ProblemCompanyTag"("companyId", "frequency" DESC);

-- CreateIndex
CREATE INDEX "UserProblemStatus_userId_status_firstAcceptedAt_idx" ON "public"."UserProblemStatus"("userId", "status", "firstAcceptedAt" DESC);

-- CreateIndex
CREATE INDEX "UserProblemStatus_problemId_status_idx" ON "public"."UserProblemStatus"("problemId", "status");

-- CreateIndex
CREATE INDEX "ActivityDay_date_idx" ON "public"."ActivityDay"("date");

-- CreateIndex
CREATE INDEX "ActivityDay_userId_date_idx" ON "public"."ActivityDay"("userId", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "XpEvent_idempotencyKey_key" ON "public"."XpEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "XpEvent_userId_occurredAt_idx" ON "public"."XpEvent"("userId", "occurredAt");

-- CreateIndex
CREATE INDEX "XpBucket_period_periodKey_xp_lastXpAt_idx" ON "public"."XpBucket"("period", "periodKey", "xp" DESC, "lastXpAt" ASC);

-- CreateIndex
CREATE INDEX "XpBucket_period_periodKey_batchYear_xp_lastXpAt_idx" ON "public"."XpBucket"("period", "periodKey", "batchYear", "xp" DESC, "lastXpAt" ASC);

-- CreateIndex
CREATE INDEX "XpBucket_period_periodKey_departmentCode_xp_lastXpAt_idx" ON "public"."XpBucket"("period", "periodKey", "departmentCode", "xp" DESC, "lastXpAt" ASC);

-- CreateIndex
CREATE INDEX "XpBucket_period_periodKey_batchYear_departmentCode_section__idx" ON "public"."XpBucket"("period", "periodKey", "batchYear", "departmentCode", "section", "xp" DESC, "lastXpAt" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "XpBucket_period_periodKey_userId_key" ON "public"."XpBucket"("period", "periodKey", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardSnapshot_period_periodKey_scope_scopeKey_key" ON "public"."LeaderboardSnapshot"("period", "periodKey", "scope", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Badge_key_key" ON "public"."Badge"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Hint_problemVersionId_tier_key" ON "public"."Hint"("problemVersionId", "tier");

-- CreateIndex
CREATE UNIQUE INDEX "Editorial_problemVersionId_key" ON "public"."Editorial"("problemVersionId");

-- CreateIndex
CREATE INDEX "HintReveal_userId_problemId_idx" ON "public"."HintReveal"("userId", "problemId");

-- CreateIndex
CREATE UNIQUE INDEX "HintReveal_userId_hintId_key" ON "public"."HintReveal"("userId", "hintId");

-- CreateIndex
CREATE UNIQUE INDEX "StudyPlan_slug_key" ON "public"."StudyPlan"("slug");

-- CreateIndex
CREATE INDEX "StudyPlanItem_problemId_idx" ON "public"."StudyPlanItem"("problemId");

-- CreateIndex
CREATE UNIQUE INDEX "StudyPlanItem_planId_problemId_key" ON "public"."StudyPlanItem"("planId", "problemId");

-- CreateIndex
CREATE INDEX "StudyPlanEnrollment_planId_idx" ON "public"."StudyPlanEnrollment"("planId");

-- CreateIndex
CREATE INDEX "Bookmark_userId_createdAt_idx" ON "public"."Bookmark"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Note_userId_updatedAt_idx" ON "public"."Note"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "public"."Notification"("userId", "readAt", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "CodeDraft_userId_problemId_language_key" ON "public"."CodeDraft"("userId", "problemId", "language");

-- AddForeignKey
ALTER TABLE "public"."ProblemTag" ADD CONSTRAINT "ProblemTag_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProblemCompanyTag" ADD CONSTRAINT "ProblemCompanyTag_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProblemCompanyTag" ADD CONSTRAINT "ProblemCompanyTag_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProblemStat" ADD CONSTRAINT "ProblemStat_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserProblemStatus" ADD CONSTRAINT "UserProblemStatus_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserProblemStatus" ADD CONSTRAINT "UserProblemStatus_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ActivityDay" ADD CONSTRAINT "ActivityDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserStats" ADD CONSTRAINT "UserStats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."XpEvent" ADD CONSTRAINT "XpEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."XpBucket" ADD CONSTRAINT "XpBucket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DailyChallenge" ADD CONSTRAINT "DailyChallenge_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserBadge" ADD CONSTRAINT "UserBadge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserBadge" ADD CONSTRAINT "UserBadge_badgeId_fkey" FOREIGN KEY ("badgeId") REFERENCES "public"."Badge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Hint" ADD CONSTRAINT "Hint_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Editorial" ADD CONSTRAINT "Editorial_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."HintReveal" ADD CONSTRAINT "HintReveal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."HintReveal" ADD CONSTRAINT "HintReveal_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."HintReveal" ADD CONSTRAINT "HintReveal_hintId_fkey" FOREIGN KEY ("hintId") REFERENCES "public"."Hint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EditorialView" ADD CONSTRAINT "EditorialView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EditorialView" ADD CONSTRAINT "EditorialView_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProblemActivity" ADD CONSTRAINT "ProblemActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProblemActivity" ADD CONSTRAINT "ProblemActivity_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyPlanSection" ADD CONSTRAINT "StudyPlanSection_planId_fkey" FOREIGN KEY ("planId") REFERENCES "public"."StudyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyPlanItem" ADD CONSTRAINT "StudyPlanItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "public"."StudyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyPlanItem" ADD CONSTRAINT "StudyPlanItem_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "public"."StudyPlanSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyPlanItem" ADD CONSTRAINT "StudyPlanItem_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyPlanEnrollment" ADD CONSTRAINT "StudyPlanEnrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."StudyPlanEnrollment" ADD CONSTRAINT "StudyPlanEnrollment_planId_fkey" FOREIGN KEY ("planId") REFERENCES "public"."StudyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bookmark" ADD CONSTRAINT "Bookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Bookmark" ADD CONSTRAINT "Bookmark_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Note" ADD CONSTRAINT "Note_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Note" ADD CONSTRAINT "Note_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CodeDraft" ADD CONSTRAINT "CodeDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CodeDraft" ADD CONSTRAINT "CodeDraft_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ────────────────────────────────────────────────────────────────────────
-- Hand-written: fences Prisma cannot express.
-- ────────────────────────────────────────────────────────────────────────

-- The XP ledger is append-only: no UPDATE, no DELETE. Voiding XP writes a
-- compensating REVERSAL row. A trigger that raises is used instead of a
-- DO INSTEAD NOTHING rule, so an accidental write fails loudly rather than
-- silently doing nothing.
CREATE OR REPLACE FUNCTION recx_refuse_xp_event_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'XpEvent is an append-only ledger (write a REVERSAL row instead)'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "XpEvent_append_only"
  BEFORE UPDATE OR DELETE ON "public"."XpEvent"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_xp_event_change();

-- Hints and editorials are version content: frozen with the version.
CREATE TRIGGER "Hint_frozen_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."Hint"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_frozen_child_write();
CREATE TRIGGER "Editorial_frozen_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."Editorial"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_frozen_child_write();

-- Problem search: trigram GIN on the title (never a bare ILIKE '%x%' scan).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Problem_title_trgm_idx" ON "public"."Problem" USING gin ("title" gin_trgm_ops);

-- Size caps matching the zod boundaries.
ALTER TABLE "public"."CodeDraft"
  ADD CONSTRAINT "CodeDraft_source_size_check" CHECK (octet_length("source") <= 262144);
ALTER TABLE "public"."Note"
  ADD CONSTRAINT "Note_content_size_check" CHECK (octet_length("contentMd") <= 65536);
ALTER TABLE "public"."Hint"
  ADD CONSTRAINT "Hint_tier_check" CHECK ("tier" BETWEEN 1 AND 3);

-- Counters never go negative.
ALTER TABLE "public"."UserProblemStatus"
  ADD CONSTRAINT "UserProblemStatus_counts_check" CHECK ("attempts" >= 0 AND "failedAttempts" >= 0);
ALTER TABLE "public"."StudyPlanEnrollment"
  ADD CONSTRAINT "StudyPlanEnrollment_counts_check" CHECK ("itemsDone" >= 0 AND "itemsDone" <= "itemsTotal");
