import type { Redis } from "ioredis";
import { progressChannel, progressEventSchema, type JobKind, type ProgressEvent } from "@recx/shared";
import type { Logger } from "./logger";

/**
 * Live progress for the browser: Redis PUBLISH on recx:<kind>:<id>, relayed
 * by the web app over SSE. The worker sends {type:"state"} and {type:"test"};
 * the web app sends {type:"final"} after it commits the result. Progress is
 * best-effort — a lost event never affects a verdict (Postgres is truth).
 */
export interface Publisher {
  publish(kind: JobKind, id: string, event: ProgressEvent): Promise<void>;
}

export class RedisPublisher implements Publisher {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
  ) {}

  async publish(kind: JobKind, id: string, event: ProgressEvent): Promise<void> {
    const parsed = progressEventSchema.safeParse(event);
    if (!parsed.success) {
      this.logger.error({ kind, id, event }, "refusing to publish an invalid progress event");
      return;
    }
    try {
      await this.redis.publish(progressChannel(kind, id), JSON.stringify(parsed.data));
    } catch (error) {
      this.logger.debug({ kind, id, err: error }, "progress publish failed (non-fatal)");
    }
  }
}

/** Collects events in memory (tests, and the integration test's job path). */
export class MemoryPublisher implements Publisher {
  readonly events: { channel: string; event: ProgressEvent }[] = [];

  async publish(kind: JobKind, id: string, event: ProgressEvent): Promise<void> {
    this.events.push({ channel: progressChannel(kind, id), event: progressEventSchema.parse(event) });
  }
}
