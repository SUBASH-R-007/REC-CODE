-- CreateEnum
CREATE TYPE "public"."SnapshotTrigger" AS ENUM ('TICK', 'RUN', 'SUBMIT', 'PASTE');

-- CreateTable
CREATE TABLE "public"."AssessmentAttempt" (
    "id" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "examSessionId" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "status" "public"."AttemptStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "seed" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "pausedMs" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3),
    "totalScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "maxScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "layout" JSONB NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "deviceRegistrationId" TEXT,
    "ipHashFirst" TEXT,
    "ipHashLast" TEXT,
    "uaHash" TEXT,
    "lockSessionId" TEXT,
    "proctorMode" "public"."ProctorMode" NOT NULL,
    "accommodationFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "heartbeatBitmap" BYTEA,
    "heartbeatSlotSeconds" INTEGER NOT NULL DEFAULT 15,
    "lastHeartbeatAt" TIMESTAMP(3),
    "blurEventCount" INTEGER NOT NULL DEFAULT 0,
    "fullscreenExitCount" INTEGER NOT NULL DEFAULT 0,
    "pasteEventCount" INTEGER NOT NULL DEFAULT 0,
    "maxHeartbeatGapSeconds" INTEGER NOT NULL DEFAULT 0,
    "integrityScore" INTEGER NOT NULL DEFAULT 100,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AttemptSnapshot" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "atMs" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "isDiff" BOOLEAN NOT NULL DEFAULT false,
    "trigger" "public"."SnapshotTrigger" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProctorEvent" (
    "id" BIGSERIAL NOT NULL,
    "attemptId" TEXT NOT NULL,
    "kind" "public"."ProctorEventKind" NOT NULL,
    "source" "public"."EventSource" NOT NULL,
    "severity" "public"."Severity" NOT NULL DEFAULT 'INFO',
    "clientSeq" INTEGER,
    "atMs" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "size" INTEGER,
    "hash" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProctorEvent_pkey" PRIMARY KEY ("id","occurredAt")
) PARTITION BY RANGE ("occurredAt");

-- CreateIndex
CREATE INDEX "AssessmentAttempt_status_expiresAt_idx" ON "public"."AssessmentAttempt"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "AssessmentAttempt_assessmentId_integrityScore_idx" ON "public"."AssessmentAttempt"("assessmentId", "integrityScore");

-- CreateIndex
CREATE INDEX "AssessmentAttempt_examSessionId_status_idx" ON "public"."AssessmentAttempt"("examSessionId", "status");

