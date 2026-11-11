-- Phase 12h: mock interviews, with a read-only mirror for the interviewer.
--
-- SPEC §11: "mock-interview scheduler with read-only spectate mode (full
-- Yjs collaborative editing is Phase 12)". The spectator is the
-- INTERVIEWER and nobody else — the spec contrasts the mode with
-- collaborative editing, so what it describes is a TA watching rather than
-- typing. Read as "an audience" it would be a surface showing one
-- student's draft code to others, which is the thing SPEC §9 forbids a
-- placement officer, and not something to build on an inference.
--
-- The CHECKs are the lifecycle written down. A slot's status and its
-- columns are what both people on the page are told — "booked", "running",
-- "nobody came" — so a row whose status and columns disagree is the
-- product lying to one of them.

-- CreateEnum
CREATE TYPE "public"."MockInterviewStatus" AS ENUM ('OPEN', 'BOOKED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateTable
CREATE TABLE "public"."MockInterview" (
    "id" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "candidateId" TEXT,
    "problemId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "status" "public"."MockInterviewStatus" NOT NULL DEFAULT 'OPEN',
    "bookedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "ratingCommunication" INTEGER,
    "ratingProblemSolving" INTEGER,
    "ratingCode" INTEGER,
    "feedbackMd" TEXT,
    "feedbackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MockInterview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MockInterviewSnapshot" (
    "interviewId" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MockInterviewSnapshot_pkey" PRIMARY KEY ("interviewId")
);

-- CreateIndex
CREATE INDEX "MockInterview_status_startsAt_idx" ON "public"."MockInterview"("status", "startsAt");

-- CreateIndex
CREATE INDEX "MockInterview_mentorId_startsAt_idx" ON "public"."MockInterview"("mentorId", "startsAt");

-- CreateIndex
CREATE INDEX "MockInterview_candidateId_startsAt_idx" ON "public"."MockInterview"("candidateId", "startsAt");

-- AddForeignKey
ALTER TABLE "public"."MockInterview" ADD CONSTRAINT "MockInterview_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MockInterview" ADD CONSTRAINT "MockInterview_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MockInterview" ADD CONSTRAINT "MockInterview_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MockInterview" ADD CONSTRAINT "MockInterview_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MockInterviewSnapshot" ADD CONSTRAINT "MockInterviewSnapshot_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "public"."MockInterview"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A booked slot has a candidate; an open one does not. Everything after
-- BOOKED keeps the candidate, because the record is about them.
ALTER TABLE "public"."MockInterview"
  ADD CONSTRAINT "MockInterview_candidate_pair_check"
  CHECK (
    ("status" = 'OPEN' AND "candidateId" IS NULL AND "bookedAt" IS NULL)
    OR ("status" = 'CANCELLED')
    OR ("status" <> 'OPEN' AND "candidateId" IS NOT NULL AND "bookedAt" IS NOT NULL)
  );

-- Running means it started; over means it ended; and it cannot have ended
-- before it started.
ALTER TABLE "public"."MockInterview"
  ADD CONSTRAINT "MockInterview_timing_check"
  CHECK (
    ("status" IN ('IN_PROGRESS', 'COMPLETED') = ("startedAt" IS NOT NULL))
    AND (("status" = 'COMPLETED') = ("endedAt" IS NOT NULL))
    AND ("endedAt" IS NULL OR "startedAt" IS NULL OR "endedAt" >= "startedAt")
  );

-- A cancelled slot names who called it off and why; nothing else carries
-- either. The candidate is shown both.
ALTER TABLE "public"."MockInterview"
  ADD CONSTRAINT "MockInterview_cancel_pair_check"
  CHECK (
    ("status" = 'CANCELLED' AND "cancelledById" IS NOT NULL AND "cancelReason" IS NOT NULL)
    OR ("status" <> 'CANCELLED' AND "cancelledById" IS NULL AND "cancelReason" IS NULL)
  );

ALTER TABLE "public"."MockInterview"
  ADD CONSTRAINT "MockInterview_cancel_reason_size_check"
  CHECK ("cancelReason" IS NULL OR (length("cancelReason") >= 10 AND length("cancelReason") <= 500));

-- A slot nobody could sit, or one that runs into next week, is a mistake
-- rather than a plan.
ALTER TABLE "public"."MockInterview"
  ADD CONSTRAINT "MockInterview_duration_check"
  CHECK ("durationMinutes" >= 15 AND "durationMinutes" <= 120);

-- The feedback is written once, as a whole: three ratings in range, a
-- bounded note and the moment. Half of it would be worse than none,
-- because the candidate is shown whatever is there.
ALTER TABLE "public"."MockInterview"
  ADD CONSTRAINT "MockInterview_feedback_pair_check"
  CHECK (
    ("feedbackAt" IS NULL AND "ratingCommunication" IS NULL AND "ratingProblemSolving" IS NULL
      AND "ratingCode" IS NULL AND "feedbackMd" IS NULL)
    OR ("feedbackAt" IS NOT NULL AND "ratingCommunication" IS NOT NULL AND "ratingProblemSolving" IS NOT NULL
      AND "ratingCode" IS NOT NULL AND "feedbackMd" IS NOT NULL)
  );

ALTER TABLE "public"."MockInterview"
  ADD CONSTRAINT "MockInterview_rating_range_check"
  CHECK (
    ("ratingCommunication" IS NULL OR "ratingCommunication" BETWEEN 1 AND 5)
    AND ("ratingProblemSolving" IS NULL OR "ratingProblemSolving" BETWEEN 1 AND 5)
    AND ("ratingCode" IS NULL OR "ratingCode" BETWEEN 1 AND 5)
  );

ALTER TABLE "public"."MockInterview"
  ADD CONSTRAINT "MockInterview_feedback_size_check"
  CHECK ("feedbackMd" IS NULL OR (length("feedbackMd") >= 30 AND length("feedbackMd") <= 4000));

-- Nobody interviews themselves.
ALTER TABLE "public"."MockInterview"
  ADD CONSTRAINT "MockInterview_not_self_check"
  CHECK ("candidateId" IS NULL OR "candidateId" <> "mentorId");

-- The mirror is bounded, because the interviewer's page renders it.
ALTER TABLE "public"."MockInterviewSnapshot"
  ADD CONSTRAINT "MockInterviewSnapshot_source_size_check"
  CHECK (length("source") <= 40000);
