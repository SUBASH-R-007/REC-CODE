-- CreateEnum
CREATE TYPE "public"."ProctorMode" AS ENUM ('NONE', 'ADVISORY', 'REMOTE_MONITORED', 'KIOSK_SEB', 'LAB_SUPERVISED');

-- CreateEnum
CREATE TYPE "public"."AttemptStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'DISCONNECTED', 'SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED', 'TERMINATED', 'VOIDED');

-- CreateEnum
CREATE TYPE "public"."FlagStatus" AS ENUM ('OPEN', 'REVIEWING', 'UPHELD', 'DISMISSED');

-- CreateEnum
CREATE TYPE "public"."Severity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "public"."EventSource" AS ENUM ('CLIENT', 'SERVER', 'INVIGILATOR');

-- CreateEnum
CREATE TYPE "public"."FocusLimitAction" AS ENUM ('AUTOSUBMIT', 'FLAG_ONLY');

-- CreateEnum
CREATE TYPE "public"."AssessmentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'OPEN', 'CLOSED', 'ARCHIVED');

-- AlterEnum
ALTER TYPE "public"."ProctorEventKind" ADD VALUE 'SNAPSHOT_JUMP';

-- CreateTable
CREATE TABLE "public"."Assessment" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "status" "public"."AssessmentStatus" NOT NULL DEFAULT 'DRAFT',
    "proctorMode" "public"."ProctorMode" NOT NULL DEFAULT 'NONE',
    "affectsPlacementEligibility" BOOLEAN NOT NULL DEFAULT false,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "durationSec" INTEGER NOT NULL,
    "maxAttempts" INTEGER NOT NULL DEFAULT 1,
    "maxFocusWarnings" INTEGER NOT NULL DEFAULT 3,
    "onLimit" "public"."FocusLimitAction" NOT NULL DEFAULT 'AUTOSUBMIT',
    "strictMode" BOOLEAN NOT NULL DEFAULT false,
    "audienceBatchYear" INTEGER,
    "audienceDepartmentCode" TEXT,
    "audienceSection" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AssessmentProblem" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssessmentProblem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExamSession" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "room" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 60,
    "allowedCidrs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "requireManagedDevice" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Assessment_slug_key" ON "public"."Assessment"("slug");

-- CreateIndex
CREATE INDEX "Assessment_status_opensAt_idx" ON "public"."Assessment"("status", "opensAt" DESC);

-- CreateIndex
CREATE INDEX "Assessment_opensAt_idx" ON "public"."Assessment"("opensAt");

