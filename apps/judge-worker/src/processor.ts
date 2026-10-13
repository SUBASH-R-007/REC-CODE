import {
  JUDGE_PROTOCOL_VERSION,
  judgeJobDataSchema,
  type BlobRef,
  type JudgeJobSpec,
  type ProgressEvent,
  type Verdict,
} from "@recx/shared";
import { isRefusal, type JobHandle, type JudgeApi } from "./api";
import { verifyInlineBlob, type BlobCache } from "./cache";
import type { BlobSource, JudgeDriver, JudgeOutcome } from "./drivers/types";
import { InfraError, ProtocolMismatchError, errorMessage } from "./errors";
import type { Logger } from "./logger";
import type { Publisher } from "./publisher";

/**
 * The worker's job path, independent of BullMQ so it is unit-testable and
 * reused by the Linux integration tests:
 *
 *   slot → claim → (refusal ⇒ done) → judge → post result (409 stale ⇒ done)
 *
 * A deterministic verdict is posted and the job completes — it is NEVER
 * rethrown, so BullMQ never re-runs student code because it was wrong.
 * Infrastructure failures release the lease:
 *
 *   retryable (InfraError)            release permanent:false, then rethrow so
 *                                     BullMQ retries (attempts 3, exponential
 *                                     from 2 s, set by the enqueuer);
 *   permanent (PermanentJudgeError)   release permanent:true — the server
 *                                     finalises INTERNAL_ERROR now and an
 *                                     admin sees the reason — and complete:
 *                                     no retry could ever succeed.
 *
 * Validation jobs (reference solutions judged at authoring time) publish no
 * progress at all: nobody is watching them live, and they are not a
 * student's submission.
 */

/** What processJob needs of a slot pool (src/slots.ts, or a lane-aware allocator). */
export interface SlotSource {
  acquire(): Promise<number>;
  release(slot: number): void;
}

export interface ProcessorDeps {
  api: JudgeApi;
  driver: JudgeDriver;
  cache: BlobCache;
  publisher: Publisher;
  slots: SlotSource;
  logger: Logger;
  nodeId: string;
  /** Aborted on shutdown: running sandboxes are killed and their jobs released. */
  signal?: AbortSignal;
  /** This node's current calibration score (posted with every result); null/absent = not calibrated. */
  calibrationScore?: () => number | null;
}

export interface ProcessOptions {
  /**
   * A slot the caller already holds (e.g. from a lane allocator). The
   * processor then neither acquires nor releases a slot itself.
   */
  slot?: number;
}

export type ProcessOutcome =
  | { outcome: "invalid" }
  | { outcome: "refused"; reason: string }
  | { outcome: "posted"; verdict: Verdict }
  | { outcome: "stale"; verdict: Verdict }
  /** Released with permanent:true — the server finalises INTERNAL_ERROR; nothing to retry. */
  | { outcome: "released"; reason: string };

function toInfraError(error: unknown): InfraError {
  return error instanceof InfraError ? error : new InfraError(`unexpected worker error: ${errorMessage(error)}`, { cause: error });
}

export function blobSourceFor(spec: JudgeJobSpec, deps: Pick<ProcessorDeps, "api" | "cache">): BlobSource {
  const handle: JobHandle = { kind: spec.kind, id: spec.id, claimToken: spec.claimToken };
  return {
    get(ref: BlobRef): Promise<Buffer> {
      const inline = spec.inlineBlobs[ref.sha256];
      if (inline !== undefined) return Promise.resolve(verifyInlineBlob(ref, inline));
      return deps.cache.get(ref, () => deps.api.fetchBlob(ref, handle));
    },
  };
}

/** Live progress for one job; validation jobs publish nothing. */
export function progressFor(spec: Pick<JudgeJobSpec, "kind" | "id">, publisher: Publisher): (event: ProgressEvent) => void {
  if (spec.kind === "validation") return () => {};
  return (event) => void publisher.publish(spec.kind, spec.id, event);
}

