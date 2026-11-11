-- Phase 13i: moderating a question after the paper has been sat.
--
-- A question turns out to be wrong after three hundred people have
-- answered it — an ambiguous stem, two correct options, a test case that
-- was never satisfiable. Re-sitting is not an option and leaving it is a
-- mark nobody can defend, so an examiner needs the two remedies every
-- board uses: award it to everyone, or take it out of the paper.
--
-- FULL_MARKS gives every candidate the question's marks. DROPPED removes
-- the question from the total as well as from every score, so a paper of
-- 50 becomes a paper of 47 and the percentages stay honest. The
-- arithmetic is in packages/shared/src/exam-moderation.ts.
--
-- The reason is NOT optional, and the CHECK is why. A mark that moved
-- with no reason recorded is a mark nobody can explain to the candidate
-- who lost it or defend to the one who gained it, and the one moment
-- somebody will certainly write the reason down is the moment they are
-- doing it. `moderatedById` and `moderatedAt` are stamped for the same
-- reason: the audit log holds the authoritative record, but admin code
-- may not read the audit log (tests/repo/admin-scope.test.ts R5), so
-- without these columns no staff screen could ever say who.
--
-- The `IS NOT NULL` before `char_length` is not redundant. A CHECK fails
-- only when its expression is FALSE, and `char_length(NULL) BETWEEN 5 AND
-- 500` is NULL, so without it `TRUE AND NULL` left the whole constraint
-- NULL and a DROPPED question with no reason at all was accepted. The
-- database test caught it; three-valued logic in a CHECK is the trap worth
-- naming where the next one is written.
--
-- `moderatedById` carries no foreign key, like `Submission."contestId"`
-- and `"assessmentAttemptId"` before it: a relation would mean a
-- back-relation on `User` for an administrative stamp that is only ever
-- resolved through `staffOnlyWhere`, and a staff member's row is never
-- deleted (R10 forbids hard-deleting anybody).
CREATE TYPE "public"."QuestionModeration" AS ENUM ('NONE', 'FULL_MARKS', 'DROPPED');

ALTER TABLE "public"."AssessmentProblem"
  ADD COLUMN "moderation" "public"."QuestionModeration" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "moderationReason" TEXT,
  ADD COLUMN "moderatedById" TEXT,
  ADD COLUMN "moderatedAt" TIMESTAMP(3);

ALTER TABLE "public"."AssessmentMcq"
  ADD COLUMN "moderation" "public"."QuestionModeration" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "moderationReason" TEXT,
  ADD COLUMN "moderatedById" TEXT,
  ADD COLUMN "moderatedAt" TIMESTAMP(3);

ALTER TABLE "public"."AssessmentProblem"
  ADD CONSTRAINT "AssessmentProblem_moderation_check" CHECK (
    ("moderation" = 'NONE'
       AND "moderationReason" IS NULL AND "moderatedById" IS NULL AND "moderatedAt" IS NULL)
    OR ("moderation" <> 'NONE'
       AND "moderationReason" IS NOT NULL
       AND char_length("moderationReason") BETWEEN 5 AND 500
       AND "moderatedById" IS NOT NULL AND "moderatedAt" IS NOT NULL));

ALTER TABLE "public"."AssessmentMcq"
  ADD CONSTRAINT "AssessmentMcq_moderation_check" CHECK (
    ("moderation" = 'NONE'
       AND "moderationReason" IS NULL AND "moderatedById" IS NULL AND "moderatedAt" IS NULL)
    OR ("moderation" <> 'NONE'
       AND "moderationReason" IS NOT NULL
       AND char_length("moderationReason") BETWEEN 5 AND 500
       AND "moderatedById" IS NOT NULL AND "moderatedAt" IS NOT NULL));
