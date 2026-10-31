-- Phase 12p: a SQL problem is not sat in an assessment.
--
-- The fourth rule of a shape this codebase already has three times
-- (interactive in Phase 12l, debugging in 12m, output-only in 12n), and
-- the reason is the same one: the practice workspace is the only surface
-- that knows the kind.
--
-- An exam attempt chooses ONE language for the whole paper —
-- `loadExamQuestions` takes the first enabled toolchain language and falls
-- back to cpp20 — and `/api/exam/[attemptId]/submit` validates every
-- answer's language against the keys of LANGUAGE_CATALOG, which has never
-- held `sql17`. So a SQL question pinned into an assessment gives a
-- candidate a C++ editor for a question that wants a query, and no way to
-- submit the query if they wrote one anyway. They would find that out
-- during a proctored sitting, which is the worst possible place.
--
-- So the PIN is refused, where the rule can be stated to the person
-- choosing the question instead of to the candidate answering it. It is
-- lifted the same way as the other three: an exam path that knows a
-- language per question, one DROP TRIGGER, and a line in the gate log that
-- the guard catalogue makes compulsory.
--
-- A CONTEST needs no rule. Its arena renders the problem list, the clock
-- and the score, and its one control is a link to /problems/<slug> — so a
-- contest participant gets the practice workspace, with the dialect
-- notice, the single-statement rule and the query editor the practice
-- surface already has. That is why this trigger is not on ContestProblem.

CREATE OR REPLACE FUNCTION recx_refuse_sql_assessment_problem() RETURNS trigger AS $$
DECLARE
  mode text;
BEGIN
  SELECT v."ioMode"::text INTO mode
    FROM "public"."ProblemVersion" v
   WHERE v."id" = NEW."problemVersionId";
  IF mode = 'SQL' THEN
    RAISE EXCEPTION 'AssessmentProblem %: problem version % is a SQL problem, which is not sat in an assessment yet: a sitting gives every question the same editor and submits every answer in one programming language', NEW."id", NEW."problemVersionId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AssessmentProblem_no_sql"
  BEFORE INSERT OR UPDATE ON "public"."AssessmentProblem"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_sql_assessment_problem();