-- CreateIndex
CREATE INDEX "AssessmentProblem_problemVersionId_idx" ON "public"."AssessmentProblem"("problemVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentProblem_assessmentId_position_key" ON "public"."AssessmentProblem"("assessmentId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentProblem_assessmentId_problemVersionId_key" ON "public"."AssessmentProblem"("assessmentId", "problemVersionId");

-- CreateIndex
CREATE INDEX "ExamSession_assessmentId_startsAt_idx" ON "public"."ExamSession"("assessmentId", "startsAt");

-- AddForeignKey
ALTER TABLE "public"."AssessmentProblem" ADD CONSTRAINT "AssessmentProblem_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AssessmentProblem" ADD CONSTRAINT "AssessmentProblem_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExamSession" ADD CONSTRAINT "ExamSession_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 6a: the invariants Prisma cannot model. Everything above this line
-- is Prisma's own output, so `prisma migrate diff` stays clean; everything
-- below is hand-written and listed in
-- packages/db/test/support/guard-catalog.ts.
--
-- Every refusal raises ERRCODE check_violation (SQLSTATE 23514).

-- ── THE HARD RULE ────────────────────────────────────────────────────────
-- SPEC §5: "Assessment.affectsPlacementEligibility = true REQUIRES
-- proctorMode = LAB_SUPERVISED. Enforce with a zod refinement at the server
-- boundary and a Postgres CHECK. Only a lab-proctored result may ever feed
-- shortlisting, certificates or placement eligibility. This stops the
-- predictable drift where an admin flips a Friday quiz into a shortlisting
-- criterion because it was convenient."
--
-- The CHECK is what makes that true of the DATA rather than of the code
-- path: no server action, no script, no psql session and no future UI can
-- produce a placement-bearing assessment that was not lab-proctored.
ALTER TABLE "public"."Assessment"
  ADD CONSTRAINT "Assessment_placement_requires_lab"
    CHECK ("affectsPlacementEligibility" = false OR "proctorMode" = 'LAB_SUPERVISED'),
  ADD CONSTRAINT "Assessment_window_check"
    CHECK ("closesAt" > "opensAt"),
  -- A minute is the shortest test worth sitting; six hours is longer than any
  -- campus sitting and keeps a typo from creating a week-long window.
  ADD CONSTRAINT "Assessment_duration_check"
    CHECK ("durationSec" BETWEEN 60 AND 21600),
  ADD CONSTRAINT "Assessment_warnings_check"
    CHECK ("maxFocusWarnings" BETWEEN 1 AND 10),
  ADD CONSTRAINT "Assessment_attempts_check"
    CHECK ("maxAttempts" BETWEEN 1 AND 5),
  ADD CONSTRAINT "Assessment_title_check"
    CHECK (char_length("title") BETWEEN 1 AND 160),
  ADD CONSTRAINT "Assessment_instructions_check"
    CHECK (char_length("instructions") BETWEEN 1 AND 20000),
  ADD CONSTRAINT "Assessment_slug_check"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- An audienceSection only means something with a batch and a department,
  -- as for Announcement.
  ADD CONSTRAINT "Assessment_audience_check"
    CHECK ("audienceSection" IS NULL
           OR ("audienceBatchYear" IS NOT NULL AND "audienceDepartmentCode" IS NOT NULL));

-- Once an assessment has left DRAFT, what a result MEANS is fixed: the
-- window, the clock, how closely it was watched, and whether it may feed
-- placement. A candidate's result must mean what it meant when they sat it,
-- and the placement flag in particular must not be switchable after the
-- fact — that would be the drift the CHECK above exists to prevent, arriving
-- by a different door.
CREATE OR REPLACE FUNCTION recx_refuse_published_assessment_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Assessment % is published and cannot be deleted (archive it instead)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF (NEW."id", NEW."createdById") IS DISTINCT FROM (OLD."id", OLD."createdById") THEN
    RAISE EXCEPTION 'Assessment %: id and createdById never change', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" <> 'DRAFT'
     AND (NEW."opensAt", NEW."closesAt", NEW."durationSec", NEW."proctorMode",
          NEW."affectsPlacementEligibility", NEW."maxAttempts")
         IS DISTINCT FROM
         (OLD."opensAt", OLD."closesAt", OLD."durationSec", OLD."proctorMode",
          OLD."affectsPlacementEligibility", OLD."maxAttempts") THEN
    RAISE EXCEPTION 'Assessment % is published: its window, duration, proctor mode, attempt limit and placement flag are fixed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- ARCHIVED is terminal.
  IF OLD."status" = 'ARCHIVED' AND NEW."status" <> 'ARCHIVED' THEN
    RAISE EXCEPTION 'Assessment % is ARCHIVED (final): its status never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Assessment_published_immutable"
  BEFORE UPDATE OR DELETE ON "public"."Assessment"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_published_assessment_change();

-- ── AssessmentProblem: the pinned version is frozen, and stays pinned ────
-- Identical rule to ContestProblem (SPEC §4a): an assessment asks what it
-- asked, so editing a problem afterwards cannot rescore a candidate.
ALTER TABLE "public"."AssessmentProblem"
  ADD CONSTRAINT "AssessmentProblem_points_check"
    CHECK ("points" > 0),
  ADD CONSTRAINT "AssessmentProblem_position_check"
    CHECK ("position" BETWEEN 1 AND 200);

CREATE OR REPLACE FUNCTION recx_refuse_unfrozen_assessment_problem() RETURNS trigger AS $$
DECLARE
  frozen timestamp(3);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."assessmentId", NEW."problemVersionId", NEW."position")
       IS DISTINCT FROM
       (OLD."assessmentId", OLD."problemVersionId", OLD."position") THEN
      RAISE EXCEPTION 'AssessmentProblem %: assessmentId, problemVersionId and position never change', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT v."frozenAt" INTO frozen
    FROM "public"."ProblemVersion" v
   WHERE v."id" = NEW."problemVersionId";
  IF frozen IS NULL THEN
    RAISE EXCEPTION 'AssessmentProblem %: problem version % is not frozen; an assessment pins a published revision, never a draft or the live pointer', NEW."id", NEW."problemVersionId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AssessmentProblem_frozen_version"
  BEFORE INSERT OR UPDATE ON "public"."AssessmentProblem"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_unfrozen_assessment_problem();

-- ── ExamSession ──────────────────────────────────────────────────────────
-- The CIDR allowlist IS the enforcement for a lab sitting (SPEC §5), so a
-- LAB_SUPERVISED session with an empty allowlist would be lab-proctored with
-- nothing proctoring it. The mode lives on the Assessment, so this is a
-- trigger rather than a row-local CHECK.
ALTER TABLE "public"."ExamSession"
  ADD CONSTRAINT "ExamSession_window_check"
    CHECK ("endsAt" > "startsAt"),
  ADD CONSTRAINT "ExamSession_capacity_check"
    CHECK ("capacity" BETWEEN 1 AND 2000),
  ADD CONSTRAINT "ExamSession_label_check"
    CHECK (char_length("label") BETWEEN 1 AND 80);

CREATE OR REPLACE FUNCTION recx_refuse_lab_session_without_allowlist() RETURNS trigger AS $$
DECLARE
  mode text;
BEGIN
  SELECT a."proctorMode"::text INTO mode
    FROM "public"."Assessment" a
   WHERE a."id" = NEW."assessmentId";
  IF mode = 'LAB_SUPERVISED' AND coalesce(array_length(NEW."allowedCidrs", 1), 0) = 0 THEN
    RAISE EXCEPTION 'ExamSession % is for a LAB_SUPERVISED assessment and must name at least one allowed CIDR: the allowlist is the enforcement', NEW."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ExamSession_lab_allowlist"
  BEFORE INSERT OR UPDATE ON "public"."ExamSession"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_lab_session_without_allowlist();

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
CREATE TRIGGER "Assessment_no_truncate"
  BEFORE TRUNCATE ON "public"."Assessment"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "ExamSession_no_truncate"
  BEFORE TRUNCATE ON "public"."ExamSession"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
