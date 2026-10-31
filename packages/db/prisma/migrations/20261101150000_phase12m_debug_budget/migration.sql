-- Phase 12m: debugging problems.
--
-- SPEC §11 asks for "debugging and output-only problem kinds". A debugging
-- problem hands the student a program that is nearly right and asks them to
-- fix it within an EDIT BUDGET, and the budget is the only thing that makes
-- it a kind: the judging is an ordinary problem's, and the broken program is
-- the StarterCode rows the version already has.
--
-- So: one nullable column, and no enum. Non-null is the kind. An enum value
-- beside it would invite code to ask "is this a debugging problem?" in
-- places that should be asking "does this problem have an edit budget?",
-- and the two could then disagree.
--
-- Additive, and every existing row satisfies both CHECKs with a NULL.

-- AlterTable
ALTER TABLE "public"."ProblemVersion" ADD COLUMN     "maxEditedLines" INTEGER;

-- One line is a real question ("find the mistake"); fifty is a rewrite with
-- extra steps. A budget of 0 would be a problem nobody can submit to, and a
-- fractional one is not a number of lines.
ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_debug_budget_range"
  CHECK ("maxEditedLines" IS NULL OR ("maxEditedLines" >= 1 AND "maxEditedLines" <= 50));

-- Not every kind of problem has a program to repair. A SQL problem's
-- starter is a comment above an empty editor, and an interactive problem's
-- answer is a conversation — measuring either against a line budget would
-- be measuring something that is not there.
ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_debug_budget_kind"
  CHECK ("maxEditedLines" IS NULL OR ("ioMode" <> 'SQL' AND "compareMode" <> 'INTERACTIVE'));
