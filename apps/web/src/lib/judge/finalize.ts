import "server-only";
import type { DbTx, JudgeNode, Prisma } from "@recx/db";
import {
  JUDGE_RETRY,
  LIMITS,
  sanitizeToolOutput,
  type ReleaseRequest,
  type ResultRequest,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { applySubmissionProgressSafely } from "@/lib/progress/apply";
import { getTestDataStore } from "@/lib/testdata/store";
import { JOB_ENTITY, markInternalError, publishProgress, requeueLease } from "./claim";
import { buildRunResult, buildSubmissionDetails, compactTestResults, truncateBytes, type SampleText } from "./truncate";
import { recordJudgeUsage } from "./usage";
import { advanceValidation, validationOutcome } from "./validation";

/**
 * Committing a worker's result, and releasing a job after an infrastructure
 * failure. Every write is guarded by the job's claimToken, the claiming node
 * and judgeState IN (DISPATCHED, RUNNING): a stale node's late result, a
 * retried HTTP callback, or a result for a job that was re-leased elsewhere
 * matches no row and becomes a 409 no-op.
 *
 * Submissions and runs are finalised under the per-user advisory lock, and
 * the same transaction charges the user's daily judge usage
 * (UserJudgeUsage, Asia/Kolkata day), so a verdict and its charge commit
 * together. A PRACTICE submission's progress (status, XP, streak, stats —
 * src/lib/progress/apply.ts) is written in the same transaction.
 */

export type FinalizeOutcome = "ok" | "stale";

/** Consecutive releases after which a node is drained automatically. */
export const AUTO_DRAIN_AFTER = 3;

class StaleResultError extends Error {}

const ACTIVE_JUDGE_STATES = ["DISPATCHED", "RUNNING"] as const;

/** A visible blob as text, already cut to the per-field detail limit. */
async function blobText(blob: { inline: string | null; storageKey: string | null }): Promise<string> {
  if (blob.inline !== null) return truncateBytes(blob.inline, LIMITS.detail.perTestBytes);
  if (!blob.storageKey) return "";
  const bytes = await getTestDataStore().get(blob.storageKey);
  return truncateBytes(bytes.toString("utf8"), LIMITS.detail.perTestBytes);
}

/** Sample input / expected output of a (frozen) version — read outside any transaction. */
async function loadSampleTexts(problemVersionId: string): Promise<SampleText[]> {
  const samples = await db.testCase.findMany({
    where: { problemVersionId, isSample: true },
    orderBy: { index: "asc" },
    select: {
      index: true,
      input: { select: { inline: true, storageKey: true } },
      output: { select: { inline: true, storageKey: true } },
    },
  });
  return Promise.all(
    samples.map(async (s) => ({ index: s.index, input: await blobText(s.input), expected: await blobText(s.output) })),
  );
}

function storedCompileOutput(body: ResultRequest): string | null {
  // The worker sanitises before sending; re-sanitise defensively so no host
  // or sandbox path can reach a stored row.
  const output = body.compile?.output ? sanitizeToolOutput(body.compile.output) : "";
  return output.length > 0 ? output : null;
}

/** Submission.subtaskResults: the per-subtask breakdown, or null when the job had none. */
export function storedSubtaskResults(body: Pick<ResultRequest, "subtasks">): Prisma.InputJsonValue | undefined {
  if (body.subtasks.length === 0) return undefined;
  return [...body.subtasks]
    .sort((a, b) => a.index - b.index)
    .map((s) => ({ index: s.index, earned: s.earned, max: s.max, verdict: s.verdict }));
}

/** Max per-test CPU ms over the tests that ran — what a validation run measured. */
export function measuredMsOf(body: Pick<ResultRequest, "tests" | "maxTimeMs">): number {
  const ran = body.tests.filter((t) => t.v !== "SKIPPED");
  return ran.length > 0 ? Math.max(...ran.map((t) => t.ms)) : body.maxTimeMs;
}

async function resetConsecutiveIe(nodeId: string): Promise<void> {
  await db.judgeNode
    .updateMany({ where: { id: nodeId, consecutiveIe: { gt: 0 } }, data: { consecutiveIe: 0 } })
    .catch((error: unknown) => console.warn(`[judge] could not reset consecutiveIe for ${nodeId}:`, error));
}

const lockUser = (tx: DbTx, userId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('user:' || ${userId}::text))`;

export async function finalizeSubmission(node: JudgeNode, body: ResultRequest): Promise<FinalizeOutcome> {
  const { id } = body;
  const head = await db.submission.findUnique({
    where: { id },
    select: { problemVersionId: true, claimToken: true },
  });
  // Cheap early exit before any blob reads; the guarded update below is the real check.
  if (!head || head.claimToken !== body.claimToken) return "stale";

  const details = buildSubmissionDetails(body.tests, await loadSampleTexts(head.problemVersionId));
  const testResults = compactTestResults(body.tests);
  const judgedAt = new Date();

  try {
    await db.$transaction(async (tx) => {
      const owner = await tx.submission.findUnique({
        where: { id },
        select: {
          userId: true,
          origin: true,
          lane: true,
          problemId: true,
          problemVersionId: true,
          language: true,
          createdAt: true,
        },
      });
      if (!owner) throw new StaleResultError();
      // Serialise every finalise for this student (Phase 3 writes XP and
      // streaks here; two results must never interleave).
      await lockUser(tx, owner.userId);

      const updated = await tx.submission.updateMany({
        where: {
          id,
          claimToken: body.claimToken,
          claimedByNodeId: node.id,
          judgeState: { in: [...ACTIVE_JUDGE_STATES] },
        },
        data: {
          status: "DONE",
          judgeState: "DONE",
          verdict: body.verdict,
          score: body.score,
          maxScore: body.maxScore,
          subtaskResults: storedSubtaskResults(body),
          cpuMs: body.cpuMs,
          testResults,
          passedCases: body.passedCases,
          totalCases: body.totalCases,
          maxTimeMs: body.maxTimeMs,
          maxMemoryKb: body.maxMemoryKb,
          firstFailedIndex: body.firstFailedIndex,
          compileOutput: storedCompileOutput(body),
          judgeNodeId: node.id,
          calibrationScore: body.calibrationScore,
          judgedAt,
          claimToken: null,
          leaseExpiresAt: null,
        },
      });
      if (updated.count === 0) throw new StaleResultError();

      if (details.length > 0) {
        await tx.submissionTestDetail.createMany({
          data: details.map((d) => ({ submissionId: id, ...d })),
          skipDuplicates: true,
        });
      }

      // An admin rejudge (lane REJUDGE) re-runs work the student already
      // paid for: it must never charge their daily budget a second time.
      if (owner.lane !== "REJUDGE") {
        await recordJudgeUsage(tx, {
          userId: owner.userId,
          kind: "submission",
          cpuMs: body.cpuMs,
          at: judgedAt,
          practice: owner.origin === "PRACTICE",
        });
      }

      // ── Phase 3: XP ledger, streak and per-user stats ───────────────────
      // Written here, inside this transaction and under the per-user
      // advisory lock above, so a verdict and its progress commit together.
      // Behind a savepoint: a progress failure is rolled back and logged,
      // and the verdict still commits (src/lib/progress/apply.ts). Contest
      // and assessment origins get their own scoring in later phases.
      if (owner.origin === "PRACTICE") {
        await applySubmissionProgressSafely(tx, {
          submissionId: id,
          userId: owner.userId,
          problemId: owner.problemId,
          problemVersionId: owner.problemVersionId,
          language: owner.language,
          verdict: body.verdict,
          submittedAt: owner.createdAt,
          now: judgedAt,
          rejudge: owner.lane === "REJUDGE",
        });
      }
      // ── end Phase 3 ─────────────────────────────────────────────────────
    });
  } catch (error) {
    if (error instanceof StaleResultError) return "stale";
    throw error;
  }

  await publishProgress("submission", id, { type: "final" });
  await resetConsecutiveIe(node.id);
  return "ok";
}

export async function finalizeRun(node: JudgeNode, body: ResultRequest): Promise<FinalizeOutcome> {
  const { id } = body;
  const head = await db.runRequest.findUnique({
    where: { id },
    select: { problemVersionId: true, customInput: true, claimToken: true, userId: true },
  });
  if (!head || head.claimToken !== body.claimToken) return "stale";

  const result =
    head.customInput !== null
      ? buildRunResult(body.tests, { kind: "custom" })
      : buildRunResult(body.tests, { kind: "samples", samples: await loadSampleTexts(head.problemVersionId) });
  const judgedAt = new Date();

  try {
    await db.$transaction(async (tx) => {
      await lockUser(tx, head.userId);
      const updated = await tx.runRequest.updateMany({
        where: {
          id,
          claimToken: body.claimToken,
          claimedByNodeId: node.id,
          judgeState: { in: [...ACTIVE_JUDGE_STATES] },
        },
        data: {
          status: "DONE",
          judgeState: "DONE",
          verdict: body.verdict,
          compileOutput: storedCompileOutput(body),
          result: result.map((entry) => ({ ...entry })),
          judgeNodeId: node.id,
          judgedAt,
          claimToken: null,
          leaseExpiresAt: null,
        },
      });
      if (updated.count === 0) throw new StaleResultError();
      await recordJudgeUsage(tx, { userId: head.userId, kind: "run", cpuMs: body.cpuMs, at: judgedAt });
    });
  } catch (error) {
    if (error instanceof StaleResultError) return "stale";
    throw error;
  }

  await publishProgress("run", id, { type: "final" });
  await resetConsecutiveIe(node.id);
  return "ok";
}

/**
 * A reference solution's validation result: the verdict, per-test results,
 * the measured time (max per-test CPU ms) and whether the verdict is the one
 * its author expected. Then the pipeline moves on (stage 2, limits).
 */
export async function finalizeValidation(node: JudgeNode, body: ResultRequest): Promise<FinalizeOutcome> {
  const { id } = body;
  const head = await db.validationRun.findUnique({
    where: { id },
    select: { claimToken: true, problemVersionId: true, referenceSolution: { select: { expectedVerdict: true } } },
  });
  if (!head || head.claimToken !== body.claimToken) return "stale";

  const outcome = validationOutcome(head.referenceSolution.expectedVerdict, body.verdict, body.tests);
  const testResults = compactTestResults(body.tests).map((t) => {
    const message = body.tests.find((r) => r.i === t.i)?.message;
    return message ? { ...t, message: message.slice(0, 512) } : { ...t };
  });
  const updated = await db.validationRun.updateMany({
    where: {
      id,
      claimToken: body.claimToken,
      claimedByNodeId: node.id,
      judgeState: { in: [...ACTIVE_JUDGE_STATES] },
    },
    data: {
      status: "DONE",
      judgeState: "DONE",
      verdict: body.verdict,
      outcome,
      measuredMs: measuredMsOf(body),
      testResults,
      compileOutput: storedCompileOutput(body),
      judgeNodeId: node.id,
      calibrationScore: body.calibrationScore,
      judgedAt: new Date(),
      claimToken: null,
      leaseExpiresAt: null,
    },
  });
  if (updated.count === 0) return "stale";

  await publishProgress("validation", id, { type: "final" });
  await resetConsecutiveIe(node.id);
  // The result is committed; moving the pipeline on must never fail the
  // worker's callback (the CLI and the next result retry it).
  await advanceValidation(head.problemVersionId).catch((error: unknown) =>
    console.error(`[validation] advancing version ${head.problemVersionId} failed:`, error),
  );
  return "ok";
}

/**
 * A result from a node that is QUARANTINED now (its self-check or hardening
 * check failed) cannot be trusted: it is not stored. The job goes back to the
 * queue for a healthy node — lease cleared, the attempt given back, since the
 * job itself did nothing wrong — and the discard is audited.
 */
export async function discardQuarantinedResult(node: JudgeNode, body: ResultRequest): Promise<void> {
  const requeued = await requeueLease(body.kind, body.id, node.id, body.claimToken, { refundAttempt: true });
  if (!requeued) {
    console.warn(`[judge] quarantined node ${node.id} posted a stale result for ${body.kind} ${body.id}`);
    return;
  }
  console.error(
    `[judge] !!! discarded the ${body.verdict} result of ${body.kind} ${body.id} from quarantined node ${node.id}; requeued`,
  );
  await audit({
    actorId: null,
    action: "judge.result.discarded_quarantined",
    entityType: JOB_ENTITY[body.kind],
    entityId: body.id,
    sensitivity: "SECURITY",
    metadata: { nodeId: node.id, hostname: node.hostname, kind: body.kind, verdict: body.verdict },
  });
  await publishProgress(body.kind, body.id, { type: "state", state: "QUEUED" });
}

/** A node that keeps failing infrastructure-wise is drained (finishes nothing new). */
async function recordNodeFailure(node: JudgeNode, reason: string): Promise<void> {
  const { consecutiveIe } = await db.judgeNode.update({
    where: { id: node.id },
    data: { consecutiveIe: { increment: 1 } },
    select: { consecutiveIe: true },
  });
  if (consecutiveIe < AUTO_DRAIN_AFTER) return;
  const drained = await db.judgeNode.updateMany({
    where: { id: node.id, status: "ONLINE" },
    data: { status: "DRAINING" },
  });
  if (drained.count === 0) return;
  console.error(`[judge] !!! node ${node.id} auto-drained after ${consecutiveIe} consecutive releases (last: ${reason})`);
  await audit({
    actorId: null,
    action: "judge.node.auto_drain",
    entityType: "JudgeNode",
    entityId: node.id,
    metadata: { consecutiveIe, lastReason: reason.slice(0, 500), hostname: node.hostname },
  });
}

/**
 * Infrastructure failure after a claim (sandbox error, blob fetch failure,
 * worker shutdown): the job goes back to QUEUED with its lease expired, so a
 * retry may claim it at once. After the final attempt the job is marked
 * INTERNAL_ERROR immediately rather than waiting for a claim to notice.
 *
 * A permanent release (the job can never succeed on any node: an
 * unsupported compare mode, a corrupt spec) is finalised INTERNAL_ERROR at
 * once — IE, excluded from scoring, audited — instead of spending three
 * attempts. It says nothing about the node, so it does not count toward the
 * node's auto-drain.
 */
export async function releaseJob(node: JudgeNode, body: ReleaseRequest): Promise<FinalizeOutcome> {
  if (body.permanent) {
    const failed = await markInternalError(
      body.kind,
      body.id,
      { claimToken: body.claimToken, nodeId: node.id },
      { nodeId: node.id, reason: `permanent failure: ${body.reason}`, auditAction: `judge.${body.kind}.permanent_failure` },
    );
    return failed ? "ok" : "stale";
  }

  const released = await requeueLease(body.kind, body.id, node.id, body.claimToken);
  if (!released) return "stale";
  console.warn(
    `[judge] node ${node.id} released ${body.kind} ${body.id} on attempt ${released.attemptCount}: ${body.reason}`,
  );
  if (released.attemptCount >= JUDGE_RETRY.attempts) {
    await markInternalError(body.kind, body.id, { exhausted: true }, {
      nodeId: node.id,
      reason: `released on the final attempt: ${body.reason}`,
    });
  }
  await recordNodeFailure(node, body.reason);
  return "ok";
}

