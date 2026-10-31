import "server-only";
import { Queue } from "bullmq";
import {
  engineForIoMode,
  judgeJobOptions,
  queueNameFor,
  type JobKind,
  type JudgeEngine,
  type JudgeJobData,
  type JudgeLane,
} from "@recx/shared";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";

const globalForQueues = globalThis as unknown as { recxQueues?: Map<string, Queue<JudgeJobData>> };

function queueFor(engine: JudgeEngine, lane: JudgeLane): Queue<JudgeJobData> {
  globalForQueues.recxQueues ??= new Map();
  const name = queueNameFor(engine, lane);
  let q = globalForQueues.recxQueues.get(name);
  if (!q) {
    q = new Queue<JudgeJobData>(name, { connection: redis() });
    globalForQueues.recxQueues.set(name, q);
  }
  return q;
}

/**
 * Which engine judges this job (Phase 12k).
 *
 * Read here, from the row, rather than passed in by each caller. There are
 * five enqueue call sites and none of them has the problem version in hand;
 * a parameter would be five chances to pass the wrong one, and a SQL job on
 * an isolate queue is a job an isolate node claims and cannot run. One
 * indexed lookup on the submit path is the cheaper mistake.
 *
 * Null means the row is gone, in which case there is nothing to enqueue.
 */
async function engineForJob(kind: JobKind, id: string): Promise<JudgeEngine | null> {
  const select = { problemVersion: { select: { ioMode: true } } } as const;
  const row =
    kind === "submission"
      ? await db.submission.findUnique({ where: { id }, select })
      : kind === "run"
        ? await db.runRequest.findUnique({ where: { id }, select })
        : await db.validationRun.findUnique({ where: { id }, select });
  if (!row) return null;
  return engineForIoMode(row.problemVersion.ioMode);
}

/**
 * Enqueue a judge job AFTER its row is committed to Postgres as QUEUED.
 * jobId = the row id (BullMQ dedupes). Returns false — never throws — when
 * Redis is unavailable: the row stays QUEUED and the scheduler's reconciler
 * enqueues it within ~10s. Redis is transport, Postgres is truth.
 */
export async function enqueueJudge(kind: JobKind, id: string, lane: JudgeLane): Promise<boolean> {
  try {
    const engine = await engineForJob(kind, id);
    if (engine === null) {
      console.error(`[judge-queue] ${kind} ${id} has no row; nothing to enqueue`);
      return false;
    }
    const queue = queueFor(engine, lane);
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
