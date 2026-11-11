-- Phase 17: what a submission's own readings say about how it grows.
--
-- A student who has just seen "Accepted" asks two questions the platform
-- could not answer: what is the complexity of this, and is it any good?
-- Neither can be answered from the source. Deciding the running time of an
-- arbitrary program is undecidable, and a counter of nested `for` loops
-- would be confidently wrong about memoisation, early exits, library sorts
-- and recursion -- so nothing here reads the code.
--
-- What it reads is the run. Every submission already carries one CPU-ms and
-- one peak-KB reading per test case, and a problem's cases come in different
-- sizes: that is a scatter plot, and a scatter plot can be fitted.
-- `estimateComplexity` (packages/shared/src/complexity.ts) fits six curves
-- of the form `y = a*f(n) + c` and keeps the one with the smallest residual.
--
-- Three columns, and the reason each is a column rather than a derivation:
--
--   * `timeComplexity` / `spaceComplexity` are enums rather than JSON paths
--     because the second half of the feature GROUPS BY them -- "most
--     accepted solutions here are O(n log n)" is a count per class over the
--     peer population, and a jsonb path cannot be grouped without a
--     functional index.
--   * `complexityDetail` carries the whole outcome of both fits, including
--     the REFUSAL REASON when there is no class. That reason is the part a
--     student reads most often: a problem whose tests are all one size can
--     never produce a fit, and saying so is the honest answer.
--   * They are written at finalise and not derived on read, for three
--     reasons. The input sizes of a frozen version's HIDDEN cases are not
--     readable from a student-facing path (tests/repo/student-exposure.test.ts
--     rule R3 confines that to the judge and admin paths, and the import
--     graph keeps a student page out of them). The class must be groupable.
--     And an estimate stored beside the run that produced it stays auditable
--     when the estimator changes later -- the same argument as
--     `calibrationScore`, which is stored on the row for exactly that reason.
--
-- Null is the normal state, not an error state. The estimator refuses below
-- five distinct input sizes, below an 8x span between the smallest and the
-- largest, and when the whole rise is inside the judge's own resolution. On
-- a catalogue whose problems were authored before any of this existed, most
-- rows will have null in both columns and a reason in the detail.
--
-- NOTHING about these columns reaches scoring, XP, the leaderboard, a
-- contest standing, an assessment result or any eligibility decision. They
-- are a measurement a student reads about their own submission. A slow
-- solution is Accepted, and stays Accepted.
--
-- No backfill. Existing rows keep null in all three columns: the estimate
-- describes a run, and a run that was judged before the estimator existed
-- was never measured. An admin rejudge writes them, which is the only
-- honest way an old row acquires one.

CREATE TYPE "public"."ComplexityClass" AS ENUM (
  'LOG',
  'SQRT',
  'LINEAR',
  'LINEARITHMIC',
  'QUADRATIC',
  'CUBIC'
);

ALTER TABLE "public"."Submission"
  ADD COLUMN "timeComplexity"   "public"."ComplexityClass",
  ADD COLUMN "spaceComplexity"  "public"."ComplexityClass",
  ADD COLUMN "complexityDetail" JSONB;

-- The peer population of one accepted solution: every OTHER student's
-- accepted PRACTICE submissions to the same frozen revision in the same
-- language. Four equality predicates, ordered by selectivity, so the index
-- answers both the time ranking and the per-class counts from one scan.
CREATE INDEX "Submission_problemVersionId_language_origin_verdict_idx"
  ON "public"."Submission" ("problemVersionId", "language", "origin", "verdict");
