-- Phase 16a: a student says this problem is wrong.
--
-- docs/ROADMAP.md §3.2. Every problem in this catalogue was authored here:
-- there is no upstream to inherit a corrected test case from, and no
-- million-submission population to surface a bad one by statistics. The
-- people who will read a new problem carefully are the students sitting in
-- front of it, and until now they had a discussion thread, which has no
-- queue, no owner and no state.
--
-- Three rules are enforced here rather than only in the action:
--
--   1. One OPEN report per student per revision (partial unique index).
--      A decided report never blocks a new one, and a new revision is a
--      new row's worth of ground.
--   2. A decision carries its sentence. UPHELD or DISMISSED with no
--      `resolution`, no `resolvedAt` or no `resolvedById` is a decision
--      nobody can read, and OPEN with any of them set is a row that
--      contradicts itself.
--   3. A hold carries its reason and its stamp. `Problem.qualityHold` is
--      what withholds a problem from NEW papers, and the next examiner
--      reads that reason instead of guessing.
--
-- What is deliberately NOT here: any effect of a report arriving. An OPEN
-- report changes nothing — no unpublish, no delisting, no refusal. A report
-- that withheld a problem by itself would hand every candidate a veto over
-- the paper they are about to sit.

CREATE TYPE "public"."ProblemReportReason" AS ENUM (
  'WRONG_EXPECTED_OUTPUT',
  'STATEMENT_UNCLEAR',
  'STATEMENT_CONTRADICTS_SAMPLES',
  'LIMITS_TOO_TIGHT',
  'MISSING_CONSTRAINT',
  'OTHER'
);

CREATE TABLE "public"."ProblemReport" (
  "id"               TEXT NOT NULL,
  "problemVersionId" TEXT NOT NULL,
  "reporterId"       TEXT NOT NULL,
  "reason"           "public"."ProblemReportReason" NOT NULL,
  "detail"           TEXT NOT NULL,
  "status"           "public"."ReportStatus" NOT NULL DEFAULT 'OPEN',
  "resolvedById"     TEXT,
  "resolvedAt"       TIMESTAMP(3),
  "resolution"       TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProblemReport_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."ProblemReport"
  ADD CONSTRAINT "ProblemReport_problemVersionId_fkey"
  FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."ProblemReport"
  ADD CONSTRAINT "ProblemReport_reporterId_fkey"
  FOREIGN KEY ("reporterId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."ProblemReport"
  ADD CONSTRAINT "ProblemReport_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ProblemReport_status_createdAt_idx" ON "public"."ProblemReport"("status", "createdAt");
CREATE INDEX "ProblemReport_problemVersionId_status_idx" ON "public"."ProblemReport"("problemVersionId", "status");
CREATE INDEX "ProblemReport_reporterId_idx" ON "public"."ProblemReport"("reporterId");

-- Rule 1. Partial, because the uniqueness is a property of OPEN rows only.
CREATE UNIQUE INDEX "ProblemReport_one_open_per_reporter"
  ON "public"."ProblemReport"("problemVersionId", "reporterId")
  WHERE "status" = 'OPEN';

-- Rule 2. A decision is all three columns or none of them.
ALTER TABLE "public"."ProblemReport"
  ADD CONSTRAINT "ProblemReport_decision_check" CHECK (
    ("status" = 'OPEN'
       AND "resolvedById" IS NULL AND "resolvedAt" IS NULL AND "resolution" IS NULL)
    OR ("status" <> 'OPEN'
       AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL
       AND "resolution" IS NOT NULL AND length(btrim("resolution")) > 0)
  );

ALTER TABLE "public"."ProblemReport"
  ADD CONSTRAINT "ProblemReport_detail_check" CHECK (
    length(btrim("detail")) > 0 AND length("detail") <= 1000
  );

ALTER TABLE "public"."ProblemReport"
  ADD CONSTRAINT "ProblemReport_resolution_length_check" CHECK (
    "resolution" IS NULL OR length("resolution") <= 1000
  );

-- The hold itself, on the Problem.
ALTER TABLE "public"."Problem"
  ADD COLUMN "qualityHold"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "qualityHoldReason" TEXT,
  ADD COLUMN "qualityHeldById"   TEXT,
  ADD COLUMN "qualityHeldAt"     TIMESTAMP(3);

-- Rule 3. A hold is the flag, a reason and a stamp, together or not at all.
ALTER TABLE "public"."Problem"
  ADD CONSTRAINT "Problem_quality_hold_check" CHECK (
    ("qualityHold" = false
       AND "qualityHoldReason" IS NULL AND "qualityHeldById" IS NULL AND "qualityHeldAt" IS NULL)
    OR ("qualityHold" = true
       AND "qualityHoldReason" IS NOT NULL AND length(btrim("qualityHoldReason")) > 0
       AND length("qualityHoldReason") <= 300
       AND "qualityHeldById" IS NOT NULL AND "qualityHeldAt" IS NOT NULL)
  );

-- A held problem is refused a pin into a NEW paper, exactly where the four
-- kind refusals live (20261101140500, 20261101151000 and their neighbours).
-- Existing papers are untouched: this fires on INSERT and UPDATE of a pin,
-- not on the hold being set, so a paper somebody is part-way through
-- setting keeps the question it already has, and a sitting in progress is
-- not interrupted by a staff decision taken while it runs.
CREATE OR REPLACE FUNCTION recx_refuse_held_assessment_problem() RETURNS trigger AS $$
DECLARE
  held   boolean;
  why    text;
  code   text;
BEGIN
  SELECT p."qualityHold", coalesce(p."qualityHoldReason", ''), p."displayCode"
    INTO held, why, code
    FROM "public"."ProblemVersion" v
    JOIN "public"."Problem" p ON p."id" = v."problemId"
   WHERE v."id" = NEW."problemVersionId";
  IF held THEN
    RAISE EXCEPTION 'AssessmentProblem %: problem % is withheld from new papers while a reported defect is open (%)', NEW."id", code, why
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AssessmentProblem_no_quality_hold"
  BEFORE INSERT OR UPDATE ON "public"."AssessmentProblem"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_held_assessment_problem();
