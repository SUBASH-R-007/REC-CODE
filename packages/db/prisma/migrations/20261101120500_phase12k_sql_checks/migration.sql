-- Phase 12k: the CHECKs for SQL versions.
--
-- Separate from 20261101120000_phase12k_sql_problems because PostgreSQL
-- refuses to USE a new enum value in the transaction that added it
-- (`unsafe use of new value "SQL" of enum type "IoMode"`), and Prisma runs
-- one transaction per migration. Nothing here drops or alters an existing
-- guard: all four are new.

-- A version is SQL exactly when it compares result sets. One column answers
-- "which engine judges this?" either way round, so a row cannot say it is a
-- SQL problem that compares stdout, or a stdout problem that compares rows.
ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_sql_mode_mirror"
  CHECK (("ioMode" = 'SQL') = ("compareMode" = 'ROWS'));

-- The two SQL-only columns are present exactly for a SQL version. The
-- dialect is stated rather than inferred (the problem page says it too),
-- and the ordering rule is per VERSION because ordering is a property of
-- the question.
-- Each column on its own, not the pair: `(ioMode = 'SQL') = (a IS NOT NULL
-- AND b IS NOT NULL)` is satisfied by a STDIN version that carries a
-- dialect and no ordering rule, because both sides are then false. The
-- test that asked for that row is what found it.
ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_sql_fields_pair"
  CHECK (
    (("ioMode" = 'SQL') = ("sqlDialect" IS NOT NULL))
    AND (("ioMode" = 'SQL') = ("sqlOrdered" IS NOT NULL))
  );

-- A SQL version has no function signature: there is no function, and a
-- stale signature would be read by the FUNCTION comparator rules.
ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_sql_no_signature"
  CHECK ("ioMode" <> 'SQL' OR "functionSignature" IS NULL);

-- And no checker: a testlib checker is a C++ program, and nothing compiles
-- one for a SQL problem. The comparison is the result set.
ALTER TABLE "public"."ProblemVersion"
  ADD CONSTRAINT "ProblemVersion_sql_no_checker"
  CHECK ("ioMode" <> 'SQL' OR ("checkerSha256" IS NULL AND "testlibId" IS NULL));
