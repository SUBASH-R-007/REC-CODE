-- Phase 12d: discussion, shared solutions, doubts and moderation.
--
-- SPEC §11: "discussion and solution sharing gated behind an unassisted
-- solve (with the TA_MENTOR moderation role shipping simultaneously, not
-- after)." The parenthesis is why four tables arrive together rather than
-- the first two now and moderation later: a place where students post about
-- problems, with nobody able to take a post down, is not a feature, it is
-- an incident with a date on it.
--
-- The CHECKs at the foot are the parts of that sentence the data can hold:
-- a hidden post names who hid it and why, a resolved report names who
-- resolved it, a report points at exactly one thing, and a reply cannot be
-- its own parent. Each is something a moderator or a student is TOLD, so a
-- row that breaks it makes the product lie rather than merely misbehave.

-- CreateEnum
CREATE TYPE "public"."DiscussionPostKind" AS ENUM ('SOLUTION', 'TIP');

-- CreateEnum
CREATE TYPE "public"."DiscussionPostStatus" AS ENUM ('VISIBLE', 'HIDDEN');

-- CreateEnum
CREATE TYPE "public"."DoubtStatus" AS ENUM ('OPEN', 'ANSWERED');

-- CreateEnum
CREATE TYPE "public"."ReportReason" AS ENUM ('SPOILER', 'WRONG', 'ABUSE', 'SPAM', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."ReportStatus" AS ENUM ('OPEN', 'UPHELD', 'DISMISSED');

-- CreateTable
CREATE TABLE "public"."DiscussionPost" (
    "id" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "parentId" TEXT,
    "kind" "public"."DiscussionPostKind" NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "language" TEXT,
    "submissionId" TEXT,
    "status" "public"."DiscussionPostStatus" NOT NULL DEFAULT 'VISIBLE',
    "editorialQuality" BOOLEAN NOT NULL DEFAULT false,
    "hiddenById" TEXT,
    "hiddenReason" TEXT,
    "hiddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "DiscussionPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DoubtThread" (
    "id" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "status" "public"."DoubtStatus" NOT NULL DEFAULT 'OPEN',
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "DoubtThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DoubtReply" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "byMentor" BOOLEAN NOT NULL DEFAULT false,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoubtReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ContentReport" (
    "id" TEXT NOT NULL,
    "postId" TEXT,
    "doubtId" TEXT,
    "reporterId" TEXT NOT NULL,
    "reason" "public"."ReportReason" NOT NULL,
    "detail" TEXT NOT NULL,
    "status" "public"."ReportStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscussionPost_problemId_status_createdAt_idx" ON "public"."DiscussionPost"("problemId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DiscussionPost_parentId_idx" ON "public"."DiscussionPost"("parentId");

-- CreateIndex
CREATE INDEX "DiscussionPost_authorId_idx" ON "public"."DiscussionPost"("authorId");

-- CreateIndex
CREATE INDEX "DoubtThread_problemId_status_createdAt_idx" ON "public"."DoubtThread"("problemId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "DoubtThread_authorId_idx" ON "public"."DoubtThread"("authorId");

-- CreateIndex
CREATE INDEX "DoubtReply_threadId_createdAt_idx" ON "public"."DoubtReply"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_status_createdAt_idx" ON "public"."ContentReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ContentReport_postId_idx" ON "public"."ContentReport"("postId");

-- CreateIndex
CREATE INDEX "ContentReport_doubtId_idx" ON "public"."ContentReport"("doubtId");

-- AddForeignKey
ALTER TABLE "public"."DiscussionPost" ADD CONSTRAINT "DiscussionPost_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionPost" ADD CONSTRAINT "DiscussionPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionPost" ADD CONSTRAINT "DiscussionPost_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "public"."DiscussionPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionPost" ADD CONSTRAINT "DiscussionPost_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "public"."Submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DiscussionPost" ADD CONSTRAINT "DiscussionPost_hiddenById_fkey" FOREIGN KEY ("hiddenById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DoubtThread" ADD CONSTRAINT "DoubtThread_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DoubtThread" ADD CONSTRAINT "DoubtThread_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DoubtReply" ADD CONSTRAINT "DoubtReply_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."DoubtThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DoubtReply" ADD CONSTRAINT "DoubtReply_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContentReport" ADD CONSTRAINT "ContentReport_postId_fkey" FOREIGN KEY ("postId") REFERENCES "public"."DiscussionPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContentReport" ADD CONSTRAINT "ContentReport_doubtId_fkey" FOREIGN KEY ("doubtId") REFERENCES "public"."DoubtThread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContentReport" ADD CONSTRAINT "ContentReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContentReport" ADD CONSTRAINT "ContentReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A hidden post says who hid it and why, or it is not hidden. The author is
-- shown both, which is the whole difference between moderation and posts
-- quietly disappearing.
ALTER TABLE "public"."DiscussionPost"
  ADD CONSTRAINT "DiscussionPost_hidden_pair_check"
  CHECK (
    ("status" = 'VISIBLE' AND "hiddenById" IS NULL AND "hiddenReason" IS NULL AND "hiddenAt" IS NULL)
    OR ("status" = 'HIDDEN' AND "hiddenById" IS NOT NULL AND "hiddenReason" IS NOT NULL AND "hiddenAt" IS NOT NULL)
  );

-- Bodies are bounded and non-empty (DISCUSSION_LIMITS in @recx/shared).
ALTER TABLE "public"."DiscussionPost"
  ADD CONSTRAINT "DiscussionPost_body_size_check"
  CHECK (length("bodyMd") >= 30 AND length("bodyMd") <= 8000);

ALTER TABLE "public"."DiscussionPost"
  ADD CONSTRAINT "DiscussionPost_hidden_reason_size_check"
  CHECK ("hiddenReason" IS NULL OR (length("hiddenReason") >= 10 AND length("hiddenReason") <= 500));

-- A reply is not its own parent. One level of nesting is a product
-- decision (a thread that nests is a thread nobody moderates); the cycle is
-- the part the database can refuse on its own.
ALTER TABLE "public"."DiscussionPost"
  ADD CONSTRAINT "DiscussionPost_not_own_parent_check"
  CHECK ("parentId" IS NULL OR "parentId" <> "id");

-- Shared code names a language, and a language means there is code.
ALTER TABLE "public"."DiscussionPost"
  ADD CONSTRAINT "DiscussionPost_shared_code_check"
  CHECK (("submissionId" IS NULL AND "language" IS NULL) OR ("submissionId" IS NOT NULL AND "language" IS NOT NULL));

ALTER TABLE "public"."DoubtThread"
  ADD CONSTRAINT "DoubtThread_title_size_check"
  CHECK (length("title") >= 10 AND length("title") <= 140);

ALTER TABLE "public"."DoubtThread"
  ADD CONSTRAINT "DoubtThread_body_size_check"
  CHECK (length("bodyMd") >= 20 AND length("bodyMd") <= 4000);

-- A thread is ANSWERED exactly when it has an answered moment.
ALTER TABLE "public"."DoubtThread"
  ADD CONSTRAINT "DoubtThread_answered_pair_check"
  CHECK (("status" = 'OPEN' AND "answeredAt" IS NULL) OR ("status" = 'ANSWERED' AND "answeredAt" IS NOT NULL));

ALTER TABLE "public"."DoubtReply"
  ADD CONSTRAINT "DoubtReply_body_size_check"
  CHECK (length("bodyMd") >= 2 AND length("bodyMd") <= 4000);

-- Exactly one target. A report that names both or neither is a report a
-- moderator cannot act on, and nothing in the code path would say so.
ALTER TABLE "public"."ContentReport"
  ADD CONSTRAINT "ContentReport_one_target_check"
  CHECK (("postId" IS NULL) <> ("doubtId" IS NULL));

ALTER TABLE "public"."ContentReport"
  ADD CONSTRAINT "ContentReport_detail_size_check"
  CHECK (length("detail") >= 10 AND length("detail") <= 500);

-- A resolved report names who resolved it and when; an open one names
-- neither. Moderation decisions have a person attached, like every other
-- decision in this product.
ALTER TABLE "public"."ContentReport"
  ADD CONSTRAINT "ContentReport_resolved_pair_check"
  CHECK (
    ("status" = 'OPEN' AND "resolvedById" IS NULL AND "resolvedAt" IS NULL)
    OR ("status" <> 'OPEN' AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL)
  );
