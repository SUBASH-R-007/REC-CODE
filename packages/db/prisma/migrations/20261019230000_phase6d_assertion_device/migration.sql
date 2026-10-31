-- Phase 6d: the consumed challenge records which device signed it.
--
-- SPEC §5 requires "a fresh assertion against a server challenge" to START an
-- attempt, and the assertion and the start are two requests — so something
-- has to carry the result between them.
--
-- The first draft used a short-lived signed cookie, which needed a signing
-- secret the web app does not have (sessions here are random tokens hashed in
-- the database, so there is no AUTH_SECRET to borrow). Adding one would have
-- meant a new env var, a new thing to rotate, and a forgeable value to defend.
--
-- The consumed WebAuthnChallenge row is already the evidence: it records the
-- user, the purpose, the assessment and the moment it was spent, and
-- `WebAuthnChallenge_single_use` makes it unspendable twice. Recording the
-- device on it means the start path reads a row it already trusts.
ALTER TABLE "public"."WebAuthnChallenge"
  ADD COLUMN "deviceRegistrationId" TEXT,
  -- A device is recorded only on a challenge that was actually spent.
  ADD CONSTRAINT "WebAuthnChallenge_device_check"
    CHECK ("deviceRegistrationId" IS NULL OR "consumedAt" IS NOT NULL);
