-- Phase 12n: what an output-only version is, and what it is not.
--
-- One CHECK, because every rule here is about the same mistake: carrying a
-- field that belongs to a kind of problem this is not. An output-only
-- version has no program, so it has no function signature and no starter to
-- repair; it is not a query, so it has no dialect and no result-set
-- comparison; and it is not a conversation, so it has no interactor.
--
-- What is NOT here, because no CHECK could hold it: that the version has
-- exactly ONE test case and that the case is a SAMPLE. Both span tables (and
-- the case's blobs), so they are the publish gate's rules — stated to the
-- author in a sentence rather than as a constraint violation.

ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_output_only_fields"
  CHECK (
    "ioMode" <> 'OUTPUT_ONLY'
    OR (
      "functionSignature" IS NULL
      AND "sqlDialect" IS NULL
      AND "sqlOrdered" IS NULL
      AND "interactorSha256" IS NULL
      AND "maxEditedLines" IS NULL
      AND "compareMode" <> 'INTERACTIVE'
      AND "compareMode" <> 'ROWS'
    )
  );
