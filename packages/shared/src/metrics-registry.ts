import { METRICS, forbiddenLabels, metricsFor, type MetricOwner, type MetricSpec } from "./metrics";

/**
 * Building a registry from the metric contract (Phase 10a).
 *
 * The three processes each expose a different subset of `METRICS`, and each
 * builds it the same way: from the contract, not from a hand-written list
 * beside it. That is the whole point of having the contract as data — a
 * metric cannot exist in the registry under a name or a label set the spec
 * does not give, because nothing constructs one.
 *
 * `@prometheus-io/client` is not imported here. `packages/shared` is
 * imported by the judge worker, which SPEC §7 keeps to a minimal dependency
 * list, and by the design package; a Prometheus client in shared would put
 * it in every consumer's graph. So this module describes the registry and
 * each app constructs it with its own client — `buildMetrics` takes the
 * constructors.
 */

export interface MetricFactories<C, G, H> {
  counter(options: { name: string; help: string; labelNames: string[] }): C;
  gauge(options: { name: string; help: string; labelNames: string[] }): G;
  histogram(options: { name: string; help: string; labelNames: string[]; buckets: number[] }): H;
}

export type BuiltMetrics<C, G, H> = Readonly<Record<string, C | G | H>>;

/**
 * Construct every metric this owner is responsible for.
 *
 * Refuses, loudly, a spec entry whose labels would identify a person. The
 * same rule is asserted over the live registry by a test; this is the one
 * that stops a bad entry ever reaching it, and it throws at startup rather
 * than returning an error nobody reads — a process that would otherwise
 * publish a student's id to the monitoring VM should not start.
 */
export function buildMetrics<C, G, H>(
  owner: MetricOwner,
  factories: MetricFactories<C, G, H>,
): BuiltMetrics<C, G, H> {
  const out: Record<string, C | G | H> = {};
  for (const spec of metricsFor(owner)) {
    const bad = forbiddenLabels(spec.labels);
    if (bad.length > 0) {
      throw new Error(
        `Metric ${spec.name} declares label(s) that could identify a person: ${bad.join(", ")}. ` +
          "Prometheus is scraped by a separate host, retained for months and screenshotted onto dashboards.",
      );
    }
    out[spec.name] = construct(spec, factories);
  }
  return Object.freeze(out);
}

function construct<C, G, H>(spec: MetricSpec, factories: MetricFactories<C, G, H>): C | G | H {
  const base = { name: spec.name, help: spec.help, labelNames: [...spec.labels] };
  switch (spec.type) {
    case "counter":
      return factories.counter(base);
    case "gauge":
      return factories.gauge(base);
    case "histogram":
      if (!spec.buckets || spec.buckets.length === 0) {
        throw new Error(`Histogram ${spec.name} has no buckets. Default buckets hide the range that matters.`);
      }
      return factories.histogram({ ...base, buckets: [...spec.buckets] });
  }
}

/** Every metric name, for a test that reads a live registry's output. */
export const ALL_METRIC_NAMES: readonly string[] = Object.freeze(METRICS.map((metric) => metric.name));

/**
 * Parse the names and labels out of a Prometheus exposition payload.
 *
 * Used by the fence that reads `/metrics` and asserts no label identifies a
 * person. It reads the SERVED TEXT rather than the registry object, because
 * the served text is what leaves the process — a metric registered through
 * the client directly, bypassing `buildMetrics`, appears here and nowhere
 * else.
 */
export function parseExposition(text: string): Array<{ name: string; labels: string[] }> {
  const out = new Map<string, Set<string>>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{([^}]*)\})?/.exec(trimmed);
    if (!match) continue;
    const name = match[1]!;
    const labels = out.get(name) ?? new Set<string>();
    for (const pair of (match[3] ?? "").split(",")) {
      const key = pair.split("=")[0]?.trim();
      if (key) labels.add(key);
    }
    out.set(name, labels);
  }
  return [...out].map(([name, labels]) => ({ name, labels: [...labels].sort() })).sort((a, b) => a.name.localeCompare(b.name));
}
