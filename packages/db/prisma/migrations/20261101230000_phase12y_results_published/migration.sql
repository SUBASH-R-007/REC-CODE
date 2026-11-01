-- Phase 12y: a result a candidate can read, once staff release it.
--
-- Asked for: students should see their own assessment result, "only when
-- result published by admin".
--
-- Marking and releasing are two acts, and keeping them apart is the whole
-- point of this column. A paper is marked the moment it is handed in --
-- the multiple-choice half immediately, the coding half as the judge gets
-- through it -- and that is the figure staff read on
-- /admin/assessments/<id>/results. None of it is a result yet: a question
-- may have been wrong, a judge may have failed on somebody, a whole
-- cohort may have tripped over a typo in the paper. All of those are
-- fixable while the marks are staff's own, and none of them is fixable
-- quietly once a candidate has read a number.
--
-- So: NULL means marked but not released. A timestamp means a named human
-- decided these marks are the result, and from that moment each candidate
-- can read their own -- their own only, never anybody else's, and never a
-- rank or a cohort position.
--
-- Withdrawing sets it back to NULL. That is deliberately possible: the
-- reason to publish carefully is that a mistake reaches people, and a
-- product that made the mistake permanent would be choosing its own
-- dignity over theirs. Both directions are audited at SENSITIVE.
--
-- Not in the frozen tuple `recx_refuse_published_assessment_change()`
-- protects (window, duration, proctor mode, attempt limit, placement
-- flag): those are the terms a candidate sat under and cannot move
-- afterwards. When the marks are released is not a term of the paper.

ALTER TABLE "public"."Assessment"
  ADD COLUMN "resultsPublishedAt" TIMESTAMP(3),
  ADD COLUMN "resultsPublishedById" TEXT;

-- Published means published BY somebody: the two columns move together, so
-- a release can always be attributed. (The audit row is the full record;
-- this is what the page shows without joining to it.)
ALTER TABLE "public"."Assessment"
  ADD CONSTRAINT "Assessment_results_published_by_check"
  CHECK (("resultsPublishedAt" IS NULL) = ("resultsPublishedById" IS NULL));
