/**
 * Error taxonomy for the SQL judge — the same rule the isolate worker
 * lives by, in a different engine.
 *
 * A deterministic verdict (AC, WA, TLE, RE, CE, OLE) is a statement about
 * the student's query and is NEVER thrown: it is posted as a result. Only
 * infrastructure failures throw, and only an InfraError makes this process
 * hand a lease back.
 *
 *   InfraError (permanent = false)   this node failed and another attempt
 *                                    may succeed: the sandbox cluster
 *                                    unreachable, a blob that fails its
 *                                    sha256, the app host down.
 *   PermanentJudgeError              no node can judge this job as
 *                                    specified: a setup script that does
 *                                    not run, an expected-result blob that
 *                                    is not a result set, a dialect this
 *                                    service does not speak. Released with
 *                                    permanent:true, so the server
 *                                    finalises at once instead of spending
 *                                    three attempts on the same bad data.
 */

export interface InfraErrorOptions {
  cause?: unknown;
  permanent?: boolean;
}

export class InfraError extends Error {
  override readonly name: string = "InfraError";
  readonly permanent: boolean;

  constructor(message: string, options?: InfraErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.permanent = options?.permanent ?? false;
  }

  get retryable(): boolean {
    return !this.permanent;
  }
}

export class PermanentJudgeError extends InfraError {
  override readonly name: string = "PermanentJudgeError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { ...options, permanent: true });
  }
}

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
 * The app host speaks a different judge protocol version (HTTP 426). Fatal:
 * a service that cannot read what the server sends must drain rather than
 * guess at a job.
 */
export class ProtocolMismatchError extends Error {
  override readonly name = "ProtocolMismatchError";

  constructor(endpoint: string) {
    super(`protocol mismatch: the app host rejected ${endpoint} with HTTP 426 — upgrade this SQL judge`);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