-- CreateIndex
CREATE INDEX "AssessmentAttempt_userId_startedAt_idx" ON "public"."AssessmentAttempt"("userId", "startedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "AssessmentAttempt_assessmentId_userId_attemptNumber_key" ON "public"."AssessmentAttempt"("assessmentId", "userId", "attemptNumber");

-- CreateIndex
CREATE INDEX "AttemptSnapshot_attemptId_questionId_atMs_idx" ON "public"."AttemptSnapshot"("attemptId", "questionId", "atMs");

-- CreateIndex
CREATE INDEX "ProctorEvent_attemptId_atMs_idx" ON "public"."ProctorEvent"("attemptId", "atMs");

-- CreateIndex
CREATE INDEX "ProctorEvent_attemptId_severity_idx" ON "public"."ProctorEvent"("attemptId", "severity");

-- CreateIndex
CREATE INDEX "ProctorEvent_occurredAt_idx" ON "public"."ProctorEvent"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProctorEvent_attemptId_clientSeq_occurredAt_key" ON "public"."ProctorEvent"("attemptId", "clientSeq", "occurredAt");

-- AddForeignKey
ALTER TABLE "public"."AssessmentAttempt" ADD CONSTRAINT "AssessmentAttempt_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "public"."Assessment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AssessmentAttempt" ADD CONSTRAINT "AssessmentAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AssessmentAttempt" ADD CONSTRAINT "AssessmentAttempt_examSessionId_fkey" FOREIGN KEY ("examSessionId") REFERENCES "public"."ExamSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AttemptSnapshot" ADD CONSTRAINT "AttemptSnapshot_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."AssessmentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Phase 6b, hand-written half. Everything above is Prisma's output, except
-- that ProctorEvent's CREATE TABLE was turned into PARTITION BY RANGE
-- ("occurredAt") and its unique index widened to include the partition key —
-- Postgres requires every partition column in a unique index on a
-- partitioned table.
--
-- Prisma does not model partitions, so the columns are identical either way
-- and `prisma migrate diff` still reports no drift.

-- ── ProctorEvent partitions ──────────────────────────────────────────────
-- Monthly from day one (SPEC §4): "a college-wide exam adds millions of rows
-- that must be dropped wholesale by DETACH PARTITION at the retention
-- boundary". Created ahead for the first year so nothing depends on a job
-- having run; `proctor_event_default` catches anything outside the range so
-- an insert can never fail for want of a partition, and the scheduler's
-- retention job detaches and drops by month.
CREATE TABLE "public"."proctor_event_2026_10" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "public"."proctor_event_2026_11" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE "public"."proctor_event_2026_12" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE "public"."proctor_event_2027_01" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE "public"."proctor_event_2027_02" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE "public"."proctor_event_2027_03" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE "public"."proctor_event_2027_04" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2027-04-01') TO ('2027-05-01');
CREATE TABLE "public"."proctor_event_2027_05" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2027-05-01') TO ('2027-06-01');
CREATE TABLE "public"."proctor_event_2027_06" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2027-06-01') TO ('2027-07-01');
CREATE TABLE "public"."proctor_event_2027_07" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2027-07-01') TO ('2027-08-01');
CREATE TABLE "public"."proctor_event_2027_08" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2027-08-01') TO ('2027-09-01');
CREATE TABLE "public"."proctor_event_2027_09" PARTITION OF "public"."ProctorEvent"
  FOR VALUES FROM ('2027-09-01') TO ('2027-10-01');
-- A row outside every range lands here rather than failing the insert. A
-- non-empty default is an operational warning, not a correctness problem:
-- the monthly job creates the next partitions well ahead.
CREATE TABLE "public"."proctor_event_default" PARTITION OF "public"."ProctorEvent" DEFAULT;

-- ── ProctorEvent: shape only, never content ─────────────────────────────
-- SPEC §5: "Store event shape only: kind, timestamp, duration, byte size,
-- sha256, cadence statistics. Never clipboard text, never keystroke
-- content." The size cap is the structural half of that promise: 64 KB is
-- far more than any shape and far less than a pasted file.
ALTER TABLE "public"."ProctorEvent"
  ADD CONSTRAINT "ProctorEvent_atMs_check"
    CHECK ("atMs" >= 0),
  ADD CONSTRAINT "ProctorEvent_size_check"
    CHECK ("size" IS NULL OR ("size" >= 0 AND "size" <= 65536)),
  ADD CONSTRAINT "ProctorEvent_duration_check"
    CHECK ("durationMs" IS NULL OR "durationMs" >= 0),
  -- Only a client has a sequence to keep, and the sequence is what makes
  -- suppression detectable; a server or invigilator event has none.
  ADD CONSTRAINT "ProctorEvent_client_seq_check"
    CHECK (("source" = 'CLIENT') = ("clientSeq" IS NOT NULL)),
  ADD CONSTRAINT "ProctorEvent_client_seq_range_check"
    CHECK ("clientSeq" IS NULL OR "clientSeq" >= 0),
  -- A sha256, if present, is a sha256 — not somewhere to smuggle text.
  ADD CONSTRAINT "ProctorEvent_hash_check"
    CHECK ("hash" IS NULL OR "hash" ~ '^[a-f0-9]{64}$');

-- ── AssessmentAttempt ───────────────────────────────────────────────────
ALTER TABLE "public"."AssessmentAttempt"
  ADD CONSTRAINT "AssessmentAttempt_number_check"
    CHECK ("attemptNumber" >= 1),
  ADD CONSTRAINT "AssessmentAttempt_window_check"
    CHECK ("expiresAt" > "startedAt"),
  ADD CONSTRAINT "AssessmentAttempt_paused_check"
    CHECK ("pausedMs" >= 0),
  ADD CONSTRAINT "AssessmentAttempt_counts_check"
    CHECK ("blurEventCount" >= 0 AND "fullscreenExitCount" >= 0
           AND "pasteEventCount" >= 0 AND "maxHeartbeatGapSeconds" >= 0
           AND "version" >= 0),
  ADD CONSTRAINT "AssessmentAttempt_score_check"
    CHECK ("maxScore" >= 0 AND "totalScore" >= 0 AND "totalScore" <= "maxScore"),
  -- A review aid, never a gate (SPEC §0 caps the automatic consequence at
  -- flag-and-withhold). The bound keeps it readable as a percentage.
  ADD CONSTRAINT "AssessmentAttempt_integrity_check"
    CHECK ("integrityScore" BETWEEN 0 AND 100),
  ADD CONSTRAINT "AssessmentAttempt_slot_check"
    CHECK ("heartbeatSlotSeconds" BETWEEN 1 AND 60),
  -- submittedAt belongs to exactly the two submitted statuses.
  ADD CONSTRAINT "AssessmentAttempt_submitted_check"
    CHECK (("status" IN ('SUBMITTED', 'AUTO_SUBMITTED')) = ("submittedAt" IS NOT NULL));

-- The status machine, and "the clock is written once".
--
-- The transitions mirror canTransition() in @recx/shared exactly, including
-- the two that matter most:
--   * VOIDED is reachable ONLY from a finished status, so no automatic path
--     can ever reach it — §0's "no signal ever auto-penalises" made true of
--     the data rather than of the code;
--   * DISCONNECTED -> IN_PROGRESS is allowed, because a candidate whose wifi
--     dropped has not finished, and their clock never stopped.
CREATE OR REPLACE FUNCTION recx_refuse_attempt_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AssessmentAttempt % is never deleted (it is the record of a sitting)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- The clock, the paper and the identity of the sitting are written once.
  -- expiresAt in particular: it is computed server-side at start, and a
  -- later change would silently move a candidate's deadline.
  IF (NEW."id", NEW."assessmentId", NEW."userId", NEW."attemptNumber",
      NEW."seed", NEW."startedAt", NEW."expiresAt", NEW."layout", NEW."proctorMode")
     IS DISTINCT FROM
     (OLD."id", OLD."assessmentId", OLD."userId", OLD."attemptNumber",
      OLD."seed", OLD."startedAt", OLD."expiresAt", OLD."layout", OLD."proctorMode") THEN
    RAISE EXCEPTION 'AssessmentAttempt %: the sitting (ids, seed, clock, layout, proctor mode) is written once. Grant time with pausedMs instead of moving expiresAt', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
         (OLD."status" = 'NOT_STARTED'  AND NEW."status" = 'IN_PROGRESS')
      OR (OLD."status" = 'IN_PROGRESS'  AND NEW."status" IN ('DISCONNECTED','SUBMITTED','AUTO_SUBMITTED','EXPIRED','TERMINATED'))
      OR (OLD."status" = 'DISCONNECTED' AND NEW."status" IN ('IN_PROGRESS','AUTO_SUBMITTED','EXPIRED','TERMINATED'))
      OR (OLD."status" IN ('SUBMITTED','AUTO_SUBMITTED','EXPIRED','TERMINATED') AND NEW."status" = 'VOIDED')
    ) THEN
      RAISE EXCEPTION 'AssessmentAttempt % cannot move from % to %', OLD."id", OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Counters only ever rise: an event already recorded is not un-recorded.
  IF NEW."blurEventCount" < OLD."blurEventCount"
     OR NEW."fullscreenExitCount" < OLD."fullscreenExitCount"
     OR NEW."pasteEventCount" < OLD."pasteEventCount" THEN
    RAISE EXCEPTION 'AssessmentAttempt %: event counters only increase', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- A granted break only ever grows, too.
  IF NEW."pausedMs" < OLD."pausedMs" THEN
    RAISE EXCEPTION 'AssessmentAttempt %: pausedMs only increases (a granted break is never taken back)', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AssessmentAttempt_machine"
  BEFORE UPDATE OR DELETE ON "public"."AssessmentAttempt"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_attempt_change();

