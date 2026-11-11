-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- A password you do not have cannot be the one you must change. The flag is
-- only ever set together with a hash an admin chose, and clearing the hash
-- (there is no path that does) would have to clear the flag too.
ALTER TABLE "public"."User"
  ADD CONSTRAINT "User_must_change_password_check"
  CHECK ("mustChangePassword" = false OR "passwordHash" IS NOT NULL);
