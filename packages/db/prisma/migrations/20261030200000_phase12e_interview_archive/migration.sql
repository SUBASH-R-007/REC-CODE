-- Phase 12e: the interview-experience archive.
--
-- SPEC §11: "the moderated InterviewExperience archive — structured
-- fields, not prose — which is the only legal and genuinely REC-specific
-- source of company tags and 'asked at' frequency, and is therefore
-- load-bearing rather than a nicety."
--
-- Note what the table does NOT have: a body. There is one free-text
-- column, `companyName`, and it exists so a student can name a company
-- nobody has entered yet. An account of an interview written in a hurry
-- names interviewers, repeats questions under an NDA and says things
-- about a company the college would have to answer for — and prose cannot
-- be counted, which is the whole reason this archive exists.
--
-- The CHECKs hold up the parts a reader is told: a decided row names who
-- decided it and why, a month is a month, a year is in range, and a row
-- with no author is a pre-launch BOOTSTRAP row and nothing else.

-- CreateEnum
CREATE TYPE "public"."InterviewRoundKind" AS ENUM ('ONLINE_ASSESSMENT', 'TECHNICAL', 'SYSTEM_DESIGN', 'MANAGERIAL', 'HR');

-- CreateEnum
CREATE TYPE "public"."InterviewMode" AS ENUM ('ON_CAMPUS', 'OFF_CAMPUS', 'REFERRAL');

-- CreateEnum
CREATE TYPE "public"."InterviewOutcome" AS ENUM ('OFFER', 'NO_OFFER', 'WITHDREW', 'WAITING');

-- CreateEnum
CREATE TYPE "public"."InterviewPreparation" AS ENUM ('REC_CODE_PRACTICE', 'REC_CODE_CONTESTS', 'APTITUDE_PRACTICE', 'MOCK_INTERVIEWS', 'CORE_CS_REVISION', 'PROJECT_DEEP_DIVE', 'RESUME_REVIEW');

-- CreateEnum
CREATE TYPE "public"."InterviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "public"."InterviewSource" AS ENUM ('STUDENT', 'BOOTSTRAP');

-- CreateTable
CREATE TABLE "public"."InterviewExperience" (
    "id" TEXT NOT NULL,
    "authorId" TEXT,
    "source" "public"."InterviewSource" NOT NULL DEFAULT 'STUDENT',
    "companyId" TEXT,
    "companyName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "mode" "public"."InterviewMode" NOT NULL,
    "heldYear" INTEGER NOT NULL,
    "heldMonth" INTEGER NOT NULL,
    "rounds" INTEGER NOT NULL,
    "longestRoundMinutes" INTEGER,
    "outcome" "public"."InterviewOutcome" NOT NULL,
    "roundKinds" "public"."InterviewRoundKind"[],
    "topics" TEXT[],
    "preparation" "public"."InterviewPreparation"[],
    "status" "public"."InterviewStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterviewExperience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InterviewExperienceProblem" (
    "experienceId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,

    CONSTRAINT "InterviewExperienceProblem_pkey" PRIMARY KEY ("experienceId","problemId")
);

-- CreateIndex
CREATE INDEX "InterviewExperience_status_createdAt_idx" ON "public"."InterviewExperience"("status", "createdAt");

-- CreateIndex
CREATE INDEX "InterviewExperience_companyId_status_idx" ON "public"."InterviewExperience"("companyId", "status");

-- CreateIndex
CREATE INDEX "InterviewExperience_authorId_idx" ON "public"."InterviewExperience"("authorId");

-- CreateIndex
CREATE INDEX "InterviewExperienceProblem_problemId_idx" ON "public"."InterviewExperienceProblem"("problemId");

-- AddForeignKey
ALTER TABLE "public"."InterviewExperience" ADD CONSTRAINT "InterviewExperience_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InterviewExperience" ADD CONSTRAINT "InterviewExperience_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "public"."Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InterviewExperience" ADD CONSTRAINT "InterviewExperience_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InterviewExperienceProblem" ADD CONSTRAINT "InterviewExperienceProblem_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "public"."InterviewExperience"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InterviewExperienceProblem" ADD CONSTRAINT "InterviewExperienceProblem_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A decided row names the person, the moment and the sentence the student
-- is shown; a PENDING row names none of them.
ALTER TABLE "public"."InterviewExperience"
  ADD CONSTRAINT "InterviewExperience_decided_pair_check"
  CHECK (
    ("status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "decisionReason" IS NULL)
    OR ("status" <> 'PENDING' AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decisionReason" IS NOT NULL)
  );

-- A row with no author is the pre-launch collection, and nothing else. A
-- student submission that lost its author would be an anonymous claim
-- about a named company with nobody to ask about it.
ALTER TABLE "public"."InterviewExperience"
  ADD CONSTRAINT "InterviewExperience_author_check"
  CHECK (("source" = 'STUDENT' AND "authorId" IS NOT NULL) OR "source" = 'BOOTSTRAP');

-- Month precision, and a real month.
ALTER TABLE "public"."InterviewExperience"
  ADD CONSTRAINT "InterviewExperience_held_check"
  CHECK ("heldMonth" >= 1 AND "heldMonth" <= 12 AND "heldYear" >= 2020 AND "heldYear" <= 2100);

ALTER TABLE "public"."InterviewExperience"
  ADD CONSTRAINT "InterviewExperience_rounds_check"
  CHECK ("rounds" >= 1 AND "rounds" <= 12);

ALTER TABLE "public"."InterviewExperience"
  ADD CONSTRAINT "InterviewExperience_duration_check"
  CHECK ("longestRoundMinutes" IS NULL OR ("longestRoundMinutes" >= 5 AND "longestRoundMinutes" <= 600));

ALTER TABLE "public"."InterviewExperience"
  ADD CONSTRAINT "InterviewExperience_company_name_check"
  CHECK (length("companyName") >= 2 AND length("companyName") <= 80);

ALTER TABLE "public"."InterviewExperience"
  ADD CONSTRAINT "InterviewExperience_role_check"
  CHECK (length("role") >= 2 AND length("role") <= 80);

ALTER TABLE "public"."InterviewExperience"
  ADD CONSTRAINT "InterviewExperience_reason_size_check"
  CHECK ("decisionReason" IS NULL OR (length("decisionReason") >= 10 AND length("decisionReason") <= 500));

-- An experience that names no round kind describes nothing.
--
-- COALESCE, and not for tidiness: `array_length(x, 1)` returns NULL for an
-- EMPTY array, so the obvious `array_length(...) >= 1` evaluates to NULL
-- and a CHECK that is NULL passes. The first draft of this constraint read
-- exactly that way and accepted every empty list; the database test found
-- it on its first run.
ALTER TABLE "public"."InterviewExperience"
  ADD CONSTRAINT "InterviewExperience_round_kinds_check"
  CHECK (coalesce(array_length("roundKinds", 1), 0) BETWEEN 1 AND 12);

-- A company tag's frequency is a count, and a count is not negative.
-- Added here rather than in Phase 1 because this is the migration that
-- starts moving it: until now every tag was CURATED with a hand-set
-- number nobody incremented.
ALTER TABLE "public"."ProblemCompanyTag"
  ADD CONSTRAINT "ProblemCompanyTag_frequency_check"
  CHECK ("frequency" >= 0);
