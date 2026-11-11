-- CreateEnum
CREATE TYPE "public"."TriageBand" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "public"."IntegrityStatus" AS ENUM ('OPEN', 'CLEARED', 'UPHELD', 'AUTO_CLEARED', 'OVERTURNED');

-- CreateEnum
CREATE TYPE "public"."IntegrityVerdict" AS ENUM ('CLEAR', 'UPHOLD');

-- CreateEnum
CREATE TYPE "public"."AppealOutcome" AS ENUM ('PENDING', 'UPHELD', 'OVERTURNED');

-- CreateTable
CREATE TABLE "public"."IntegrityFlag" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "band" "public"."TriageBand" NOT NULL,
    "substantivePoints" INTEGER NOT NULL,
    "contextPoints" INTEGER NOT NULL DEFAULT 0,
    "signals" JSONB NOT NULL DEFAULT '[]',
    "flaggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewDeadline" TIMESTAMP(3) NOT NULL,
    "status" "public"."IntegrityStatus" NOT NULL DEFAULT 'OPEN',
    "reviewersRequired" INTEGER NOT NULL DEFAULT 0,
    "withheld" BOOLEAN NOT NULL DEFAULT true,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrityFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."IntegrityReview" (
    "id" TEXT NOT NULL,
    "flagId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "verdict" "public"."IntegrityVerdict" NOT NULL,
    "rationale" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrityReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."IntegrityAppeal" (
    "id" TEXT NOT NULL,
    "flagId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decideBy" TIMESTAMP(3) NOT NULL,
    "firstReviewerId" TEXT,
    "firstVerdict" "public"."IntegrityVerdict",
    "firstRationale" TEXT,
    "firstDecidedAt" TIMESTAMP(3),
    "secondReviewerId" TEXT,
    "secondVerdict" "public"."IntegrityVerdict",
    "secondRationale" TEXT,
    "secondDecidedAt" TIMESTAMP(3),
    "outcome" "public"."AppealOutcome" NOT NULL DEFAULT 'PENDING',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrityAppeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InvigilatorMessage" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "requiresAck" BOOLEAN NOT NULL DEFAULT true,
    "sentById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "InvigilatorMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AttemptTermination" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptTermination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrityFlag_attemptId_key" ON "public"."IntegrityFlag"("attemptId");

-- CreateIndex
CREATE INDEX "IntegrityFlag_status_reviewDeadline_idx" ON "public"."IntegrityFlag"("status", "reviewDeadline");

-- CreateIndex
CREATE INDEX "IntegrityFlag_band_flaggedAt_idx" ON "public"."IntegrityFlag"("band", "flaggedAt");

-- CreateIndex
CREATE INDEX "IntegrityReview_reviewerId_decidedAt_idx" ON "public"."IntegrityReview"("reviewerId", "decidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrityReview_flagId_reviewerId_key" ON "public"."IntegrityReview"("flagId", "reviewerId");

-- CreateIndex
CREATE INDEX "IntegrityAppeal_outcome_decideBy_idx" ON "public"."IntegrityAppeal"("outcome", "decideBy");

-- CreateIndex
CREATE INDEX "IntegrityAppeal_studentId_submittedAt_idx" ON "public"."IntegrityAppeal"("studentId", "submittedAt");

-- CreateIndex
CREATE INDEX "InvigilatorMessage_attemptId_sentAt_idx" ON "public"."InvigilatorMessage"("attemptId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttemptTermination_attemptId_key" ON "public"."AttemptTermination"("attemptId");

-- CreateIndex
CREATE INDEX "AttemptTermination_confirmedAt_idx" ON "public"."AttemptTermination"("confirmedAt");

-- AddForeignKey
ALTER TABLE "public"."IntegrityFlag" ADD CONSTRAINT "IntegrityFlag_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."AssessmentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."IntegrityReview" ADD CONSTRAINT "IntegrityReview_flagId_fkey" FOREIGN KEY ("flagId") REFERENCES "public"."IntegrityFlag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."IntegrityReview" ADD CONSTRAINT "IntegrityReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."IntegrityAppeal" ADD CONSTRAINT "IntegrityAppeal_flagId_fkey" FOREIGN KEY ("flagId") REFERENCES "public"."IntegrityFlag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."IntegrityAppeal" ADD CONSTRAINT "IntegrityAppeal_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."InvigilatorMessage" ADD CONSTRAINT "InvigilatorMessage_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."AssessmentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AttemptTermination" ADD CONSTRAINT "AttemptTermination_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."AssessmentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────
-- Phase 6e, hand-written half. Everything above is Prisma's output.
--
-- Note on the regexes below: there are none. Postgres caps a bounded regex
-- repetition at 255 and parses the pattern LAZILY, so a CHECK with
-- '{40,4000}' in it is created happily and fails on every insert (Phase 6d,
-- docs/CONVENTIONS.md). Lengths are length() BETWEEN.

-- ── IntegrityFlag ───────────────────────────────────────────────────────
ALTER TABLE "public"."IntegrityFlag"
  ADD CONSTRAINT "IntegrityFlag_points_check"
    CHECK ("substantivePoints" >= 0 AND "contextPoints" >= 0),
  -- 1 at MEDIUM, 2 at HIGH, 0 otherwise. The number is derived from the
  -- band, so a flag cannot claim to need a different number of reviewers
  -- from the one its band calls for.
  ADD CONSTRAINT "IntegrityFlag_reviewers_check"
    CHECK ("reviewersRequired" = CASE "band" WHEN 'HIGH' THEN 2 WHEN 'MEDIUM' THEN 1 ELSE 0 END),
  -- A NONE band is not a flag at all; a row must not exist for one.
  ADD CONSTRAINT "IntegrityFlag_band_check"
    CHECK ("band" <> 'NONE'),
  ADD CONSTRAINT "IntegrityFlag_deadline_check"
    CHECK ("reviewDeadline" > "flaggedAt"),
  -- Resolved exactly when the status says so.
  ADD CONSTRAINT "IntegrityFlag_resolved_check"
    CHECK (("status" = 'OPEN') = ("resolvedAt" IS NULL)),
  -- A resolved flag is never still withheld, and an OPEN one always is:
  -- "withhold from the public leaderboard" is the WHOLE automatic
  -- consequence, so it has to end when the review does.
  ADD CONSTRAINT "IntegrityFlag_withheld_check"
    CHECK (("status" = 'OPEN') = ("withheld" = true));

-- A flag's identity and its score are written once, and it never moves
-- backwards to OPEN.
--
-- The band in particular: re-banding a flag after a reviewer has read it
-- would change what a verdict was a verdict ABOUT. If the thresholds are
-- retuned (SPEC section 5 expects them to be), the retune applies to new
-- flags; the old ones stand as they were judged.
CREATE OR REPLACE FUNCTION recx_refuse_integrity_flag_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IntegrityFlag % is never deleted (a student may appeal it)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW."id", NEW."attemptId", NEW."band", NEW."substantivePoints", NEW."flaggedAt", NEW."reviewDeadline")
     IS DISTINCT FROM
     (OLD."id", OLD."attemptId", OLD."band", OLD."substantivePoints", OLD."flaggedAt", OLD."reviewDeadline") THEN
    RAISE EXCEPTION 'IntegrityFlag %: the band, the points and the deadline are written once. A retune applies to new flags', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."status" <> 'OPEN' AND NEW."status" = 'OPEN' THEN
    RAISE EXCEPTION 'IntegrityFlag % is already resolved; it cannot be reopened', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Only an appeal reaches OVERTURNED, and only from UPHELD.
  IF NEW."status" = 'OVERTURNED' AND OLD."status" <> 'UPHELD' THEN
    RAISE EXCEPTION 'IntegrityFlag %: only an upheld flag can be overturned', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "IntegrityFlag_write_once"
  BEFORE UPDATE OR DELETE ON "public"."IntegrityFlag"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_integrity_flag_change();

-- ── IntegrityReview ─────────────────────────────────────────────────────
ALTER TABLE "public"."IntegrityReview"
  -- A WRITTEN rationale. 40 characters is not an arbitrary floor: it is
  -- about the shortest a real sentence runs, and it is what stops "ok",
  -- "cleared" and "looks fine" standing as the reason a student's result was
  -- withheld. SPEC section 5 requires the verdict to carry one, and the
  -- student reads it in their own report.
  ADD CONSTRAINT "IntegrityReview_rationale_check"
    CHECK (length(btrim("rationale")) BETWEEN 40 AND 4000);

-- A verdict is final and is never rewritten. A reviewer who changes their
-- mind records a new verdict on the appeal, where a second person sees it.
CREATE OR REPLACE FUNCTION recx_refuse_review_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IntegrityReview % is never deleted: it is the record of a human decision', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'IntegrityReview % is never changed. Record a new verdict on an appeal instead', OLD."id"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "IntegrityReview_append_only"
  BEFORE UPDATE OR DELETE ON "public"."IntegrityReview"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_review_change();

-- ── IntegrityAppeal ─────────────────────────────────────────────────────
ALTER TABLE "public"."IntegrityAppeal"
  -- The student's own words, and enough of them to be an appeal.
  ADD CONSTRAINT "IntegrityAppeal_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 20 AND 4000),
  ADD CONSTRAINT "IntegrityAppeal_window_check"
    CHECK ("decideBy" > "submittedAt"),
  -- Each reviewer's verdict comes with their rationale and their moment, or
  -- with none of the three.
  --
  -- `"firstRationale" IS NOT NULL` is not redundant, and leaving it out was a
  -- real bug caught by integrity-invariants.db.test.ts. A CHECK constraint in
  -- Postgres is satisfied unless it evaluates to FALSE — and
  -- `length(btrim(NULL)) BETWEEN 40 AND 4000` is NULL, not false. So the
  -- second disjunct came out NULL, `false OR NULL` is NULL, and a verdict
  -- with no rationale at all was accepted: exactly the write this constraint
  -- exists to refuse. Any CHECK that reaches through a nullable column needs
  -- its own IS NOT NULL.
  ADD CONSTRAINT "IntegrityAppeal_first_check"
    CHECK (
      ("firstReviewerId" IS NULL AND "firstVerdict" IS NULL AND "firstRationale" IS NULL AND "firstDecidedAt" IS NULL)
      OR ("firstReviewerId" IS NOT NULL AND "firstVerdict" IS NOT NULL AND "firstDecidedAt" IS NOT NULL
          AND "firstRationale" IS NOT NULL AND length(btrim("firstRationale")) BETWEEN 40 AND 4000)
    ),
  ADD CONSTRAINT "IntegrityAppeal_second_check"
    CHECK (
      ("secondReviewerId" IS NULL AND "secondVerdict" IS NULL AND "secondRationale" IS NULL AND "secondDecidedAt" IS NULL)
      OR ("secondReviewerId" IS NOT NULL AND "secondVerdict" IS NOT NULL AND "secondDecidedAt" IS NOT NULL
          AND "secondRationale" IS NOT NULL AND length(btrim("secondRationale")) BETWEEN 40 AND 4000)
    ),
  -- TWO people. The same person twice is not two people, and this is the
  -- constraint that says so (SPEC section 5: a two-person appeal).
  ADD CONSTRAINT "IntegrityAppeal_two_person_check"
    CHECK ("secondReviewerId" IS NULL OR "secondReviewerId" <> "firstReviewerId"),
  -- The second reviewer cannot arrive before the first.
  ADD CONSTRAINT "IntegrityAppeal_order_check"
    CHECK ("secondReviewerId" IS NULL OR "firstReviewerId" IS NOT NULL),
  -- A student never appeals their own appeal into a decision: the outcome is
  -- resolved exactly when it is not PENDING.
  ADD CONSTRAINT "IntegrityAppeal_resolved_check"
    CHECK (("outcome" = 'PENDING') = ("resolvedAt" IS NULL)),
  -- An appeal is decided only once both reviewers have spoken.
  ADD CONSTRAINT "IntegrityAppeal_complete_check"
    CHECK ("outcome" = 'PENDING' OR ("firstVerdict" IS NOT NULL AND "secondVerdict" IS NOT NULL));

-- The student's words, the flag it is about and each recorded verdict are
-- written once. An appeal whose reason could be edited afterwards is not a
-- record of anything.
CREATE OR REPLACE FUNCTION recx_refuse_appeal_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IntegrityAppeal % is never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF (NEW."id", NEW."flagId", NEW."studentId", NEW."reason", NEW."submittedAt", NEW."decideBy")
     IS DISTINCT FROM
     (OLD."id", OLD."flagId", OLD."studentId", OLD."reason", OLD."submittedAt", OLD."decideBy") THEN
    RAISE EXCEPTION 'IntegrityAppeal %: the student''s words, the flag and the window are written once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."firstVerdict" IS NOT NULL
     AND (NEW."firstReviewerId", NEW."firstVerdict", NEW."firstRationale") IS DISTINCT FROM
         (OLD."firstReviewerId", OLD."firstVerdict", OLD."firstRationale") THEN
    RAISE EXCEPTION 'IntegrityAppeal %: a recorded verdict is never rewritten', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."secondVerdict" IS NOT NULL
     AND (NEW."secondReviewerId", NEW."secondVerdict", NEW."secondRationale") IS DISTINCT FROM
         (OLD."secondReviewerId", OLD."secondVerdict", OLD."secondRationale") THEN
    RAISE EXCEPTION 'IntegrityAppeal %: a recorded verdict is never rewritten', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."outcome" <> 'PENDING' AND NEW."outcome" <> OLD."outcome" THEN
    RAISE EXCEPTION 'IntegrityAppeal % is already decided', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "IntegrityAppeal_write_once"
  BEFORE UPDATE OR DELETE ON "public"."IntegrityAppeal"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_appeal_change();

-- ── InvigilatorMessage ──────────────────────────────────────────────────
ALTER TABLE "public"."InvigilatorMessage"
  ADD CONSTRAINT "InvigilatorMessage_body_check"
    CHECK (length(btrim("body")) BETWEEN 1 AND 2000),
  ADD CONSTRAINT "InvigilatorMessage_ack_check"
    CHECK ("acknowledgedAt" IS NULL OR "acknowledgedAt" >= "sentAt");

-- The body is written once and the acknowledgement happens once: SPEC
-- section 5 wants the acknowledgement RECORDED, and a record that can be
-- rewritten records nothing.
CREATE OR REPLACE FUNCTION recx_refuse_message_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'InvigilatorMessage % is never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."attemptId", NEW."body", NEW."requiresAck", NEW."sentById", NEW."sentAt") IS DISTINCT FROM
     (OLD."attemptId", OLD."body", OLD."requiresAck", OLD."sentById", OLD."sentAt") THEN
    RAISE EXCEPTION 'InvigilatorMessage %: what was sent, by whom and when is written once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."acknowledgedAt" IS NOT NULL AND NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt" THEN
    RAISE EXCEPTION 'InvigilatorMessage % was already acknowledged', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "InvigilatorMessage_write_once"
  BEFORE UPDATE OR DELETE ON "public"."InvigilatorMessage"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_message_change();

-- ── AttemptTermination ──────────────────────────────────────────────────
ALTER TABLE "public"."AttemptTermination"
  ADD CONSTRAINT "AttemptTermination_reason_check"
    CHECK (length(btrim("reason")) BETWEEN 20 AND 2000),
  -- TWO staff. The requester is not the confirmer, and this CHECK is the
  -- whole two-person rule: SPEC section 5 requires "a second staff
  -- confirmation", and a rule enforced only in a route is a rule one future
  -- route forgets.
  ADD CONSTRAINT "AttemptTermination_two_person_check"
    CHECK ("confirmedById" IS NULL OR "confirmedById" <> "requestedById"),
  ADD CONSTRAINT "AttemptTermination_confirmed_check"
    CHECK (("confirmedById" IS NULL) = ("confirmedAt" IS NULL)),
  ADD CONSTRAINT "AttemptTermination_order_check"
    CHECK ("confirmedAt" IS NULL OR "confirmedAt" >= "requestedAt");

-- The request is written once, and a confirmation happens once.
CREATE OR REPLACE FUNCTION recx_refuse_termination_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AttemptTermination % is never deleted', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."attemptId", NEW."requestedById", NEW."reason", NEW."requestedAt") IS DISTINCT FROM
     (OLD."attemptId", OLD."requestedById", OLD."reason", OLD."requestedAt") THEN
    RAISE EXCEPTION 'AttemptTermination %: who asked, why and when is written once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."confirmedById" IS NOT NULL
     AND (NEW."confirmedById", NEW."confirmedAt") IS DISTINCT FROM (OLD."confirmedById", OLD."confirmedAt") THEN
    RAISE EXCEPTION 'AttemptTermination % was already confirmed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttemptTermination_write_once"
  BEFORE UPDATE OR DELETE ON "public"."AttemptTermination"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_termination_change();

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
CREATE TRIGGER "IntegrityFlag_no_truncate"
  BEFORE TRUNCATE ON "public"."IntegrityFlag"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "IntegrityReview_no_truncate"
  BEFORE TRUNCATE ON "public"."IntegrityReview"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "IntegrityAppeal_no_truncate"
  BEFORE TRUNCATE ON "public"."IntegrityAppeal"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "AttemptTermination_no_truncate"
  BEFORE TRUNCATE ON "public"."AttemptTermination"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
