-- Phase 13a: which languages a paper may be answered in.
--
-- Until now a sitting had ONE language and nobody chose it. `cpp20`, or
-- whatever enabled toolchain key sorted first, was frozen into every
-- attempt's layout: a department running a Python paper had no way to say
-- so, and the only lever was enabling and disabling toolchains
-- platform-wide, which changes every other exam and the practice pages at
-- the same time.
--
-- EMPTY MEANS EVERY ENABLED LANGUAGE. That is what the default gives every
-- paper already in this database, and it is what "the department restricted
-- nothing" should mean. A paper nobody has restricted must not become a
-- paper nobody can sit.
--
-- Not added to the tuple `Assessment_published_immutable` freezes (the
-- window, the clock, the proctor mode, the attempt limit, the placement
-- flag). Those decide what a result MEANS and must not move after anybody
-- has sat. This list cannot move under a candidate either -- it is frozen
-- into each attempt's `layout` at start, beside the frozen version ids --
-- so the only thing an edit changes is what the NEXT candidate is offered.
-- A department that discovers an hour before the second hall that it forgot
-- Java has to be able to add it, and the audit row records who did.
--
-- The CHECK below deliberately does NOT enumerate the catalog. The language
-- catalog lives in packages/shared/src/languages.ts and the installed
-- toolchains live in `LanguageConfig`; a third copy of the list inside a
-- CHECK body is the mistake the aptitude taxonomy already made (see
-- `AptitudeQuestion_area_topic_check` and the note in
-- docs/OPEN-QUESTIONS.md), where adding one value means dropping and
-- recreating a catalogued guard. So the database guards the SHAPE -- a
-- plausible key, a bounded list -- the action refuses an unknown key by
-- name, and `paperLanguages()` intersects with what is actually installed
-- before a candidate is offered anything.
ALTER TABLE "public"."Assessment"
  ADD COLUMN "allowedLanguages" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "public"."Assessment"
  ADD CONSTRAINT "Assessment_allowedLanguages_check"
    CHECK (cardinality("allowedLanguages") <= 32
           -- Every element is a plausible language key. Written against the
           -- joined string because a CHECK body may not hold a subquery, and
           -- `unnest` needs one; the empty array joins to '' and the leading
           -- group is optional, so "no restriction" passes.
           AND array_to_string("allowedLanguages", ',')
               ~ '^([a-z][a-z0-9]{1,23})?(,[a-z][a-z0-9]{1,23})*$');
