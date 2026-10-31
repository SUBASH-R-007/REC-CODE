-- Phase 12b: the AI helper.
--
-- A student stuck on a PRACTICE problem asks what they have got wrong, or
-- what approach to take, and a model answers. This table is the record of
-- that: the finaliser reads it exactly as it reads HintReveal, because a
-- solve that followed an answer is ASSISTED and readiness is built on
-- unassisted evidence.
--
-- Three guarantees live in the data rather than only in the code path:
--
--   * PRACTICE only. The context column carries a CHECK rather than being
--     left implicit, so the promise made to every candidate — no assistant
--     in a contest or an assessment — survives a future caller that forgets.
--   * A failure is a failure. answer IS NULL exactly when failed, so a
--     broken ask cannot be read later as something the student was told.
--   * Append-only. A row here is what makes a later solve ASSISTED; if it
--     could be deleted or edited, the XP and the readiness number built on
--     it could be quietly re-written afterwards.

-- CreateEnum
CREATE TYPE "public"."AiAskKind" AS ENUM ('MISTAKE', 'APPROACH');

-- CreateTable
CREATE TABLE "public"."AiAssist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "problemId" TEXT NOT NULL,
    "context" "public"."HelpContext" NOT NULL DEFAULT 'PRACTICE',
    "kind" "public"."AiAskKind" NOT NULL,
    "modelId" TEXT NOT NULL,
    "answer" TEXT,
    "failed" BOOLEAN NOT NULL DEFAULT false,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "latencyMs" INTEGER,
    "askedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiAssist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiAssist_userId_problemId_idx" ON "public"."AiAssist"("userId", "problemId");

-- CreateIndex
CREATE INDEX "AiAssist_userId_askedAt_idx" ON "public"."AiAssist"("userId", "askedAt");

-- AddForeignKey
ALTER TABLE "public"."AiAssist" ADD CONSTRAINT "AiAssist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AiAssist" ADD CONSTRAINT "AiAssist_problemId_fkey" FOREIGN KEY ("problemId") REFERENCES "public"."Problem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The assistant is a practice tool. Said here too, not only at the boundary.
ALTER TABLE "public"."AiAssist"
  ADD CONSTRAINT "AiAssist_practice_only_check"
  CHECK ("context" = 'PRACTICE');

-- An answer exists exactly when the ask did not fail.
ALTER TABLE "public"."AiAssist"
  ADD CONSTRAINT "AiAssist_answer_pair_check"
  CHECK (("failed" = false AND "answer" IS NOT NULL) OR ("failed" = true AND "answer" IS NULL));

-- An answer a student actually read is never empty, and never unbounded.
ALTER TABLE "public"."AiAssist"
  ADD CONSTRAINT "AiAssist_answer_size_check"
  CHECK ("answer" IS NULL OR (length("answer") > 0 AND length("answer") <= 20000));

-- Usage is counted, never negative, and absent together on a failure.
ALTER TABLE "public"."AiAssist"
  ADD CONSTRAINT "AiAssist_usage_check"
  CHECK (
    ("tokensIn" IS NULL OR "tokensIn" >= 0)
    AND ("tokensOut" IS NULL OR "tokensOut" >= 0)
    AND ("latencyMs" IS NULL OR "latencyMs" >= 0)
  );

-- Append-only: see the header.
CREATE OR REPLACE FUNCTION "public"."recx_refuse_ai_assist_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AiAssist is append-only: a recorded AI answer is what makes a later solve ASSISTED, so it cannot be edited or removed (%).', TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AiAssist_append_only"
  BEFORE UPDATE OR DELETE ON "public"."AiAssist"
  FOR EACH ROW EXECUTE FUNCTION "public"."recx_refuse_ai_assist_change"();

-- And not by the back door either.
CREATE TRIGGER "AiAssist_no_truncate"
  BEFORE TRUNCATE ON "public"."AiAssist"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."recx_refuse_truncate"();
