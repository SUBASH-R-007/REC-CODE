import { JUDGE_RETRY, LANE_PRIORITY, QUEUE_NAME, progressChannel } from "@recx/shared";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BullJudgeQueues, ensureJob } from "../src/queues";

/**
 * BullJudgeQueues against a real Redis 7. Opt-in: RECX_REDIS_TESTS=1.
 * Every key lives under a throwaway BullMQ prefix (deleted afterwards), so a
 * local judge worker consuming the real queues never sees these jobs.
 */
const ENABLED = process.env.RECX_REDIS_TESTS === "1";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe.skipIf(!ENABLED)("BullJudgeQueues against Redis", () => {
  const prefix = `recx-sched-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const log = pino({ level: "silent" });
  let conn: Redis;
  let queues: BullJudgeQueues;

  beforeAll(async () => {
    // Same options as main.ts.
    conn = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1, commandTimeout: 5_000, lazyConnect: true });
    await conn.connect();
    queues = new BullJudgeQueues(conn, log, prefix);
  });

  afterAll(async () => {
    await queues?.close();
    if (conn) {
      let cursor = "0";
      do {
        const [next, keys] = await conn.scan(cursor, "MATCH", `${prefix}:*`, "COUNT", 500);
        if (keys.length > 0) await conn.del(...keys);
        cursor = next;
      } while (cursor !== "0");
      await conn.quit();
    }
  });

  it("reports readiness from the connection", () => {
    expect(queues.ready()).toBe(true);
  });

  it("adds a missing job once, then keeps it", async () => {
    const data = { kind: "submission" as const, id: `${prefix}-a` };
    expect(await queues.state("PRACTICE", data.id)).toBe("unknown");
    expect(await ensureJob(queues, "PRACTICE", data, false)).toBe("added");
    // A job with a priority sits in BullMQ's prioritized set.
    expect(await queues.state("PRACTICE", data.id)).toBe("prioritized");
    expect(await ensureJob(queues, "PRACTICE", data, false)).toBe("kept");
  });

  it("replaces a completed job, which BullMQ would otherwise dedupe", async () => {
    const data = { kind: "run" as const, id: `${prefix}-b` };
    await queues.add("RUN", data);

    const workerConn = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const worker = new Worker(QUEUE_NAME.RUN, async () => "ok", { connection: workerConn, prefix });
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once("completed", () => resolve());
        worker.once("failed", (_job, err) => reject(err));
      });
    } finally {
      await worker.close();
      await workerConn.quit();
    }
    expect(await queues.state("RUN", data.id)).toBe("completed");

    expect(await ensureJob(queues, "RUN", data, true)).toBe("replaced");
    expect(await queues.state("RUN", data.id)).toBe("completed"); // the dry run wrote nothing

    expect(await ensureJob(queues, "RUN", data, false)).toBe("replaced");
    expect(await queues.state("RUN", data.id)).toBe("prioritized");
  });

  it("carries a validation job on the REJUDGE queue with the shared options", async () => {
    const data = { kind: "validation" as const, id: `${prefix}-v` };
    expect(await ensureJob(queues, "REJUDGE", data, false)).toBe("added");
    expect(await queues.state("REJUDGE", data.id)).toBe("prioritized");
    expect(await ensureJob(queues, "REJUDGE", data, false)).toBe("kept");

    const inspect = new Queue(QUEUE_NAME.REJUDGE, { connection: conn, prefix });
    try {
      const job = await inspect.getJob(data.id);
      expect(job?.data).toEqual(data);
      expect(job?.id).toBe(data.id);
      expect(job?.opts.priority).toBe(LANE_PRIORITY.REJUDGE);
      expect(job?.opts.attempts).toBe(JUDGE_RETRY.attempts);
    } finally {
      await inspect.close();
    }
  });

  it("publishes validation progress on its own channel", async () => {
    const id = `${prefix}-vp`;
    const sub = new Redis(REDIS_URL);
    try {
      await sub.subscribe(progressChannel("validation", id));
      const received = new Promise<string>((resolve) => sub.once("message", (_channel: string, message: string) => resolve(message)));
      await queues.publish("validation", id, { type: "state", state: "QUEUED" });
      expect(JSON.parse(await received)).toEqual({ type: "state", state: "QUEUED" });
    } finally {
      await sub.quit();
    }
  });

  it("publishes validated progress events on the shared channel", async () => {
    const id = `${prefix}-c`;
    const sub = new Redis(REDIS_URL);
    try {
      await sub.subscribe(progressChannel("submission", id));
      const received = new Promise<string>((resolve) => sub.once("message", (_channel: string, message: string) => resolve(message)));
      await queues.publish("submission", id, { type: "final" });
      expect(JSON.parse(await received)).toEqual({ type: "final" });
    } finally {
      await sub.quit();
    }
  });
});
