-- Phase 7a: the aptitude question bank.
--
-- SPEC §5. Three enums, three tables, and the invariants that make a
-- question bank scorable: a worked explanation is mandatory at PUBLISH, a
-- topic belongs to its area, each kind's answer shape is held in the data,
-- and a published question's KEY never changes while its explanation stays
-- writable.
--
-- Every CHECK below is written so it cannot evaluate to NULL on a NULL
-- column: a CHECK that evaluates to NULL is SATISFIED in Postgres, which is
-- how a mandatory field ends up optional (docs/CONVENTIONS.md). And no
-- pattern uses a bounded repetition count — Postgres's limit is 255 and it
-- compiles a regex lazily, so `{16,1024}` creates happily and then raises on
-- every insert.

-- CreateEnum
CREATE TYPE "public"."AptitudeArea" AS ENUM ('QUANTITATIVE', 'LOGICAL', 'VERBAL');

-- CreateEnum
CREATE TYPE "public"."AptitudeTopic" AS ENUM ('PERCENTAGES', 'PROFIT_LOSS', 'TIME_SPEED_DISTANCE', 'TIME_AND_WORK', 'RATIO_PROPORTION', 'AVERAGES_MIXTURES', 'PERMUTATIONS_COMBINATIONS', 'PROBABILITY', 'NUMBER_SYSTEMS', 'INTEREST', 'AGES', 'CALENDARS_CLOCKS', 'MENSURATION', 'DATA_INTERPRETATION', 'SERIES', 'BLOOD_RELATIONS', 'SYLLOGISMS', 'SEATING_ARRANGEMENT', 'PUZZLES', 'CODING_DECODING', 'DATA_SUFFICIENCY', 'DIRECTIONS', 'STATEMENT_CONCLUSION', 'READING_COMPREHENSION', 'SENTENCE_CORRECTION', 'PARA_JUMBLES', 'SYNONYMS_ANTONYMS', 'CLOZE', 'ERROR_SPOTTING');

-- CreateEnum
CREATE TYPE "public"."AptitudeQuestionKind" AS ENUM ('SINGLE_CHOICE', 'MULTI_CHOICE', 'NUMERIC_ENTRY', 'PASSAGE_GROUPED');

