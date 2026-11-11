-- CreateEnum
CREATE TYPE "public"."WebAuthnPurpose" AS ENUM ('ENROL', 'ASSERT');

-- CreateEnum
CREATE TYPE "public"."AttestationKind" AS ENUM ('NONE', 'SELF', 'BASIC', 'ATTCA', 'ANONCA');

-- AlterTable
ALTER TABLE "public"."AssessmentAttempt" ADD COLUMN     "seatLabel" TEXT;

-- CreateTable
CREATE TABLE "public"."DeviceRegistration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "aaguid" TEXT,
    "label" TEXT NOT NULL,
    "attestationKind" "public"."AttestationKind" NOT NULL DEFAULT 'NONE',
    "signCount" INTEGER NOT NULL DEFAULT 0,
    "isLoaner" BOOLEAN NOT NULL DEFAULT false,
    "loanConsumedAt" TIMESTAMP(3),
    "enrolledBySupervisorId" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WebAuthnChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "purpose" "public"."WebAuthnPurpose" NOT NULL,
    "assessmentId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeviceRegistration_credentialId_key" ON "public"."DeviceRegistration"("credentialId");

-- CreateIndex
CREATE INDEX "DeviceRegistration_userId_revokedAt_idx" ON "public"."DeviceRegistration"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "DeviceRegistration_enrolledBySupervisorId_idx" ON "public"."DeviceRegistration"("enrolledBySupervisorId");

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnChallenge_challenge_key" ON "public"."WebAuthnChallenge"("challenge");

-- CreateIndex
CREATE INDEX "WebAuthnChallenge_userId_purpose_expiresAt_idx" ON "public"."WebAuthnChallenge"("userId", "purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "WebAuthnChallenge_expiresAt_idx" ON "public"."WebAuthnChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "public"."AssessmentAttempt" ADD CONSTRAINT "AssessmentAttempt_deviceRegistrationId_fkey" FOREIGN KEY ("deviceRegistrationId") REFERENCES "public"."DeviceRegistration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."DeviceRegistration" ADD CONSTRAINT "DeviceRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WebAuthnChallenge" ADD CONSTRAINT "WebAuthnChallenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────
-- Phase 6d, hand-written half. Everything above is Prisma's output.

-- ── DeviceRegistration ──────────────────────────────────────────────────
ALTER TABLE "public"."DeviceRegistration"
  -- Base64url, as an authenticator reports it. Bounded, because a credential
  -- id is a handle and not somewhere to put a payload.
  --
  -- The character class and the length are SEPARATE: Postgres' regex engine
  -- caps a bounded repetition at 255, so '{16,1024}' is an invalid regex —
  -- and it is parsed LAZILY, so such a CHECK is created happily and then
  -- errors on every insert. The catalog fences see the constraint exists;
  -- only device-invariants.db.test.ts sees that it works.
  ADD CONSTRAINT "DeviceRegistration_credential_check"
    CHECK ("credentialId" ~ '^[A-Za-z0-9_-]+$' AND length("credentialId") BETWEEN 16 AND 1024),
  ADD CONSTRAINT "DeviceRegistration_public_key_check"
    CHECK ("publicKey" ~ '^[A-Za-z0-9_-]+$' AND length("publicKey") BETWEEN 32 AND 4096),
  -- 32 hex characters, all-zero for most platform authenticators.
  ADD CONSTRAINT "DeviceRegistration_aaguid_check"
    CHECK ("aaguid" IS NULL OR "aaguid" ~ '^[0-9a-f]{32}$'),
  ADD CONSTRAINT "DeviceRegistration_label_check"
    CHECK (length(btrim("label")) BETWEEN 1 AND 80),
  ADD CONSTRAINT "DeviceRegistration_sign_count_check"
    CHECK ("signCount" >= 0),
  -- Only a loaner is ever consumed.
  ADD CONSTRAINT "DeviceRegistration_loan_check"
    CHECK ("loanConsumedAt" IS NULL OR "isLoaner" = true),
  -- A withdrawal has someone's name on it.
  ADD CONSTRAINT "DeviceRegistration_revoked_check"
    CHECK (("revokedAt" IS NULL) = ("revokedById" IS NULL)),
  ADD CONSTRAINT "DeviceRegistration_revoked_after_enrol_check"
    CHECK ("revokedAt" IS NULL OR "revokedAt" >= "enrolledAt");

-- "max 2 active devices" (SPEC §5) is a COUNT, which no CHECK or unique
-- index can express — so it is a trigger. A loaner is excluded from the
-- count on purpose: the limit exists to stop a student registering a
-- friend's machine as a second "own" device, and a loaner is issued by a
-- supervisor who is standing there. Counting it would mean a student with two
-- devices cannot be lent one when a device breaks, which is the exact
-- situation the loaner exists for.
CREATE OR REPLACE FUNCTION recx_refuse_excess_device() RETURNS trigger AS $$
DECLARE
  active_own INT;
BEGIN
  IF NEW."isLoaner" THEN RETURN NEW; END IF;
  IF NEW."revokedAt" IS NOT NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO active_own
    FROM "public"."DeviceRegistration"
   WHERE "userId" = NEW."userId"
     AND "isLoaner" = false
     AND "revokedAt" IS NULL
     AND "id" <> NEW."id";

  IF active_own >= 2 THEN
    RAISE EXCEPTION 'User % already has 2 active registered devices; revoke one before enrolling another', NEW."userId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DeviceRegistration_device_limit"
  BEFORE INSERT OR UPDATE ON "public"."DeviceRegistration"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_excess_device();

-- A registration is never hard-deleted and its identity is never rewritten:
-- which device sat an exam has to stay answerable years later, and an
-- AssessmentAttempt points at this row.
CREATE OR REPLACE FUNCTION recx_refuse_device_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DeviceRegistration % is never deleted; set revokedAt instead', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW."id", NEW."userId", NEW."credentialId", NEW."publicKey", NEW."isLoaner",
      NEW."enrolledBySupervisorId", NEW."enrolledAt")
     IS DISTINCT FROM
     (OLD."id", OLD."userId", OLD."credentialId", OLD."publicKey", OLD."isLoaner",
      OLD."enrolledBySupervisorId", OLD."enrolledAt") THEN
    RAISE EXCEPTION 'DeviceRegistration %: the credential, its owner and who enrolled it are written once. Revoke it and enrol again', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- A withdrawal is final. "Un-revoking" would make the audit trail a lie.
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS NULL THEN
    RAISE EXCEPTION 'DeviceRegistration % is already revoked; enrol a new registration instead', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- A loaner is spent once.
  IF OLD."loanConsumedAt" IS NOT NULL AND NEW."loanConsumedAt" IS DISTINCT FROM OLD."loanConsumedAt" THEN
    RAISE EXCEPTION 'DeviceRegistration %: a loan is consumed once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The signature counter only ever rises. A counter going backwards is the
  -- one hint WebAuthn gives that a credential may have been cloned, and the
  -- application refuses the assertion; the database refuses to record the
  -- regression either way.
  IF NEW."signCount" < OLD."signCount" THEN
    RAISE EXCEPTION 'DeviceRegistration %: the signature counter only increases', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DeviceRegistration_write_once"
  BEFORE UPDATE OR DELETE ON "public"."DeviceRegistration"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_device_change();

