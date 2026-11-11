import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  JUDGE_HEADERS,
  JUDGE_PROTOCOL_VERSION,
  claimRefusalSchema,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  judgeJobSpecSchema,
  releaseRequestSchema,
  resultRequestSchema,
  type BlobRef,
  type ClaimRefusal,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type JobKind,
  type JudgeJobData,
  type JudgeJobSpec,
  type ReleaseRequest,
  type ResultRequest,
} from "@recx/shared";
import { HttpStatusError, InfraError, ProtocolMismatchError, errorMessage } from "./errors";

/**
 * The judge node's only channel to the platform: five endpoints on the app
 * host, authenticated with this node's token. Everything the worker learns
 * about a job comes through here and is zod-validated on arrival.
 */

/** What the worker holds for a claimed job: enough to fetch its blobs and post or release it. */
export interface JobHandle {
  kind: JobKind;
  id: string;
  claimToken: string;
}

export interface JudgeApi {
  heartbeat(body: HeartbeatRequest): Promise<HeartbeatResponse>;
  /** A job spec on success, a refusal (treated as "job done") otherwise. */
  claim(job: JudgeJobData): Promise<JudgeJobSpec | ClaimRefusal>;
  /** Raw bytes of one blob of the claimed job. The cache verifies its sha256. */
  fetchBlob(ref: BlobRef, job: JobHandle): Promise<Buffer>;
  /** stale = the server already finalised this job or the lease moved on (HTTP 409). */
  postResult(body: ResultRequest): Promise<{ stale: boolean }>;
  /**
   * Give the job back after an infrastructure failure. permanent:true = no
   * node can ever judge it as specified: the server finalises INTERNAL_ERROR
   * at once instead of spending the remaining attempts.
   */
  release(body: ReleaseRequest): Promise<{ stale: boolean }>;
}

export function isRefusal(claim: JudgeJobSpec | ClaimRefusal): claim is ClaimRefusal {
  return "refused" in claim && claim.refused === true;
}

type Endpoint = "heartbeat" | "claim" | "blob" | "result" | "release";

const DEFAULT_TIMEOUTS: Readonly<Record<Endpoint, number>> = {
  heartbeat: 5_000,
  claim: 15_000,
  blob: 60_000,
  result: 30_000,
  release: 10_000,
};

/** Any JSON object. Success bodies of result/release carry nothing the worker needs. */
const ackSchema = z.object({}).passthrough();

export interface HttpJudgeApiOptions {
  appUrl: string;
  nodeId: string;
  token: string;
  fetch?: typeof fetch;
  /**
   * Retries after a network error or timeout (never after an HTTP status).
   * The heartbeat never retries: the next beat is JUDGE_HEARTBEAT_MS away.
   */
  retries?: number;
  retryDelayMs?: number;
  timeoutsMs?: Partial<Record<Endpoint, number>>;
}

interface RawResponse {
  status: number;
  body: Buffer;
}

