import { queueNameFor, type JobKind, type JudgeEngine, type JudgeJobData, type JudgeLane, type ProgressEvent } from "@recx/shared";
import type { JudgeQueuePort } from "../../src/queues";

/**
 * In-memory JudgeQueuePort. Records every call so tests can assert exactly
 * what the reconciler did to the transport, without a Redis that a dev judge
 * worker might be consuming.
 *
 * Phase 12k: keyed by QUEUE NAME rather than by lane, because a lane has one
 * queue per engine and a SQL job on the isolate family's queue is exactly
 * the mistake the engine argument exists to prevent. `added` and `removed`
 * record the engine, so a test can see which family a job went to.
 */
export class FakeQueues implements JudgeQueuePort {
  connected = true;
  /** `${queueName}:${id}` → BullMQ state. */
  readonly jobs = new Map<string, string>();
  /** Ids BullMQ would refuse to remove (locked). */
  readonly locked = new Set<string>();
  readonly added: Array<{ engine: JudgeEngine; lane: JudgeLane; data: JudgeJobData }> = [];
  readonly removed: Array<{ engine: JudgeEngine; lane: JudgeLane; id: string }> = [];
  readonly published: Array<{ kind: JobKind; id: string; event: ProgressEvent }> = [];
  failNext = 0;

  ready(): boolean {
    return this.connected;
  }

  private key(engine: JudgeEngine, lane: JudgeLane, id: string): string {
    return `${queueNameFor(engine, lane)}:${id}`;
  }

  setState(lane: JudgeLane, id: string, state: string, engine: JudgeEngine = "isolate"): void {
    this.jobs.set(this.key(engine, lane, id), state);
  }

  stateOf(lane: JudgeLane, id: string, engine: JudgeEngine = "isolate"): string {
    return this.jobs.get(this.key(engine, lane, id)) ?? "unknown";
  }

  async state(engine: JudgeEngine, lane: JudgeLane, id: string): Promise<string> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
    }
    return this.stateOf(lane, id, engine);
  }

  async remove(engine: JudgeEngine, lane: JudgeLane, id: string): Promise<boolean> {
    if (this.locked.has(id)) return false;
    this.removed.push({ engine, lane, id });
    this.jobs.delete(this.key(engine, lane, id));
    return true;
  }

  async add(engine: JudgeEngine, lane: JudgeLane, data: JudgeJobData): Promise<void> {
    this.added.push({ engine, lane, data });
    // BullMQ dedupes on jobId: adding over an existing job is a no-op.
    const key = this.key(engine, lane, data.id);
    if (!this.jobs.has(key)) this.jobs.set(key, "waiting");
  }

  async depth(engine: JudgeEngine, lane: JudgeLane): Promise<{ waiting: number; oldestAgeSeconds: number }> {
    const prefix = `${queueNameFor(engine, lane)}:`;
    let waiting = 0;
    for (const [key, state] of this.jobs) {
      if (key.startsWith(prefix) && ["waiting", "prioritized", "delayed"].includes(state)) waiting += 1;
    }
    return { waiting, oldestAgeSeconds: 0 };
  }

  async publish(kind: JobKind, id: string, event: ProgressEvent): Promise<void> {
    this.published.push({ kind, id, event });
  }

  async close(): Promise<void> {}
}
