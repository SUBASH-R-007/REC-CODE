-- Phase 12i: written and system-design questions, graded against a rubric.
--
-- SPEC §11, the last item of the Phase 11+ list: "written/system-design
-- with rubric grading". Nothing here runs code — a design answer has no
-- test cases — so the CHECKs carry weight that a judge carries elsewhere:
-- they are what stops a half-written mark reaching a student.
--
-- Two rules are written down here rather than only in the application.
-- A mark is whole or it does not exist (the grader, the moment, the note
-- and the weighted total arrive together, and a grader is never the
-- author). And a published rubric is fixed: a student marked 12 of 16
-- against four criteria did not get that score against five, so the
-- criteria can only be written while the question is a draft, which the
-- application enforces and this file documents.

-- CreateEnum
CREATE TYPE "public"."WrittenKind" AS ENUM ('SYSTEM_DESIGN', 'WRITTEN');

-- CreateEnum
CREATE TYPE "public"."WrittenPromptStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "public"."WrittenAnswerStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'GRADED');

-- CreateTable
CREATE TABLE "public"."WrittenPrompt" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "public"."WrittenKind" NOT NULL,
    "title" TEXT NOT NULL,
    "promptMd" TEXT NOT NULL,
    "timeBoxMinutes" INTEGER NOT NULL,
    "status" "public"."WrittenPromptStatus" NOT NULL DEFAULT 'DRAFT',
    "authorId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WrittenPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WrittenCriterion" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "guidance" TEXT,
    "weight" INTEGER NOT NULL,

    CONSTRAINT "WrittenCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WrittenAnswer" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "status" "public"."WrittenAnswerStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "graderId" TEXT,
    "gradedAt" TIMESTAMP(3),
    "overallMd" TEXT,
    "points" INTEGER,
    "outOf" INTEGER,
    "handedBackAt" TIMESTAMP(3),
    "handBackNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WrittenAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WrittenMark" (
    "answerId" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "WrittenMark_pkey" PRIMARY KEY ("answerId","criterionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "WrittenPrompt_slug_key" ON "public"."WrittenPrompt"("slug");

-- CreateIndex
CREATE INDEX "WrittenPrompt_status_kind_idx" ON "public"."WrittenPrompt"("status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "WrittenCriterion_promptId_order_key" ON "public"."WrittenCriterion"("promptId", "order");

-- CreateIndex
CREATE INDEX "WrittenAnswer_status_submittedAt_idx" ON "public"."WrittenAnswer"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "WrittenAnswer_authorId_updatedAt_idx" ON "public"."WrittenAnswer"("authorId", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WrittenAnswer_promptId_authorId_key" ON "public"."WrittenAnswer"("promptId", "authorId");

-- AddForeignKey
ALTER TABLE "public"."WrittenPrompt" ADD CONSTRAINT "WrittenPrompt_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WrittenCriterion" ADD CONSTRAINT "WrittenCriterion_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "public"."WrittenPrompt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WrittenAnswer" ADD CONSTRAINT "WrittenAnswer_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "public"."WrittenPrompt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WrittenAnswer" ADD CONSTRAINT "WrittenAnswer_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WrittenAnswer" ADD CONSTRAINT "WrittenAnswer_graderId_fkey" FOREIGN KEY ("graderId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WrittenMark" ADD CONSTRAINT "WrittenMark_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "public"."WrittenAnswer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WrittenMark" ADD CONSTRAINT "WrittenMark_criterionId_fkey" FOREIGN KEY ("criterionId") REFERENCES "public"."WrittenCriterion"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A question people can read is a question that has been published, and a
-- retired one says when. A draft has never been open.
ALTER TABLE "public"."WrittenPrompt"
  ADD CONSTRAINT "WrittenPrompt_status_pair_check"
  CHECK (
    ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL)
    AND (("status" = 'RETIRED') = ("retiredAt" IS NOT NULL))
    AND ("status" <> 'DRAFT' OR "publishedAt" IS NULL)
  );

ALTER TABLE "public"."WrittenPrompt"
  ADD CONSTRAINT "WrittenPrompt_title_size_check"
  CHECK (length("title") >= 8 AND length("title") <= 160);

ALTER TABLE "public"."WrittenPrompt"
  ADD CONSTRAINT "WrittenPrompt_body_size_check"
  CHECK (length("promptMd") >= 50 AND length("promptMd") <= 8000);

-- Advice, not a clock — but advice outside this range is a typo.
ALTER TABLE "public"."WrittenPrompt"
  ADD CONSTRAINT "WrittenPrompt_time_box_check"
  CHECK ("timeBoxMinutes" >= 10 AND "timeBoxMinutes" <= 180);

ALTER TABLE "public"."WrittenCriterion"
  ADD CONSTRAINT "WrittenCriterion_weight_check"
  CHECK ("weight" >= 1 AND "weight" <= 5);

ALTER TABLE "public"."WrittenCriterion"
  ADD CONSTRAINT "WrittenCriterion_label_size_check"
  CHECK (
    length("label") >= 3 AND length("label") <= 120
    AND ("guidance" IS NULL OR length("guidance") <= 400)
  );

ALTER TABLE "public"."WrittenCriterion"
  ADD CONSTRAINT "WrittenCriterion_order_check"
  CHECK ("order" >= 0 AND "order" < 8);

-- A draft may be three words; something handed in may not. The upper bound
-- is the same either way, because the page renders it.
ALTER TABLE "public"."WrittenAnswer"
  ADD CONSTRAINT "WrittenAnswer_body_size_check"
  CHECK (length("bodyMd") <= 20000 AND ("status" = 'DRAFT' OR length("bodyMd") >= 120));

ALTER TABLE "public"."WrittenAnswer"
  ADD CONSTRAINT "WrittenAnswer_submitted_pair_check"
  CHECK (("status" IN ('SUBMITTED', 'GRADED')) = ("submittedAt" IS NOT NULL));

-- A mark is whole or it does not exist: who marked it, when, the note the
-- student reads, and the weighted total that was true at the time.
ALTER TABLE "public"."WrittenAnswer"
  ADD CONSTRAINT "WrittenAnswer_graded_pair_check"
  CHECK (
    ("status" = 'GRADED') = (
      "graderId" IS NOT NULL AND "gradedAt" IS NOT NULL AND "overallMd" IS NOT NULL
      AND "points" IS NOT NULL AND "outOf" IS NOT NULL
    )
  );

ALTER TABLE "public"."WrittenAnswer"
  ADD CONSTRAINT "WrittenAnswer_score_range_check"
  CHECK (
    ("points" IS NULL AND "outOf" IS NULL)
    OR ("points" >= 0 AND "outOf" > 0 AND "points" <= "outOf")
  );

ALTER TABLE "public"."WrittenAnswer"
  ADD CONSTRAINT "WrittenAnswer_overall_size_check"
  CHECK ("overallMd" IS NULL OR (length("overallMd") >= 30 AND length("overallMd") <= 4000));

-- Handed back unmarked: the moment and the sentence arrive together, and
-- the student is shown the sentence.
ALTER TABLE "public"."WrittenAnswer"
  ADD CONSTRAINT "WrittenAnswer_hand_back_pair_check"
  CHECK (
    ("handedBackAt" IS NULL AND "handBackNote" IS NULL)
    OR ("handedBackAt" IS NOT NULL AND "handBackNote" IS NOT NULL
      AND length("handBackNote") >= 10 AND length("handBackNote") <= 500)
  );

-- Nobody marks their own answer.
ALTER TABLE "public"."WrittenAnswer"
  ADD CONSTRAINT "WrittenAnswer_not_self_check"
  CHECK ("graderId" IS NULL OR "graderId" <> "authorId");

ALTER TABLE "public"."WrittenMark"
  ADD CONSTRAINT "WrittenMark_points_check"
  CHECK ("points" >= 0 AND "points" <= 4);

ALTER TABLE "public"."WrittenMark"
  ADD CONSTRAINT "WrittenMark_note_size_check"
  CHECK ("note" IS NULL OR length("note") <= 500);
