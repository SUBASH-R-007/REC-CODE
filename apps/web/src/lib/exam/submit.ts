import "server-only";
import { createHash } from "node:crypto";
import type { AttemptLayout } from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { enqueueJudge } from "@/lib/judge/queue";
import { writeSnapshot } from "@/lib/exam/snapshots";
import type { AttemptGuardOk } from "@/lib/exam/attempt";

/**
 * Submitting a sitting (Phase 6c).
 *
 * The order here is the design, and it is the opposite of what feels natural:
 *
 *   1. snapshot every answer, with `trigger: SUBMIT`;
 *   2. create one Submission per answered question, pinned to the FROZEN
 *      `ProblemVersion` the layout names;
 *   3. only then move the attempt to SUBMITTED;
 *   4. and only then enqueue the judge.
 *
 * The attempt moves last because the status is what the attempt guard reads:
 * the moment it says SUBMITTED, every further request from that client is
 * refused, and a crash between (1) and (3) must leave a sitting a candidate
 * can resume rather than one that is closed with no work recorded. Judging is
 * enqueued after the status moves because a judge result arriving against a
 * still-IN_PROGRESS attempt would be a result for a sitting that could still
 * change.
 *
 * Submissions go to the ASSESSMENT lane, which the judge allocator serves
 * first and only from nodes whose calibration and self-check are fresh
 * (Phase 2). An exam answer waiting behind practice traffic is an exam
 * answer judged after the candidate has left.
 *
 * No practice rate caps apply. The caps exist to stop someone hammering the
 * judge from the practice page; an exam has a clock and a fixed number of
 * questions, and refusing a candidate's final submission because they had a
 * busy afternoon would be indefensible.
 */

export interface SubmitResult {
  readonly submitted: boolean;
  /** One per question that had work in it. */
  readonly submissionIds: string[];
  /** Questions with nothing in them, which are simply not submitted. */
  readonly blank: number;
  readonly reason?: "already_finished" | "no_language";
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export async function submitAttempt(
  guard: AttemptGuardOk,
  layout: AttemptLayout,
  answers: ReadonlyArray<{ readonly questionId: string; readonly language: string; readonly source: string }>,
): Promise<SubmitResult> {
  const { attempt, now } = guard;
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));

  const language = answers[0]?.language;
  if (language === undefined) {
    // Nothing to submit at all: still finalise, so the sitting closes.
    const moved = await finalise(attempt.id, now);
    if (moved) await record(attempt.id, attempt.userId, [], answers.length, now);
    return { submitted: moved, submissionIds: [], blank: layout.questions.length };
  }

  const config = await db.languageConfig.findFirst({
    where: { key: language, enabled: true, isCurrent: true },
    select: { id: true },
  });
  if (!config) return { submitted: false, submissionIds: [], blank: 0, reason: "no_language" };

  // ── 1. Snapshot everything, before anything is finalised ───────────────
  for (const question of layout.questions) {
    const answer = byQuestion.get(question.questionId);
    if (!answer || answer.source.trim() === "") continue;
    await writeSnapshot(guard, {
      questionId: question.questionId,
      language: answer.language,
      source: answer.source,
      trigger: "SUBMIT",
      atMs: Math.max(0, now.getTime() - attempt.startedAt.getTime()),
    });
  }

  // ── 2. One Submission per answered question ────────────────────────────
  const submissionIds: string[] = [];
  let blank = 0;
  for (const question of layout.questions) {
    const answer = byQuestion.get(question.questionId);
    if (!answer || answer.source.trim() === "") {
      blank++;
      continue;
    }
    const version = await db.problemVersion.findUnique({
      where: { id: question.problemVersionId },
      select: { problemId: true, _count: { select: { testCases: true } } },
    });
    if (!version || version._count.testCases === 0) {
      // A question with no tests cannot be judged. Counted as blank rather
      // than silently dropped, so the totals a reviewer sees add up.
      blank++;
      console.error(`[exam] attempt ${attempt.id}: question ${question.questionId} has no tests; not judged`);
      continue;
    }
    const row = await db.submission.create({
      data: {
        userId: attempt.userId,
        problemId: version.problemId,
        // The PINNED version, not the live one: a problem republished
        // mid-exam must not change what this candidate was judged against.
        problemVersionId: question.problemVersionId,
        languageConfigId: config.id,
        language: answer.language,
        origin: "ASSESSMENT",
        lane: "ASSESSMENT",
        status: "QUEUED",
        judgeState: "PENDING",
        totalCases: version._count.testCases,
        sourceSha256: sha256(answer.source),
        sourceBytes: Buffer.byteLength(answer.source, "utf8"),
        assessmentAttemptId: attempt.id,
        source: { create: { source: answer.source } },
      },
      select: { id: true },
    });
    submissionIds.push(row.id);
  }

  // ── 3. The status, last ────────────────────────────────────────────────
  const moved = await finalise(attempt.id, now);
  if (!moved) return { submitted: false, submissionIds, blank, reason: "already_finished" };
  await record(attempt.id, attempt.userId, submissionIds, blank, now);

  // ── 4. The judge, after the sitting is closed ──────────────────────────
  for (const id of submissionIds) {
    const queued = await enqueueJudge("submission", id, "ASSESSMENT");
    if (!queued) {
      // The row is QUEUED in Postgres whatever Redis did; the scheduler's
      // reconciler dispatches it on its next tick. Logged loudly because a
      // college-wide sitting that cannot reach Redis needs someone awake.
      console.error(`[exam] submission ${id} could not be enqueued; the reconciler will pick it up`);
    }
  }

  return { submitted: true, submissionIds, blank };
}

/**
 * Move the attempt to SUBMITTED, conditional on a status that still accepts
 * work — so the deadline sweeper, the focus-limit auto-submit and a
 * candidate's own button cannot finalise the same sitting twice.
 */
async function finalise(attemptId: string, now: Date): Promise<boolean> {
  const moved = await db.assessmentAttempt.updateMany({
    where: { id: attemptId, status: { in: ["IN_PROGRESS", "DISCONNECTED"] } },
    data: { status: "SUBMITTED", submittedAt: now, version: { increment: 1 } },
  });
  return moved.count === 1;
}

async function record(
  attemptId: string,
  userId: string,
  submissionIds: readonly string[],
  blank: number,
  now: Date,
): Promise<void> {
  await audit({
    actorId: userId,
    action: "assessment.attempt.submitted",
    entityType: "AssessmentAttempt",
    entityId: attemptId,
    targetUserId: userId,
    metadata: {
      by: "candidate",
      at: now.toISOString(),
      submissions: submissionIds.length,
      blank,
    },
  });
}
