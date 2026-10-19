-- Phase 8b: the inactivity policy, versioned and immutable.
--
-- SPEC §5: "Every threshold is a Super-admin-configurable, audit-logged
-- setting rather than a constant, so the policy can be tightened without a
-- deploy." The numbers therefore live in rows rather than in code — and
-- because a Phase 8c AccountStatusEvent cites the version it was decided
-- under, those rows can never be edited. A threshold change writes a new
-- version and the old one stays, so the explanation of a decision taken
-- months ago still reads true.
--
-- NOTE ON WHAT IS **NOT** HERE: there is no numeric floor on
-- `disableAfterDays`. An earlier draft had `>= 14` in this CHECK, justified
-- as refusing a threshold short enough to catch a fortnight's illness. It
-- contradicted the spec clause above three sentences later: a constant in a
-- CHECK is a constant that needs a migration, and the college's own stated
-- wish (five days) would have become unreachable by the one mechanism the
-- spec says must not require a deploy. The fortnight argument lives in
-- `AUTO_DISABLE_FLOOR_REASON` and is shown above the field, where a human
-- reads it and types a confirmation to override it.

-- CreateEnum
CREATE TYPE "public"."RestrictionStage" AS ENUM ('NONE', 'NUDGED', 'WARNED', 'SOFT_RESTRICTED', 'DISABLED');

-- CreateTable
CREATE TABLE "public"."InactivityPolicy" (
    "version" SERIAL NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "batchYear" INTEGER,
    "departmentCode" TEXT,
    "nudgeAfterDays" INTEGER,
    "warnAfterDays" INTEGER,
    "softRestrictAfterDays" INTEGER,
    "disableAfterDays" INTEGER,
    "autoDisableEnabled" BOOLEAN NOT NULL DEFAULT false,
    "graceDays" INTEGER NOT NULL DEFAULT 2,
    "countsAsActivity" JSONB NOT NULL DEFAULT '{"submission":true,"solve":true,"login":false,"lesson":true}',
    "minActivityPerDay" INTEGER NOT NULL DEFAULT 1,
    "excludeNonWorkingDays" BOOLEAN NOT NULL DEFAULT true,
    "excludeApprovedLeave" BOOLEAN NOT NULL DEFAULT true,
    "notifyMentor" BOOLEAN NOT NULL DEFAULT true,
    "notifyParentEmail" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InactivityPolicy_pkey" PRIMARY KEY ("version")
);

-- CreateIndex
CREATE INDEX "InactivityPolicy_isActive_version_idx" ON "public"."InactivityPolicy"("isActive", "version" DESC);

-- ── Invariants ──────────────────────────────────────────────────────────

-- Every non-null threshold is a real number of days, and the non-null ones
-- are non-decreasing up the ladder.
--
-- Every comparison is COALESCE'd to true, which is the point rather than a
-- flourish: a comparison against NULL evaluates to NULL, and A CHECK THAT
-- EVALUATES TO NULL IS SATISFIED. Without the COALESCE a policy with one null
-- rung would skip the whole constraint instead of skipping that rung. The
-- pairs are listed in full (not just adjacent ones) because a null in the
-- middle must not let the rungs either side cross.
ALTER TABLE "public"."InactivityPolicy"
  ADD CONSTRAINT "InactivityPolicy_threshold_order_check"
  CHECK (
    COALESCE("nudgeAfterDays" BETWEEN 1 AND 365, true)
    AND COALESCE("warnAfterDays" BETWEEN 1 AND 365, true)
    AND COALESCE("softRestrictAfterDays" BETWEEN 1 AND 365, true)
    AND COALESCE("disableAfterDays" BETWEEN 1 AND 365, true)
    AND COALESCE("nudgeAfterDays" <= "warnAfterDays", true)
    AND COALESCE("nudgeAfterDays" <= "softRestrictAfterDays", true)
    AND COALESCE("nudgeAfterDays" <= "disableAfterDays", true)
    AND COALESCE("warnAfterDays" <= "softRestrictAfterDays", true)
    AND COALESCE("warnAfterDays" <= "disableAfterDays", true)
    AND COALESCE("softRestrictAfterDays" <= "disableAfterDays", true)
  );

ALTER TABLE "public"."InactivityPolicy"
  ADD CONSTRAINT "InactivityPolicy_grace_check"
  CHECK ("graceDays" BETWEEN 0 AND 30);

ALTER TABLE "public"."InactivityPolicy"
  ADD CONSTRAINT "InactivityPolicy_min_activity_check"
  CHECK ("minActivityPerDay" BETWEEN 1 AND 20);

