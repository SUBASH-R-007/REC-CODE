-- Phase 16j: a second factor for privileged accounts.
--
-- docs/ROADMAP.md §3.1. A single password stood in front of impersonation,
-- the roster import commit, result release, the placement export, the AI
-- provider settings and the judge node controls. Every one of those is
-- audited, which is how a department finds out afterwards; this is how it
-- avoids needing to. Scoped as that entry scoped it: ADMIN and SUPER_ADMIN,
-- TOTP, recovery codes. Students keep a password, because 5,000 students
-- with TOTP is a help-desk programme rather than a security improvement.
--
-- Three tables, and the rules each one enforces HERE rather than only in the
-- action that writes it:
--
--   1. `TotpCredential` — one per account, the secret encrypted, and a
--      monotonic `lastCounter`. A trigger refuses a counter that does not
--      move FORWARD, which is what makes a replayed code impossible even
--      if two requests race: the second one's UPDATE is refused by the
--      database rather than by a check somebody could forget.
--   2. `TotpRecoveryCode` — sha256 only, and a trigger that refuses
--      un-spending one or moving it to another account. The same shape as
--      the one-time password link (Phase 11a), for the same reason.
--   3. `SecondFactorChallenge` — the half-finished sign-in. There is NO
--      Session row until the code verifies, so a password alone creates
--      nothing a guard has to know about. A trigger refuses raising the
--      attempt ceiling or moving a challenge to another account.
--
-- What is deliberately NOT here: any column on `User` saying "this account
-- has 2FA". The credential row IS that fact, and a boolean beside it is a
-- second answer to the same question — which is how an account ends up with
-- a flag set and no secret, or a secret nobody asks for.

