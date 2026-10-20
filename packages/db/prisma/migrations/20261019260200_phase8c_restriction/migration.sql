-- Phase 8c: the restriction, and the append-only history of why.
--
-- SPEC §5: "a disputed lockout must be explainable months later." Everything
-- in this file serves that one sentence. An AccountStatusEvent cannot exist
-- without the evidence it was decided on; the history is append-only; the
-- policy version it cites is immutable. Without those, "the system disabled
-- me" is unanswerable, and that is the failure mode that destroys trust in a
-- placement platform.
--
-- ── WHY `source` EXISTS ────────────────────────────────────────────────
-- The two restoration paths the spec requires — a solved problem clearing a
-- restriction, and a retroactive leave reversing one — are stage moves with
-- no human actor. Without a source column they would both be "system" rows:
-- forced to manufacture sweep evidence inside a submission transaction, and
-- colliding with the sweep's own row on the per-day unique index. Marked
-- manual instead they would fail the actor and typed-reason CHECKs. So the
-- design was unwritable until `source` existed, and every constraint below
-- is scoped to the sources it is actually about rather than to the blunt
-- `triggeredBySystem` flag.

-- CreateEnum
CREATE TYPE "public"."AccountStatusSource" AS ENUM ('INACTIVITY_SWEEP', 'AUTO_CLEAR_ON_SOLVE', 'SELF_CLEAR', 'LEAVE_REVERSAL', 'MANUAL_ADMIN', 'MANUAL_SUPER');

