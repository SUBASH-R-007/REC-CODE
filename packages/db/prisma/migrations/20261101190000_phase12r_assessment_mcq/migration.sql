-- Phase 12r: a paper can hold multiple-choice questions.
--
-- Asked for directly: "introduce mcq and stuff, for that save and next is
-- enough, but for code we need run test case". The second half shipped in
-- 12q.5; this is the first.
--
-- Assessment-owned, and deliberately NOT a fourth AptitudeArea. Phase 12g
-- tried that and reverted it whole: AptitudePassage_area_topic_check and
-- AptitudeQuestion_area_topic_check enumerate every (area, topic) pair in
-- the CHECK body, so a new area means dropping two catalogued guards, and
-- frozen-coverage.test.ts fails the build for any migration that drops one.
-- docs/OPEN-QUESTIONS.md records that the single guarded drop which would
-- fix that properly is a human's decision, not ours. Nothing here goes near
-- it: an assessment's MCQ is a different thing from a practice aptitude
-- question. It belongs to the paper that asks it, has no topic, no
-- difficulty curve and no per-question statistics, and is marked by
-- comparison rather than by a judge.
--
-- The rules the database holds, and why each one is here rather than in a
-- form validator:
--
--   * 2 to 8 options, none blank. One option is not a choice, and a blank
--     option is a radio button a candidate cannot tell from a rendering
--     bug. Eight is the most that fits a phone without scrolling the
--     question off the screen.
--   * The answer is one of the options. An out-of-range correctIndex is a
--     question nobody can get right, and it would be found by a cohort
--     rather than by its author.
--   * A non-empty stem, positive points, a position in 1..200 — the same
--     three rules AssessmentProblem already carries.
--   * THE PALETTE IS ONE NUMBERED LIST. A candidate sees "Question 4 of
--     9" whether 4 is a program or a question, so position is unique
--     across BOTH tables, which no single unique index can say. Hence a
--     trigger, in both directions, sharing one function.
--
-- The position trigger raises check_violation and not unique_violation,
-- though a clash is exactly what it is. Prisma maps unique_violation to its
-- own P2002 and replaces the message with "Unique constraint failed on the
-- (not available)", so the sentence below never reaches the admin who needs
-- it; check_violation comes through verbatim, which is how the other
-- guards in this schema are able to explain themselves.
--
-- A candidate's answer is stored as a position in the order THEY were
-- shown, not as a stored index. The shuffle lives in their attempt layout,
-- and marking maps it back (packages/shared/src/exam-mcq.ts). The other way
-- round would mean trusting a browser to un-shuffle before it reports, and
-- an index that arrives outside the order they were shown would then be
-- indistinguishable from a wrong answer instead of being reported as the
-- corruption it is.

CREATE TABLE "public"."AssessmentMcq" (
  "id"           TEXT NOT NULL,
  "assessmentId" TEXT NOT NULL,
  "position"     INTEGER NOT NULL,
  "stem"         TEXT NOT NULL,
  "options"      TEXT[] NOT NULL,
  "correctIndex" INTEGER NOT NULL,
  "points"       DOUBLE PRECISION NOT NULL DEFAULT 1,
  "explanation"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AssessmentMcq_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."AssessmentMcqAnswer" (
  "attemptId"   TEXT NOT NULL,
  "mcqId"       TEXT NOT NULL,
  "chosenIndex" INTEGER NOT NULL,
  "answeredAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AssessmentMcqAnswer_pkey" PRIMARY KEY ("attemptId", "mcqId")
);

CREATE UNIQUE INDEX "AssessmentMcq_assessmentId_position_key"
  ON "public"."AssessmentMcq"("assessmentId", "position");
CREATE INDEX "AssessmentMcq_assessmentId_idx" ON "public"."AssessmentMcq"("assessmentId");
CREATE INDEX "AssessmentMcqAnswer_mcqId_idx" ON "public"."AssessmentMcqAnswer"("mcqId");

ALTER TABLE "public"."AssessmentMcq"
  ADD CONSTRAINT "AssessmentMcq_assessmentId_fkey"
    FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."AssessmentMcqAnswer"
  ADD CONSTRAINT "AssessmentMcqAnswer_attemptId_fkey"
    FOREIGN KEY ("attemptId") REFERENCES "public"."AssessmentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AssessmentMcqAnswer_mcqId_fkey"
    FOREIGN KEY ("mcqId") REFERENCES "public"."AssessmentMcq"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."AssessmentMcq"
  ADD CONSTRAINT "AssessmentMcq_options_check"
    CHECK (array_length("options", 1) BETWEEN 2 AND 8 AND NOT ('' = ANY("options"))),
  ADD CONSTRAINT "AssessmentMcq_correct_index_check"
    CHECK ("correctIndex" >= 0 AND "correctIndex" < array_length("options", 1)),
  ADD CONSTRAINT "AssessmentMcq_stem_check"
    CHECK (length(btrim("stem")) > 0),
  ADD CONSTRAINT "AssessmentMcq_points_check"
    CHECK ("points" > 0),
  ADD CONSTRAINT "AssessmentMcq_position_check"
    CHECK ("position" BETWEEN 1 AND 200);

ALTER TABLE "public"."AssessmentMcqAnswer"
  ADD CONSTRAINT "AssessmentMcqAnswer_chosen_index_check"
    CHECK ("chosenIndex" >= 0 AND "chosenIndex" < 8);

-- ── The palette is one numbered list ────────────────────────────────────
--
-- One function, two triggers, told apart by TG_TABLE_NAME, so the rule
-- cannot be enforced on one side and forgotten on the other.

CREATE OR REPLACE FUNCTION recx_refuse_clashing_assessment_position() RETURNS trigger AS $$
DECLARE
  taken boolean;
BEGIN
  IF TG_TABLE_NAME = 'AssessmentMcq' THEN
    SELECT EXISTS (
      SELECT 1 FROM "public"."AssessmentProblem" p
       WHERE p."assessmentId" = NEW."assessmentId" AND p."position" = NEW."position"
    ) INTO taken;
    IF taken THEN
      RAISE EXCEPTION 'AssessmentMcq %: position % is already a coding question on this assessment; the question palette is one numbered list', NEW."id", NEW."position"
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM "public"."AssessmentMcq" m
       WHERE m."assessmentId" = NEW."assessmentId" AND m."position" = NEW."position"
    ) INTO taken;
    IF taken THEN
      RAISE EXCEPTION 'AssessmentProblem %: position % is already a multiple-choice question on this assessment; the question palette is one numbered list', NEW."id", NEW."position"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AssessmentMcq_position_free"
  BEFORE INSERT OR UPDATE ON "public"."AssessmentMcq"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_clashing_assessment_position();

CREATE TRIGGER "AssessmentProblem_position_free"
  BEFORE INSERT OR UPDATE ON "public"."AssessmentProblem"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_clashing_assessment_position();