CREATE TABLE "public"."TotpCredential" (
  "id"           TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  -- AES-256-GCM over the base32 secret, under TOTP_ENCRYPTION_KEY. Never
  -- the secret itself: a database dump must not yield working second
  -- factors, which is the whole reason this column is not plaintext.
  "secretCipher" TEXT NOT NULL,
  -- NULL until the holder has proved the app works by typing one code.
  -- An unconfirmed credential is never asked for at sign-in.
  "confirmedAt"  TIMESTAMP(3),
  -- The last 30-second step accepted. Monotonic (trigger below).
  "lastCounter"  BIGINT,
  "lastUsedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TotpCredential_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."TotpCredential"
  ADD CONSTRAINT "TotpCredential_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One per account. Re-enrolling replaces the row rather than adding one,
-- so "which of my two secrets is live" is never a question.
CREATE UNIQUE INDEX "TotpCredential_userId_key" ON "public"."TotpCredential"("userId");

-- A counter without a confirmation is a credential that was used before it
-- was proved; a confirmation without a cipher cannot exist (NOT NULL).
ALTER TABLE "public"."TotpCredential"
  ADD CONSTRAINT "TotpCredential_counter_needs_confirmation_check" CHECK (
    "lastCounter" IS NULL OR "confirmedAt" IS NOT NULL
  );

ALTER TABLE "public"."TotpCredential"
  ADD CONSTRAINT "TotpCredential_cipher_check" CHECK (
    length("secretCipher") BETWEEN 32 AND 512
  );

CREATE TABLE "public"."TotpRecoveryCode" (
  "id"        TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  -- sha256 of the normalised code. The code itself is shown once, at
  -- generation, and cannot be recovered from here.
  "codeHash"  TEXT NOT NULL,
  "usedAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TotpRecoveryCode_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."TotpRecoveryCode"
  ADD CONSTRAINT "TotpRecoveryCode_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "TotpRecoveryCode_codeHash_key" ON "public"."TotpRecoveryCode"("codeHash");
CREATE INDEX "TotpRecoveryCode_userId_usedAt_idx" ON "public"."TotpRecoveryCode"("userId", "usedAt");

ALTER TABLE "public"."TotpRecoveryCode"
  ADD CONSTRAINT "TotpRecoveryCode_hash_check" CHECK (length("codeHash") = 64);

CREATE TABLE "public"."SecondFactorChallenge" (
  "id"        TEXT NOT NULL,
  -- sha256 of the cookie value, like a Session. The cookie is the only
  -- copy of the token.
  "tokenHash" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "attempts"  INTEGER NOT NULL DEFAULT 0,
  "userAgent" TEXT,
  -- sha256(ip + pepper). Never a raw IP.
  "ipHash"    TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SecondFactorChallenge_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."SecondFactorChallenge"
  ADD CONSTRAINT "SecondFactorChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "SecondFactorChallenge_tokenHash_key" ON "public"."SecondFactorChallenge"("tokenHash");
CREATE INDEX "SecondFactorChallenge_userId_idx" ON "public"."SecondFactorChallenge"("userId");
CREATE INDEX "SecondFactorChallenge_expiresAt_idx" ON "public"."SecondFactorChallenge"("expiresAt");

ALTER TABLE "public"."SecondFactorChallenge"
  ADD CONSTRAINT "SecondFactorChallenge_hash_check" CHECK (length("tokenHash") = 64);

-- Five, from @recx/shared's SECOND_FACTOR_MAX_ATTEMPTS. A row at the
-- ceiling is spent; nothing deletes it early, so the ceiling cannot be
-- escaped by trying again.
ALTER TABLE "public"."SecondFactorChallenge"
  ADD CONSTRAINT "SecondFactorChallenge_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5);

-- Rule 1. The counter only ever moves forward, and only for a confirmed
-- credential. This is the replay guard, and it is here because a TOCTOU
-- race between two requests holding the same code would otherwise let the
-- second one through -- the check in TypeScript reads a value the first
-- request has not committed yet, while this one reads the row it is
-- locking.
CREATE OR REPLACE FUNCTION recx_refuse_totp_counter_rewind() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" <> OLD."userId" THEN
    RAISE EXCEPTION 'TotpCredential %: a credential cannot be moved to another account', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."confirmedAt" IS NOT NULL AND NEW."confirmedAt" IS NULL THEN
    RAISE EXCEPTION 'TotpCredential %: a confirmed credential cannot be un-confirmed (delete it instead)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."lastCounter" IS NOT NULL
     AND (NEW."lastCounter" IS NULL OR NEW."lastCounter" <= OLD."lastCounter") THEN
    RAISE EXCEPTION 'TotpCredential %: the time step must move forward (% -> %) -- a code is used once', OLD."id", OLD."lastCounter", NEW."lastCounter"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TotpCredential_no_rewind"
  BEFORE UPDATE ON "public"."TotpCredential"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_totp_counter_rewind();

-- Rule 2. A spent recovery code stays spent, and stays this account's. The
-- hash is immutable too: changing it in place would be a way to mint a new
-- code without a new row to audit.
CREATE OR REPLACE FUNCTION recx_refuse_recovery_code_change() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" <> OLD."userId" OR NEW."codeHash" <> OLD."codeHash" THEN
    RAISE EXCEPTION 'TotpRecoveryCode %: the owner and the hash are immutable', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."usedAt" IS NOT NULL AND (NEW."usedAt" IS NULL OR NEW."usedAt" <> OLD."usedAt") THEN
    RAISE EXCEPTION 'TotpRecoveryCode %: a spent recovery code cannot be un-spent', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TotpRecoveryCode_no_unspend"
  BEFORE UPDATE ON "public"."TotpRecoveryCode"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_recovery_code_change();

-- Rule 3. A challenge belongs to one account for its whole life, its window
-- never widens, and its attempt count never falls. Without the last of
-- those, five tries is five tries per reset rather than five tries.
CREATE OR REPLACE FUNCTION recx_refuse_second_factor_challenge_change() RETURNS trigger AS $$
BEGIN
  IF NEW."userId" <> OLD."userId" OR NEW."tokenHash" <> OLD."tokenHash" THEN
    RAISE EXCEPTION 'SecondFactorChallenge %: the owner and the token are immutable', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."expiresAt" > OLD."expiresAt" THEN
    RAISE EXCEPTION 'SecondFactorChallenge %: the window cannot be widened', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'SecondFactorChallenge %: the attempt count cannot fall (% -> %)', OLD."id", OLD."attempts", NEW."attempts"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SecondFactorChallenge_no_reset"
  BEFORE UPDATE ON "public"."SecondFactorChallenge"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_second_factor_challenge_change();

-- A credential belongs to an account that may hold one. ADMIN and
-- SUPER_ADMIN, from @recx/shared's SECOND_FACTOR_ROLES -- not because a
-- student's second factor would be harmful, but because the surfaces that
-- manage one exist only in the admin tree, and a row nothing can manage is
-- a row somebody will have to explain later. A demotion leaves the row
-- alone: it is harmless, and deleting a credential as a side effect of a
-- role change is a sign-in that breaks for a reason nobody can see.
CREATE OR REPLACE FUNCTION recx_refuse_totp_for_role() RETURNS trigger AS $$
DECLARE
  who "public"."Role";
BEGIN
  SELECT u."role" INTO who FROM "public"."User" u WHERE u."id" = NEW."userId";
  IF who IS NULL OR who NOT IN ('ADMIN', 'SUPER_ADMIN') THEN
    RAISE EXCEPTION 'TotpCredential %: a second factor is for ADMIN and SUPER_ADMIN (this account is %)', NEW."id", coalesce(who::text, 'missing')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TotpCredential_role_only"
  BEFORE INSERT ON "public"."TotpCredential"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_totp_for_role();
