-- Phase 4 — D1 FUNCTION harness / comparators (SQL-only).
--
-- "A problem cannot publish without a declared comparator" (spec, Phase 4).
-- The comparator lives in the frozen "functionSignature" jsonb (validated by
-- functionSignatureSchema in @recx/shared); there is no Prisma column or enum
-- for it, and these CHECK constraints are not modelled by Prisma either (same
-- precedent as the init migration), so `prisma migrate diff` stays clean.
--
-- Every rule is scoped to FROZEN rows: a DRAFT may be incomplete while it is
-- being authored. The publish transition — the UPDATE that sets "frozenAt",
-- the only UPDATE the frozen guard permits — is what these constraints check.
-- The app enforces the same rules first (comparatorIssues() in the publish
-- and approve gates); this is the database half.

-- A frozen FUNCTION version declares one of the six comparators.
ALTER TABLE "public"."ProblemVersion" ADD CONSTRAINT "ProblemVersion_function_comparator_declared" CHECK (
  "frozenAt" IS NULL
  OR "ioMode" <> 'FUNCTION'
  OR COALESCE(
    ("functionSignature" ->> 'comparator') IN
      ('EXACT', 'FLOAT_TOLERANCE', 'SET_EQUAL', 'ROWS_ANY_ORDER', 'IN_PLACE_MUTATION', 'CUSTOM_CHECKER'),
    false
  )
);

-- The CHECKER mirror: a frozen FUNCTION version has compareMode CHECKER
-- exactly when its comparator is CUSTOM_CHECKER (TOKEN otherwise, by
-- convention; the judge compares FUNCTION output structurally).
ALTER TABLE "public"."ProblemVersion" ADD CONSTRAINT "ProblemVersion_function_checker_mirror" CHECK (
  "frozenAt" IS NULL
  OR "ioMode" <> 'FUNCTION'
  OR COALESCE(("functionSignature" ->> 'comparator') = 'CUSTOM_CHECKER', false) = ("compareMode" = 'CHECKER')
);

-- A frozen CHECKER version (STDIN or CUSTOM_CHECKER) names its checker blob and its pinned testlib.
ALTER TABLE "public"."ProblemVersion" ADD CONSTRAINT "ProblemVersion_checker_present_when_frozen" CHECK (
  "frozenAt" IS NULL
  OR "compareMode" <> 'CHECKER'
  OR ("checkerSha256" IS NOT NULL AND "testlibId" IS NOT NULL)
);
