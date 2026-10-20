import type { JobKind, JudgeJobData, JudgeLane, ProgressEvent } from "@recx/shared";
import type { JudgeQueuePort } from "../../src/queues";

/**
 * In-memory JudgeQueuePort. Records every call so tests can assert exactly
 * what the reconciler did to the transport, without a Redis that a dev judge
 * worker might be consuming.
 */
export class FakeQueues implements JudgeQueuePort {
  connected = true;
  /** `${lane}:${id}` → BullMQ state. */
  readonly jobs = new Map<string, string>();
  /** Ids BullMQ would refuse to remove (locked). */
  readonly locked = new Set<string>();
  readonly added: Array<{ lane: JudgeLane; data: JudgeJobData }> = [];
  readonly removed: Array<{ lane: JudgeLane; id: string }> = [];
  readonly published: Array<{ kind: JobKind; id: string; event: ProgressEvent }> = [];
  failNext = 0;

  ready(): boolean {
    return this.connected;
  }

  setState(lane: JudgeLane, id: string, state: string): void {
    this.jobs.set(`${lane}:${id}`, state);
  }

  stateOf(lane: JudgeLane, id: string): string {
    return this.jobs.get(`${lane}:${id}`) ?? "unknown";
  }

  async state(lane: JudgeLane, id: string): Promise<string> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    }
    return this.stateOf(lane, id);
  }

  async remove(lane: JudgeLane, id: string): Promise<boolean> {
    if (this.locked.has(id)) return false;
    this.removed.push({ lane, id });
    this.jobs.delete(`${lane}:${id}`);
    return true;
  }

  async add(lane: JudgeLane, data: JudgeJobData): Promise<void> {
    this.added.push({ lane, data });
    // BullMQ dedupes on jobId: adding over an existing job is a no-op.
    if (!this.jobs.has(`${lane}:${data.id}`)) this.jobs.set(`${lane}:${data.id}`, "waiting");
  }

  async publish(kind: JobKind, id: string, event: ProgressEvent): Promise<void> {
    this.published.push({ kind, id, event });
  }

  async close(): Promise<void> {}
}
