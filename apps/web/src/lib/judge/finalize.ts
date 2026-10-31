import "server-only";
import type { DbTx, JudgeNode, Prisma } from "@recx/db";
import {
  JUDGE_RETRY,
  LIMITS,
  readResultSet,
  sanitizeToolOutput,
  writeResultSet,
  type IoMode,
  type ReleaseRequest,
  type ResultRequest,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { applyContestSubmission } from "@/lib/contests/attempt";
import { applySubmissionProgressSafely } from "@/lib/progress/apply";
import { getTestDataStore } from "@/lib/testdata/store";
import { JOB_ENTITY, markInternalError, publishProgress, requeueLease } from "./claim";
import { buildRunResult, buildSubmissionDetails, compactTestResults, truncateBytes, type SampleText } from "./truncate";
import { recordJudgeUsage } from "./usage";
import { storeSqlCapture } from "./sql-capture";
import { advanceValidation, validationOutcome } from "./validation";
import { verdictReached } from "@/lib/metrics";

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
async function blobText(
  blob: { inline: string | null; storageKey: string | null },
  maxBytes: number = LIMITS.detail.perTestBytes,
): Promise<string> {
  if (blob.inline !== null) return truncateBytes(blob.inline, maxBytes);
  if (!blob.storageKey) return "";
  const bytes = await getTestDataStore().get(blob.storageKey);
  return truncateBytes(bytes.toString("utf8"), maxBytes);
}

/**
 * How much of a SQL expected-result blob is read before it is clipped to
 * the rows a page shows. A result set is JSON, and JSON cut at a byte
 * budget is not JSON any more — so it is cut by ROWS first, and that
 * cannot be done to text nobody has parsed yet.
 */
const SQL_EXPECTED_READ_BYTES = 1024 * 1024;

/**
 * The expected side of a SQL case, clipped to the rows a student is shown
 * (Phase 12k). Text that is not a result set is returned as it came: a
 * blob written before this existed, or one already cut, is shown as text
 * rather than lost.
 */
function sqlExpectedForDisplay(text: string): string {
  const resultSet = readResultSet(text);
  return resultSet ? writeResultSet(resultSet) : truncateBytes(text, LIMITS.detail.perTestBytes);
}

/** Sample input / expected output of a (frozen) version — read outside any transaction. */
/**
 * The sample cases' texts, for the result console.
 *
 * `ioMode` decides what "expected" means. A SQL case's expected result set
 * is clipped for display (Phase 12k). An output-only case's expected
 * output IS THE ANSWER, so it is withheld entirely (Phase 12n): its case
 * is a sample because the student must see the DATA, and the console shows
 * their own answer beside the verdict and nothing else.
 */
async function loadSampleTexts(problemVersionId: string, ioMode: IoMode = "STDIN"): Promise<SampleText[]> {
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
    samples.map(async (s) => ({
      index: s.index,
      input: await blobText(s.input),
      expected:
        ioMode === "SQL"
          ? sqlExpectedForDisplay(await blobText(s.output, SQL_EXPECTED_READ_BYTES))
          : ioMode === "OUTPUT_ONLY"
            ? ""
            : await blobText(s.output),
    })),
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
    // `language` is read for `judge_verdict_total`'s label (Phase 10a). The
    // result body does not carry it, and versioning the judge protocol for a
    // metric label would be the wrong trade; this select already runs.
    select: {
      problemVersionId: true,
      claimToken: true,
      language: true,
      problemVersion: { select: { ioMode: true } },
    },
  });
  // Cheap early exit before any blob reads; the guarded update below is the real check.
  if (!head || head.claimToken !== body.claimToken) return "stale";

  const samples = await loadSampleTexts(head.problemVersionId, head.problemVersion.ioMode);
  const details = buildSubmissionDetails(body.tests, samples);
  // The sample indexes of the VERSION decide which cases may carry the
  // judge's message, so a worker cannot make a hidden case visible.
  const testResults = compactTestResults(body.tests, new Set(samples.map((s) => s.index)));
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
          contestId: true,
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
      // and the verdict still commits (src/lib/progress/apply.ts). The
      // ASSESSMENT origin gets its own scoring in Phase 6.
      if (owner.origin === "CONTEST" && owner.contestId) {
        // Phase 5: the authoritative attempt row and this student's own
        // standing row, in this transaction and under the same per-user
        // lock. Rank is NOT touched here — one job every 15 s does that
        // (SPEC §4e).
        await applyContestSubmission(tx, {
          submissionId: id,
          userId: owner.userId,
          contestId: owner.contestId,
          problemVersionId: owner.problemVersionId,
          verdict: body.verdict,
          score: body.score ?? 0,
          submittedAt: owner.createdAt,
        });
      }
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
  /**
   * Phase 10a. Here, past the guarded update, so the counter describes a
   * result that was STORED: a stale post is discarded, and counting it would
   * make `judge_verdict_total` disagree with the submissions table.
   */
  verdictReached(body.verdict, head.language);
  return "ok";
}

export async function finalizeRun(node: JudgeNode, body: ResultRequest): Promise<FinalizeOutcome> {
  const { id } = body;
  const head = await db.runRequest.findUnique({
    where: { id },
    select: {
      problemVersionId: true,
      customInput: true,
      claimToken: true,
      userId: true,
      language: true,
      problemVersion: { select: { ioMode: true } },
    },
  });
  if (!head || head.claimToken !== body.claimToken) return "stale";

  const result =
    head.customInput !== null
      ? buildRunResult(body.tests, { kind: "custom" })
      : buildRunResult(body.tests, {
          kind: "samples",
          samples: await loadSampleTexts(head.problemVersionId, head.problemVersion.ioMode),
        });
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
  verdictReached(body.verdict, head.language);
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
    select: {
      claimToken: true,
      problemVersionId: true,
      // For `judge_verdict_total`'s label (Phase 10a).
      language: true,
      referenceSolution: { select: { expectedVerdict: true } },
    },
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
  /**
   * A validation counts as a verdict, and it has to: these run on the same
   * judge hosts as a student's submission, and `markInternalError` counts
   * their failures. If the numerator could include a validation but the
   * denominator could not, the INTERNAL_ERROR rate alert would read high
   * every time a staff member validated a problem.
   */
  verdictReached(body.verdict, head.language);

  /**
   * Phase 12k: a SQL validation run is a CAPTURE run — the author's
   * reference query against each dataset — and what it reports becomes the
   * version's expected results. Stored after the run row is committed, and
   * never for anything but a validation job on an unfrozen SQL version
   * (`storeSqlCapture` re-checks all of that itself).
   *
   * A refusal is logged rather than thrown: the run is already recorded,
   * and the validation status is what decides whether the version may
   * publish — a version whose capture did not store cannot pass it.
   */
  if (body.sqlCaptured && body.sqlCaptured.length > 0) {
    const captured = await storeSqlCapture(id, body).catch((error: unknown) => {
      console.error(`[validation] storing the SQL capture for run ${id} failed:`, error);
      return { stored: false as const, reason: "the capture could not be stored" };
    });
    if (captured.stored) console.info(`[validation] run ${id}: stored ${captured.cases} expected result sets`);
    else console.error(`[validation] run ${id}: the capture was not stored — ${captured.reason}`);
  }

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

