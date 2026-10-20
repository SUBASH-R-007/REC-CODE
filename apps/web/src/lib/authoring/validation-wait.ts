import "server-only";
import { advanceValidation, getValidationStatus, redispatchQueuedRuns, type ValidationStatus } from "@/lib/judge/validation";

const TERMINAL = new Set(["COMPLETE", "STAGE1_FAILED", "NOT_STARTED"]);

/**
 * Poll a revision's validation until it settles (COMPLETE, STAGE1_FAILED
 * or NOT_STARTED) or the deadline passes. Advances stage 2 on every poll and
 * re-dispatches queued runs every ~20 s (Redis may have been down at enqueue
 * time). Used by the operator CLIs; the admin UI refreshes instead.
 */
export async function waitForValidation(
  versionId: string,
  options: { timeoutMs: number; pollMs?: number; onPhase?: (status: ValidationStatus) => void },
): Promise<{ status: ValidationStatus; timedOut: boolean }> {
  const pollMs = options.pollMs ?? 2_000;
  const deadline = Date.now() + options.timeoutMs;
  let last = "";
  for (let poll = 0; ; poll++) {
    await advanceValidation(versionId);
    if (poll % 10 === 9) await redispatchQueuedRuns(versionId);
    const status = await getValidationStatus(versionId);
    const line = `${status.phase}:${status.pending}`;
    if (line !== last) {
      options.onPhase?.(status);
      last = line;
    }
    if (TERMINAL.has(status.phase)) return { status, timedOut: false };
    if (Date.now() > deadline) return { status, timedOut: true };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
