-- AlterTable
ALTER TABLE "public"."Assessment" ALTER COLUMN "proctorMode" SET DEFAULT 'ADVISORY';

-- Phase 12a: an assessment is always proctored.
--
-- The mode was never read by the engine (the Phase 11b audit): a NONE
-- assessment collected the same client signals, triaged them the same way
-- and could flag and withhold a result exactly as any other — so the mode
-- told a student nobody was watching while the product watched. Collecting
-- nothing instead would leave a sitting that counts for something with no
-- record of how it went, so the honest fix is the other one.
--
-- NOTE for a database that already holds a NONE assessment: this migration
-- will fail, and should. It does not rewrite those rows. A published
-- assessment's terms are what its candidates were told, and
-- `Assessment_published_immutable` exists to keep them that way; a migration
-- that disabled a guard to move them would be the one kind of change this
-- repository refuses to make quietly (packages/db/test/frozen-coverage.test.ts
-- fails the build for it). Decide each row by hand — archive it, or move it
-- while it is still a draft — then apply this.
ALTER TABLE "public"."Assessment"
  ADD CONSTRAINT "Assessment_proctored_check"
  CHECK ("proctorMode" <> 'NONE');
