-- Phase 12q: a SQL problem is not set in a contest either.
--
-- The migration three before this one (20261101170000) pinned SQL out of
-- assessments and said, in as many words, why a contest needed no such
-- rule: "its one control is a link to /problems/<slug> — so a contest
-- participant gets the practice workspace, with the dialect notice, the
-- single-statement rule and the query editor the practice surface already
-- has. That is why this trigger is not on ContestProblem."
--
-- That was true, and it was true because a contest was never actually
-- submitted to. Every submission the product made was origin PRACTICE on
-- the PRACTICE lane, whichever page it came from, so a SQL question in a
-- contest was simply a practice query that happened to be listed in an
-- arena. Phase 12q, slice 3 wires contest submissions: a submission on a
-- contest's problem, by a registered student, inside the window, is now
-- origin CONTEST on the CONTEST lane.
--
-- CONTEST is a sensitive lane (SENSITIVE_LANES, docs/JUDGE.md §lanes) and
-- is served only by a node whose calibration and self-check are fresh. A
-- SQL node has no calibration at all — a query's limit is the database's
-- own statement_timeout and there is no benchmark for it yet — so it
-- carries a lane restriction that keeps it off ASSESSMENT and CONTEST, and
-- it is the only engine that can judge `sql17`. The two facts together mean
-- a SQL question in a running contest would now produce a submission that
-- NO node in the fleet may claim: QUEUED for ever, with a student watching
-- a spinner and nothing in any log calling it an error. That is strictly
-- worse than the practice query it used to be.
--
-- So the pin moves to where the rule can be read by the admin choosing the
-- question rather than by the student answering it, which is the same
-- reason the other four exist. docs/OPEN-QUESTIONS.md has said since Phase
-- 12k that "nobody should place a SQL problem in a contest until that is
-- built"; this is that sentence, enforced.
--
-- BEFORE INSERT OR UPDATE, so rows that already pin a SQL problem are left
-- alone: a development database has several from the Phase 12p browser
-- runs, and those contests have all ended.
--
-- Lifted by a calibration benchmark for the SQL engine — which is what
-- would let a SQL node serve the sensitive lanes at all — then one DROP
-- TRIGGER and a line in the gate log that the guard catalogue makes
-- compulsory.

CREATE OR REPLACE FUNCTION recx_refuse_sql_contest_problem() RETURNS trigger AS $$
DECLARE
  mode text;
BEGIN
  SELECT v."ioMode"::text INTO mode
    FROM "public"."ProblemVersion" v
   WHERE v."id" = NEW."problemVersionId";
  IF mode = 'SQL' THEN
    RAISE EXCEPTION 'ContestProblem %: problem version % is a SQL problem, which is not set in a contest yet: the CONTEST lane is served only by nodes with fresh calibration, and the SQL engine has none, so the submission could never be claimed', NEW."id", NEW."problemVersionId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContestProblem_no_sql"
  BEFORE INSERT OR UPDATE ON "public"."ContestProblem"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_sql_contest_problem();
