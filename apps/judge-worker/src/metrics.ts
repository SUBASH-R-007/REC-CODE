import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import { buildMetrics } from "@recx/shared";

/**
 * The judge worker's metrics (Phase 10a).
 *
 * Three of the ten, and the three only this process can see: how long a
 * submission's tests actually took inside the sandbox, how often the sandbox
 * failed to initialise, and how often a compile was served from the cache.
 *
 * The one that earns its place in an incident is
 * `judge_sandbox_init_failures_total`. SPEC §10 names the INTERNAL_ERROR rate
 * as "the canary for a broken compiler image or a cgroup misconfiguration
 * after a host upgrade — otherwise discovered from student complaints", and
 * this counter is the same signal one layer down: it moves when `isolate
 * --init` starts refusing, which is what a kernel or cgroup change looks
 * like from here.
 *
 * `judge_worker_heartbeat_age_seconds` is deliberately NOT here. A worker
 * that has died cannot report that its own heartbeat is old, and that is the
 * case the metric exists for — the scheduler derives it from `JudgeNode`.
 * `packages/shared/src/metrics.ts` assigns the owner, and a test asserts it.
 *
 * Its own `Registry`, and no `collectDefaultMetrics`: the host's own CPU and
 * memory come from the node exporter, which is the thing that still works
 * when this process is the problem.
 */

export const registry = new Registry();

const metrics = buildMetrics<Counter<string>, Gauge<string>, Histogram<string>>("judge-worker", {
  counter: (options) => new Counter({ ...options, registers: [registry] }),
  gauge: (options) => new Gauge({ ...options, registers: [registry] }),
  histogram: (options) => new Histogram({ ...options, registers: [registry] }),
});

const runDuration = metrics.judge_run_duration_seconds as Histogram<string>;
const sandboxInitFailures = metrics.judge_sandbox_init_failures_total as Counter<string>;
const compileCacheHits = metrics.judge_compile_cache_hits_total as Counter<string>;

/**
 * Every recorder is a no-throw.
 *
 * A metrics client that can break a judging run is a worse outage than no
 * metrics at all, and on this host it would be worse still: a throw from
 * here would surface as an InfraError, release the lease, and make a
 * perfectly good submission look like a judge failure.
 */
function quiet(what: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error(`[metrics] ${what} failed`, error);
  }
}

/** One judged job, in seconds, measured around the driver call. */
export function runCompleted(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  quiet("runCompleted", () => runDuration.observe(seconds));
}

/** `isolate --init` refused, after the retry. */
export function sandboxInitFailed(): void {
  quiet("sandboxInitFailed", () => sandboxInitFailures.inc());
}

/** A compile served from the cache rather than run. */
export function compileCacheHit(): void {
  quiet("compileCacheHit", () => compileCacheHits.inc());
}

export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export const METRICS_CONTENT_TYPE = registry.contentType;
