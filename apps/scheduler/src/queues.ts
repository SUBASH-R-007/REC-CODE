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

  /**
   * How many jobs are waiting in a lane, and how old the oldest is
   * (Phase 10a).
   *
   * "Waiting" is `waiting + delayed + prioritized`, not just `waiting`: a
   * job held back by a delay or sitting behind a priority is a job a student
   * is waiting on, and BullMQ counts those separately. Excluding them would
   * make the depth gauge read zero during exactly the backlog the alert
   * exists to catch.
   *
   * The oldest age comes from the HEAD OF EACH of those three lists rather
   * than from scanning the queue: at a depth of two hundred a scan would be
   * the most expensive thing the tick did, and `getJobs` with the range
   * `0..0` returns one job per type, so this is three fetches however deep
   * the lane is.
   *
   * It has to be all three. A job enqueued with a priority — which is every
   * judge job this platform enqueues, see `judgeJobOptions` — never appears
   * in `waiting` at all, so reading only that list would report an age of
   * zero for exactly the backlog the alert exists to catch.
   *
   * Each head is the oldest in its own list: `waiting` is a list in arrival
   * order, and `prioritized` is a zset whose score is the priority first and
   * the insertion counter second — and every job in one lane carries that
   * lane's single priority, so within a lane ascending score IS arrival
   * order. The one approximation is `delayed`, ordered by when it becomes
   * due rather than when it arrived; delayed jobs here are retries with a
   * backoff measured in seconds, so the head is close enough, and taking the
   * MINIMUM timestamp of the three means a wrong guess there can only be
   * corrected by one of the two exact lists, never hidden by it.
   *
   * `timestamp` is when the job was ENQUEUED, which for the oldest waiting
   * job is the number SPEC §10's "oldest job > 60s" rule means: how long
   * somebody has been waiting, not how long the job has existed.
   */
  async depth(lane: JudgeLane): Promise<{ waiting: number; oldestAgeSeconds: number }> {
    const queue = this.queue(lane);
    const counts = await queue.getJobCounts("waiting", "delayed", "prioritized");
    const waiting = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.prioritized ?? 0);
    if (waiting === 0) return { waiting: 0, oldestAgeSeconds: 0 };
    const heads = await queue.getJobs(["waiting", "prioritized", "delayed"], 0, 0, true);
    const stamps = heads.map((job) => job?.timestamp ?? 0).filter((at) => at > 0);
    if (stamps.length === 0) return { waiting, oldestAgeSeconds: 0 };
    const age = (Date.now() - Math.min(...stamps)) / 1000;
    return { waiting, oldestAgeSeconds: Math.max(0, age) };
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
