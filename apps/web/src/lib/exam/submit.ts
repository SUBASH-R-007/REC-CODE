import "server-only";
import { createHash } from "node:crypto";
import { acceptsLanguage, questionLanguages, type AttemptLayout } from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { enqueueJudge } from "@/lib/judge/queue";
import { flagAttemptIfNeeded } from "@/lib/integrity/flag";
import { deriveSnapshotJumps } from "@/lib/exam/snapshot-jump";
import { languagesOfSitting } from "@/lib/exam/language";
import { markAttemptMcqs } from "@/lib/exam/mcq";
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
  readonly reason?: "already_finished" | "no_language" | "language_not_accepted";
  /**
   * The language that was refused, for the route's message (Phase 13a).
   * Only set with `language_not_accepted`.
   */
  readonly refusedLanguage?: string;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export async function submitAttempt(
  guard: AttemptGuardOk,
  layout: AttemptLayout,
  answers: ReadonlyArray<{ readonly questionId: string; readonly language: string; readonly source: string }>,
): Promise<SubmitResult> {
  const { attempt, now } = guard;
  const byQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));

  /**
   * The multiple-choice half, marked first (Phase 12r).
   *
   * Above the branch below, not inside it. A paper that is ALL
   * multiple-choice sends no coding answers at all, so it takes the
   * "nothing to submit" path — and marking the MCQs only on the other path
   * meant the one kind of paper where the MCQs are the whole thing was the
   * one where nothing recorded them. Found by sitting one.
   *
   * It needs no judge, so there is nothing to wait for, and it runs before
   * the status moves because once the attempt is SUBMITTED the guard
   * refuses everything from that client. Behind a catch because it must
   * never cost a candidate their submission: the marks are recomputed on
   * read anyway, so a failure here loses a note in an audit row, not an
   * answer.
   */
  let mcqTotals;
  try {
    const totals = await markAttemptMcqs({ attemptId: attempt.id, layout });
    if (totals.marks.length > 0) {
      mcqTotals = {
        correct: totals.correct,
        wrong: totals.wrong,
        blank: totals.blank,
        corrupt: totals.corrupt,
        points: totals.points,
        maxPoints: totals.maxPoints,
      };
      if (totals.corrupt > 0) {
        // Somebody's marks are at stake and this is not a candidate's
        // mistake; it should be looked at rather than averaged away.
        console.error(`[exam] attempt ${attempt.id}: ${totals.corrupt} multiple-choice answer(s) could not be mapped`);
      }
    }
  } catch (error) {
    console.error(`[exam] attempt ${attempt.id}: marking the multiple-choice half failed`, error);
  }

  /**
   * Every answer's language must be one this sitting accepts (Phase 13a).
   *
   * Checked BEFORE anything is finalised, and the whole submission is
   * refused rather than the offending answer dropped: the sitting is still
   * live at this point, so a refusal is something a candidate can act on
   * (pick an accepted language and hand in again), while a silently
   * dropped answer is a zero they find out about when the results come
   * out. The editor only ever offers the frozen set, so reaching this
   * means a client somebody has been editing.
   */
  const paperLanguages = await languagesOfSitting(layout);
  const acceptedFor = (questionId: string): string[] => {
    // Phase 13c: a question may narrow the paper, so each answer is
    // judged against ITS OWN question's frozen list.
    const question = layout.questions.find((q) => q.questionId === questionId);
    return questionLanguages({ question: question?.languages, paper: paperLanguages });
  };
  const refused = answers.find(
    (answer) => answer.source.trim() !== "" && !acceptsLanguage(acceptedFor(answer.questionId), answer.language),
  );
  if (refused) {
    return {
      submitted: false,
      submissionIds: [],
      blank: 0,
      reason: "language_not_accepted",
      refusedLanguage: refused.language,
    };
  }

  const language = answers[0]?.language;
  if (language === undefined) {
    // No code to judge — an all-multiple-choice paper, or a blank one.
    // Still finalise, so the sitting closes, and still record what the
    // questions came to.
    const moved = await finalise(attempt.id, now);
    if (moved) await record(attempt.id, attempt.userId, [], answers.length, now, mcqTotals);
    return { submitted: moved, submissionIds: [], blank: layout.questions.length };
  }

  /**
   * ONE TOOLCHAIN ROW PER LANGUAGE USED (Phase 13a).
   *
   * This used to read the config for `answers[0].language` and stamp every
   * submission with it. That was invisible while a sitting had one
   * language and would have been a quiet disaster the moment it had two: a
   * paper answered in Python and C would have had both submissions
   * recorded against whichever toolchain the first answer happened to use,
   * so the judge would have compiled the Python file with gcc. The verdict
   * would have been a compile error on a correct program.
   */
  const used = [...new Set(answers.filter((answer) => answer.source.trim() !== "").map((a) => a.language))];
  const configs = new Map<string, string>();
  for (const key of used) {
    const row = await db.languageConfig.findFirst({
      where: { key, enabled: true, isCurrent: true },
      select: { id: true },
    });
    // A language accepted when the paper was laid out and disabled since.
    // Refused rather than judged with another toolchain: there is nothing
    // honest to fall back to.
    if (!row) return { submitted: false, submissionIds: [], blank: 0, reason: "no_language" };
    configs.set(key, row.id);
  }

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
    const configId = configs.get(answer.language);
    if (configId === undefined) {
      // Cannot happen -- `used` is built from these same answers -- and if
      // it ever does, a blank counted and logged beats a crash that loses
      // every other question in the loop.
      blank++;
      console.error(`[exam] attempt ${attempt.id}: no toolchain row for ${answer.language}; not judged`);
      continue;
    }
    const row = await db.submission.create({
      data: {
        userId: attempt.userId,
        problemId: version.problemId,
        // The PINNED version, not the live one: a problem republished
        // mid-exam must not change what this candidate was judged against.
        problemVersionId: question.problemVersionId,
        languageConfigId: configId,
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
  await record(attempt.id, attempt.userId, submissionIds, blank, now, mcqTotals);

  /**
   * Phase 11b: derive SNAPSHOT_JUMP, now that the final solution exists.
   *
   * It has to be here and not earlier: the rule is a share of the FINAL
   * solution's token count, which nothing knows until the sitting ends. It
   * is after `finalise` because an attempt that did not move is one somebody
   * else already closed, and deriving against it twice would double a
   * candidate's evidence — the derivation refuses that too.
   *
   * A failure here must not fail a submission. The work is recorded, the
   * judge is about to run, and a missing derived signal is a weaker review,
   * not a lost exam.
   */
  try {
    const jumps = await deriveSnapshotJumps(attempt);
    if (jumps.length > 0) {
      console.info(`[exam] attempt ${attempt.id}: ${jumps.length} SNAPSHOT_JUMP event(s) derived`);
    }
  } catch (error) {
    console.error(`[exam] attempt ${attempt.id}: SNAPSHOT_JUMP derivation failed`, error);
  }

  /**
   * Phase 11b: band the sitting — which nothing did either.
   *
   * `flagAttemptIfNeeded` was written in Phase 6, complete, idempotent and
   * audited, and the audit behind `tests/repo/proctoring-posture.test.ts`
   * found that NO code path in the repository called it. So no attempt was
   * ever flagged, no result was ever withheld, the 72-hour SLA had nothing
   * to act on, and the review queue, the reviews and the appeals were a
   * surface over an empty table. The whole integrity engine was inert.
   *
   * Here, and after the derivation above, because the band counts
   * SNAPSHOT_JUMP events. Here and not in the scheduler's expiry sweep
   * because an expired sitting creates no Submission at all — there is no
   * result to withhold — and this is the one place a sitting's results are
   * created (docs/OPEN-QUESTIONS.md).
   *
   * The ceiling is unchanged and worth restating: the most this can do is
   * raise a flag and keep the result off the PUBLIC leaderboard until a
   * human looks or 72 hours pass, whichever comes first.
   */
  try {
    const flag = await flagAttemptIfNeeded(attempt.id);
    if (flag.flagged) {
      console.info(`[exam] attempt ${attempt.id}: flagged ${flag.triage.band} for review`);
    }
  } catch (error) {
    console.error(`[exam] attempt ${attempt.id}: banding failed`, error);
  }

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
  /**
   * What the multiple-choice half came to (Phase 12r). In the audit row
   * rather than on the attempt: it is not a score, it is a note of what
   * was marked at the moment the candidate handed in, so a result queried
   * months later can be held against what the sitting said at the time.
   * The marking itself is recomputed on read from rows that cannot drift.
   */
  mcq?: { correct: number; wrong: number; blank: number; corrupt: number; points: number; maxPoints: number },
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
      ...(mcq ? { mcq } : {}),
    },
  });
}
