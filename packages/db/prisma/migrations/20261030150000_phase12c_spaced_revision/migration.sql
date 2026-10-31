-- Phase 12c: spaced revision.
--
-- A problem a student has solved comes back — a day later, then three, then
-- a week, three weeks, two months — and clearing the last rung retires it.
-- SPEC §11 calls this the highest-value thing on the post-launch list,
-- because the documented failure mode of sheet prep is solving 300 problems
-- once and retaining none.
--
-- What the CHECKs here are for: a card's schedule is the only thing a
-- student is told about WHY a problem is in front of them today, and the
-- product answers that question from these columns. A stage outside the
-- ladder, a negative count, or a learned card still carrying a future due
-- date would each make that sentence a lie, and no code path would notice.

-- CreateTable
CREATE TABLE "public"."RevisionCard" (
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "stage" INTEGER NOT NULL DEFAULT 0,
    "dueOn" DATE NOT NULL,
    "reviews" INTEGER NOT NULL DEFAULT 0,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReviewAt" TIMESTAMP(3),
    "learnedAt" TIMESTAMP(3),

    CONSTRAINT "RevisionCard_pkey" PRIMARY KEY ("userId","problemId")
);

-- The only hot query: what is due for this student today.
-- CreateIndex
CREATE INDEX "RevisionCard_userId_learnedAt_dueOn_idx" ON "public"."RevisionCard"("userId", "learnedAt", "dueOn");

-- AddForeignKey
ALTER TABLE "public"."RevisionCard" ADD CONSTRAINT "RevisionCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RevisionCard" ADD CONSTRAINT "RevisionCard_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The ladder has five rungs (REVISION_INTERVALS in @recx/shared). Kept as a
-- literal range rather than a reference: a migration cannot import, and a
-- future rung is a migration of its own, which is the right amount of
-- friction for changing how often every student in the college is asked to
-- revise.
ALTER TABLE "public"."RevisionCard"
  ADD CONSTRAINT "RevisionCard_stage_check"
  CHECK ("stage" >= 0 AND "stage" <= 4);

-- Counts are counts.
ALTER TABLE "public"."RevisionCard"
  ADD CONSTRAINT "RevisionCard_counts_check"
  CHECK ("reviews" >= 0 AND "lapses" >= 0);

-- A reviewed card has a review time, and a learned one has been reviewed.
ALTER TABLE "public"."RevisionCard"
  ADD CONSTRAINT "RevisionCard_review_pair_check"
  CHECK (("reviews" = 0 AND "lastReviewAt" IS NULL) OR ("reviews" > 0 AND "lastReviewAt" IS NOT NULL));

ALTER TABLE "public"."RevisionCard"
  ADD CONSTRAINT "RevisionCard_learned_check"
  CHECK ("learnedAt" IS NULL OR ("reviews" > 0 AND "stage" = 4));

-- Backfill: every problem already solved gets a card, THREE PER STUDENT PER
-- DAY starting today.
--
-- Without this the feature does nothing for anybody until tomorrow, and
-- nothing at all for the students who need it most — the ones who solved
-- two hundred problems last term and remember forty of them. With a naive
-- backfill those same students open /revision on launch day and find two
-- hundred cards due, which is not a queue, it is a reason to close the tab.
--
-- So the dates are spread: one student's cards fall due three a day, oldest
-- solve first, because the solve they are most likely to have forgotten is
-- the one furthest behind them. A student with 30 solves is clear in ten
-- days; one with 300 has a schedule rather than a wall.
--
-- Stage 0 on purpose. The product has never asked these students to recall
-- any of it, so it does not get to claim they are on the 60-day step.
INSERT INTO "public"."RevisionCard" ("userId", "problemId", "stage", "dueOn")
SELECT
  s."userId",
  s."problemId",
  0,
  ((now() AT TIME ZONE 'Asia/Kolkata')::date
    + ((row_number() OVER (
          PARTITION BY s."userId"
          ORDER BY s."firstAcceptedAt" ASC NULLS LAST, s."problemId" ASC
        ) - 1) / 3)::int)
FROM "public"."UserProblemStatus" s
JOIN "public"."Problem" p ON p."id" = s."problemId"
WHERE s."status" = 'SOLVED'
  AND p."status" = 'PUBLISHED'
ON CONFLICT DO NOTHING;