export async function processJob(data: unknown, deps: ProcessorDeps, options: ProcessOptions = {}): Promise<ProcessOutcome> {
  const parsed = judgeJobDataSchema.safeParse(data);
  if (!parsed.success) {
    // Malformed payloads can never succeed; retrying would only repeat this.
    deps.logger.error({ data }, "dropping a judge job with an invalid payload");
    return { outcome: "invalid" };
  }
  const job = parsed.data;

  const heldByCaller = options.slot !== undefined;
  const slot = options.slot ?? (await deps.slots.acquire());
  try {
    if (deps.signal?.aborted) throw new InfraError("the worker is shutting down; job left for another node");

    const claim = await deps.api.claim(job);
    if (isRefusal(claim)) {
      deps.logger.info({ kind: job.kind, id: job.id, reason: claim.reason }, "claim refused; nothing to do");
      return { outcome: "refused", reason: claim.reason };
    }
    const spec = claim;
    const log = deps.logger.child({ kind: spec.kind, id: spec.id, attempt: spec.attempt, lang: spec.language.key, slot });
    const startedAt = Date.now();

    let outcome: JudgeOutcome;
    try {
      outcome = await deps.driver.judge(spec, {
        slot,
        blobs: blobSourceFor(spec, deps),
        progress: progressFor(spec, deps.publisher),
        logger: log,
        signal: deps.signal,
      });
    } catch (error) {
      if (error instanceof ProtocolMismatchError) throw error;
      const infra = toInfraError(error);
      if (infra.permanent) {
        log.error({ err: infra }, "this job can never be judged as specified; releasing it permanently (INTERNAL_ERROR)");
        await release(deps, spec, infra.message, true, log);
        return { outcome: "released", reason: infra.message };
      }
      log.error({ err: infra }, "infrastructure failure while judging; releasing the lease for a retry");
      await release(deps, spec, infra.message, false, log);
      throw infra;
    }

    let posted: { stale: boolean };
    try {
      posted = await deps.api.postResult({
        protocolVersion: JUDGE_PROTOCOL_VERSION,
        kind: spec.kind,
        id: spec.id,
        claimToken: spec.claimToken,
        ...outcome,
        judgeNodeId: deps.nodeId,
        calibrationScore: deps.calibrationScore?.() ?? null,
      });
    } catch (error) {
      if (error instanceof ProtocolMismatchError) throw error;
      const infra = toInfraError(error);
      log.error({ err: infra, verdict: outcome.verdict }, "could not post the result; releasing the lease for a retry");
      await release(deps, spec, `result post failed: ${infra.message}`, false, log);
      throw infra;
    }

    const summary = {
      verdict: outcome.verdict,
      passed: outcome.passedCases,
      total: outcome.totalCases,
      score: outcome.score,
      maxScore: outcome.maxScore,
      maxTimeMs: outcome.maxTimeMs,
      cpuMs: outcome.cpuMs,
      compileCached: outcome.compile?.cached ?? null,
      tookMs: Date.now() - startedAt,
    };
    if (posted.stale) {
      log.warn(summary, "result was stale (already finalised or the lease moved on); discarded by the server");
      return { outcome: "stale", verdict: outcome.verdict };
    }
    log.info(summary, "judged");
    return { outcome: "posted", verdict: outcome.verdict };
  } finally {
    if (!heldByCaller) deps.slots.release(slot);
  }
}

async function release(deps: ProcessorDeps, spec: JudgeJobSpec, reason: string, permanent: boolean, log: Logger): Promise<void> {
  try {
    await deps.api.release({
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      kind: spec.kind,
      id: spec.id,
      claimToken: spec.claimToken,
      reason: reason.slice(0, 500),
      permanent,
    });
  } catch (error) {
    // The lease still expires on its own (JUDGE_LEASE_SECONDS); the reconciler re-enqueues.
    log.warn({ err: errorMessage(error), permanent }, "release failed; the lease will expire instead");
  }
}
