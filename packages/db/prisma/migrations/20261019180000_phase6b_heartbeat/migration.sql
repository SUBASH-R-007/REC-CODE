-- Phase 6b, the heartbeat's own column.
--
-- The heartbeat carries the client's message sequence number, and SEQUENCE_GAP
-- is one of the 25 ProctorEventKinds the spec enumerates. Detecting a gap
-- needs a server-side high-water mark: the events themselves cannot supply it,
-- because the whole point of the kind is a run of numbers whose events never
-- arrived.
--
-- Nullable rather than defaulted to a sentinel, so "no client message yet" is
-- a state the column states rather than one the reader has to infer from -1.
ALTER TABLE "public"."AssessmentAttempt"
  ADD COLUMN     "lastClientSeq" INTEGER,
  ADD CONSTRAINT "AssessmentAttempt_client_seq_check"
    CHECK ("lastClientSeq" IS NULL OR "lastClientSeq" >= 0);
