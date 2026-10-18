-- CreateEnum
CREATE TYPE "public"."ContestKind" AS ENUM ('ICPC', 'SUBTASK');

-- CreateEnum
CREATE TYPE "public"."ContestStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RUNNING', 'FINISHED', 'RATED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ContestVisibility" AS ENUM ('PUBLIC', 'COHORT');

-- CreateEnum
CREATE TYPE "public"."ParticipationKind" AS ENUM ('RATED', 'UNRATED', 'VIRTUAL');

-- CreateEnum
CREATE TYPE "public"."ContestDivision" AS ENUM ('DIV3', 'DIV2', 'DIV1');

-- CreateTable
CREATE TABLE "public"."Contest" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rules" TEXT NOT NULL,
    "kind" "public"."ContestKind" NOT NULL DEFAULT 'ICPC',
    "status" "public"."ContestStatus" NOT NULL DEFAULT 'DRAFT',
    "visibility" "public"."ContestVisibility" NOT NULL DEFAULT 'PUBLIC',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "freezeMinutes" INTEGER NOT NULL DEFAULT 30,
    "isRated" BOOLEAN NOT NULL DEFAULT true,
    "audienceBatchYear" INTEGER,
    "audienceDepartmentCode" TEXT,
    "ratingComputedAt" TIMESTAMP(3),
    "ratedParticipants" INTEGER,
    "standingsVersion" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ContestProblem" (
    "id" TEXT NOT NULL,
    "contestId" TEXT NOT NULL,
    "problemVersionId" TEXT NOT NULL,
    "index" TEXT NOT NULL,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContestProblem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ContestRegistration" (
    "id" TEXT NOT NULL,
    "contestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "public"."ParticipationKind" NOT NULL DEFAULT 'RATED',
    "virtualStartsAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContestRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ContestProblemAttempt" (
    "contestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contestProblemId" TEXT NOT NULL,
    "wrongAttempts" INTEGER NOT NULL DEFAULT 0,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "solvedAt" TIMESTAMP(3),
    "solvedAtMinutes" INTEGER,
    "penaltyMinutes" INTEGER NOT NULL DEFAULT 0,
    "bestSubmissionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContestProblemAttempt_pkey" PRIMARY KEY ("contestId","userId","contestProblemId")
);

-- CreateTable
CREATE TABLE "public"."ContestStanding" (
    "contestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "penalty" INTEGER NOT NULL DEFAULT 0,
    "solved" INTEGER NOT NULL DEFAULT 0,
    "lastAcceptedAt" TIMESTAMP(3),
    "rank" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContestStanding_pkey" PRIMARY KEY ("contestId","userId")
);