-- Coherence only: a switch that is on with no threshold is a policy that
-- cannot be evaluated. No floor — see the note at the top of this file.
ALTER TABLE "public"."InactivityPolicy"
  ADD CONSTRAINT "InactivityPolicy_auto_disable_check"
  CHECK (NOT "autoDisableEnabled" OR "disableAfterDays" IS NOT NULL);

ALTER TABLE "public"."InactivityPolicy"
  ADD CONSTRAINT "InactivityPolicy_scope_check"
  CHECK ("departmentCode" IS NULL OR char_length("departmentCode") BETWEEN 2 AND 16);

-- The four keys, each a boolean. A policy whose activity map is missing a key
-- is a policy whose counter would read `undefined` as "does not count", which
-- is the harshest reading arrived at by accident.
ALTER TABLE "public"."InactivityPolicy"
  ADD CONSTRAINT "InactivityPolicy_counts_as_activity_check"
  CHECK (
    jsonb_typeof("countsAsActivity") = 'object'
    AND "countsAsActivity" ?& array['submission', 'solve', 'login', 'lesson']
    AND jsonb_typeof("countsAsActivity" -> 'submission') = 'boolean'
    AND jsonb_typeof("countsAsActivity" -> 'solve') = 'boolean'
    AND jsonb_typeof("countsAsActivity" -> 'login') = 'boolean'
    AND jsonb_typeof("countsAsActivity" -> 'lesson') = 'boolean'
  );

-- The column exists because the spec's field list has it, and the database
-- refuses to let it be true: a parent address is third-party personal data
-- and the consent record it needs is not built in any phase of this plan.
-- Dropped by the migration of whatever phase builds consent, never by a flag
-- flip.
ALTER TABLE "public"."InactivityPolicy"
  ADD CONSTRAINT "InactivityPolicy_parent_email_check"
  CHECK (NOT "notifyParentEmail");

-- At most one ACTIVE policy per scope, with nulls treated as equal, so
-- `resolveInactivityPolicy()` is always single-valued. A plain unique index
-- would treat two global policies as distinct, because NULL <> NULL.
CREATE UNIQUE INDEX "InactivityPolicy_active_scope_key"
  ON "public"."InactivityPolicy" (COALESCE("batchYear", -1), COALESCE("departmentCode", ''))
  WHERE "isActive";

-- ── Immutability ────────────────────────────────────────────────────────

-- Every column except `isActive` is frozen after insert, and DELETE is
-- refused outright.
--
-- A Phase 8c event cites `policyVersion` as the rules it was decided under.
-- If the row it cites could be edited, the evidence would quietly become a
-- lie — the strongest possible version of "the system disabled me and nobody
-- can say why". Retiring a policy is `isActive = false` plus a new version;
-- the old row stays for as long as anything cites it, which is forever.
CREATE OR REPLACE FUNCTION recx_refuse_inactivity_policy_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'InactivityPolicy_version_immutable: version % is cited by the decisions taken under it; deactivate it instead', OLD."version"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."version" IS DISTINCT FROM OLD."version"
     OR NEW."batchYear" IS DISTINCT FROM OLD."batchYear"
     OR NEW."departmentCode" IS DISTINCT FROM OLD."departmentCode"
     OR NEW."nudgeAfterDays" IS DISTINCT FROM OLD."nudgeAfterDays"
     OR NEW."warnAfterDays" IS DISTINCT FROM OLD."warnAfterDays"
     OR NEW."softRestrictAfterDays" IS DISTINCT FROM OLD."softRestrictAfterDays"
     OR NEW."disableAfterDays" IS DISTINCT FROM OLD."disableAfterDays"
     OR NEW."autoDisableEnabled" IS DISTINCT FROM OLD."autoDisableEnabled"
     OR NEW."graceDays" IS DISTINCT FROM OLD."graceDays"
     OR NEW."countsAsActivity" IS DISTINCT FROM OLD."countsAsActivity"
     OR NEW."minActivityPerDay" IS DISTINCT FROM OLD."minActivityPerDay"
     OR NEW."excludeNonWorkingDays" IS DISTINCT FROM OLD."excludeNonWorkingDays"
     OR NEW."excludeApprovedLeave" IS DISTINCT FROM OLD."excludeApprovedLeave"
     OR NEW."notifyMentor" IS DISTINCT FROM OLD."notifyMentor"
     OR NEW."notifyParentEmail" IS DISTINCT FROM OLD."notifyParentEmail"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'InactivityPolicy_version_immutable: a threshold change is a NEW version, not an edit to version %', OLD."version"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "InactivityPolicy_version_immutable"
  BEFORE UPDATE OR DELETE ON "public"."InactivityPolicy"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_inactivity_policy_change();

-- ── TRUNCATE guard ──────────────────────────────────────────────────────
CREATE TRIGGER "InactivityPolicy_no_truncate"
  BEFORE TRUNCATE ON "public"."InactivityPolicy"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