-- ── AttemptSnapshot ─────────────────────────────────────────────────────
-- The most probative artefact, so it is append-only: a snapshot is evidence
-- both ways — it convicts a paste and exonerates a student whose timeline
-- grows four lines a minute with failed runs in between.
ALTER TABLE "public"."AttemptSnapshot"
  ADD CONSTRAINT "AttemptSnapshot_atMs_check"
    CHECK ("atMs" >= 0),
  ADD CONSTRAINT "AttemptSnapshot_content_check"
    CHECK (octet_length("content") <= 65536),
  ADD CONSTRAINT "AttemptSnapshot_hash_check"
    CHECK ("contentHash" ~ '^[a-f0-9]{64}$');

CREATE OR REPLACE FUNCTION recx_refuse_snapshot_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AttemptSnapshot % is append-only evidence and is never %', OLD."id",
    CASE WHEN TG_OP = 'UPDATE' THEN 'updated' ELSE 'deleted here (the retention job detaches by age)' END
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttemptSnapshot_append_only"
  BEFORE UPDATE ON "public"."AttemptSnapshot"
  FOR EACH ROW EXECUTE FUNCTION recx_refuse_snapshot_change();

-- ── TRUNCATE guards ─────────────────────────────────────────────────────
CREATE TRIGGER "AssessmentAttempt_no_truncate"
  BEFORE TRUNCATE ON "public"."AssessmentAttempt"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();

CREATE TRIGGER "AttemptSnapshot_no_truncate"
  BEFORE TRUNCATE ON "public"."AttemptSnapshot"
  FOR EACH STATEMENT EXECUTE FUNCTION recx_refuse_truncate();
