import type {
  BlobRef,
  ClaimRefusal,
  HeartbeatRequest,
  HeartbeatResponse,
  JudgeJobData,
  JudgeJobSpec,
  ReleaseRequest,
  ResultRequest,
} from "@recx/shared";
import { JUDGE_LANES, releaseRequestSchema, resultRequestSchema } from "@recx/shared";
import type { JobHandle, JudgeApi } from "../../src/api";
import { InfraError } from "../../src/errors";

/**
 * An in-memory app host: serves claims from a job table and blobs from a
 * blob table, and records results and releases. Results and releases are
 * validated with the real protocol schemas, exactly as the server would.
 */
export class FakeJudgeApi implements JudgeApi {
  readonly jobs = new Map<string, JudgeJobSpec | ClaimRefusal>();
  readonly blobs = new Map<string, Buffer>();
  readonly results: ResultRequest[] = [];
  readonly releases: ReleaseRequest[] = [];
  readonly heartbeats: HeartbeatRequest[] = [];
  readonly blobFetches: string[] = [];
  /** Answer to postResult: false = accepted, true = 409 stale. */
  staleResults = false;
  failResultPosts = false;
  /** What heartbeat() answers (every lane open by default). */
  heartbeatResponse: () => HeartbeatResponse = () => ({
    status: "ONLINE",
    serverTime: new Date().toISOString(),
    lanes: [...JUDGE_LANES],
    laneRestrictions: [],
  });

  add(spec: JudgeJobSpec, blobs: Map<string, Buffer>): void {
    this.jobs.set(`${spec.kind}:${spec.id}`, spec);
    for (const [sha, data] of blobs) this.blobs.set(sha, data);
  }

  async heartbeat(body: HeartbeatRequest): Promise<HeartbeatResponse> {
    this.heartbeats.push(body);
    return this.heartbeatResponse();
  }

  async claim(job: JudgeJobData): Promise<JudgeJobSpec | ClaimRefusal> {
    return this.jobs.get(`${job.kind}:${job.id}`) ?? { refused: true, reason: "NOT_FOUND" };
  }

  async fetchBlob(ref: BlobRef, job: JobHandle): Promise<Buffer> {
    const spec = this.jobs.get(`${job.kind}:${job.id}`);
    if (!spec || "refused" in spec || spec.claimToken !== job.claimToken) {
      throw new InfraError("fake: blob requested without a valid claim");
    }
    this.blobFetches.push(ref.sha256);
    const data = this.blobs.get(ref.sha256);
    if (!data) throw new InfraError(`fake: unknown blob ${ref.sha256}`);
    return data;
  }

  async postResult(body: ResultRequest): Promise<{ stale: boolean }> {
    if (this.failResultPosts) throw new InfraError("fake: app host unreachable");
    this.results.push(resultRequestSchema.parse(body));
    return { stale: this.staleResults };
  }

  async release(body: ReleaseRequest): Promise<{ stale: boolean }> {
    this.releases.push(releaseRequestSchema.parse(body));
    return { stale: false };
  }
}
