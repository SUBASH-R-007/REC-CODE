import "server-only";
import { Queue } from "bullmq";
import {
  judgeJobOptions,
  QUEUE_NAME,
  type JobKind,
  type JudgeJobData,
  type JudgeLane,
} from "@recx/shared";
import { redis } from "@/lib/redis";

const globalForQueues = globalThis as unknown as { recxQueues?: Map<JudgeLane, Queue<JudgeJobData>> };

function queueFor(lane: JudgeLane): Queue<JudgeJobData> {
  globalForQueues.recxQueues ??= new Map();
  let q = globalForQueues.recxQueues.get(lane);
  if (!q) {
    q = new Queue<JudgeJobData>(QUEUE_NAME[lane], { connection: redis() });
    globalForQueues.recxQueues.set(lane, q);
  }
  return q;
}

/**
 * Enqueue a judge job AFTER its row is committed to Postgres as QUEUED.
 * jobId = the row id (BullMQ dedupes). Returns false — never throws — when
 * Redis is unavailable: the row stays QUEUED and the scheduler's reconciler
 * enqueues it within ~10s. Redis is transport, Postgres is truth.
 */
export async function enqueueJudge(kind: JobKind, id: string, lane: JudgeLane): Promise<boolean> {
  try {
    const queue = queueFor(lane);
    const existing = await queue.getJob(id);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") await existing.remove();
      else return true; // already waiting / active / delayed
    }
    await queue.add("judge", { kind, id }, judgeJobOptions(lane, id));
    return true;
  } catch (error) {
    console.error(`[judge-queue] enqueue failed for ${kind} ${id}; reconciler will retry:`, (error as Error).message);
    return false;
  }
}
