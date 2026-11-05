-- Phase 14b: one candidate's REC Exam Browser sitting.
--
-- The row exists before the attempt does, which is why it is a row at all:
-- the candidate launches the browser from the readiness page, and the
-- readiness page comes before the clock starts.
--
-- What this table does NOT hold is a key. The signing key is derived per
-- request from the deployment's EXAM_BROWSER_SECRET and this row's id
-- (docs/EXAM-BROWSER.md §5), so a dump of this table lets nobody sign
-- anything. `launchTokenHash` is a hash for the same reason
-- "AssessmentAttempt"."tokenHash" is: the token itself is never stored.
--
-- Every CHECK below is written as `X IS NULL OR <condition>` rather than as
-- a bare condition on a nullable column. A CHECK only fails on FALSE, and
-- an expression over NULL is NULL, so `char_length("col") = 64` silently
-- accepts a NULL. Phase 13i shipped exactly that mistake and a database
-- test caught it; these are written the other way round from the start.

-- CreateTable
CREATE TABLE "public"."ExamBrowserSitting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "launchTokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "boundAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "lastSeenVersion" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "ipHashBound" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamBrowserSitting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExamBrowserSitting_launchTokenHash_key" ON "public"."ExamBrowserSitting"("launchTokenHash");

-- CreateIndex
CREATE INDEX "ExamBrowserSitting_userId_assessmentId_createdAt_idx" ON "public"."ExamBrowserSitting"("userId", "assessmentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ExamBrowserSitting_expiresAt_idx" ON "public"."ExamBrowserSitting"("expiresAt");

-- AddForeignKey
ALTER TABLE "public"."ExamBrowserSitting" ADD CONSTRAINT "ExamBrowserSitting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ExamBrowserSitting" ADD CONSTRAINT "ExamBrowserSitting_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "public"."AssessmentAttempt" ADD COLUMN "examBrowserSittingId" TEXT;

-- AddForeignKey
ALTER TABLE "public"."AssessmentAttempt" ADD CONSTRAINT "AssessmentAttempt_examBrowserSittingId_fkey" FOREIGN KEY ("examBrowserSittingId") REFERENCES "public"."ExamBrowserSitting"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The launch token is stored as a sha256 hex digest and never as itself.
-- 64 characters, lower-case hex, so a column holding a token rather than a
-- digest of one is refused by the database rather than by a code review.
ALTER TABLE "public"."ExamBrowserSitting"
  ADD CONSTRAINT "ExamBrowserSitting_launch_token_is_a_digest"
  CHECK ("launchTokenHash" ~ '^[0-9a-f]{64}$');

-- A token that expires before it is minted is unusable, and a row like that
-- means the clock or the caller is wrong.
ALTER TABLE "public"."ExamBrowserSitting"
  ADD CONSTRAINT "ExamBrowserSitting_expiry_follows_creation"
  CHECK ("expiresAt" > "createdAt");

-- A sitting cannot be seen before it is bound: the application presents a
-- version only once it holds a key, and it only holds a key once the one
-- exchange that spends the launch token has happened.
ALTER TABLE "public"."ExamBrowserSitting"
  ADD CONSTRAINT "ExamBrowserSitting_seen_implies_bound"
  CHECK ("lastSeenAt" IS NULL OR "boundAt" IS NOT NULL);

ALTER TABLE "public"."ExamBrowserSitting"
  ADD CONSTRAINT "ExamBrowserSitting_version_pair_is_whole"
  CHECK (("lastSeenVersion" IS NULL) = ("lastSeenAt" IS NULL));

-- Three numbers. The deployment's floor is compared against this, and a
-- version that is not a version would compare as "below any floor" and
-- quietly lock a hall out.
ALTER TABLE "public"."ExamBrowserSitting"
  ADD CONSTRAINT "ExamBrowserSitting_version_looks_like_one"
  CHECK ("lastSeenVersion" IS NULL OR "lastSeenVersion" ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}([-+][0-9A-Za-z.-]+)?$');

-- Never a raw IP, anywhere (SPEC §4). hashIp() produces a sha256 hex digest.
ALTER TABLE "public"."ExamBrowserSitting"
  ADD CONSTRAINT "ExamBrowserSitting_ip_is_hashed"
  CHECK ("ipHashBound" IS NULL OR "ipHashBound" ~ '^[0-9a-f]{64}$');

-- An attempt may name a REC Exam Browser sitting only if that is the mode
-- it is being sat under. Deliberately one-way rather than a biconditional:
-- clearing the column is how a sitting's attestation is revoked, so a
-- KIOSK_RECX attempt with no sitting id is a revoked sitting, not corrupt
-- data. What it forbids is the other direction -- an advisory or a
-- lab-supervised paper carrying an attestation nothing will ever check.
ALTER TABLE "public"."AssessmentAttempt"
  ADD CONSTRAINT "AssessmentAttempt_browser_sitting_needs_kiosk_recx"
  CHECK ("examBrowserSittingId" IS NULL OR "proctorMode" = 'KIOSK_RECX');
