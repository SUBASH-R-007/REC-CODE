-- Phase 12k: SQL problems in the data model.
--
-- SPEC §6: "SQL problems (per-submission ephemeral Postgres schema,
-- read-only role, statement_timeout = 5s, result-set comparison,
-- PostgreSQL dialect only, stated on the problem page)".
--
-- Additive, every line of it: two enum VALUES and two nullable columns. The
-- question Phase 12g died on was asked before any of this was written, and
-- the answer is in docs/handoff/phase12/DESIGN-sql.md §3 — the three
-- catalogued CHECKs that mention ioMode or compareMode are scoped by
-- `"ioMode" <> 'FUNCTION'` or `"compareMode" <> 'CHECKER'` rather than
-- enumerating the enum's domain, so a version with ioMode 'SQL' satisfies
-- every one of them unchanged and nothing frozen is dropped.
--
-- What a SQL version does NOT get: a new table. A `TestCase` already
-- carries an input blob and an output blob, which for SQL are the case's
-- dataset and its expected result set — the same immutability, the same
-- sha256 discipline, the same bundle. Reusing them is what keeps
-- `Submission` unchanged, and with it XP, the leaderboard, contests,
-- assessments and rejudges.
--
-- Prisma does not model CHECK constraints, so the four in the next
-- migration are hand-written (the same precedent as the init migration) and
-- catalogued in packages/db/test/support/guard-catalog.ts.
--
-- The CHECKs that use the new enum values are the NEXT migration
-- (20261101120500_phase12k_sql_checks), not this one: PostgreSQL refuses
-- `unsafe use of new value "SQL" of enum type "IoMode"` inside the same
-- transaction that added the value, and Prisma runs one transaction per
-- migration. Two files is the honest way to say "the value exists, then it
-- is constrained" — the alternative, comparing `"ioMode"::text`, would put
-- a cast of questionable immutability inside a constraint to save a file.


-- CreateEnum
CREATE TYPE "public"."SqlDialect" AS ENUM ('postgres17');

-- AlterEnum
ALTER TYPE "public"."CompareMode" ADD VALUE 'ROWS';

-- AlterEnum
ALTER TYPE "public"."IoMode" ADD VALUE 'SQL';

-- AlterTable
ALTER TABLE "public"."ProblemVersion" ADD COLUMN     "sqlDialect" "public"."SqlDialect",
ADD COLUMN     "sqlOrdered" BOOLEAN;
