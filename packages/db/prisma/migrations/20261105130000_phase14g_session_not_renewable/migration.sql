-- Phase 14g, second pass: a session that may not renew itself.
--
-- Found by running the real application, not by a test. The exchange issues
-- the sitting's session with an expiry of the paper plus slack, and then
-- `currentSession()` renewed it on its very first request: `needsRenew` is
-- true for any session expiring inside seven days, so a two-hour session
-- became a fourteen-day one and the bound this slice documented was false
-- in practice.
--
-- So renewal becomes a property of the session rather than of the clock.
-- Every session created by signing in is renewable, which is what the
-- default is for; the one the exam browser holds is not, and expires when
-- the paper it was issued for is over whether anybody asks again or not.

-- AlterTable
ALTER TABLE "public"."Session" ADD COLUMN "renewable" BOOLEAN NOT NULL DEFAULT true;
