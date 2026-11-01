-- Phase 13c: the languages ONE QUESTION may be answered in.
--
-- 13a gave a paper its accepted set and a candidate a picker. This is the
-- narrowing a department asks for next: "answer this one in C", on the
-- question about pointers, without making the whole paper C.
--
-- EMPTY MEANS ALL OF THE PAPER'S, which is what every question already in
-- this database holds and what most questions will always hold.
--
-- It narrows and never widens. The paper's list is what the candidate was
-- told on the readiness page, before the clock started; a question quietly
-- accepting something that list does not would make that page a lie. The
-- action refuses the combination where somebody is choosing it, and
-- `questionLanguages()` intersects again on read.
--
-- The CHECK guards the SHAPE and not the catalogue, for the reason
-- `Assessment_allowedLanguages_check` does: the languages live in
-- packages/shared/src/languages.ts and in `LanguageConfig`, and a third
-- copy inside a CHECK body is the mistake the aptitude taxonomy already
-- made. Bounded at 32 because a paper's own list is.
ALTER TABLE "public"."AssessmentProblem"
  ADD COLUMN "allowedLanguages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "public"."AssessmentProblem"
  ADD CONSTRAINT "AssessmentProblem_allowedLanguages_check"
    CHECK (cardinality("allowedLanguages") <= 32
           AND array_to_string("allowedLanguages", ',')
               ~ '^([a-z][a-z0-9]{1,23})?(,[a-z][a-z0-9]{1,23})*$');