-- CreateTable
CREATE TABLE "public"."AptitudePassage" (
    "id" TEXT NOT NULL,
    "area" "public"."AptitudeArea" NOT NULL,
    "topic" "public"."AptitudeTopic" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "sourceNote" TEXT NOT NULL,
    "origin" "public"."ContentOrigin" NOT NULL,
    "authorId" TEXT,
    "status" "public"."ProblemStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AptitudePassage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AptitudeQuestion" (
    "id" TEXT NOT NULL,
    "displayCode" TEXT NOT NULL,
    "area" "public"."AptitudeArea" NOT NULL,
    "topic" "public"."AptitudeTopic" NOT NULL,
    "kind" "public"."AptitudeQuestionKind" NOT NULL,
    "difficulty" "public"."Difficulty" NOT NULL,
    "status" "public"."ProblemStatus" NOT NULL DEFAULT 'DRAFT',
    "passageId" TEXT,
    "stem" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "correctOptionIndexes" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "numericAnswer" DECIMAL(20,6),
    "numericTolerance" DECIMAL(20,6),
    "numericUnit" TEXT,
    "explanation" TEXT NOT NULL DEFAULT '',
    "expectedSeconds" INTEGER NOT NULL,
    "origin" "public"."ContentOrigin" NOT NULL,
    "sourceBatch" TEXT,
    "authorId" TEXT,
    "reviewedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AptitudeQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AptitudeQuestionStat" (
    "questionId" TEXT NOT NULL,
    "timesServed" INTEGER NOT NULL DEFAULT 0,
    "timesAnswered" INTEGER NOT NULL DEFAULT 0,
    "timesCorrect" INTEGER NOT NULL DEFAULT 0,
    "totalSeconds" INTEGER NOT NULL DEFAULT 0,
    "lastServedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AptitudeQuestionStat_pkey" PRIMARY KEY ("questionId")
);

-- CreateIndex
CREATE INDEX "AptitudePassage_status_area_topic_idx" ON "public"."AptitudePassage"("status", "area", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "AptitudeQuestion_displayCode_key" ON "public"."AptitudeQuestion"("displayCode");

-- CreateIndex
CREATE INDEX "AptitudeQuestion_status_area_topic_idx" ON "public"."AptitudeQuestion"("status", "area", "topic");

-- CreateIndex
CREATE INDEX "AptitudeQuestion_topic_difficulty_status_idx" ON "public"."AptitudeQuestion"("topic", "difficulty", "status");

-- CreateIndex
CREATE INDEX "AptitudeQuestion_contentHash_idx" ON "public"."AptitudeQuestion"("contentHash");

-- CreateIndex
CREATE INDEX "AptitudeQuestion_passageId_idx" ON "public"."AptitudeQuestion"("passageId");

-- AddForeignKey
ALTER TABLE "public"."AptitudeQuestion" ADD CONSTRAINT "AptitudeQuestion_passageId_fkey" FOREIGN KEY ("passageId") REFERENCES "public"."AptitudePassage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AptitudeQuestionStat" ADD CONSTRAINT "AptitudeQuestionStat_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "public"."AptitudeQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── The option-index helper ─────────────────────────────────────────────
-- A CHECK may call an IMMUTABLE function; it may not contain a subquery. So
-- "every correct index exists, and no index twice" lives here. An
-- out-of-range key is a question nobody can answer correctly.
CREATE OR REPLACE FUNCTION recx_aptitude_option_indexes_valid(indexes INTEGER[], options TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    -- NULL-safe: a NULL array is not a violation, it is an empty key, and
    -- the per-kind shape CHECKs decide whether that is allowed.
    COALESCE(
      (
        SELECT bool_and(i >= 0 AND i < COALESCE(array_length(options, 1), 0))
        FROM unnest(COALESCE(indexes, ARRAY[]::INTEGER[])) AS i
      ),
      true
    )
    AND COALESCE(array_length(indexes, 1), 0) = (
      SELECT COUNT(DISTINCT i) FROM unnest(COALESCE(indexes, ARRAY[]::INTEGER[])) AS i
    );
$$;

-- ── AptitudePassage invariants ──────────────────────────────────────────

-- A passage shorter than 80 characters is a stem, not a passage.
ALTER TABLE "public"."AptitudePassage"
  ADD CONSTRAINT "AptitudePassage_body_check"
  CHECK (char_length(btrim("body")) BETWEEN 80 AND 20000);

ALTER TABLE "public"."AptitudePassage"
  ADD CONSTRAINT "AptitudePassage_word_count_check"
  CHECK ("wordCount" >= 0);

-- A passage with no stated provenance is a passage nobody can check.
ALTER TABLE "public"."AptitudePassage"
  ADD CONSTRAINT "AptitudePassage_source_note_check"
  CHECK (char_length(btrim("sourceNote")) BETWEEN 10 AND 500);

ALTER TABLE "public"."AptitudePassage"
  ADD CONSTRAINT "AptitudePassage_title_check"
  CHECK (char_length(btrim("title")) BETWEEN 3 AND 200);

-- ── AptitudeQuestion invariants ─────────────────────────────────────────

-- APT-00042, the Problem.displayCode convention. Spelled without a bounded
-- repetition count on purpose.
ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_display_code_check"
  CHECK ("displayCode" ~ '^APT-[0-9]+$' AND char_length("displayCode") >= 9);

ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_stem_check"
  CHECK (char_length(btrim("stem")) BETWEEN 5 AND 4000);

-- SPEC §5: "Worked explanations are mandatory, enforced at publish." A zod
-- refinement in the publish action is the obvious place and is not enough:
-- this holds against a back-fill script, a raw SQL fix and any future second
-- publish path. 40 characters is the floor that stops "use the formula"
-- shipping as a worked explanation.
ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_explanation_published"
  CHECK ("status" <> 'PUBLISHED' OR char_length(btrim("explanation")) >= 40);

ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_explanation_length"
  CHECK (char_length("explanation") <= 8000);

-- A VERBAL question tagged MENSURATION would silently corrupt every section
-- blueprint and every weakness heatmap. The mapping is immutable, so it is a
-- CHECK and not a trigger. Generated from APTITUDE_TOPIC_AREA in
-- packages/shared/src/aptitude-taxonomy.ts — one list, not two.
ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_area_topic_check"
  CHECK (
    ("area" = 'QUANTITATIVE' AND "topic" IN ('PERCENTAGES', 'PROFIT_LOSS', 'TIME_SPEED_DISTANCE', 'TIME_AND_WORK', 'RATIO_PROPORTION', 'AVERAGES_MIXTURES', 'PERMUTATIONS_COMBINATIONS', 'PROBABILITY', 'NUMBER_SYSTEMS', 'INTEREST', 'AGES', 'CALENDARS_CLOCKS', 'MENSURATION', 'DATA_INTERPRETATION'))
    OR ("area" = 'LOGICAL' AND "topic" IN ('SERIES', 'BLOOD_RELATIONS', 'SYLLOGISMS', 'SEATING_ARRANGEMENT', 'PUZZLES', 'CODING_DECODING', 'DATA_SUFFICIENCY', 'DIRECTIONS', 'STATEMENT_CONCLUSION'))
    OR ("area" = 'VERBAL' AND "topic" IN ('READING_COMPREHENSION', 'SENTENCE_CORRECTION', 'PARA_JUMBLES', 'SYNONYMS_ANTONYMS', 'CLOZE', 'ERROR_SPOTTING'))
  );

ALTER TABLE "public"."AptitudePassage"
  ADD CONSTRAINT "AptitudePassage_area_topic_check"
  CHECK (
    ("area" = 'QUANTITATIVE' AND "topic" IN ('PERCENTAGES', 'PROFIT_LOSS', 'TIME_SPEED_DISTANCE', 'TIME_AND_WORK', 'RATIO_PROPORTION', 'AVERAGES_MIXTURES', 'PERMUTATIONS_COMBINATIONS', 'PROBABILITY', 'NUMBER_SYSTEMS', 'INTEREST', 'AGES', 'CALENDARS_CLOCKS', 'MENSURATION', 'DATA_INTERPRETATION'))
    OR ("area" = 'LOGICAL' AND "topic" IN ('SERIES', 'BLOOD_RELATIONS', 'SYLLOGISMS', 'SEATING_ARRANGEMENT', 'PUZZLES', 'CODING_DECODING', 'DATA_SUFFICIENCY', 'DIRECTIONS', 'STATEMENT_CONCLUSION'))
    OR ("area" = 'VERBAL' AND "topic" IN ('READING_COMPREHENSION', 'SENTENCE_CORRECTION', 'PARA_JUMBLES', 'SYNONYMS_ANTONYMS', 'CLOZE', 'ERROR_SPOTTING'))
  );

-- The kinds and the passage link are one fact stated twice, so they are held
-- consistent: only a PASSAGE_GROUPED question carries a passage, and every
-- PASSAGE_GROUPED question carries one.
ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_passage_kind"
  CHECK (("passageId" IS NOT NULL) = ("kind" = 'PASSAGE_GROUPED'));

-- A choice question has 2–8 options and no numeric answer.
ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_choice_shape"
  CHECK (
    "kind" = 'NUMERIC_ENTRY'
    OR (
      COALESCE(array_length("options", 1), 0) BETWEEN 2 AND 8
      AND "numericAnswer" IS NULL
      AND "numericTolerance" IS NULL
      AND "numericUnit" IS NULL
    )
  );

ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_single_answer"
  CHECK (
    "kind" NOT IN ('SINGLE_CHOICE', 'PASSAGE_GROUPED')
    OR COALESCE(array_length("correctOptionIndexes", 1), 0) = 1
  );

-- A multi-choice with one correct option is a mis-authored single-choice: it
-- makes the all-or-nothing rule indistinguishable from single-choice scoring.
ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_multi_answer"
  CHECK (
    "kind" <> 'MULTI_CHOICE'
    OR COALESCE(array_length("correctOptionIndexes", 1), 0)
       BETWEEN 2 AND COALESCE(array_length("options", 1), 0)
  );

ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_numeric_shape"
  CHECK (
    "kind" <> 'NUMERIC_ENTRY'
    OR (
      "numericAnswer" IS NOT NULL
      AND "numericTolerance" IS NOT NULL
      AND "numericTolerance" >= 0
      AND COALESCE(array_length("options", 1), 0) = 0
      AND COALESCE(array_length("correctOptionIndexes", 1), 0) = 0
    )
  );

ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_option_index_check"
  CHECK (recx_aptitude_option_indexes_valid("correctOptionIndexes", "options"));

ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_expected_seconds_check"
  CHECK ("expectedSeconds" BETWEEN 5 AND 1800);

ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_content_hash_check"
  CHECK ("contentHash" ~ '^[0-9a-f]+$' AND char_length("contentHash") = 64);

-- A PUBLISHED row carries its publication date; a RETIRED one carries its
-- retirement date. A status with no date behind it is a status nobody can
-- audit.
ALTER TABLE "public"."AptitudeQuestion"
  ADD CONSTRAINT "AptitudeQuestion_status_dates_check"
  CHECK (
    ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL)
    AND ("status" <> 'RETIRED' OR "retiredAt" IS NOT NULL)
  );

-- ── AptitudeQuestionStat invariants ─────────────────────────────────────
-- timesAnswered <= timesServed is protective only because timesServed moves
-- where the question is SERVED. Incrementing both at finalise would make it
-- vacuous and bias the "dud question" denominator by every abandoned attempt.
ALTER TABLE "public"."AptitudeQuestionStat"
  ADD CONSTRAINT "AptitudeQuestionStat_counts_check"
  CHECK (
    "timesServed" >= 0
    AND "timesAnswered" >= 0
    AND "timesCorrect" >= 0
    AND "totalSeconds" >= 0
    AND "timesAnswered" <= "timesServed"
    AND "timesCorrect" <= "timesAnswered"
  );

-- ── A published question's key is frozen; its explanation is not ────────
-- Students have already been scored on that question, so rewriting its key
-- silently rescores the past, while improving the wording of the worked
-- solution harms nobody. Retiring stays open (a RETIRED question is never
-- deleted — answer rows reference it, and past percentiles must stay honest).
CREATE OR REPLACE FUNCTION recx_refuse_published_question_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('PUBLISHED', 'RETIRED') THEN
      RAISE EXCEPTION
        'AptitudeQuestion % has been published; retire it instead of deleting it. Answer rows reference it, and past results must stay honest.',
        OLD."displayCode"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" <> 'PUBLISHED' THEN
    RETURN NEW;
  END IF;

  IF NEW."stem" IS DISTINCT FROM OLD."stem"
     OR NEW."options" IS DISTINCT FROM OLD."options"
     OR NEW."correctOptionIndexes" IS DISTINCT FROM OLD."correctOptionIndexes"
     OR NEW."numericAnswer" IS DISTINCT FROM OLD."numericAnswer"
     OR NEW."numericTolerance" IS DISTINCT FROM OLD."numericTolerance"
     OR NEW."numericUnit" IS DISTINCT FROM OLD."numericUnit"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."area" IS DISTINCT FROM OLD."area"
     OR NEW."topic" IS DISTINCT FROM OLD."topic"
     OR NEW."passageId" IS DISTINCT FROM OLD."passageId"
     OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash" THEN
    RAISE EXCEPTION
      'AptitudeQuestion % is published: its stem, options, key, kind, area, topic and passage are frozen. The explanation stays editable, and a wrong question is RETIRED rather than rewritten.',
      OLD."displayCode"
      USING ERRCODE = 'check_violation';
  END IF;

  -- A published question cannot go back to DRAFT or IN_REVIEW: a cohort has
  -- already been scored on it.
  IF NEW."status" NOT IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION
      'AptitudeQuestion % cannot return to %; a published question is retired, never unpublished.',
      OLD."displayCode", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "AptitudeQuestion_published_immutable"
  BEFORE UPDATE OR DELETE ON "public"."AptitudeQuestion"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_published_question_change();

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
CREATE TRIGGER "AptitudePassage_no_truncate"
  BEFORE TRUNCATE ON "public"."AptitudePassage"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "AptitudeQuestion_no_truncate"
  BEFORE TRUNCATE ON "public"."AptitudeQuestion"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
