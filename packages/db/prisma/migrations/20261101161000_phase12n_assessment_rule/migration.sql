-- Phase 12n: an output-only problem is not sat in an assessment.
--
-- The practice workspace is the only surface that knows this kind: it
-- offers the answer language alone, shows the data without the expected
-- answer, and has no Run button. An exam attempt builds its OWN editor,
-- and `submitAttempt` uses one language for every question in the sitting
-- — so an output-only question in an assessment would show a candidate a
-- code box for a question that wants an answer, and submit it as whatever
-- language the first question used.
--
-- So the PIN is refused, which is where the rule can be stated to the
-- person choosing the question rather than to the candidate answering it.
-- It is the third rule of this shape (interactive problems in Phase 12l,
-- debugging problems in Phase 12m) and it is lifted the same way: an exam
-- path that knows the kind, one DROP TRIGGER, and a line in the gate log
-- that the guard catalogue makes compulsory.
--
-- A CONTEST needs no rule: its arena links to the ordinary workspace, so
-- the answer box, the language and the refusals are all the practice
-- ones. That is why this trigger is not on ContestProblem.

CREATE OR REPLACE FUNCTION recx_refuse_output_only_assessment_problem() RETURNS trigger AS $$
DECLARE
  mode text;
BEGIN
  SELECT v."ioMode"::text INTO mode
    FROM "public"."ProblemVersion" v
   WHERE v."id" = NEW."problemVersionId";
  IF mode = 'OUTPUT_ONLY' THEN
    RAISE EXCEPTION 'AssessmentProblem %: problem version % is an output-only problem, which is not sat in an assessment yet: a sitting builds its own editor and submits every answer in one language', NEW."id", NEW."problemVersionId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AssessmentProblem_no_output_only"
  BEFORE INSERT OR UPDATE ON "public"."AssessmentProblem"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_output_only_assessment_problem();