-- CreateTable
CREATE TABLE "public"."AccountRestriction" (
    "userId" TEXT NOT NULL,
    "stage" "public"."RestrictionStage" NOT NULL DEFAULT 'NONE',
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graceEndsAt" TIMESTAMP(3),
    "countedInactiveDays" INTEGER NOT NULL DEFAULT 0,
    "lastEvaluatedAt" TIMESTAMP(3),
    "policyVersion" INTEGER,
    "selfClearedCount" INTEGER NOT NULL DEFAULT 0,
    "selfClearedTermKey" TEXT,
    "ownsAccountStatus" BOOLEAN NOT NULL DEFAULT false,
    "adminReviewOpenedAt" TIMESTAMP(3),
    "adminReviewClearedAt" TIMESTAMP(3),

    CONSTRAINT "AccountRestriction_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "public"."AccountStatusEvent" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "fromStage" "public"."RestrictionStage" NOT NULL,
    "toStage" "public"."RestrictionStage" NOT NULL,
    "fromStatus" "public"."AccountStatus" NOT NULL,
    "toStatus" "public"."AccountStatus" NOT NULL,
    "source" "public"."AccountStatusSource" NOT NULL,
    "policyVersion" INTEGER,
    "evidence" JSONB NOT NULL,
    "triggeredBySystem" BOOLEAN NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "evaluationDate" DATE,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccountRestriction_stage_stageEnteredAt_idx" ON "public"."AccountRestriction"("stage", "stageEnteredAt");

-- CreateIndex
CREATE INDEX "AccountRestriction_lastEvaluatedAt_idx" ON "public"."AccountRestriction"("lastEvaluatedAt");

-- CreateIndex
CREATE INDEX "AccountRestriction_adminReviewOpenedAt_idx" ON "public"."AccountRestriction"("adminReviewOpenedAt");

-- CreateIndex
CREATE INDEX "AccountStatusEvent_userId_createdAt_idx" ON "public"."AccountStatusEvent"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AccountStatusEvent_toStage_createdAt_idx" ON "public"."AccountStatusEvent"("toStage", "createdAt");

-- CreateIndex
CREATE INDEX "AccountStatusEvent_source_createdAt_idx" ON "public"."AccountStatusEvent"("source", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."AccountRestriction" ADD CONSTRAINT "AccountRestriction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AccountRestriction" ADD CONSTRAINT "AccountRestriction_policyVersion_fkey" FOREIGN KEY ("policyVersion") REFERENCES "public"."InactivityPolicy"("version") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AccountStatusEvent" ADD CONSTRAINT "AccountStatusEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AccountStatusEvent" ADD CONSTRAINT "AccountStatusEvent_policyVersion_fkey" FOREIGN KEY ("policyVersion") REFERENCES "public"."InactivityPolicy"("version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Invariants: AccountRestriction ──────────────────────────────────────

ALTER TABLE "public"."AccountRestriction"
  ADD CONSTRAINT "AccountRestriction_counted_check"
  CHECK ("countedInactiveDays" >= 0);

-- The self-service count and the term it belongs to move together, so a
-- count with no term is a reset nobody can date.
ALTER TABLE "public"."AccountRestriction"
  ADD CONSTRAINT "AccountRestriction_self_cleared_check"
  CHECK (
    "selfClearedCount" BETWEEN 0 AND 8
    AND ("selfClearedCount" = 0) = ("selfClearedTermKey" IS NULL)
  );

ALTER TABLE "public"."AccountRestriction"
  ADD CONSTRAINT "AccountRestriction_grace_check"
  CHECK ("graceEndsAt" IS NULL OR "graceEndsAt" >= "stageEnteredAt");

-- A student at NONE has nothing counted and no grace window. Otherwise a
-- cleared account would keep rendering a dormancy countdown.
ALTER TABLE "public"."AccountRestriction"
  ADD CONSTRAINT "AccountRestriction_none_check"
  CHECK ("stage" <> 'NONE' OR ("countedInactiveDays" = 0 AND "graceEndsAt" IS NULL));

-- The engine claims `User.status` only at the two rungs that actually move
-- it. A NONE row that still claimed ownership would let a later clear
-- un-suspend an account a human suspended for something else entirely.
ALTER TABLE "public"."AccountRestriction"
  ADD CONSTRAINT "AccountRestriction_owns_status_check"
  CHECK (NOT "ownsAccountStatus" OR "stage" IN ('SOFT_RESTRICTED', 'DISABLED'));

ALTER TABLE "public"."AccountRestriction"
  ADD CONSTRAINT "AccountRestriction_review_check"
  CHECK (
    "adminReviewClearedAt" IS NULL
    OR ("adminReviewOpenedAt" IS NOT NULL AND "adminReviewClearedAt" >= "adminReviewOpenedAt")
  );

-- ── Invariants: AccountStatusEvent ──────────────────────────────────────

-- No no-op rows: a history of entries where nothing changed is a history
-- nobody can read.
ALTER TABLE "public"."AccountStatusEvent"
  ADD CONSTRAINT "AccountStatusEvent_change_check"
  CHECK ("fromStage" <> "toStage" OR "fromStatus" <> "toStatus");

-- Always an object, whatever the source. The eight-key list below applies to
-- the sweep; every other source still has to say something.
ALTER TABLE "public"."AccountStatusEvent"
  ADD CONSTRAINT "AccountStatusEvent_evidence_object_check"
  CHECK (jsonb_typeof("evidence") = 'object');

-- A system row has no actor and a human row always has one — and which
-- sources are "system" is stated rather than left to whoever sets the flag.
-- SELF_CLEAR carries the student as its actor, which is true and is what
-- their own history should show.
ALTER TABLE "public"."AccountStatusEvent"
  ADD CONSTRAINT "AccountStatusEvent_actor_check"
  CHECK (
    "triggeredBySystem" = ("actorId" IS NULL)
    AND "triggeredBySystem" = ("source" IN ('INACTIVITY_SWEEP', 'AUTO_CLEAR_ON_SOLVE', 'LEAVE_REVERSAL'))
  );

-- "Hard disable is otherwise only ever a manual, REASONED, audit-logged
-- admin action." A student clicking one button types no reason; a staff
-- member changing somebody else's status always does.
--
-- COALESCE because `reason` is nullable: char_length(NULL) >= 10 is NULL,
-- and a CHECK that evaluates to NULL is satisfied — so without it the row
-- this exists to refuse is the one it lets through.
ALTER TABLE "public"."AccountStatusEvent"
  ADD CONSTRAINT "AccountStatusEvent_manual_reason_check"
  CHECK (
    "source" NOT IN ('MANUAL_ADMIN', 'MANUAL_SUPER')
    OR COALESCE(char_length(btrim("reason")), 0) >= 10
  );

-- Only the sweep has a policy version and an evaluation window to cite, and
-- it must cite both.
ALTER TABLE "public"."AccountStatusEvent"
  ADD CONSTRAINT "AccountStatusEvent_system_policy_check"
  CHECK (
    "source" <> 'INACTIVITY_SWEEP'
    OR ("policyVersion" IS NOT NULL AND "evaluationDate" IS NOT NULL)
  );

ALTER TABLE "public"."AccountStatusEvent"
  ADD CONSTRAINT "AccountStatusEvent_evaluation_date_check"
  CHECK (("evaluationDate" IS NOT NULL) = ("source" = 'INACTIVITY_SWEEP'));

-- THE LOAD-BEARING CONSTRAINT OF THE PHASE. A sweep transition cannot be
-- recorded without the explanation a disputed lockout needs months later:
-- what the student's last activity was, how many calendar days passed, how
-- many counted, which days were excluded and why, the threshold crossed, the
-- policy version and the moment it was evaluated.
--
-- `inactivityEvidenceSchema` in @recx/shared mirrors this list, and a test
-- parses THIS array out of THIS file and asserts the two are the same set —
-- so the database constraint and the zod schema are provably one list.
ALTER TABLE "public"."AccountStatusEvent"
  ADD CONSTRAINT "AccountStatusEvent_system_evidence_check"
  CHECK (
    "source" <> 'INACTIVITY_SWEEP'
    OR (
      "evidence" ?& array['lastActiveAt', 'calendarDaysElapsed', 'countedInactiveDays', 'excludedDates', 'excludedReason', 'thresholdDays', 'policyVersion', 'evaluatedAt']
      AND jsonb_typeof("evidence" -> 'excludedDates') = 'array'
      AND jsonb_typeof("evidence" -> 'excludedReason') = 'array'
      AND jsonb_array_length("evidence" -> 'excludedDates') = jsonb_array_length("evidence" -> 'excludedReason')
    )
  );

-- A restoration explains itself too: what cleared it (a problem id, the word
-- `self`, or a leave id) and when. A reversal nobody can trace is as much of
-- a problem as a restriction nobody can trace, because the question "why is
-- this student not restricted?" is also asked.
ALTER TABLE "public"."AccountStatusEvent"
  ADD CONSTRAINT "AccountStatusEvent_clear_evidence_check"
  CHECK (
    "source" NOT IN ('AUTO_CLEAR_ON_SOLVE', 'SELF_CLEAR', 'LEAVE_REVERSAL')
    OR "evidence" ?& array['clearedBy', 'clearedAt']
  );

-- "DISABLED → ACTIVE is Super-admin only." A department ADMIN cannot reopen
-- a closed account by any path, and neither can a clear-on-solve or a
-- self-clear. The two sources that may are a super-admin acting by hand and
-- a retroactive leave that proves the count was wrong.
ALTER TABLE "public"."AccountStatusEvent"
  ADD CONSTRAINT "AccountStatusEvent_undisable_check"
  CHECK (
    ("fromStage"::text <> 'DISABLED' AND "fromStatus"::text <> 'DISABLED')
    OR "source" IN ('MANUAL_SUPER', 'LEAVE_REVERSAL')
  );

-- Idempotence per campus day, for the sweep ONLY. A second run on the same
-- day is a unique violation on one row rather than a second transition for
-- the whole cohort — and because the index is scoped to the sweep, a student
-- escalated at 02:00 who solves a problem at 09:00 gets both rows, which is
-- the history that actually happened.
CREATE UNIQUE INDEX "AccountStatusEvent_sweep_once_per_day"
  ON "public"."AccountStatusEvent" ("userId", "evaluationDate")
  WHERE "source" = 'INACTIVITY_SWEEP';

-- ── Guards ──────────────────────────────────────────────────────────────

-- Append-only, the same shape as recx_refuse_xp_event_change. `notifiedAt`
-- moves from NULL to a value exactly once, because the job has to record
-- that it told somebody; nothing else ever changes, and nothing is deleted.
CREATE OR REPLACE FUNCTION recx_refuse_account_status_event_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AccountStatusEvent_append_only: the status history is never deleted'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."notifiedAt" IS NULL AND NEW."notifiedAt" IS NOT NULL THEN
    -- The one permitted update. Everything else must be unchanged.
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."fromStage" IS DISTINCT FROM OLD."fromStage"
       OR NEW."toStage" IS DISTINCT FROM OLD."toStage"
       OR NEW."fromStatus" IS DISTINCT FROM OLD."fromStatus"
       OR NEW."toStatus" IS DISTINCT FROM OLD."toStatus"
       OR NEW."source" IS DISTINCT FROM OLD."source"
       OR NEW."policyVersion" IS DISTINCT FROM OLD."policyVersion"
       OR NEW."evidence" IS DISTINCT FROM OLD."evidence"
       OR NEW."triggeredBySystem" IS DISTINCT FROM OLD."triggeredBySystem"
       OR NEW."actorId" IS DISTINCT FROM OLD."actorId"
       OR NEW."reason" IS DISTINCT FROM OLD."reason"
       OR NEW."evaluationDate" IS DISTINCT FROM OLD."evaluationDate"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    THEN
      RAISE EXCEPTION 'AccountStatusEvent_append_only: only notifiedAt may be set, and nothing else with it'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'AccountStatusEvent_append_only: this history is append-only (notifiedAt is set once)'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AccountStatusEvent_append_only"
  BEFORE UPDATE OR DELETE ON "public"."AccountStatusEvent"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_account_status_event_change();

-- §0's "no account is hard-disabled by a cron job", expressed where no code
-- path can route around it.
--
-- A sweep row reaching DISABLED is refused unless the InactivityPolicy
-- version it cites has autoDisableEnabled = true. With the shipped default
-- (false), the DATABASE refuses the row — a future job, a future migration
-- and a future psql session all hit the same refusal. A code-path check
-- would be one refactor away from untrue.
CREATE OR REPLACE FUNCTION recx_refuse_system_disable() RETURNS trigger AS $$
BEGIN
  IF NEW."source" <> 'INACTIVITY_SWEEP' THEN
    RETURN NEW;
  END IF;
  IF NEW."toStage"::text <> 'DISABLED' AND NEW."toStatus"::text <> 'DISABLED' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "public"."InactivityPolicy" p
     WHERE p."version" = NEW."policyVersion" AND p."autoDisableEnabled"
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AccountStatusEvent_system_disable_opt_in: policy version % does not permit automatic disabling', NEW."policyVersion"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AccountStatusEvent_system_disable_opt_in"
  BEFORE INSERT ON "public"."AccountStatusEvent"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_system_disable();

-- At most one rung per transition. A drop straight to NONE is always allowed,
-- because a restoration is not a penalty and is never rate-limited; an
-- escalation moves exactly one step. Nobody reaches DISABLED from NONE, even
-- by raw SQL.
--
-- A row where the stage does NOT move is allowed, and that is not a loophole:
-- `AccountStatusEvent_change_check` already requires something to have
-- changed, so such a row is one where only `User.status` moved — an admin
-- taking an already-WARNED student off the board at their own request, say.
-- Refusing it would mean the only way to record a status change was to invent
-- a stage change that did not happen.
CREATE OR REPLACE FUNCTION recx_refuse_stage_jump() RETURNS trigger AS $$
DECLARE
  ladder text[] := ARRAY['NONE', 'NUDGED', 'WARNED', 'SOFT_RESTRICTED', 'DISABLED'];
  from_index integer;
  to_index integer;
BEGIN
  IF NEW."toStage"::text = 'NONE' OR NEW."toStage" = NEW."fromStage" THEN
    RETURN NEW;
  END IF;
  from_index := array_position(ladder, NEW."fromStage"::text);
  to_index := array_position(ladder, NEW."toStage"::text);
  IF from_index IS NULL OR to_index IS NULL THEN
    RAISE EXCEPTION 'AccountStatusEvent_single_step: unknown stage (% -> %)', NEW."fromStage", NEW."toStage"
      USING ERRCODE = 'check_violation';
  END IF;
  IF abs(to_index - from_index) <> 1 THEN
    RAISE EXCEPTION 'AccountStatusEvent_single_step: % -> % is not one rung', NEW."fromStage", NEW."toStage"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AccountStatusEvent_single_step"
  BEFORE INSERT ON "public"."AccountStatusEvent"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_stage_jump();

-- Never sweep a student who is sitting an assessment right now. The spec
-- repeats this as an anti-requirement, and the reason governs the phase:
-- locking a student out of a graded assessment because they were ill is a
-- worse failure than under-enforcing.
--
-- A CLEAR during an attempt is a kindness, not a sweep, so only escalations
-- are refused.
CREATE OR REPLACE FUNCTION recx_refuse_sweep_with_open_attempt() RETURNS trigger AS $$
DECLARE
  ladder text[] := ARRAY['NONE', 'NUDGED', 'WARNED', 'SOFT_RESTRICTED', 'DISABLED'];
BEGIN
  IF NEW."source" <> 'INACTIVITY_SWEEP' THEN
    RETURN NEW;
  END IF;
  IF array_position(ladder, NEW."toStage"::text) <= array_position(ladder, NEW."fromStage"::text) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "public"."AssessmentAttempt" a
     WHERE a."userId" = NEW."userId" AND a."status" IN ('IN_PROGRESS', 'DISCONNECTED')
  ) THEN
    RAISE EXCEPTION 'AccountStatusEvent_no_sweep_mid_attempt: % is sitting an assessment', NEW."userId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AccountStatusEvent_no_sweep_mid_attempt"
  BEFORE INSERT ON "public"."AccountStatusEvent"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_sweep_with_open_attempt();

-- A stage never moves without an event explaining it, whichever path moved
-- it. DEFERRED so the two rows can be written in either order inside one
-- transaction — but at COMMIT the explanation must be there.
--
-- This is what makes "every automatic decision carries its evidence" true of
-- the STATE and not only of the history: a stage set by hand in psql, with
-- no event, does not commit.
CREATE OR REPLACE FUNCTION recx_refuse_restriction_without_event() RETURNS trigger AS $$
BEGIN
  IF NEW."stage" = 'NONE' AND NEW."countedInactiveDays" = 0 AND TG_OP = 'INSERT' THEN
    -- A fresh row at NONE is the absence of a restriction, not a decision.
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."AccountStatusEvent" e
     WHERE e."userId" = NEW."userId"
       AND e."toStage" = NEW."stage"
       AND e."createdAt" >= NEW."stageEnteredAt"
  ) THEN
    RAISE EXCEPTION 'AccountRestriction_requires_event: stage % for % has no AccountStatusEvent explaining it', NEW."stage", NEW."userId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "AccountRestriction_requires_event"
  AFTER INSERT OR UPDATE OF "stage" ON "public"."AccountRestriction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_restriction_without_event();

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
CREATE TRIGGER "AccountRestriction_no_truncate"
  BEFORE TRUNCATE ON "public"."AccountRestriction"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "AccountStatusEvent_no_truncate"
  BEFORE TRUNCATE ON "public"."AccountStatusEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
