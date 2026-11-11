-- Phase 8a: the academic calendar, and approved leave.
--
-- SPEC §5 Phase 8: "Inactivity as a policy engine, not a kill switch." The
-- engine's first requirement is a calendar, because "ten days inactive" said
-- without one is a date subtraction pretending to be a judgement about a
-- student. A college shuts for Pongal; a student is ill. Neither is idleness.
--
-- Both tables are append-mostly, and that is load-bearing rather than tidy:
-- a Phase 8c evidence row lists the dates it excluded and why, so a calendar
-- that could be rewritten afterwards turns old evidence into a lie. The
-- correction path for a mis-entered past day is a retroactive LeaveException,
-- which is the spec's own reversal mechanism (docs/OPEN-QUESTIONS.md).

-- `btree_gist` so a daterange EXCLUDE constraint can also compare a text
-- userId with `=`. Only `pg_trgm` is installed today (20261010001004).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "public"."CalendarDayKind" AS ENUM ('REGULAR', 'HOLIDAY', 'EXAM_WEEK', 'SEMESTER_BREAK', 'PLACEMENT_WEEK');

-- CreateEnum
CREATE TYPE "public"."LeaveKind" AS ENUM ('MEDICAL', 'BEREAVEMENT', 'UNIVERSITY_EXAM', 'PLACEMENT_DRIVE', 'INTERNSHIP', 'SPORTS_EVENT', 'APPROVED_OTHER');

-- CreateEnum
CREATE TYPE "public"."LeaveStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."CalendarDay" (
    "date" DATE NOT NULL,
    "isWorkingDay" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT NOT NULL,
    "kind" "public"."CalendarDayKind" NOT NULL DEFAULT 'REGULAR',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarDay_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "public"."LeaveException" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "public"."LeaveKind" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "status" "public"."LeaveStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT NOT NULL,
    "evidenceFileId" TEXT,
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaveException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarDay_kind_date_idx" ON "public"."CalendarDay"("kind", "date");

-- CreateIndex
CREATE INDEX "LeaveException_userId_status_startDate_idx" ON "public"."LeaveException"("userId", "status", "startDate");

-- CreateIndex
CREATE INDEX "LeaveException_status_startDate_idx" ON "public"."LeaveException"("status", "startDate");

-- AddForeignKey
ALTER TABLE "public"."LeaveException" ADD CONSTRAINT "LeaveException_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Invariants: CalendarDay ─────────────────────────────────────────────

-- A label somebody can read in the grid. An unlabelled holiday is a day
-- nobody can check against the college's own circular.
ALTER TABLE "public"."CalendarDay"
  ADD CONSTRAINT "CalendarDay_label_check"
  CHECK (char_length(btrim("label")) BETWEEN 1 AND 120);

-- There is deliberately NO constraint tying `kind` to `isWorkingDay`. They
-- answer different questions: `kind <> REGULAR` is a structural exclusion the
-- counter always applies, and `isWorkingDay = false` is the weekend, which is
-- the one thing the policy's `excludeNonWorkingDays` toggle switches off.
-- Forcing every non-regular day to `isWorkingDay = false` would leave that
-- spec field with nothing left to mean — an exam week IS a working week.

-- ── Invariants: LeaveException ──────────────────────────────────────────

-- Inclusive of both ends, and no longer than half a year. A leave longer than
-- that is a withdrawal, which is a different conversation and a different
-- status on User.
ALTER TABLE "public"."LeaveException"
  ADD CONSTRAINT "LeaveException_range_check"
  CHECK ("endDate" >= "startDate" AND ("endDate" - "startDate") <= 180);

ALTER TABLE "public"."LeaveException"
  ADD CONSTRAINT "LeaveException_reason_check"
  CHECK (char_length(btrim("reason")) BETWEEN 10 AND 1000);

-- Decided means decided BY somebody AT a moment. A row that says APPROVED
-- with no decider is a row an appeal cannot trace.
--
-- Three rules, not the one biconditional the draft had. `(status IN
-- ('APPROVED','REJECTED')) = (decided…)` reads well and is wrong: it makes
-- CANCELLED mean "never decided", so cancelling an APPROVED leave would have
-- to erase its decider — which the terms trigger rightly refuses, leaving an
-- approved leave that can never be withdrawn. A student who recovers early
-- cancels their own medical leave, and the record must keep who approved it.
--
-- So: the pair moves together; a decided status has it; a REQUESTED row does
-- not; and CANCELLED is deliberately silent, because a leave can be called
-- off either before or after it was granted.
ALTER TABLE "public"."LeaveException"
  ADD CONSTRAINT "LeaveException_decision_pair_check"
  CHECK (
    ("decidedById" IS NULL) = ("decidedAt" IS NULL)
    AND ("status" NOT IN ('APPROVED', 'REJECTED') OR "decidedById" IS NOT NULL)
    AND ("status" <> 'REQUESTED' OR "decidedById" IS NULL)
  );

