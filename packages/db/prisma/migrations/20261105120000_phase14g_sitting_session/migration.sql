-- Phase 14g: the sitting carries its own session.
--
-- Launching the real application for the first time found what no unit test
-- could: REC Exam Browser is a fresh Chromium with no cookies, so the
-- readiness page answered it with a 307 to /login -- a sign-in form inside a
-- window with no address bar, which is the exact habit
-- docs/EXAM-BROWSER.md §5 says must never be taught to a candidate.
--
-- So the exchange that spends the launch token also issues a Session for the
-- candidate it was minted for, and the application sets it as a cookie
-- before it navigates. The candidate signs in once, in their own browser.
--
-- Two columns rather than one. "sessionId" is the live pointer and its
-- foreign key is SET NULL, because ending a sitting DELETES the session --
-- that is what revocation means here. "sessionIssuedAt" survives that
-- deletion, so the row still answers "was this sitting given a session, and
-- when", which is the question an audit asks. Neither column ever holds the
-- token: Session."tokenHash" is a digest, exactly as it is for every other
-- session in this database.

-- AlterTable
ALTER TABLE "public"."ExamBrowserSitting" ADD COLUMN "sessionId" TEXT,
ADD COLUMN "sessionIssuedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "ExamBrowserSitting_sessionId_key" ON "public"."ExamBrowserSitting"("sessionId");

-- AddForeignKey
ALTER TABLE "public"."ExamBrowserSitting" ADD CONSTRAINT "ExamBrowserSitting_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A live pointer only ever exists on a sitting that was issued a session.
-- The converse is not true and must not be: the pointer is nulled when the
-- session is deleted, which is the normal end of every sitting.
ALTER TABLE "public"."ExamBrowserSitting"
  ADD CONSTRAINT "ExamBrowserSitting_session_pointer_implies_issued"
  CHECK ("sessionId" IS NULL OR "sessionIssuedAt" IS NOT NULL);

-- A session is issued by the one exchange that spends the launch token, so
-- a sitting holding one that was never bound is corrupt data.
ALTER TABLE "public"."ExamBrowserSitting"
  ADD CONSTRAINT "ExamBrowserSitting_session_implies_bound"
  CHECK ("sessionIssuedAt" IS NULL OR "boundAt" IS NOT NULL);
