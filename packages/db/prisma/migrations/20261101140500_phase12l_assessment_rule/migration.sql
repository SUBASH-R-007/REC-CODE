-- Phase 12l: an interactive problem is not sat in an assessment.
--
-- SPEC §11, in its own words: "admin-authored interactors only, and keep
-- them out of high-stakes assessments until they have run cleanly through
-- two practice contests".
--
-- That is a RULE WITH A DATE on it, not a permanent property, and the
-- honest place for it is where the pinning happens: an assessment pins a
-- frozen revision, and this refuses the pin when that revision is judged
-- by a conversation. A contest may hold one — SPEC says so — which is why
-- the trigger is on AssessmentProblem and not on ContestProblem.
--
-- A trigger rather than a CHECK because the fact lives on another table,
-- exactly like the frozen-version rule this sits beside. When the two
-- practice contests have happened and somebody decides to lift it, the
-- decision is one DROP TRIGGER and one line in the gate log — and the
-- guard catalogue will fail the build until that line exists, which is the
-- point of listing it.

CREATE OR REPLACE FUNCTION recx_refuse_interactive_assessment_problem() RETURNS trigger AS $$
DECLARE
  mode text;
BEGIN
  SELECT v."compareMode"::text INTO mode
    FROM "public"."ProblemVersion" v
   WHERE v."id" = NEW."problemVersionId";
  IF mode = 'INTERACTIVE' THEN
    RAISE EXCEPTION 'AssessmentProblem %: problem version % is an interactive problem, which is not sat in an assessment yet (SPEC 11: two clean practice contests first)', NEW."id", NEW."problemVersionId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AssessmentProblem_no_interactive"
  BEFORE INSERT OR UPDATE ON "public"."AssessmentProblem"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_interactive_assessment_problem();
