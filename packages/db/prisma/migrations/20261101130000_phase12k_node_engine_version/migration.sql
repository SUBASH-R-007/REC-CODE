-- Phase 12k, slice 5: a judge node's ENGINE version.
--
-- The fleet has two engines now, and the row that describes a node could
-- only say how old its isolate was. A SQL node has no isolate at all: what
-- an ops person needs from it is the database's own version, because that
-- is the thing a verdict depends on — a cluster upgraded under a published
-- problem can change what a query returns.
--
-- `isolateVersion` is NOT reused for it. A column named after one engine,
-- holding another engine's version, is the kind of small lie that costs an
-- hour during an incident.
--
-- Additive and nullable-free: one column with a default, so every existing
-- row is correct the moment it lands (an isolate node has no engine
-- version of its own, and "" is what the heartbeat already sends).

-- AlterTable
ALTER TABLE "public"."JudgeNode" ADD COLUMN     "engineVersion" TEXT NOT NULL DEFAULT '';
