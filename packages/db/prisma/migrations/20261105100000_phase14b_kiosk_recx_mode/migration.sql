-- Phase 14b: the KIOSK_RECX proctor mode — the enum value, and nothing else.
--
-- docs/EXAM-BROWSER.md §1: a second kiosk option beside Safe Exam Browser,
-- not a replacement. A paper is set to one of them, or to neither, and both
-- are verified server-side on every request. The difference is whose key it
-- is: SEB checks a configuration key shared in a .seb file, this checks one
-- minted for a single sitting.
--
-- The value is added ALONE because PostgreSQL will not let a new enum value
-- be USED in the transaction that adds it, and Prisma runs each migration in
-- one. The CHECK that mentions 'KIOSK_RECX' is therefore the next migration
-- -- the same split Phase 12n and Phase 12k made for the same reason.

-- AlterEnum
ALTER TYPE "public"."ProctorMode" ADD VALUE 'KIOSK_RECX';