CREATE TRIGGER "DeviceRegistration_no_truncate"
  BEFORE TRUNCATE ON "public"."DeviceRegistration"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

-- ── WebAuthnChallenge ───────────────────────────────────────────────────
ALTER TABLE "public"."WebAuthnChallenge"
  ADD CONSTRAINT "WebAuthnChallenge_challenge_check"
    CHECK ("challenge" ~ '^[A-Za-z0-9_-]+$' AND length("challenge") BETWEEN 32 AND 512),
  ADD CONSTRAINT "WebAuthnChallenge_window_check"
    CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "WebAuthnChallenge_consumed_check"
    CHECK ("consumedAt" IS NULL OR "consumedAt" >= "createdAt");

-- A challenge is spent ONCE. That is what makes it a challenge rather than a
-- password: the conditional UPDATE in the verification path is what claims
-- it, and this refuses a second claim even from raw SQL.
CREATE OR REPLACE FUNCTION recx_refuse_challenge_reuse() RETURNS trigger AS $$
BEGIN
  IF (NEW."challenge", NEW."userId", NEW."purpose") IS DISTINCT FROM
     (OLD."challenge", OLD."userId", OLD."purpose") THEN
    RAISE EXCEPTION 'WebAuthnChallenge %: a challenge is never rewritten', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'WebAuthnChallenge % has already been used', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WebAuthnChallenge_single_use"
  BEFORE UPDATE ON "public"."WebAuthnChallenge"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_challenge_reuse();

-- ── AssessmentAttempt: the seat ─────────────────────────────────────────
ALTER TABLE "public"."AssessmentAttempt"
  ADD CONSTRAINT "AssessmentAttempt_seat_check"
    CHECK ("seatLabel" IS NULL OR length(btrim("seatLabel")) BETWEEN 1 AND 40);
