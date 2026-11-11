/**
 * Error taxonomy for the judge worker.
 *
 * The one rule that matters: a deterministic verdict (AC, WA, TLE, MLE, RE,
 * CE, OLE …) is a statement about the student's code and is NEVER thrown —
 * it is posted as a result. Only infrastructure failures throw, and only an
 * InfraError makes the worker release its lease.
 *
 *   InfraError (permanent = false)   this node failed; another attempt (on
 *                                    this or another node) may succeed:
 *                                    isolate XX, a box that will not
 *                                    initialise, a blob that fails its sha256,
 *                                    a toolchain missing on THIS node.
 *                                    Released with permanent:false → retried.
 *   PermanentJudgeError              no node can ever judge this job as
 *                                    specified: an unsupported compare mode,
 *                                    a runtime whose toolchain the catalog
 *                                    does not know, a corrupt subtask table,
 *                                    a checker that does not compile or that
 *                                    reports FAIL. Released with
 *                                    permanent:true → the server finalises
 *                                    INTERNAL_ERROR at once and an admin sees
 *                                    the reason; no attempts are wasted.
 */

export interface InfraErrorOptions {
  cause?: unknown;
  permanent?: boolean;
}

/**
 * Something on the judge host, the network or the job's own data failed.
 * Never student-facing and never a verdict.
 */
export class InfraError extends Error {
  override readonly name: string = "InfraError";
  /** True when retrying on any node cannot help (see PermanentJudgeError). */
  readonly permanent: boolean;

  constructor(message: string, options?: InfraErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.permanent = options?.permanent ?? false;
  }

  /** Retrying (another attempt, maybe another node) can succeed. */
  get retryable(): boolean {
    return !this.permanent;
  }
}

/** The job can never succeed on any node: release with permanent:true. */
export class PermanentJudgeError extends InfraError {
  override readonly name: string = "PermanentJudgeError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, permanent: true });
  }
}

/** A non-2xx answer from the app host that is not one of the expected ones. */
export class HttpStatusError extends InfraError {
  constructor(
    readonly endpoint: string,
    readonly status: number,
    detail: string,
  ) {
    super(`${endpoint} failed: HTTP ${status}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * The app host speaks a different judge protocol version (HTTP 426). Fatal for
 * this process: a half-upgraded fleet must never post results the server
 * would misread. The worker stops taking jobs and exits.
 */
export class ProtocolMismatchError extends Error {
  override readonly name = "ProtocolMismatchError";

  constructor(endpoint: string) {
    super(`protocol mismatch: the app host rejected ${endpoint} with HTTP 426 — upgrade this judge node`);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
