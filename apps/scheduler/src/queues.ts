import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import {
  judgeJobOptions as sharedJudgeJobOptions,
  QUEUE_NAME,
  progressChannel,
  progressEventSchema,
  type JobKind,
  type JudgeJobData,
  type JudgeLane,
  type ProgressEvent,
} from "@recx/shared";
import { classifyJobState } from "./classify";

/** BullMQ options for a judge job: the single shared definition, so a
 * re-enqueued job behaves exactly like one the web app added at submit time. */
export function judgeJobOptions(lane: JudgeLane, id: string): JobsOptions {
  return sharedJudgeJobOptions(lane, id);
}

/** The slice of BullMQ the reconciler needs, so the decision path is testable without Redis. */
export interface JudgeQueuePort {
  /** Whether Redis is connected right now. False defers every enqueue to a later tick. */
  ready(): boolean;
  /** `Queue.getJobState()` — "unknown" when there is no such job. */
  state(lane: JudgeLane, id: string): Promise<string>;
  /** True when the job is gone afterwards (false: BullMQ refused, e.g. it is locked). */
  remove(lane: JudgeLane, id: string): Promise<boolean>;
  add(lane: JudgeLane, data: JudgeJobData): Promise<void>;
  /** Live progress for an open submission/run page (best effort). */
  publish(kind: JobKind, id: string, event: ProgressEvent): Promise<void>;
  close(): Promise<void>;
}

export type EnsureOutcome = "kept" | "added" | "replaced" | "remove-refused";

/**
 * Make sure job `data.id` exists in a non-terminal state on the lane's queue.
 * In a dry run the state is read but nothing is removed or added; the
 * outcome reports what WOULD have happened.
 */
export async function ensureJob(
  queues: JudgeQueuePort,
  lane: JudgeLane,
  data: JudgeJobData,
  dryRun: boolean,
): Promise<EnsureOutcome> {
  const action = classifyJobState(await queues.state(lane, data.id));
  if (action === "keep") return "kept";
  if (dryRun) return action === "add" ? "added" : "replaced";
  if (action === "replace" && !(await queues.remove(lane, data.id))) return "remove-refused";
  await queues.add(lane, data);
  return action === "add" ? "added" : "replaced";
}

/**
 * BullMQ queues on one shared ioredis connection. The connection is created
 * with enableOfflineQueue=false and a command timeout, so a Redis outage
 * fails each call fast instead of stalling the tick; Postgres work in the
 * same tick carries on regardless (Redis is transport, Postgres is truth).
 */
export class BullJudgeQueues implements JudgeQueuePort {
  private readonly queues = new Map<JudgeLane, Queue<JudgeJobData>>();

  /**
   * `prefix` is BullMQ's key prefix. Production uses BullMQ's default, as the
   * web app does; tests pass a throwaway prefix so they never touch the
   * queues a local judge worker is consuming.
   */
  constructor(
    private readonly connection: Redis,
    private readonly log: Logger,
    private readonly prefix?: string,
  ) {}

  ready(): boolean {
    return this.connection.status === "ready";
  }

  private queue(lane: JudgeLane): Queue<JudgeJobData> {
    let q = this.queues.get(lane);
    if (!q) {
      // skipMetasUpdate: the web app owns queue metadata; the scheduler only
      // reads job state and re-adds jobs.
      q = new Queue<JudgeJobData>(QUEUE_NAME[lane], {
        connection: this.connection,
        skipMetasUpdate: true,
        ...(this.prefix ? { prefix: this.prefix } : {}),
      });
      // An EventEmitter 'error' without a listener would crash the process.
      q.on("error", (err) => this.log.warn({ err, queue: QUEUE_NAME[lane] }, "BullMQ queue error"));
      this.queues.set(lane, q);
    }
    return q;
  }

  state(lane: JudgeLane, id: string): Promise<string> {
    return this.queue(lane).getJobState(id);
  }

  async remove(lane: JudgeLane, id: string): Promise<boolean> {
    // 1 = removed, 0 = locked by a worker (left for the next tick).
    return (await this.queue(lane).remove(id)) === 1;
  }

  async add(lane: JudgeLane, data: JudgeJobData): Promise<void> {
    await this.queue(lane).add("judge", data, judgeJobOptions(lane, data.id));
  }

  async publish(kind: JobKind, id: string, event: ProgressEvent): Promise<void> {
    const payload = progressEventSchema.parse(event);
    await this.connection.publish(progressChannel(kind, id), JSON.stringify(payload));
  }

  async close(): Promise<void> {
    // The connection is shared (passed in), so Queue.close() leaves it open;
    // main.ts quits it afterwards.
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}
