-- Phase 12n: output-only problems — the enum value, and nothing else.
--
-- SPEC §11: "debugging and output-only problem kinds". An output-only
-- problem's submission is the ANSWER: one visible case, no program, and the
-- student's text compared with the expected output or judged by the author's
-- checker.
--
-- This migration adds the value ALONE because PostgreSQL will not let a new
-- enum value be USED in the transaction that adds it, and Prisma runs each
-- migration in one. The CHECKs that mention 'OUTPUT_ONLY' are therefore the
-- next migration — the same split Phase 12k used for its SQL checks.

-- AlterEnum
ALTER TYPE "public"."IoMode" ADD VALUE 'OUTPUT_ONLY';