-- A refusal a student can read. 10 characters is not eloquence; it is more
-- than "no".
--
-- COALESCE is load-bearing, not defensive. `decisionNote` is nullable, and
-- `char_length(btrim(NULL)) >= 10` evaluates to NULL — and A CHECK THAT
-- EVALUATES TO NULL IS SATISFIED. Without it the one row this constraint
-- exists to refuse, a REJECTED leave with no note at all, is the one row it
-- lets through. Found by the refusal test, which is the only thing that
-- reliably finds this (docs/CONVENTIONS.md).
ALTER TABLE "public"."LeaveException"
  ADD CONSTRAINT "LeaveException_rejection_note_check"
  CHECK ("status" <> 'REJECTED' OR COALESCE(char_length(btrim("decisionNote")), 0) >= 10);

-- Never self-approved. The same two-person rule PrivilegedOperation uses: a
-- student cannot excuse their own absence, and neither can the tutor who
-- raised it on their behalf.
ALTER TABLE "public"."LeaveException"
  ADD CONSTRAINT "LeaveException_two_person_check"
  CHECK ("decidedById" IS NULL OR "decidedById" <> "requestedById");

-- One student never holds two overlapping APPROVED leaves. Without this a day
-- could be excluded twice under two kinds and `excludedReason` in the evidence
-- JSON would be whichever row the planner happened to read first.
ALTER TABLE "public"."LeaveException"
  ADD CONSTRAINT "LeaveException_no_overlapping_approved"
  EXCLUDE USING gist (
    "userId" WITH =,
    daterange("startDate", "endDate", '[]') WITH &&
  ) WHERE ("status" = 'APPROVED');

-- ── Immutability ────────────────────────────────────────────────────────

-- A past calendar day is frozen. Phase 8c evidence rows cite these days by
-- date, so an edit to one rewrites the explanation of a decision already
-- taken. Today and the future stay editable: a calendar is planned ahead and
-- revised ahead, which is the whole point of having one.
CREATE OR REPLACE FUNCTION recx_refuse_past_calendar_day_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."date" < current_date THEN
      RAISE EXCEPTION 'CalendarDay_past_immutable: % is in the past; correct history with a retroactive LeaveException', OLD."date"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."date" < current_date OR NEW."date" < current_date THEN
    RAISE EXCEPTION 'CalendarDay_past_immutable: % is in the past; correct history with a retroactive LeaveException', OLD."date"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CalendarDay_past_immutable"
  BEFORE UPDATE OR DELETE ON "public"."CalendarDay"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_past_calendar_day_change();

-- The terms of a leave never change, and its status moves only forwards.
-- Modelled on recx_refuse_granted_accommodation_terms.
--
-- Why the terms and not just the status: a leave approved for three days in
-- October and later widened to three weeks in November would retroactively
-- excuse an absence nobody approved, and the evidence row that cited it would
-- still cite it. Widening a leave means asking again.
CREATE OR REPLACE FUNCTION recx_refuse_leave_terms_change() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."startDate" IS DISTINCT FROM OLD."startDate"
     OR NEW."endDate" IS DISTINCT FROM OLD."endDate"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."evidenceFileId" IS DISTINCT FROM OLD."evidenceFileId"
     OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'LeaveException_terms_immutable: the terms of a leave never change; raise a new request'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" <> NEW."status" THEN
    IF NOT (
      (OLD."status" = 'REQUESTED' AND NEW."status" IN ('APPROVED', 'REJECTED', 'CANCELLED'))
      OR (OLD."status" = 'APPROVED' AND NEW."status" = 'CANCELLED')
    ) THEN
      RAISE EXCEPTION 'LeaveException_terms_immutable: % cannot become %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The decision is written once. A second reviewer overturning the first
  -- silently is how a two-person rule becomes a one-person rule.
  IF OLD."decidedById" IS NOT NULL AND NEW."decidedById" IS DISTINCT FROM OLD."decidedById" THEN
    RAISE EXCEPTION 'LeaveException_terms_immutable: the decider is set once'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."decidedAt" IS NOT NULL AND NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt" THEN
    RAISE EXCEPTION 'LeaveException_terms_immutable: the decision time is set once'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LeaveException_terms_immutable"
  BEFORE UPDATE ON "public"."LeaveException"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_leave_terms_change();

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
CREATE TRIGGER "CalendarDay_no_truncate"
  BEFORE TRUNCATE ON "public"."CalendarDay"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "LeaveException_no_truncate"
  BEFORE TRUNCATE ON "public"."LeaveException"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
