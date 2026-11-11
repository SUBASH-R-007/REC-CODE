-- Phase 6c: the per-assessment randomisation secret.
--
-- SPEC §5: "seed = HMAC-SHA256(assessment.secret, attemptId), feeding
-- xoshiro128**." Per assessment rather than platform-wide, so one leaked
-- secret cannot be used to precompute papers for every assessment in the
-- college. It is never sent to a client, never logged and never written to an
-- audit row.
--
-- The default exists so the column can be NOT NULL without a backfill step;
-- gen_random_uuid() is built in from PostgreSQL 13. Application code still
-- sets it explicitly on create, so the value does not depend on the database
-- default surviving a future migration.
ALTER TABLE "public"."Assessment"
  ADD COLUMN "seedSecret" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  ADD CONSTRAINT "Assessment_seed_secret_check" CHECK (length("seedSecret") >= 16);
