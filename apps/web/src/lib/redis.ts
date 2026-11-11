import "server-only";
import { Redis } from "ioredis";
import { env } from "@/lib/env";

/**
 * Redis is transport only — Postgres is truth. A Redis flush loses queue
 * position and zero submissions (the scheduler's reconciler re-enqueues from
 * Postgres every 10s). So every caller here must tolerate Redis being down.
 */
const globalForRedis = globalThis as unknown as { recxRedis?: Redis };

export function redis(): Redis {
  if (!globalForRedis.recxRedis) {
    globalForRedis.recxRedis = new Redis(env().REDIS_URL, {
      // BullMQ requires this for blocking connections; harmless here.
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    globalForRedis.recxRedis.on("error", (err) => {
      console.error("[redis] connection error:", err.message);
    });
  }
  return globalForRedis.recxRedis;
}

/** A fresh connection for SUBSCRIBE (a subscribed connection can do nothing else). */
export function newSubscriber(): Redis {
  const sub = new Redis(env().REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
  });
  sub.on("error", (err) => console.error("[redis:sub] error:", err.message));
  return sub;
}
