-- Phase 16e: what a candidate agreed to before a proctored sitting.
--
-- SPEC §6 names this table and its columns in the DPDP paragraph, and §4's
-- model inventory lists it. It was in no phase of the plan, which is how it
-- became the unowned precondition `notifyParentEmail` had been waiting on
-- (docs/ROADMAP.md §2.7) — and it is the one piece of the proctoring design
-- with a law behind it rather than a preference.
--
-- Three things the database holds, because none of them survives being a
-- convention:
--
--   1. **Append-only.** A consent record that can be edited proves nothing.
--      UPDATE and DELETE are refused outright, exactly as they are for
--      AuditLog and XpEvent. A retention purge is the only thing that will
--      ever remove one, and it will do so by dropping the trigger in its own
--      migration — which the guard catalogue makes impossible to do quietly.
--   2. **One per candidate per paper per policy version.** Pressing the
--      button twice is one record; a new version of the words is a new
--      record, which is how a re-consent will work when the wording changes.
--   3. **A hash of the exact words.** `policyVersion` alone would be a
--      pointer into a file that moves. The record stores sha256 of the text
--      that was on screen, so it is still evidence after the text changes.

CREATE TABLE "public"."ConsentRecord" (
  "id"            TEXT NOT NULL,
  "userId"        TEXT NOT NULL,
  "assessmentId"  TEXT NOT NULL,
  "policyVersion" INTEGER NOT NULL,
  "policyHash"    TEXT NOT NULL,
  "acceptedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ipHash"        TEXT,

  CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."ConsentRecord"
  ADD CONSTRAINT "ConsentRecord_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."ConsentRecord"
  ADD CONSTRAINT "ConsentRecord_assessmentId_fkey"
  FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ConsentRecord_userId_assessmentId_policyVersion_key"
  ON "public"."ConsentRecord"("userId", "assessmentId", "policyVersion");

CREATE INDEX "ConsentRecord_assessmentId_acceptedAt_idx"
  ON "public"."ConsentRecord"("assessmentId", "acceptedAt");

-- A version is a positive integer and a hash is a sha256 in hex. Both are
-- written by one call site today; neither is worth discovering by reading a
-- row that cannot be interpreted in 2029.
ALTER TABLE "public"."ConsentRecord"
  ADD CONSTRAINT "ConsentRecord_version_check" CHECK ("policyVersion" > 0);

ALTER TABLE "public"."ConsentRecord"
  ADD CONSTRAINT "ConsentRecord_hash_check" CHECK ("policyHash" ~ '^[0-9a-f]{64}$');

-- Never the address itself. The same shape as every other ipHash column.
ALTER TABLE "public"."ConsentRecord"
  ADD CONSTRAINT "ConsentRecord_ip_hash_check" CHECK ("ipHash" IS NULL OR "ipHash" ~ '^[0-9a-f]{64}$');

CREATE OR REPLACE FUNCTION recx_refuse_consent_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ConsentRecord is append-only: a consent record that can be changed is not evidence of anything (%)', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ConsentRecord_append_only"
  BEFORE UPDATE OR DELETE ON "public"."ConsentRecord"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_consent_change();

CREATE TRIGGER "ConsentRecord_no_truncate"
  BEFORE TRUNCATE ON "public"."ConsentRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
