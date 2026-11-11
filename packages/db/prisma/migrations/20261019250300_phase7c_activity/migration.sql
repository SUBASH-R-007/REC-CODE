-- Phase 7c: aptitude counts as activity.
--
-- SPEC Phase 8's nightly job takes its candidate set from User
-- [status, lastActiveAt] and counts "days with a qualifying ActivityDay". With
-- no row, a student who practises aptitude every day and nothing else shows an
-- empty heatmap, a zero streak, and is swept toward SOFT_RESTRICTED by a
-- policy engine that cannot see them. Two counters, so that policy can count
-- them when it is designed.
--
-- What this does NOT do is advance the streak. The spec's own countsAsActivity
-- default has no aptitude key, and inventing one here would be inventing
-- Phase 8's policy a phase early (docs/OPEN-QUESTIONS.md).

-- And one more column, for a different reason: the 200/day aptitude XP cap is
-- a read-then-write, and SPEC section 4(d) forbids aggregating XpEvent on a
-- request. `xpEasy` already exists for exactly this, for the 600/day Easy cap,
-- so the aptitude cap reads a maintained column too rather than scanning the
-- ledger. tests/repo/xp-ledger.test.ts refused the first draft for doing the
-- scan, and it was right to.

-- AlterTable
ALTER TABLE "public"."ActivityDay" ADD COLUMN "aptitudeAnswers" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "public"."ActivityDay" ADD COLUMN "mocksFinalised" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "public"."ActivityDay" ADD COLUMN "xpAptitude" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "public"."ActivityDay"
  ADD CONSTRAINT "ActivityDay_aptitude_check"
  CHECK ("aptitudeAnswers" >= 0 AND "mocksFinalised" >= 0 AND "xpAptitude" >= 0);