export class HttpJudgeApi implements JudgeApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly timeouts: Record<Endpoint, number>;

  constructor(private readonly options: HttpJudgeApiOptions) {
    this.base = options.appUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.retries = options.retries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeoutsMs };
  }

  async heartbeat(body: HeartbeatRequest): Promise<HeartbeatResponse> {
    const res = await this.send("heartbeat", "POST", "/api/judge/heartbeat", heartbeatRequestSchema.parse(body));
    if (res.status !== 200) throw this.statusError("heartbeat", res);
    return this.validate("heartbeat", heartbeatResponseSchema, parseJson("heartbeat", res.body));
  }

  async claim(job: JudgeJobData): Promise<JudgeJobSpec | ClaimRefusal> {
    const res = await this.send("claim", "POST", "/api/judge/claim", {
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      kind: job.kind,
      id: job.id,
    });
    if (res.status !== 200) throw this.statusError("claim", res);
    const json = parseJson("claim", res.body);

    const refusal = claimRefusalSchema.safeParse(json);
    if (refusal.success) return refusal.data;

    const spec = this.validate("claim", judgeJobSpecSchema, json);
    if (spec.kind !== job.kind || spec.id !== job.id) {
      throw new InfraError(`claim returned ${spec.kind} ${spec.id} for a request about ${job.kind} ${job.id}`);
    }
    return spec;
  }

  async fetchBlob(ref: BlobRef, job: JobHandle): Promise<Buffer> {
    const query = new URLSearchParams({ kind: job.kind, id: job.id, claimToken: job.claimToken });
    const res = await this.send("blob", "GET", `/api/judge/blob/${ref.sha256}?${query.toString()}`);
    if (res.status !== 200) throw this.statusError("blob", res);
    if (res.body.byteLength !== ref.sizeBytes) {
      throw new InfraError(`blob ${ref.sha256.slice(0, 12)}… is ${res.body.byteLength} bytes, expected ${ref.sizeBytes}`);
    }
    return res.body;
  }

  async postResult(body: ResultRequest): Promise<{ stale: boolean }> {
    const valid = resultRequestSchema.safeParse(body);
    if (!valid.success) {
      // A worker bug, not a verdict: never post a result the server would reject.
      throw new InfraError(`result failed local validation: ${summarizeIssues(valid.error)}`);
    }
    return this.ackOrStale("result", await this.send("result", "POST", "/api/judge/result", valid.data));
  }

  async release(body: ReleaseRequest): Promise<{ stale: boolean }> {
    const valid = releaseRequestSchema.parse({ ...body, reason: body.reason.slice(0, 500) });
    return this.ackOrStale("release", await this.send("release", "POST", "/api/judge/release", valid));
  }

  // ── plumbing ──────────────────────────────────────────────────────────

  private ackOrStale(endpoint: Endpoint, res: RawResponse): { stale: boolean } {
    // 409 {stale:true}: already finalised, or the lease moved to another node.
    if (res.status === 409) return { stale: true };
    if (res.status < 200 || res.status > 299) throw this.statusError(endpoint, res);
    this.validate(endpoint, ackSchema, parseJsonOrEmpty(res.body));
    return { stale: false };
  }

  private validate<T>(endpoint: Endpoint, schema: z.ZodType<T, z.ZodTypeDef, unknown>, json: unknown): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new InfraError(`${endpoint} response failed validation: ${summarizeIssues(parsed.error)}`);
    }
    return parsed.data;
  }

  private statusError(endpoint: Endpoint, res: RawResponse): HttpStatusError {
    const json = parseJsonOrEmpty(res.body) as { error?: unknown };
    const detail = typeof json.error === "string" ? json.error.slice(0, 200) : "";
    return new HttpStatusError(endpoint, res.status, detail);
  }

  /**
   * One request with the three node headers. Network failures and timeouts
   * are retried with exponential backoff; any HTTP status is returned as-is
   * except 426, which is fatal.
   */
  private async send(endpoint: Endpoint, method: "GET" | "POST", pathAndQuery: string, body?: unknown): Promise<RawResponse> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.token}`,
      [JUDGE_HEADERS.node]: this.options.nodeId,
      [JUDGE_HEADERS.protocol]: String(JUDGE_PROTOCOL_VERSION),
      accept: endpoint === "blob" ? "application/octet-stream" : "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      let bytes: Buffer;
      try {
        response = await this.fetchImpl(`${this.base}${pathAndQuery}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeouts[endpoint]),
          redirect: "error",
        });
        bytes = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        // fetch() only throws for transport problems (DNS, refused, reset, timeout).
        if (attempt >= (endpoint === "heartbeat" ? 0 : this.retries)) {
          throw new InfraError(`${endpoint}: app host unreachable after ${attempt + 1} attempts — ${errorMessage(error)}`, {
            cause: error,
          });
        }
        await sleep(this.retryDelayMs * 2 ** attempt);
        continue;
      }
      if (response.status === 426) throw new ProtocolMismatchError(endpoint);
      return { status: response.status, body: bytes };
    }
  }
}

function parseJson(endpoint: Endpoint, body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new InfraError(`${endpoint} response is not valid JSON`);
  }
}

function parseJsonOrEmpty(body: Buffer): unknown {
  if (body.byteLength === 0) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return {};
  }
}

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
    .join("; ");
}
