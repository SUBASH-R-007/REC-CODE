-- Phase 12z: a hall's own Safe Exam Browser keys.
--
-- 12y.8 generates the .seb file and hands it to SEB from the readiness
-- page; SEB then sends sha256(url + key) on every request and the server
-- compares it against a stored key. There was nowhere to store one: the
-- pair lived in PlatformSetting rows (`seb`, `seb:<examSessionId>`) that
-- no screen could write, so a KIOSK_SEB paper refused every candidate
-- with "no exam keys have been configured" and the only cure was SQL.
--
-- The hall's pair moves onto the hall. Two reasons, and the second is the
-- one that decided it:
--
--   * it is hall configuration -- a key rotates per sitting, beside the
--     network allowlist that is already here;
--   * PlatformSetting is the super-admin's table. The capability matrix
--     reserves `settings.write` to SUPER_ADMIN and
--     `tests/repo/platform-setting-writes.test.ts` allows writes from
--     exactly five audited super-admin action files. A STAFF action
--     writing a hall key into it would have widened who can write every
--     platform setting, and the fence refused the first draft that tried.
--     The fence was right; the data was in the wrong place.
--
-- The college-wide default stays in PlatformSetting `seb`, set by a
-- super-admin, and a hall's own keys win over it (`sebKeysFor`).
--
-- Nullable, with no default: null means "this hall has no key of its own"
-- and falls through to the college's, which is what every existing hall
-- does today.

ALTER TABLE "public"."ExamSession"
  ADD COLUMN "sebConfigKey" TEXT,
  ADD COLUMN "sebBrowserExamKey" TEXT;
