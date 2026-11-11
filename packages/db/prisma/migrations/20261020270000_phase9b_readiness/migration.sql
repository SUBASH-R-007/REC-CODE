-- Phase 9b: readiness snapshots, and the named mentor.
--
-- SPEC §5: readiness is "a preparation-coverage measure, explicitly not a
-- prediction of being placed", computed nightly and RETAINING the component
-- breakdown. The breakdown is the whole point — a disputed number has to be
-- recomputable years later from the stored components and the rules version
-- that produced them, or "the platform said I was not ready" is unanswerable
-- in exactly the way a Phase 8 lockout would have been.
--
-- Three constraints below are the phase's honesty argument expressed in the
-- data rather than in a code review:
--
--   * `score <= availableWeight` — a renormalised or zero-filled score is
--     not storable. With mockInterviewScore unsourced, no TOP score may
--     exceed 85, and a row claiming 95 is refused.
--   * `(availableWeight = 0) = (score IS NULL)` — a tier with nothing
--     measurable has NO score, not a zero. "Show missing components as
--     missing, never silently as zero", in the column definition.
--   * a breadth value always names the topic that limited it, so the
--     minimum is checkable rather than asserted.

-- CreateTable
CREATE TABLE "public"."ReadinessRun" (
    "computedOn" DATE NOT NULL,
    "rulesVersion" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "studentsEvaluated" INTEGER NOT NULL DEFAULT 0,
    "cohortStats" JSONB NOT NULL DEFAULT '{}',
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "ReadinessRun_pkey" PRIMARY KEY ("computedOn")
);

