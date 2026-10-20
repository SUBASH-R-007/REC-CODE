-- Phase 7c: the sitting engine.
--
-- SPEC §5's second gate for this phase, in its own words: *a test asserts
-- allowBackNavigation: false is enforced server-side, not just in the UI.*
-- The data half of that is recx_refuse_closed_section_write below, and the
-- invariant suite exercises it by raw SQL — because a client that forgets the
-- rule is a client that hands back the advantage the setting exists to
-- remove, and so is a server action somebody edits later.
--
-- Also here, finally, recx_refuse_used_pattern_change: a pattern that has
-- been SAT is frozen. It needs MockAttempt to exist, which is why it lands in
-- the migration that first makes an attempt possible rather than in 7b — so
-- there is no window in which a sat pattern is editable.
--
-- Every CHECK is NULL-safe. A CHECK that evaluates to NULL is SATISFIED, and
-- that has now been the cause of one real hole per phase.

-- CreateEnum
CREATE TYPE "public"."MockAttemptStatus" AS ENUM ('IN_PROGRESS', 'SUBMITTED', 'AUTO_SUBMITTED', 'ABANDONED');

-- CreateTable
CREATE TABLE "public"."MockAttempt" (
    "id" TEXT NOT NULL,
    "patternId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "public"."MockAttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "seed" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "currentSectionPosition" INTEGER NOT NULL DEFAULT 1,
    "layout" JSONB NOT NULL,
    "accommodationFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "totalRaw" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalMax" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sectionsPassed" INTEGER NOT NULL DEFAULT 0,
    "passedOverall" BOOLEAN,
    "percentileAtFinalise" DOUBLE PRECISION,
    "finalizedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MockAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MockSectionState" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "highWaterIndex" INTEGER NOT NULL DEFAULT 0,
    "correctCount" INTEGER NOT NULL DEFAULT 0,
    "wrongCount" INTEGER NOT NULL DEFAULT 0,
    "unansweredCount" INTEGER NOT NULL DEFAULT 0,
    "rawScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "percent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "passedCutoff" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MockSectionState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MockAttemptAnswer" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "sectionStateId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "selectedIndexes" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "numericValue" DECIMAL(20,6),
    "markedForReview" BOOLEAN NOT NULL DEFAULT false,
    "isCorrect" BOOLEAN,
    "awarded" DOUBLE PRECISION,
    "firstSeenAtMs" INTEGER NOT NULL,
    "answeredAtMs" INTEGER,
    "changeCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MockAttemptAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AptitudeUserTopicStat" (
    "userId" TEXT NOT NULL,
    "topic" "public"."AptitudeTopic" NOT NULL,
    "attempted" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "totalSeconds" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AptitudeUserTopicStat_pkey" PRIMARY KEY ("userId","topic")
);

-- CreateIndex
CREATE UNIQUE INDEX "MockAttempt_patternId_userId_attemptNumber_key" ON "public"."MockAttempt"("patternId", "userId", "attemptNumber");

-- CreateIndex
CREATE INDEX "MockAttempt_userId_startedAt_idx" ON "public"."MockAttempt"("userId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "MockAttempt_status_expiresAt_idx" ON "public"."MockAttempt"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "MockAttempt_patternId_percent_idx" ON "public"."MockAttempt"("patternId", "percent" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "MockSectionState_attemptId_sectionId_key" ON "public"."MockSectionState"("attemptId", "sectionId");

-- CreateIndex
CREATE UNIQUE INDEX "MockSectionState_attemptId_position_key" ON "public"."MockSectionState"("attemptId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MockAttemptAnswer_attemptId_questionId_key" ON "public"."MockAttemptAnswer"("attemptId", "questionId");

-- CreateIndex
CREATE UNIQUE INDEX "MockAttemptAnswer_attemptId_sectionStateId_position_key" ON "public"."MockAttemptAnswer"("attemptId", "sectionStateId", "position");

-- CreateIndex
CREATE INDEX "MockAttemptAnswer_questionId_idx" ON "public"."MockAttemptAnswer"("questionId");

-- CreateIndex
CREATE INDEX "AptitudeUserTopicStat_topic_correct_idx" ON "public"."AptitudeUserTopicStat"("topic", "correct");

-- AddForeignKey
ALTER TABLE "public"."MockAttempt" ADD CONSTRAINT "MockAttempt_patternId_fkey" FOREIGN KEY ("patternId") REFERENCES "public"."MockPattern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MockAttempt" ADD CONSTRAINT "MockAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MockSectionState" ADD CONSTRAINT "MockSectionState_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."MockAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MockSectionState" ADD CONSTRAINT "MockSectionState_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "public"."AptitudeSection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MockAttemptAnswer" ADD CONSTRAINT "MockAttemptAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."MockAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MockAttemptAnswer" ADD CONSTRAINT "MockAttemptAnswer_sectionStateId_fkey" FOREIGN KEY ("sectionStateId") REFERENCES "public"."MockSectionState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MockAttemptAnswer" ADD CONSTRAINT "MockAttemptAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."AptitudeQuestion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AptitudeUserTopicStat" ADD CONSTRAINT "AptitudeUserTopicStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── MockAttempt invariants ──────────────────────────────────────────────

ALTER TABLE "public"."MockAttempt"
  ADD CONSTRAINT "MockAttempt_window_check"
  CHECK ("expiresAt" > "startedAt");

ALTER TABLE "public"."MockAttempt"
  ADD CONSTRAINT "MockAttempt_number_check"
  CHECK ("attemptNumber" >= 1);

ALTER TABLE "public"."MockAttempt"
  ADD CONSTRAINT "MockAttempt_section_position_check"
  CHECK ("currentSectionPosition" BETWEEN 1 AND 8);

-- totalRaw is deliberately NOT floored at zero: the honest total of a
-- negatively marked paper can be negative, and it is `percent` that is
-- clamped so no candidate is ever shown a negative percentage.
ALTER TABLE "public"."MockAttempt"
  ADD CONSTRAINT "MockAttempt_score_check"
  CHECK (
    "totalMax" >= 0
    AND "percent" >= 0
    AND "percent" <= 100
    AND "sectionsPassed" >= 0
    AND "totalRaw" <= "totalMax"
    AND ("percentileAtFinalise" IS NULL OR ("percentileAtFinalise" >= 0 AND "percentileAtFinalise" <= 100))
  );

-- A scored sitting carries its result; an unscored one carries none. A status
-- with no result behind it, or a result with no status, is how a total stops
-- adding up on the one page a candidate reads.
ALTER TABLE "public"."MockAttempt"
  ADD CONSTRAINT "MockAttempt_finalised_check"
  CHECK (
    CASE
      WHEN "status" IN ('SUBMITTED', 'AUTO_SUBMITTED')
        THEN "finalizedAt" IS NOT NULL AND "passedOverall" IS NOT NULL
      ELSE "finalizedAt" IS NULL AND "passedOverall" IS NULL
    END
  );

ALTER TABLE "public"."MockAttempt"
  ADD CONSTRAINT "MockAttempt_version_check"
  CHECK ("version" >= 0);

-- The layout is the paper as served, versioned.
ALTER TABLE "public"."MockAttempt"
  ADD CONSTRAINT "MockAttempt_layout_check"
  CHECK (jsonb_typeof("layout") = 'object' AND ("layout" -> 'sections') IS NOT NULL);

-- ── MockSectionState invariants ─────────────────────────────────────────

ALTER TABLE "public"."MockSectionState"
  ADD CONSTRAINT "MockSectionState_position_check"
  CHECK ("position" BETWEEN 1 AND 8);

ALTER TABLE "public"."MockSectionState"
  ADD CONSTRAINT "MockSectionState_window_check"
  CHECK ("endsAt" IS NULL OR ("startedAt" IS NOT NULL AND "endsAt" > "startedAt"));

-- A section cannot close before it opens.
ALTER TABLE "public"."MockSectionState"
  ADD CONSTRAINT "MockSectionState_started_check"
  CHECK ("submittedAt" IS NULL OR "startedAt" IS NOT NULL);

ALTER TABLE "public"."MockSectionState"
  ADD CONSTRAINT "MockSectionState_index_check"
  CHECK ("highWaterIndex" >= 0);

ALTER TABLE "public"."MockSectionState"
  ADD CONSTRAINT "MockSectionState_counts_check"
  CHECK (
    "correctCount" >= 0
    AND "wrongCount" >= 0
    AND "unansweredCount" >= 0
    AND "maxScore" >= 0
    AND "percent" >= 0
    AND "percent" <= 100
    AND "rawScore" <= "maxScore"
  );

-- ── MockAttemptAnswer invariants ────────────────────────────────────────

ALTER TABLE "public"."MockAttemptAnswer"
  ADD CONSTRAINT "MockAttemptAnswer_position_check"
  CHECK ("position" >= 0);

-- One response shape per answer. Both empty means unanswered, which is a
-- legitimate and never-penalised state (SPEC §5's negative-marking rule).
ALTER TABLE "public"."MockAttemptAnswer"
  ADD CONSTRAINT "MockAttemptAnswer_shape_check"
  CHECK (COALESCE(array_length("selectedIndexes", 1), 0) = 0 OR "numericValue" IS NULL);

ALTER TABLE "public"."MockAttemptAnswer"
  ADD CONSTRAINT "MockAttemptAnswer_timing_check"
  CHECK (
    "firstSeenAtMs" >= 0
    AND "changeCount" >= 0
    AND ("answeredAtMs" IS NULL OR "answeredAtMs" >= "firstSeenAtMs")
  );

-- isCorrect and awarded are set together or both null: a half-graded answer
-- row is how a total stops adding up.
ALTER TABLE "public"."MockAttemptAnswer"
  ADD CONSTRAINT "MockAttemptAnswer_graded_check"
  CHECK (("isCorrect" IS NULL) = ("awarded" IS NULL));

-- An unanswered question scores exactly zero, never a penalty. Stated here as
-- well as in gradeAnswer(), because this is the line in the phase most likely
-- to be written wrongly and the one a candidate would dispute.
ALTER TABLE "public"."MockAttemptAnswer"
  ADD CONSTRAINT "MockAttemptAnswer_blank_not_penalised"
  CHECK (
    COALESCE(array_length("selectedIndexes", 1), 0) > 0
    OR "numericValue" IS NOT NULL
    OR "awarded" IS NULL
    OR "awarded" = 0
  );

-- ── AptitudeUserTopicStat invariants ────────────────────────────────────

ALTER TABLE "public"."AptitudeUserTopicStat"
  ADD CONSTRAINT "AptitudeUserTopicStat_counts_check"
  CHECK (
    "attempted" >= 0
    AND "correct" >= 0
    AND "totalSeconds" >= 0
    AND "correct" <= "attempted"
  );

-- ── The clock is written once ───────────────────────────────────────────
-- The same guard Phase 6b put on AssessmentAttempt, for the same reason: a
-- deadline a later write can move is not a deadline, and a seed a later write
-- can change is a paper that cannot be reproduced in a dispute.
CREATE OR REPLACE FUNCTION recx_refuse_mock_attempt_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('SUBMITTED', 'AUTO_SUBMITTED') THEN
      RAISE EXCEPTION
        'MockAttempt % has been scored; its result and its XP are permanent and it is never deleted.',
        OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."seed" IS DISTINCT FROM OLD."seed"
     OR NEW."layout" IS DISTINCT FROM OLD."layout"
     OR NEW."patternId" IS DISTINCT FROM OLD."patternId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."attemptNumber" IS DISTINCT FROM OLD."attemptNumber" THEN
    RAISE EXCEPTION
      'MockAttempt %: the clock, the seed, the paper and the candidate are written once. Extra time is an accommodation applied before the sitting starts, never a later edit.',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- canTransitionMock() in @recx/shared, mirrored: IN_PROGRESS is the only
  -- state with exits, and all three are terminal.
  IF NEW."status" IS DISTINCT FROM OLD."status" AND OLD."status" <> 'IN_PROGRESS' THEN
    RAISE EXCEPTION
      'MockAttempt % is already %; a finished sitting never restarts, because its answers have been scored and its XP written.',
      OLD."id", OLD."status"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The section pointer only ever moves forward: a candidate cannot be sent
  -- back into a section that has closed.
  IF NEW."currentSectionPosition" < OLD."currentSectionPosition" THEN
    RAISE EXCEPTION
      'MockAttempt %: the section pointer only moves forward. A closed section is closed for good.',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "MockAttempt_written_once"
  BEFORE UPDATE OR DELETE ON "public"."MockAttempt"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_mock_attempt_change();

-- A section clock a later write can extend is not a section clock.
CREATE OR REPLACE FUNCTION recx_refuse_section_clock_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."startedAt" IS NOT NULL AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION
      'MockSectionState %: startedAt is written once, on entry.',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."endsAt" IS NOT NULL AND NEW."endsAt" IS DISTINCT FROM OLD."endsAt" THEN
    RAISE EXCEPTION
      'MockSectionState %: endsAt is written once, on entry. A section clock a later write can extend is not a section clock.',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."submittedAt" IS NOT NULL AND NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" THEN
    RAISE EXCEPTION
      'MockSectionState %: a submitted section cannot be re-submitted or re-opened.',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The high-water mark only rises. This is the column the client must not be
  -- able to move backwards, and half of enforcing allowBackNavigation: false.
  IF NEW."highWaterIndex" < OLD."highWaterIndex" THEN
    RAISE EXCEPTION
      'MockSectionState %: highWaterIndex only rises.',
      OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "MockSectionState_clock_written_once"
  BEFORE UPDATE ON "public"."MockSectionState"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_section_clock_change();

-- ── allowBackNavigation: false, in the data ─────────────────────────────
-- SPEC §5 asks for this enforced server-side and not just in the UI. The
-- invariant suite attempts both refused writes as raw SQL, which is the only
-- way to prove the rule survives a future edit to the server action.
--
-- The gate is `submittedAt`, NOT the section's `endsAt`. That is deliberate
-- and it constrains finalise: grading writes `isCorrect` and `awarded` onto
-- these very rows, so finalise must GRADE FIRST and set `submittedAt`
-- afterwards. Adding a `now() > endsAt` clause here would refuse the grading
-- writes of every section that closed on its own clock — the trigger would
-- make the scoring impossible rather than the cheating. The section deadline
-- is enforced where the clock is read, by canAnswer(), and closing the
-- section is what makes it permanent.
CREATE OR REPLACE FUNCTION recx_refuse_closed_section_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  state RECORD;
  allows_back BOOLEAN;
BEGIN
  SELECT s."submittedAt", s."highWaterIndex", s."attemptId"
    INTO state
    FROM "public"."MockSectionState" AS s
   WHERE s."id" = NEW."sectionStateId";

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'MockAttemptAnswer references a section state that does not exist.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF state."submittedAt" IS NOT NULL THEN
    RAISE EXCEPTION
      'That section has closed. Answers in it are saved and scored, and a closed section never re-opens.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT sec."allowBackNavigation"
    INTO allows_back
    FROM "public"."MockSectionState" AS st
    JOIN "public"."AptitudeSection" AS sec ON sec."id" = st."sectionId"
   WHERE st."id" = NEW."sectionStateId";

  IF COALESCE(allows_back, true) = false AND NEW."position" < state."highWaterIndex" THEN
    RAISE EXCEPTION
      'This section does not allow going back to an earlier question, which is stated on the cover page before the sitting starts.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "MockAttemptAnswer_closed_section"
  BEFORE INSERT OR UPDATE ON "public"."MockAttemptAnswer"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_closed_section_write();

-- ── A pattern that has been sat is frozen ───────────────────────────────
-- Phase 6a froze a published assessment's window for the same reason: a score
-- must mean what it meant when the candidate sat it, and a cohort percentile
-- is only honest if everyone sat the same blueprint. The trigger goes on
-- AptitudeSection (insert, update and delete) and on MockPattern's scoring
-- columns.
CREATE OR REPLACE FUNCTION recx_refuse_used_pattern_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target TEXT;
  sat INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'AptitudeSection' THEN
    target := COALESCE(NEW."patternId", OLD."patternId");
  ELSE
    target := COALESCE(NEW."id", OLD."id");
    -- Only the scoring shape is frozen. A pattern's description, its status
    -- and its maintained totals and statistics stay writable, or the nightly
    -- job and the totals trigger could never run again.
    IF TG_OP = 'UPDATE'
       AND NEW."slug" IS NOT DISTINCT FROM OLD."slug"
       AND NEW."sourceNote" IS NOT DISTINCT FROM OLD."sourceNote"
       AND NEW."modelledOnCompany" IS NOT DISTINCT FROM OLD."modelledOnCompany" THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT COUNT(*) INTO sat
    FROM "public"."MockAttempt"
   WHERE "patternId" = target
     AND "status" IN ('SUBMITTED', 'AUTO_SUBMITTED');

  IF sat > 0 THEN
    RAISE EXCEPTION
      'This pattern has been sat % times and is frozen. A score must mean what it meant when the candidate sat it, and a cohort percentile is only honest if everyone sat the same blueprint. Copy it to a new pattern instead.',
      sat
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AptitudeSection_pattern_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."AptitudeSection"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_used_pattern_change();

CREATE TRIGGER "MockPattern_scoring_frozen"
  BEFORE UPDATE ON "public"."MockPattern"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_used_pattern_change();

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
CREATE TRIGGER "MockAttempt_no_truncate"
  BEFORE TRUNCATE ON "public"."MockAttempt"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "MockSectionState_no_truncate"
  BEFORE TRUNCATE ON "public"."MockSectionState"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "MockAttemptAnswer_no_truncate"
  BEFORE TRUNCATE ON "public"."MockAttemptAnswer"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