-- CreateTable
CREATE TABLE "public"."RatingChange" (
    "id" TEXT NOT NULL,
    "contestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "before" INTEGER NOT NULL,
    "after" INTEGER NOT NULL,
    "delta" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "seed" DOUBLE PRECISION NOT NULL,
    "ratedCount" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RatingChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserRating" (
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL DEFAULT 1200,
    "contestsRated" INTEGER NOT NULL DEFAULT 0,
    "lastRatedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserRating_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Contest_slug_key" ON "public"."Contest"("slug");

-- CreateIndex
CREATE INDEX "Contest_status_startsAt_idx" ON "public"."Contest"("status", "startsAt" DESC);

-- CreateIndex
CREATE INDEX "Contest_startsAt_idx" ON "public"."Contest"("startsAt");

-- CreateIndex
CREATE INDEX "ContestProblem_problemVersionId_idx" ON "public"."ContestProblem"("problemVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "ContestProblem_contestId_index_key" ON "public"."ContestProblem"("contestId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "ContestProblem_contestId_problemVersionId_key" ON "public"."ContestProblem"("contestId", "problemVersionId");

-- CreateIndex
CREATE INDEX "ContestRegistration_userId_registeredAt_idx" ON "public"."ContestRegistration"("userId", "registeredAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ContestRegistration_contestId_userId_kind_key" ON "public"."ContestRegistration"("contestId", "userId", "kind");

-- CreateIndex
CREATE INDEX "ContestProblemAttempt_contestId_contestProblemId_idx" ON "public"."ContestProblemAttempt"("contestId", "contestProblemId");

-- CreateIndex
CREATE INDEX "ContestProblemAttempt_userId_contestId_idx" ON "public"."ContestProblemAttempt"("userId", "contestId");

-- CreateIndex
CREATE INDEX "ContestStanding_contestId_score_penalty_lastAcceptedAt_idx" ON "public"."ContestStanding"("contestId", "score" DESC, "penalty", "lastAcceptedAt");

-- CreateIndex
CREATE INDEX "RatingChange_userId_computedAt_idx" ON "public"."RatingChange"("userId", "computedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "RatingChange_contestId_userId_key" ON "public"."RatingChange"("contestId", "userId");

-- CreateIndex
CREATE INDEX "UserRating_rating_idx" ON "public"."UserRating"("rating" DESC);

-- AddForeignKey
ALTER TABLE "public"."ContestProblem" ADD CONSTRAINT "ContestProblem_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "public"."Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContestProblem" ADD CONSTRAINT "ContestProblem_problemVersionId_fkey" FOREIGN KEY ("problemVersionId") REFERENCES "public"."ProblemVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContestRegistration" ADD CONSTRAINT "ContestRegistration_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "public"."Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContestRegistration" ADD CONSTRAINT "ContestRegistration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContestProblemAttempt" ADD CONSTRAINT "ContestProblemAttempt_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "public"."Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContestProblemAttempt" ADD CONSTRAINT "ContestProblemAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContestProblemAttempt" ADD CONSTRAINT "ContestProblemAttempt_contestProblemId_fkey" FOREIGN KEY ("contestProblemId") REFERENCES "public"."ContestProblem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContestStanding" ADD CONSTRAINT "ContestStanding_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "public"."Contest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContestStanding" ADD CONSTRAINT "ContestStanding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RatingChange" ADD CONSTRAINT "RatingChange_contestId_fkey" FOREIGN KEY ("contestId") REFERENCES "public"."Contest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RatingChange" ADD CONSTRAINT "RatingChange_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."UserRating" ADD CONSTRAINT "UserRating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 5 contests: the invariants Prisma cannot model (CHECKs, triggers).
-- Everything above this line is Prisma's own CreateTable/CreateIndex output,
-- so `prisma migrate diff` stays clean; everything below is hand-written and
-- is listed in packages/db/test/support/guard-catalog.ts, where
-- frozen-coverage.test.ts (static) checks that no later migration drops,
-- disables or weakens it and guard-state.db.test.ts checks the live database.
--
-- Every refusal raises ERRCODE check_violation (SQLSTATE 23514), as in
-- Phase 4. Clock rules follow 20261010100080: the columns are timestamp(3)
-- holding UTC wall-clock time, so every comparison uses
-- statement_timestamp() AT TIME ZONE 'UTC'.

-- ── Contest: the window, the freeze rule and the rated rules ─────────────
-- The 90-minute freeze rule is SPEC §5: a freeze only on a contest at least
-- 90 minutes long, and a window that does not swallow the contest. 0
-- disables it. Kept identical to canFreeze() in @recx/shared
-- (contest-scoring.ts), which the UI and the board use.
ALTER TABLE "public"."Contest"
  ADD CONSTRAINT "Contest_window_check"
    CHECK ("endsAt" > "startsAt"),
  ADD CONSTRAINT "Contest_freeze_check"
    CHECK (
      "freezeMinutes" >= 0
      AND (
        "freezeMinutes" = 0
        OR (
          EXTRACT(EPOCH FROM ("endsAt" - "startsAt")) >= 90 * 60
          AND "freezeMinutes" * 60 < EXTRACT(EPOCH FROM ("endsAt" - "startsAt"))
        )
      )
    ),
  -- A RATED contest has been through the rating transaction.
  ADD CONSTRAINT "Contest_rated_check"
    CHECK ("status" <> 'RATED' OR "ratingComputedAt" IS NOT NULL),
  -- …and had a field of at least MIN_RATED_PARTICIPANTS (30). A smaller
  -- field is automatically unrated and says so before the start.
  ADD CONSTRAINT "Contest_rated_min_check"
    CHECK ("status" <> 'RATED' OR ("ratedParticipants" IS NOT NULL AND "ratedParticipants" >= 30)),
  ADD CONSTRAINT "Contest_rated_participants_check"
    CHECK ("ratedParticipants" IS NULL OR "ratedParticipants" >= 0),
  ADD CONSTRAINT "Contest_standings_version_check"
    CHECK ("standingsVersion" >= 0),
  ADD CONSTRAINT "Contest_slug_check"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT "Contest_title_check"
    CHECK (char_length("title") BETWEEN 1 AND 120),
  ADD CONSTRAINT "Contest_rules_check"
    CHECK (char_length("rules") BETWEEN 1 AND 20000);

-- ratingComputedAt and ratedParticipants are written once, together, and
-- never cleared or changed. The rating transaction takes
-- SELECT … FOR UPDATE on this row and aborts when ratingComputedAt is
-- already set; this trigger is the database's own half of that, so a second
-- computation cannot rewrite history even by raw SQL. Idempotence is a gate
-- test (SPEC §5, Phase 5 "Done when").
CREATE OR REPLACE FUNCTION recx_refuse_contest_rating_rewrite() RETURNS trigger AS $$
BEGIN
  IF OLD."ratingComputedAt" IS NOT NULL
     AND NEW."ratingComputedAt" IS DISTINCT FROM OLD."ratingComputedAt" THEN
    RAISE EXCEPTION 'Contest % was rated at %: ratingComputedAt is final', OLD."id", OLD."ratingComputedAt"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."ratedParticipants" IS NOT NULL
     AND NEW."ratedParticipants" IS DISTINCT FROM OLD."ratedParticipants" THEN
    RAISE EXCEPTION 'Contest %: ratedParticipants is written with the rating and is then final', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The two are written by the same UPDATE.
  IF (NEW."ratingComputedAt" IS NULL) <> (NEW."ratedParticipants" IS NULL) THEN
    RAISE EXCEPTION 'Contest %: ratingComputedAt and ratedParticipants are set together', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- A rated contest is never un-rated, and never reopens.
  IF OLD."status" = 'RATED' AND NEW."status" <> 'RATED' THEN
    RAISE EXCEPTION 'Contest % is RATED (final): its status never changes', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  -- The window is fixed once the contest is open to students.
  IF OLD."status" <> 'DRAFT'
     AND (NEW."startsAt", NEW."endsAt", NEW."kind", NEW."isRated") IS DISTINCT FROM
         (OLD."startsAt", OLD."endsAt", OLD."kind", OLD."isRated") THEN
    RAISE EXCEPTION 'Contest % is published: its window, kind and rated flag are fixed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Contest_rating_once"
  BEFORE UPDATE ON "public"."Contest"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_contest_rating_rewrite();

-- ── ContestProblem: the pinned version is frozen, and stays pinned ───────
-- SPEC §4a and §7: a contest references a frozen ProblemVersion, never
-- Problem.liveVersionId. Enforcing "frozen at INSERT" in the database is
-- what makes "a mid-contest problem edit does not change any already-judged
-- verdict" true by construction rather than by care.
ALTER TABLE "public"."ContestProblem"
  ADD CONSTRAINT "ContestProblem_points_check"
    CHECK ("points" > 0),
  ADD CONSTRAINT "ContestProblem_index_check"
    CHECK ("index" ~ '^[A-Z]{1,2}$');

CREATE OR REPLACE FUNCTION recx_refuse_unfrozen_contest_problem() RETURNS trigger AS $$
DECLARE
  frozen timestamp(3);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW."contestId", NEW."problemVersionId", NEW."index") IS DISTINCT FROM
       (OLD."contestId", OLD."problemVersionId", OLD."index") THEN
      RAISE EXCEPTION 'ContestProblem %: contestId, problemVersionId and index never change (remove it and add another)', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT v."frozenAt" INTO frozen
    FROM "public"."ProblemVersion" v
   WHERE v."id" = NEW."problemVersionId";
  IF frozen IS NULL THEN
    RAISE EXCEPTION 'ContestProblem %: problem version % is not frozen; a contest pins a published revision, never a draft or the live pointer', NEW."id", NEW."problemVersionId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ContestProblem_frozen_version"
  BEFORE INSERT OR UPDATE ON "public"."ContestProblem"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_unfrozen_contest_problem();

-- ── ContestRegistration: a virtual run carries its own clock ────────────
ALTER TABLE "public"."ContestRegistration"
  ADD CONSTRAINT "ContestRegistration_virtual_check"
    CHECK (("kind" = 'VIRTUAL') = ("virtualStartsAt" IS NOT NULL));

-- ── ContestProblemAttempt: the authoritative row ────────────────────────
-- A solve always names the submission that earned it, so the board can be
-- audited back to a verdict.
ALTER TABLE "public"."ContestProblemAttempt"
  ADD CONSTRAINT "ContestProblemAttempt_counts_check"
    CHECK ("wrongAttempts" >= 0 AND "penaltyMinutes" >= 0),
  ADD CONSTRAINT "ContestProblemAttempt_points_check"
    CHECK ("points" >= 0),
  ADD CONSTRAINT "ContestProblemAttempt_solved_check"
    CHECK (
      ("solvedAt" IS NULL AND "solvedAtMinutes" IS NULL AND "bestSubmissionId" IS NULL)
      OR ("solvedAt" IS NOT NULL AND "solvedAtMinutes" IS NOT NULL AND "bestSubmissionId" IS NOT NULL)
    ),
  ADD CONSTRAINT "ContestProblemAttempt_solved_minutes_check"
    CHECK ("solvedAtMinutes" IS NULL OR "solvedAtMinutes" >= 0),
  -- An unsolved problem carries no penalty: SPEC §5 is explicit that a
  -- rejected submission on a problem never solved costs nothing.
  ADD CONSTRAINT "ContestProblemAttempt_unsolved_penalty_check"
    CHECK ("solvedAt" IS NOT NULL OR "penaltyMinutes" = 0);

-- ── ContestStanding: a materialised view, never the truth ───────────────
ALTER TABLE "public"."ContestStanding"
  ADD CONSTRAINT "ContestStanding_rank_check"
    CHECK ("rank" IS NULL OR "rank" >= 1),
  ADD CONSTRAINT "ContestStanding_values_check"
    CHECK ("score" >= 0 AND "penalty" >= 0 AND "solved" >= 0 AND "version" >= 0);

-- ── RatingChange: append-only, and arithmetically self-consistent ───────
-- after = before + delta is checked in the database so a row can never
-- disagree with itself, and |delta| <= 200 is RATING_CLAMP from
-- @recx/shared (rating.ts).
ALTER TABLE "public"."RatingChange"
  ADD CONSTRAINT "RatingChange_delta_check"
    CHECK ("after" = "before" + "delta" AND abs("delta") <= 200),
  ADD CONSTRAINT "RatingChange_values_check"
    CHECK ("before" >= 0 AND "after" >= 0 AND "rank" >= 1 AND "seed" > 0 AND "ratedCount" >= 1);

-- The XpEvent rule: a rating history row is never rewritten or removed, so a
-- disputed rating can always be recomputed from what was stored.
CREATE OR REPLACE FUNCTION recx_refuse_rating_change_write() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'RatingChange % is append-only and is never updated (a correction is a new contest computation)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'RatingChange % is append-only and is never deleted', OLD."id"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RatingChange_append_only"
  BEFORE UPDATE OR DELETE ON "public"."RatingChange"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_rating_change_write();

-- ── UserRating ──────────────────────────────────────────────────────────
ALTER TABLE "public"."UserRating"
  ADD CONSTRAINT "UserRating_values_check"
    CHECK ("rating" >= 0 AND "contestsRated" >= 0);

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
-- Same shape as Phase 4 (recx_refuse_truncate already exists). The standings
-- are rebuildable from the attempts, but never by accident.
CREATE TRIGGER "Contest_no_truncate"
  BEFORE TRUNCATE ON "public"."Contest"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "ContestProblemAttempt_no_truncate"
  BEFORE TRUNCATE ON "public"."ContestProblemAttempt"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "ContestStanding_no_truncate"
  BEFORE TRUNCATE ON "public"."ContestStanding"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "RatingChange_no_truncate"
  BEFORE TRUNCATE ON "public"."RatingChange"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
