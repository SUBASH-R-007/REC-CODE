-- Phase 12l: interactive problems in the data model.
--
-- SPEC §11: "interactive problems (two boxes, FIFOs, interactor CPU
-- excluded, 2s mutual-idle deadlock detection — the most fragile part of
-- the engine; admin-authored interactors only, and keep them out of
-- high-stakes assessments until they have run cleanly through two practice
-- contests)".
--
-- One column, and four CHECKs that say what an interactive version is.
-- `CompareMode.INTERACTIVE` has existed since the init migration, so no
-- enum value is added and nothing frozen is touched: every constraint
-- below is scoped by `"compareMode" <> 'INTERACTIVE'` or by the new
-- column being null, which every existing row satisfies.
--
-- What an interactive version does NOT get: a table of its own, a nullable
-- `TestCase.outputSha256`, or a second testlib id. A case's expected output
-- is the EMPTY blob (there is nothing to compare — the interactor decides
-- as it goes), and the one `testlibId` column serves whichever of the two
-- testlib programs this version has, because `compareMode` is a single
-- value and a version can therefore never have both.

-- AlterTable
ALTER TABLE "public"."ProblemVersion" ADD COLUMN     "interactorSha256" TEXT;

-- The mirror, both ways round: an interactive version has an interactor,
-- and a version with an interactor is interactive. Scoped to frozen rows
-- for the first half, exactly as the checker's own rule is — a draft is
-- built up one edit at a time and is allowed to be incomplete; what must
-- never exist is a PUBLISHED version that cannot be judged.
ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_interactive_mode_mirror"
  CHECK (
    ("frozenAt" IS NULL OR "compareMode" <> 'INTERACTIVE' OR ("interactorSha256" IS NOT NULL AND "testlibId" IS NOT NULL))
    AND ("interactorSha256" IS NULL OR "compareMode" = 'INTERACTIVE')
  );

-- A conversation happens on stdin and stdout. A FUNCTION problem's answer
-- is a return value and a SQL problem's is a result set; neither has a
-- dialogue to have, and the judge refuses the pairing too (plan.ts).
ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_interactive_stdin_only"
  CHECK ("compareMode" <> 'INTERACTIVE' OR "ioMode" = 'STDIN');

-- One judge, not two. The interactor decides the verdict; a checker beside
-- it would be a second opinion nobody asked for and no code reads.
ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_interactive_no_checker"
  CHECK ("compareMode" <> 'INTERACTIVE' OR "checkerSha256" IS NULL);

-- An interactive problem is not judged by comparing output, so a float
-- epsilon on one would be a number that changes nothing — the kind of
-- stored value somebody later reads as meaningful.
ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_interactive_no_epsilon"
  CHECK ("compareMode" <> 'INTERACTIVE' OR "floatEpsilon" IS NULL);
