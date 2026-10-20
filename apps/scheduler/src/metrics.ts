import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import { JUDGE_LANES, buildMetrics, type JudgeLane } from "@recx/shared";

/**
 * The scheduler's metrics (Phase 10a).
 *
 * Three of the ten, and they are here rather than on the web app or the
 * worker for two different reasons.
 *
 * **The queue gauges** (`judge_queue_depth`, `judge_oldest_job_age_seconds`)
 * are here because the scheduler already holds a Redis connection and
 * already runs every tick. On the web app the number would depend on which
 * of two replicas Prometheus happened to scrape.
 *
 * **The heartbeat gauge** (`judge_worker_heartbeat_age_seconds`) is here
 * because the metric exists to catch a DEAD worker, and a dead worker cannot
 * report that its own heartbeat is old. Self-reported, the series goes
 * MISSING rather than HIGH, and an alert on a missing series is a different
 * rule with different failure modes — `absent()` fires on a restart, on a
 * scrape timeout and on a relabelling mistake, so it gets silenced. Derived
 * from `JudgeNode.lastHeartbeatAt`, the same row the reconciler reads, it
 * simply rises.
 *
 * `judge_verdict_total` is deliberately NOT here. Every verdict passes
 * through `POST /api/judge/result` on the web app, so counting it there is
 * exact; the scheduler would have to query for deltas and would miscount a
 * skipped tick. A counter on a replicated process is fine — Prometheus sums
 * across instances — which is the whole reason gauges and counters are
 * placed differently.
 */

export const registry = new Registry();

const metrics = buildMetrics<Counter<string>, Gauge<string>, Histogram<string>>("scheduler", {
  counter: (options) => new Counter({ ...options, registers: [registry] }),
  gauge: (options) => new Gauge({ ...options, registers: [registry] }),
  histogram: (options) => new Histogram({ ...options, registers: [registry] }),
});

const queueDepth = metrics.judge_queue_depth as Gauge<string>;
const oldestJobAge = metrics.judge_oldest_job_age_seconds as Gauge<string>;
const heartbeatAge = metrics.judge_worker_heartbeat_age_seconds as Gauge<string>;

function quiet(what: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error(`[metrics] ${what} failed`, error);
  }
}

/**
 * Publish one lane's depth and oldest-job age.
 *
 * Both are SET rather than incremented, because both are gauges read from
 * Redis each tick: a counter would drift the moment a tick was skipped, and
 * this surface is read by an alert with a two-minute `for:` that must not be
 * reading yesterday's number.
 */
export function observeQueue(lane: JudgeLane, depth: number, oldestAgeSeconds: number): void {
  quiet("observeQueue", () => {
    queueDepth.set({ queue: lane }, Math.max(0, depth));
    oldestJobAge.set({ queue: lane }, Math.max(0, oldestAgeSeconds));
  });
}

/**
 * A lane with nothing in it is ZERO, not absent.
 *
 * This is the whole reason it is a separate function. A gauge that simply
 * stops being set when a lane empties keeps its last value for ever in some
 * scrape configurations and disappears in others — and "queue depth > 200
 * for 2 min" would then alert on a lane that drained an hour ago. Every tick
 * publishes every lane, empty or not.
 */
export function observeEmptyLanes(seen: ReadonlySet<JudgeLane>): void {
  quiet("observeEmptyLanes", () => {
    for (const lane of JUDGE_LANES) {
      if (seen.has(lane)) continue;
      queueDepth.set({ queue: lane }, 0);
      oldestJobAge.set({ queue: lane }, 0);
    }
  });
}

/**
 * How long ago each judge node checked in, as the scheduler sees it.
 *
 * `worker` is the node's HOSTNAME, which is bounded and is not a person. A
 * node that has been removed from the table stops being published, which is
 * correct: it is gone, not silent.
 */
export function observeHeartbeats(nodes: readonly { hostname: string; ageSeconds: number }[]): void {
  quiet("observeHeartbeats", () => {
    heartbeatAge.reset();
    for (const node of nodes) heartbeatAge.set({ worker: node.hostname }, Math.max(0, node.ageSeconds));
  });
}

export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export const METRICS_CONTENT_TYPE = registry.contentType;
