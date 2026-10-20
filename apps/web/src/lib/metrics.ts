import "server-only";
import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import { buildMetrics } from "@recx/shared";

/**
 * The web process's metrics (Phase 10a).
 *
 * Three of the ten, and they are the three only this process can see: an
 * open verdict stream, a proctor signal as it arrives, and submit-to-verdict
 * as the STUDENT experiences it rather than as the judge measures it.
 *
 * Its own `Registry`, not the client's global one. Two reasons, and the
 * second is the one that bites: the global registry is shared with anything
 * else that happens to import the client, and `collectDefaultMetrics` on a
 * global registry in a test run leaks process gauges between suites.
 *
 * Built from the contract in `@recx/shared`, so a metric cannot exist here
 * under a name or a label set SPEC §10 does not give — and `buildMetrics`
 * throws at startup on a label that could identify a person, because a
 * process that would publish a student's id to the monitoring host should
 * not start.
 */

export const registry = new Registry();

const metrics = buildMetrics<Counter<string>, Gauge<string>, Histogram<string>>("web", {
  counter: (options) => new Counter({ ...options, registers: [registry] }),
  gauge: (options) => new Gauge({ ...options, registers: [registry] }),
  histogram: (options) => new Histogram({ ...options, registers: [registry] }),
});

const sseConnections = metrics.sse_connections_active as Gauge<string>;
const proctorEvents = metrics.proctor_event_total as Counter<string>;
const e2eLatency = metrics.submission_e2e_latency_seconds as Histogram<string>;

/**
 * Every recorder is a no-throw. A metrics client that can break a request is
 * a worse outage than no metrics: the same reasoning `audit()` uses, and for
 * the same reason — observability is there to describe failures, not cause
 * them.
 */
function quiet(what: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.error(`[metrics] ${what} failed`, error);
  }
}

export function sseOpened(): void {
  quiet("sseOpened", () => sseConnections.inc());
}

export function sseClosed(): void {
  quiet("sseClosed", () => sseConnections.dec());
}

/** One proctor signal. The TYPE only — never the attempt, never the student. */
export function proctorEventRecorded(type: string): void {
  quiet("proctorEventRecorded", () => proctorEvents.inc({ type }));
}

/**
 * Submit to final verdict, in seconds.
 *
 * Observed where the STUDENT's wait ends, not where the judge's work ends:
 * the number that matters includes the queue, and a histogram taken inside
 * the worker would report a happy 1.2s while a student watched a spinner for
 * forty.
 */
export function submissionCompleted(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  quiet("submissionCompleted", () => e2eLatency.observe(seconds));
}

/** The exposition payload, for `/metrics`. */
export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}

export const METRICS_CONTENT_TYPE = registry.contentType;
