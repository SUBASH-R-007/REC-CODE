-- Phase 11a: a one-time link that lets an account set its own password.
--
-- Why this table has to exist at all: a roster import creates every student
-- with `passwordHash` NULL, because the LMS is the identity source and no
-- password crosses that boundary. Until now that left an imported student
-- with no way to obtain one — the only accounts that could sign in were the
-- seed's. "Forgot your password" is therefore not a convenience here; it is
-- the second half of roster import.
--
-- Three invariants are expressed below rather than left to the code that
-- happens to write the rows:
--
--   * a link must have a future in it (`expiresAt > createdAt`), so a row
--     that could never be spent cannot be created;
--   * a spend must not precede the request;
--   * and a spent link is spent FOREVER. The application spends one with a
--     single conditional UPDATE and checks the row count, which is correct
--     and is also exactly the kind of correctness a later refactor loses.
--     The trigger is the version no code path can route around: it refuses
--     clearing `consumedAt`, and refuses moving a row to another account or
--     another token, which would turn one person's link into another
--     person's way in.

-- CreateTable
CREATE TABLE "public"."PasswordReset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "requestIpHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordReset_tokenHash_key" ON "public"."PasswordReset"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordReset_userId_createdAt_idx" ON "public"."PasswordReset"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PasswordReset_expiresAt_idx" ON "public"."PasswordReset"("expiresAt");

-- AddForeignKey
ALTER TABLE "public"."PasswordReset" ADD CONSTRAINT "PasswordReset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A spent link is spent forever, and never moves.
CREATE OR REPLACE FUNCTION recx_refuse_password_reset_change() RETURNS trigger AS $$
BEGIN
  IF OLD."consumedAt" IS NOT NULL AND NEW."consumedAt" IS NULL THEN
    RAISE EXCEPTION 'A password reset link, once spent, stays spent'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."userId" <> OLD."userId" OR NEW."tokenHash" <> OLD."tokenHash" THEN
    RAISE EXCEPTION 'A password reset link cannot be moved to another account or token'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."createdAt" <> OLD."createdAt" OR NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION 'A password reset link cannot have its window changed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PasswordReset_spend_once"
  BEFORE UPDATE ON "public"."PasswordReset"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_password_reset_change();

-- A link with no future in it could never be spent; a spend cannot precede
-- the request.
ALTER TABLE "public"."PasswordReset"
  ADD CONSTRAINT "PasswordReset_window_check" CHECK ("expiresAt" > "createdAt");
ALTER TABLE "public"."PasswordReset"
  ADD CONSTRAINT "PasswordReset_consumed_check"
  CHECK ("consumedAt" IS NULL OR "consumedAt" >= "createdAt");
