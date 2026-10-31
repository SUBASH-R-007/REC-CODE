-- Phase 12m: a debugging problem is not sat in an assessment.
--
-- The edit budget is refused where a student can be told about it: the
-- submit and run actions, before the row. An assessment does not submit
-- that way. `submitAttempt` writes one Submission per answered question
-- when the sitting ends, and refusing one there would throw away a
-- candidate's work at the only moment they cannot do anything about it.
--
-- The honest answer is the one Phase 12l reached for interactive problems,
-- and for the same reason: refuse the PIN rather than the submission. An
-- assessment pins a frozen revision, so this is the point where the rule
-- can be stated to the person choosing the question instead of to the
-- candidate answering it.
--
-- A contest may hold one. A contest's arena sends the student to the
-- ordinary workspace, which shows the budget and counts the lines, and its
-- submissions go through `submitSolution` — so the rule is already
-- enforced there, which is why this trigger is on AssessmentProblem and
-- not on ContestProblem.
--
-- A trigger rather than a CHECK because the fact lives on another table.
-- When an exam path learns to enforce a budget (or to show one), lifting
-- this is one DROP TRIGGER and one line in the gate log — and the guard
-- catalogue fails the build until that line exists.

CREATE OR REPLACE FUNCTION recx_refuse_debug_assessment_problem() RETURNS trigger AS $$
DECLARE
  budget int;
BEGIN
  SELECT v."maxEditedLines" INTO budget
    FROM "public"."ProblemVersion" v
   WHERE v."id" = NEW."problemVersionId";
  IF budget IS NOT NULL THEN
    RAISE EXCEPTION 'AssessmentProblem %: problem version % is a debugging problem (edit budget %), which is not sat in an assessment yet: the sitting submits every answer at the end and cannot refuse one', NEW."id", NEW."problemVersionId", budget
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AssessmentProblem_no_debug_budget"
  BEFORE INSERT OR UPDATE ON "public"."AssessmentProblem"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_debug_assessment_problem();