-- CreateTable
CREATE TABLE "public"."ReadinessSnapshot" (
    "userId" TEXT NOT NULL,
    "computedOn" DATE NOT NULL,
    "rulesVersion" INTEGER NOT NULL,
    "cohortKey" TEXT NOT NULL,
    "cohortSize" INTEGER NOT NULL,
    "batchYear" INTEGER,
    "departmentCode" TEXT,
    "section" TEXT,
    "serviceScore" INTEGER,
    "productScore" INTEGER,
    "topScore" INTEGER,
    "serviceAvailableWeight" INTEGER NOT NULL DEFAULT 0,
    "productAvailableWeight" INTEGER NOT NULL DEFAULT 0,
    "topAvailableWeight" INTEGER NOT NULL DEFAULT 0,
    "topicBreadthProduct" INTEGER,
    "topicBreadthTop" INTEGER,
    "limitingTopicProduct" "public"."Topic",
    "limitingTopicTop" "public"."Topic",
    "components" JSONB NOT NULL,
    "topicUnassisted" JSONB NOT NULL,
    "lastActiveOn" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "public"."MentorAssignment" (
    "id" TEXT NOT NULL,
    "menteeId" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,

    CONSTRAINT "MentorAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReadinessRun_ok_computedOn_idx" ON "public"."ReadinessRun"("ok", "computedOn" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ReadinessSnapshot_userId_computedOn_key" ON "public"."ReadinessSnapshot"("userId", "computedOn");

-- CreateIndex
CREATE INDEX "ReadinessSnapshot_computedOn_departmentCode_batchYear_secti_idx" ON "public"."ReadinessSnapshot"("computedOn", "departmentCode", "batchYear", "section");

-- CreateIndex
CREATE INDEX "ReadinessSnapshot_computedOn_serviceScore_idx" ON "public"."ReadinessSnapshot"("computedOn", "serviceScore");

-- CreateIndex
CREATE INDEX "ReadinessSnapshot_computedOn_productScore_idx" ON "public"."ReadinessSnapshot"("computedOn", "productScore");

-- CreateIndex
CREATE INDEX "ReadinessSnapshot_computedOn_topScore_idx" ON "public"."ReadinessSnapshot"("computedOn", "topScore");

-- CreateIndex
CREATE INDEX "ReadinessSnapshot_computedOn_lastActiveOn_idx" ON "public"."ReadinessSnapshot"("computedOn", "lastActiveOn");

-- CreateIndex
CREATE INDEX "ReadinessSnapshot_userId_computedOn_idx" ON "public"."ReadinessSnapshot"("userId", "computedOn" DESC);

-- CreateIndex
CREATE INDEX "MentorAssignment_mentorId_endedAt_idx" ON "public"."MentorAssignment"("mentorId", "endedAt");

-- CreateIndex
CREATE INDEX "MentorAssignment_menteeId_endedAt_idx" ON "public"."MentorAssignment"("menteeId", "endedAt");

-- AddForeignKey
ALTER TABLE "public"."ReadinessSnapshot" ADD CONSTRAINT "ReadinessSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- A snapshot cannot exist for a run that was never recorded. RESTRICT rather
-- than CASCADE: the run row is the record of HOW a cohort's numbers were
-- produced, and deleting it would orphan every explanation at once.
ALTER TABLE "public"."ReadinessSnapshot" ADD CONSTRAINT "ReadinessSnapshot_computedOn_fkey" FOREIGN KEY ("computedOn") REFERENCES "public"."ReadinessRun"("computedOn") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MentorAssignment" ADD CONSTRAINT "MentorAssignment_menteeId_fkey" FOREIGN KEY ("menteeId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MentorAssignment" ADD CONSTRAINT "MentorAssignment_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Invariants: ReadinessRun ────────────────────────────────────────────

ALTER TABLE "public"."ReadinessRun"
  ADD CONSTRAINT "ReadinessRun_window_check"
  CHECK ("finishedAt" IS NULL OR "finishedAt" >= "startedAt");

-- A run that says it worked has finished. One that says ok with no finish
-- time is a run nobody can put in order against the next one.
ALTER TABLE "public"."ReadinessRun"
  ADD CONSTRAINT "ReadinessRun_ok_check"
  CHECK (NOT "ok" OR "finishedAt" IS NOT NULL);

ALTER TABLE "public"."ReadinessRun"
  ADD CONSTRAINT "ReadinessRun_version_check"
  CHECK ("rulesVersion" > 0 AND "studentsEvaluated" >= 0);

ALTER TABLE "public"."ReadinessRun"
  ADD CONSTRAINT "ReadinessRun_stats_check"
  CHECK (jsonb_typeof("cohortStats") = 'object');

-- ── Invariants: ReadinessSnapshot ───────────────────────────────────────

ALTER TABLE "public"."ReadinessSnapshot"
  ADD CONSTRAINT "ReadinessSnapshot_score_range"
  CHECK (
    COALESCE("serviceScore" BETWEEN 0 AND 100, true)
    AND COALESCE("productScore" BETWEEN 0 AND 100, true)
    AND COALESCE("topScore" BETWEEN 0 AND 100, true)
  );

ALTER TABLE "public"."ReadinessSnapshot"
  ADD CONSTRAINT "ReadinessSnapshot_weight_range"
  CHECK (
    "serviceAvailableWeight" BETWEEN 0 AND 100
    AND "productAvailableWeight" BETWEEN 0 AND 100
    AND "topAvailableWeight" BETWEEN 0 AND 100
  );

-- THE HONESTY CONSTRAINT. A score may never exceed the weight that was
-- actually measurable, so a renormalised or zero-filled score is not
-- storable. With `mockInterviewScore` unsourced in this plan, no TOP score
-- may exceed 85 — and a row claiming 95 is refused rather than quietly
-- making a student with no interview practice look as ready as one with
-- five.
--
-- Every comparison COALESCE'd: a NULL score makes the comparison NULL, and a
-- CHECK that evaluates to NULL is satisfied.
ALTER TABLE "public"."ReadinessSnapshot"
  ADD CONSTRAINT "ReadinessSnapshot_score_le_available"
  CHECK (
    COALESCE("serviceScore" <= "serviceAvailableWeight", true)
    AND COALESCE("productScore" <= "productAvailableWeight", true)
    AND COALESCE("topScore" <= "topAvailableWeight", true)
  );

-- "Show missing components as missing, never silently as zero", in the
-- column definition: a tier with nothing measurable has NO score, and a
-- tier with something measurable always has one.
ALTER TABLE "public"."ReadinessSnapshot"
  ADD CONSTRAINT "ReadinessSnapshot_null_when_unmeasurable"
  CHECK (
    ("serviceAvailableWeight" = 0) = ("serviceScore" IS NULL)
    AND ("productAvailableWeight" = 0) = ("productScore" IS NULL)
    AND ("topAvailableWeight" = 0) = ("topScore" IS NULL)
  );

ALTER TABLE "public"."ReadinessSnapshot"
  ADD CONSTRAINT "ReadinessSnapshot_breadth_range"
  CHECK (
    COALESCE("topicBreadthProduct" BETWEEN 0 AND 100, true)
    AND COALESCE("topicBreadthTop" BETWEEN 0 AND 100, true)
  );

-- A breadth value always names the topic that limited it, so the MINIMUM is
-- checkable rather than asserted. A number with no argmin beside it is a
-- number nobody can act on or dispute.
ALTER TABLE "public"."ReadinessSnapshot"
  ADD CONSTRAINT "ReadinessSnapshot_breadth_pairs"
  CHECK (
    ("topicBreadthProduct" IS NULL) = ("limitingTopicProduct" IS NULL)
    AND ("topicBreadthTop" IS NULL) = ("limitingTopicTop" IS NULL)
  );

ALTER TABLE "public"."ReadinessSnapshot"
  ADD CONSTRAINT "ReadinessSnapshot_cohort_check"
  CHECK ("cohortSize" >= 0 AND char_length(btrim("cohortKey")) > 0 AND "rulesVersion" > 0);

ALTER TABLE "public"."ReadinessSnapshot"
  ADD CONSTRAINT "ReadinessSnapshot_components_object"
  CHECK (jsonb_typeof("components") = 'object' AND jsonb_typeof("topicUnassisted") = 'object');

-- ── Invariants: MentorAssignment ────────────────────────────────────────

ALTER TABLE "public"."MentorAssignment"
  ADD CONSTRAINT "MentorAssignment_not_self"
  CHECK ("menteeId" <> "mentorId");

ALTER TABLE "public"."MentorAssignment"
  ADD CONSTRAINT "MentorAssignment_end_pair"
  CHECK (("endedAt" IS NULL) = ("endedById" IS NULL));

ALTER TABLE "public"."MentorAssignment"
  ADD CONSTRAINT "MentorAssignment_reason_check"
  CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500);

-- Exactly one LIVE mentor per mentee. The at-risk list routes to a named
-- human, so two live mentors is not a representable state: a list that
-- routed to both would have each of them assume the other had spoken to the
-- student.
CREATE UNIQUE INDEX "MentorAssignment_one_active_per_mentee"
  ON "public"."MentorAssignment" ("menteeId")
  WHERE "endedAt" IS NULL;

-- ── Guards ──────────────────────────────────────────────────────────────

-- A snapshot is RECOMPUTED, never edited.
--
-- The nightly job is idempotent per (userId, computedOn), so a rerun of the
-- same campus day may overwrite the computed columns — that is a recompute
-- under the same or a newer rules version. What it may never do is move the
-- row to another student or another day, or claim an older rules version
-- than the one already stored: a row whose `rulesVersion` went backwards
-- would be a row whose stored components no longer explain its score.
CREATE OR REPLACE FUNCTION recx_refuse_snapshot_identity_change() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."computedOn" IS DISTINCT FROM OLD."computedOn" THEN
    RAISE EXCEPTION 'ReadinessSnapshot_recompute_only: a snapshot belongs to one student and one day'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."rulesVersion" < OLD."rulesVersion" THEN
    RAISE EXCEPTION 'ReadinessSnapshot_recompute_only: rulesVersion cannot go backwards (% -> %)', OLD."rulesVersion", NEW."rulesVersion"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ReadinessSnapshot_recompute_only: createdAt is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReadinessSnapshot_recompute_only"
  BEFORE UPDATE ON "public"."ReadinessSnapshot"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_snapshot_identity_change();

-- An assignment's terms never change, it ends once, and it is never deleted.
-- Re-assigning is an end plus a new row, so the history of who was asked to
-- speak to a student survives the re-assignment.
CREATE OR REPLACE FUNCTION recx_refuse_mentor_assignment_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'MentorAssignment_immutable: an assignment is ended, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."menteeId" IS DISTINCT FROM OLD."menteeId"
     OR NEW."mentorId" IS DISTINCT FROM OLD."mentorId"
     OR NEW."assignedById" IS DISTINCT FROM OLD."assignedById"
     OR NEW."assignedAt" IS DISTINCT FROM OLD."assignedAt"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
  THEN
    RAISE EXCEPTION 'MentorAssignment_immutable: the terms never change; end it and assign again'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."endedAt" IS NOT NULL AND NEW."endedAt" IS DISTINCT FROM OLD."endedAt" THEN
    RAISE EXCEPTION 'MentorAssignment_immutable: an assignment ends once'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MentorAssignment_immutable"
  BEFORE UPDATE OR DELETE ON "public"."MentorAssignment"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_mentor_assignment_change();

-- A PLACEMENT_OFFICER may never be the mentor of record, and neither may a
-- student.
--
-- SPEC §5: "The at-risk list routes to a named mentor for a conversation,
-- never an automated email." The whole purpose of that routing is to move a
-- student AWAY from the analytics surface and towards a person who teaches
-- them — so the person it routes to must not be the one reading the
-- dashboard. FOR SHARE on the mentor's row, the concurrency pattern
-- migration 20261010100200 established for Accommodation: without it a role
-- change committing concurrently could slip past the check.
CREATE OR REPLACE FUNCTION recx_refuse_unsuitable_mentor() RETURNS trigger AS $$
DECLARE
  mentor_role text;
BEGIN
  SELECT u."role"::text INTO mentor_role
    FROM "public"."User" u WHERE u."id" = NEW."mentorId" FOR SHARE;
  IF mentor_role IS NULL THEN
    RAISE EXCEPTION 'MentorAssignment_mentor_is_not_student_or_officer: no such mentor'
      USING ERRCODE = 'check_violation';
  END IF;
  IF mentor_role IN ('STUDENT', 'PLACEMENT_OFFICER') THEN
    RAISE EXCEPTION 'MentorAssignment_mentor_is_not_student_or_officer: a % cannot be the mentor of record', mentor_role
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MentorAssignment_mentor_is_not_student_or_officer"
  BEFORE INSERT OR UPDATE OF "mentorId" ON "public"."MentorAssignment"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_unsuitable_mentor();

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
CREATE TRIGGER "ReadinessRun_no_truncate"
  BEFORE TRUNCATE ON "public"."ReadinessRun"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "ReadinessSnapshot_no_truncate"
  BEFORE TRUNCATE ON "public"."ReadinessSnapshot"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "MentorAssignment_no_truncate"
  BEFORE TRUNCATE ON "public"."MentorAssignment"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

-- The per-difficulty unassisted counts the readiness job reads in ONE
-- grouped pass over the whole college (resolution R-U3). UserStats carries
-- only a single `assistedSolves` scalar, so the per-difficulty split needs
-- UserProblemStatus joined to Problem — one sequential scan rather than
-- 5,000 queries, and this index is what keeps it to the solved rows.
CREATE INDEX "UserProblemStatus_status_idx" ON "public"."UserProblemStatus"("status");
