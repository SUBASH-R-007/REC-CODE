-- Phase 7b: mock patterns and their sections.
--
-- A pattern encodes a recruiter funnel declaratively (SPEC §5). Two things
-- are enforced here that the arithmetic in @recx/shared cannot enforce on its
-- own:
--
--   * the denormalised totals on the listing page are maintained by a trigger
--     rather than aggregated on read (SPEC §4(d)'s rule generalised), so they
--     cannot drift and the page cannot scan;
--   * a section's blueprint SUMS to its question count, in the data. A
--     blueprint that does not sum is a short paper for a candidate, and
--     buildMockLayout() draws straight from it.
--
-- NOT here: recx_refuse_used_pattern_change, which freezes a pattern once a
-- finalised attempt exists. It has to read MockAttempt, which arrives with
-- the sitting engine in 7c — and it lands in the same migration that first
-- makes an attempt possible, so there is no window in which a sat pattern is
-- editable.

-- CreateEnum
CREATE TYPE "public"."MockPatternStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "public"."MockPattern" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "funnelLabel" TEXT NOT NULL,
    "sourceNote" TEXT NOT NULL,
    "modelledOnCompany" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL,
    "status" "public"."MockPatternStatus" NOT NULL DEFAULT 'DRAFT',
    "totalQuestions" INTEGER NOT NULL DEFAULT 0,
    "totalTimeSec" INTEGER NOT NULL DEFAULT 0,
    "finalizedAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "medianPercent" DOUBLE PRECISION,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MockPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AptitudeSection" (
    "id" TEXT NOT NULL,
    "patternId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "area" "public"."AptitudeArea",
    "topicMix" JSONB NOT NULL,
    "questionCount" INTEGER NOT NULL,
    "timeLimitSec" INTEGER NOT NULL,
    "cutoffPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "marksPerCorrect" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "negativeMarkFraction" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "allowBackNavigation" BOOLEAN NOT NULL DEFAULT true,
    "shuffleQuestions" BOOLEAN NOT NULL DEFAULT true,
    "shuffleOptions" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AptitudeSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MockPattern_slug_key" ON "public"."MockPattern"("slug");

-- CreateIndex
CREATE INDEX "MockPattern_status_slug_idx" ON "public"."MockPattern"("status", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "AptitudeSection_patternId_position_key" ON "public"."AptitudeSection"("patternId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "AptitudeSection_patternId_key_key" ON "public"."AptitudeSection"("patternId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "AptitudeSection_patternId_label_key" ON "public"."AptitudeSection"("patternId", "label");

-- AddForeignKey
ALTER TABLE "public"."AptitudeSection" ADD CONSTRAINT "AptitudeSection_patternId_fkey" FOREIGN KEY ("patternId") REFERENCES "public"."MockPattern"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── The blueprint helpers ───────────────────────────────────────────────
-- A CHECK may call an IMMUTABLE function but may not contain a subquery, so
-- the jsonb walk lives here. Both functions are total: a malformed topicMix
-- returns a value that fails the CHECK rather than raising, because an error
-- from inside a CHECK is an error an author cannot read.

-- The number of questions a blueprint draws, or -1 if it is not a list of
-- {topic, count} objects at all.
CREATE OR REPLACE FUNCTION recx_aptitude_topic_mix_total(mix JSONB)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  -- Every comparison is COALESCEd, and the result is COALESCEd to -1. A
  -- missing key makes `entry -> 'count'` SQL NULL, so `jsonb_typeof(...) <>
  -- 'number'` is NULL, so the EXISTS predicate is not TRUE, so a blueprint
  -- with no count at all once fell through to SUM(NULL) = NULL — and
  -- `NULL = "questionCount"` is NULL, which Postgres treats as SATISFIED.
  -- That is the same hole Phase 6e found in a mandatory-rationale CHECK, and
  -- the invariant test below found this one.
  SELECT COALESCE(
    CASE
      WHEN mix IS NULL OR jsonb_typeof(mix) <> 'array' OR jsonb_array_length(mix) = 0 THEN -1
      WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(mix) AS entry
        WHERE COALESCE(jsonb_typeof(entry), 'null') <> 'object'
          OR COALESCE(jsonb_typeof(entry -> 'topic'), 'null') <> 'string'
          OR COALESCE(jsonb_typeof(entry -> 'count'), 'null') <> 'number'
          OR COALESCE((entry ->> 'count')::numeric <> trunc((entry ->> 'count')::numeric), true)
          OR COALESCE((entry ->> 'count')::numeric < 1, true)
      ) THEN -1
      ELSE (SELECT SUM((entry ->> 'count')::integer)::integer FROM jsonb_array_elements(mix) AS entry)
    END,
    -1
  );
$$;

-- True when no topic appears on two lines of the blueprint. One line per
-- topic with the total count, so an author cannot half-edit a split.
CREATE OR REPLACE FUNCTION recx_aptitude_topic_mix_distinct(mix JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    CASE
      WHEN mix IS NULL OR jsonb_typeof(mix) <> 'array' THEN false
      ELSE jsonb_array_length(mix) = (
        SELECT COUNT(DISTINCT entry ->> 'topic') FROM jsonb_array_elements(mix) AS entry
      )
    END,
    false
  );
$$;

-- ── MockPattern invariants ──────────────────────────────────────────────

ALTER TABLE "public"."MockPattern"
  ADD CONSTRAINT "MockPattern_slug_check"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 60);

-- A pattern with no stated provenance is a pattern nobody can check.
ALTER TABLE "public"."MockPattern"
  ADD CONSTRAINT "MockPattern_source_note_check"
  CHECK (char_length(btrim("sourceNote")) BETWEEN 10 AND 500);

ALTER TABLE "public"."MockPattern"
  ADD CONSTRAINT "MockPattern_description_check"
  CHECK (char_length(btrim("description")) BETWEEN 20 AND 600);

ALTER TABLE "public"."MockPattern"
  ADD CONSTRAINT "MockPattern_totals_check"
  CHECK (
    "totalQuestions" >= 0
    AND "totalTimeSec" >= 0
    AND "finalizedAttemptCount" >= 0
    AND ("medianPercent" IS NULL OR ("medianPercent" >= 0 AND "medianPercent" <= 100))
  );

-- A PUBLISHED pattern a student can open has to have a paper behind it. The
-- totals are trigger-maintained, so this also refuses deleting the last
-- section of a published pattern — which is the write that would otherwise
-- turn a live pattern into an empty one.
ALTER TABLE "public"."MockPattern"
  ADD CONSTRAINT "MockPattern_published_has_paper"
  CHECK ("status" <> 'PUBLISHED' OR ("totalQuestions" > 0 AND "totalTimeSec" > 0));

-- ── AptitudeSection invariants ──────────────────────────────────────────

ALTER TABLE "public"."AptitudeSection"
  ADD CONSTRAINT "AptitudeSection_position_check"
  CHECK ("position" BETWEEN 1 AND 8);

ALTER TABLE "public"."AptitudeSection"
  ADD CONSTRAINT "AptitudeSection_key_check"
  CHECK ("key" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("key") BETWEEN 2 AND 40);

ALTER TABLE "public"."AptitudeSection"
  ADD CONSTRAINT "AptitudeSection_label_check"
  CHECK (char_length(btrim("label")) BETWEEN 2 AND 80);

ALTER TABLE "public"."AptitudeSection"
  ADD CONSTRAINT "AptitudeSection_count_check"
  CHECK ("questionCount" BETWEEN 1 AND 100);

ALTER TABLE "public"."AptitudeSection"
  ADD CONSTRAINT "AptitudeSection_time_check"
  CHECK ("timeLimitSec" BETWEEN 60 AND 7200);

-- Below twenty seconds a question the timer is the test, not the questions.
ALTER TABLE "public"."AptitudeSection"
  ADD CONSTRAINT "AptitudeSection_pace_check"
  CHECK ("timeLimitSec" >= 20 * "questionCount");

ALTER TABLE "public"."AptitudeSection"
  ADD CONSTRAINT "AptitudeSection_cutoff_check"
  CHECK ("cutoffPercent" >= 0 AND "cutoffPercent" <= 100);

ALTER TABLE "public"."AptitudeSection"
  ADD CONSTRAINT "AptitudeSection_marks_check"
  CHECK ("marksPerCorrect" > 0 AND "marksPerCorrect" <= 10);

-- The negative mark is a FRACTION of marksPerCorrect, never an absolute mark.
ALTER TABLE "public"."AptitudeSection"
  ADD CONSTRAINT "AptitudeSection_negative_check"
  CHECK ("negativeMarkFraction" >= 0 AND "negativeMarkFraction" <= 1);

-- The blueprint draws exactly as many questions as the section is long.
ALTER TABLE "public"."AptitudeSection"
  ADD CONSTRAINT "AptitudeSection_topic_mix_check"
  CHECK (
    recx_aptitude_topic_mix_total("topicMix") = "questionCount"
    AND recx_aptitude_topic_mix_distinct("topicMix")
  );

-- ── The totals are maintained, never aggregated on read ─────────────────
-- SPEC §4(d)'s rule generalised: no page may aggregate to render. A
-- denormalised total nobody maintains drifts, so one trigger owns both.
CREATE OR REPLACE FUNCTION recx_sync_pattern_totals()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target TEXT;
BEGIN
  target := COALESCE(NEW."patternId", OLD."patternId");
  UPDATE "public"."MockPattern" AS p
     SET "totalQuestions" = COALESCE(s."questions", 0),
         "totalTimeSec" = COALESCE(s."seconds", 0),
         "updatedAt" = now()
    FROM (
      SELECT
        SUM("questionCount")::integer AS "questions",
        SUM("timeLimitSec")::integer AS "seconds"
      FROM "public"."AptitudeSection"
      WHERE "patternId" = target
    ) AS s
   WHERE p."id" = target;

  -- A pattern whose sections moved to another pattern needs both updated.
  IF TG_OP = 'UPDATE' AND NEW."patternId" IS DISTINCT FROM OLD."patternId" THEN
    UPDATE "public"."MockPattern" AS p
       SET "totalQuestions" = COALESCE(s."questions", 0),
           "totalTimeSec" = COALESCE(s."seconds", 0),
           "updatedAt" = now()
      FROM (
        SELECT
          SUM("questionCount")::integer AS "questions",
          SUM("timeLimitSec")::integer AS "seconds"
        FROM "public"."AptitudeSection"
        WHERE "patternId" = OLD."patternId"
      ) AS s
     WHERE p."id" = OLD."patternId";
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "AptitudeSection_totals_sync"
  AFTER INSERT OR UPDATE OR DELETE ON "public"."AptitudeSection"
  FOR EACH ROW EXECUTE FUNCTION recx_sync_pattern_totals();

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
CREATE TRIGGER "MockPattern_no_truncate"
  BEFORE TRUNCATE ON "public"."MockPattern"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "AptitudeSection_no_truncate"
  BEFORE TRUNCATE ON "public"."AptitudeSection"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
