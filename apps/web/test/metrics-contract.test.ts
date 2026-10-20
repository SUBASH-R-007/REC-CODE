import { beforeAll, describe, expect, it } from "vitest";
import {
  ALL_METRIC_NAMES,
  FORBIDDEN_METRIC_LABELS,
  METRICS,
  forbiddenLabels,
  metricByName,
  metricsFor,
  parseExposition,
} from "@recx/shared";

/**
 * The metric contract, asserted against the LIVE registry (Phase 10a).
 *
 * The point of keeping the names, types and labels as data is that this test
 * can read what the process actually exposes and compare it with the spec,
 * instead of a reviewer reading two lists side by side and believing they
 * match. So every assertion here goes through the exposition text — the bytes
 * that leave the process — rather than through the `METRICS` array it was
 * built from. A metric registered directly with the client, bypassing
 * `buildMetrics`, appears in the text and nowhere else.
 */

process.env.IP_HASH_PEPPER ??= "metrics-test-pepper-16+";
process.env.DATABASE_URL ??= "postgresql://recx:recx@localhost:5433/recx_test";

let exposition: string;
let served: Array<{ name: string; labels: string[] }>;

beforeAll(async () => {
  const mod = await import("@/lib/metrics");
  // Give every metric a sample, because a Prometheus counter with no
  // observations is not in the exposition text at all — a test over an
  // untouched registry would assert over an empty string and pass.
  mod.sseOpened();
  mod.proctorEventRecorded("BLUR");
  mod.submissionCompleted(3.5);
  mod.verdictReached("AC", "cpp");
  exposition = await mod.renderMetrics();
  served = parseExposition(exposition);
});

describe("the contract itself", () => {
  it("names the ten metrics SPEC §10 asks for", () => {
    expect([...ALL_METRIC_NAMES].sort()).toEqual([
      "judge_compile_cache_hits_total",
      "judge_oldest_job_age_seconds",
      "judge_queue_depth",
      "judge_run_duration_seconds",
      "judge_sandbox_init_failures_total",
      "judge_verdict_total",
      "judge_worker_heartbeat_age_seconds",
      "proctor_event_total",
      "sse_connections_active",
      "submission_e2e_latency_seconds",
    ]);
    expect(METRICS).toHaveLength(10);
  });

  it("gives every metric a help string somebody could act on", () => {
    for (const metric of METRICS) {
      expect(metric.help.length, metric.name).toBeGreaterThan(20);
      expect(metric.help.endsWith("."), metric.name).toBe(true);
    }
  });

  it("gives every histogram its own buckets", () => {
    /**
     * Default buckets top out at 10 seconds. The judge's own ceiling is 15
     * and the end-to-end alert fires at a p95 of 30, so defaults would put
     * every normal run and every pathological one in the same final bucket —
     * and the alert would be reading a number that cannot distinguish them.
     */
    for (const metric of METRICS.filter((m) => m.type === "histogram")) {
      expect(metric.buckets, metric.name).toBeDefined();
      expect(metric.buckets!.length, metric.name).toBeGreaterThan(5);
      expect(Math.max(...metric.buckets!), metric.name).toBeGreaterThanOrEqual(15);
      // Ascending, or Prometheus silently misreports.
      const sorted = [...metric.buckets!].sort((a, b) => a - b);
      expect(metric.buckets, metric.name).toEqual(sorted);
    }
  });

  it("gives each metric exactly one owning process", () => {
    // Two processes reporting the same gauge would make the value depend on
    // which replica was scraped.
    const byName = new Map<string, number>();
    for (const metric of METRICS) byName.set(metric.name, (byName.get(metric.name) ?? 0) + 1);
    expect([...byName].filter(([, n]) => n !== 1)).toEqual([]);
    expect(metricsFor("web").map((m) => m.name).sort()).toEqual([
      /**
       * `judge_verdict_total` is here and not on the scheduler, and the
       * reason is the rule this whole test is about: a COUNTER is safe on a
       * replicated process because Prometheus sums across instances, while a
       * GAUGE is not, because two replicas reporting one Redis number report
       * it twice. Every verdict passes through `POST /api/judge/result`, so
       * counting it where it lands is exact; the scheduler would have to
       * query for deltas and would miscount a skipped tick.
       */
      "judge_verdict_total",
      "proctor_event_total",
      "sse_connections_active",
      "submission_e2e_latency_seconds",
    ]);
  });

  it("puts the worker heartbeat on the SCHEDULER, not on the worker", () => {
    /**
     * The one that matters most. A worker that has died cannot report that
     * its own heartbeat is old, and that is the case this metric exists for:
     * self-reported, it goes MISSING rather than HIGH, and an alert on a
     * missing series is a different and much easier-to-get-wrong rule.
     */
    expect(metricByName("judge_worker_heartbeat_age_seconds")!.owner).toBe("scheduler");
    expect(metricsFor("judge-worker").map((m) => m.name)).not.toContain(
      "judge_worker_heartbeat_age_seconds",
    );
  });

  it("puts the queue depth on the scheduler too, for the same reason", () => {
    // On web it would depend on which of two replicas was scraped.
    expect(metricByName("judge_queue_depth")!.owner).toBe("scheduler");
  });
});

describe("no metric label can identify a person", () => {
  it("declares only bounded, non-personal labels", () => {
    /**
     * Not a cardinality rule. Prometheus is scraped by a separate host,
     * retained for months and rendered on dashboards people screenshot into
     * chat — it is the least controlled datastore in the system and the one
     * no retention policy reaches.
     */
    for (const metric of METRICS) {
      expect(forbiddenLabels(metric.labels), metric.name).toEqual([]);
    }
    // The whole label vocabulary of the system, deduplicated: `queue` is
    // used by two metrics. Five names, all bounded, none a person.
    expect([...new Set(METRICS.flatMap((m) => m.labels))].sort()).toEqual([
      "language",
      "queue",
      "type",
      "verdict",
      "worker",
    ]);
  });

  it("counts proctor events by TYPE and nothing else", () => {
    // A per-attempt label would be a per-student behavioural record in the
    // one place no retention policy reaches.
    expect(metricByName("proctor_event_total")!.labels).toEqual(["type"]);
  });

  it("holds over the SERVED text, not only over the declaration", () => {
    for (const metric of served) {
      expect(forbiddenLabels(metric.labels), metric.name).toEqual([]);
    }
    expect(served.length).toBeGreaterThan(0);
  });

  it("mutation check: the rule catches what it is meant to", () => {
    // Without this the forbidden list could be narrowed until the rule
    // passed vacuously.
    expect(forbiddenLabels(["queue", "userId"])).toEqual(["userId"]);
    expect(forbiddenLabels(["UserID"]), "case-insensitive").toHaveLength(1);
    expect(forbiddenLabels(["submissionId", "attemptId"])).toEqual(["attemptId", "submissionId"]);
    expect(forbiddenLabels(["verdict", "language"]), "the allowed ones").toEqual([]);
    expect(FORBIDDEN_METRIC_LABELS.length).toBeGreaterThan(10);
  });
});

describe("the web registry exposes exactly its four", () => {
  it("serves them, with the help text from the contract", () => {
    for (const metric of metricsFor("web")) {
      expect(exposition, metric.name).toContain(`# HELP ${metric.name} ${metric.help}`);
      expect(exposition, metric.name).toContain(`# TYPE ${metric.name} ${metric.type}`);
    }
  });

  it("serves no metric belonging to another process", () => {
    const names = new Set(served.map((m) => m.name));
    for (const metric of METRICS.filter((m) => m.owner !== "web")) {
      expect(names.has(metric.name), metric.name).toBe(false);
    }
  });

  it("serves no default process metric", () => {
    /**
     * `collectDefaultMetrics` is deliberately not called. `process_cpu_*`
     * and `nodejs_*` are useful, but they would land on a registry this test
     * asserts the contents of, and in a test run on a global registry they
     * leak between suites. The host's own metrics come from the node
     * exporter, which is the thing that still works when this process is
     * the problem.
     */
    const names = served.map((m) => m.name);
    expect(names.filter((n) => n.startsWith("process_") || n.startsWith("nodejs_"))).toEqual([]);
  });

  it("counts an SSE connection up and back down", async () => {
    const mod = await import("@/lib/metrics");
    const value = async () => {
      const text = await mod.renderMetrics();
      return Number(/^sse_connections_active (\d+)/m.exec(text)?.[1] ?? "-1");
    };
    const before = await value();
    mod.sseOpened();
    expect(await value()).toBe(before + 1);
    mod.sseClosed();
    expect(await value()).toBe(before);
  });

  it("ignores a nonsense latency rather than poisoning the histogram", async () => {
    const mod = await import("@/lib/metrics");
    const count = async () => {
      const text = await mod.renderMetrics();
      return Number(/^submission_e2e_latency_seconds_count (\d+)/m.exec(text)?.[1] ?? "-1");
    };
    const before = await count();
    mod.submissionCompleted(Number.NaN);
    mod.submissionCompleted(-5);
    mod.submissionCompleted(Number.POSITIVE_INFINITY);
    expect(await count(), "a negative or non-finite sample is dropped").toBe(before);
    mod.submissionCompleted(2);
    expect(await count()).toBe(before + 1);
  });
});

describe("parseExposition reads the bytes, not the object", () => {
  it("picks up names and label keys, and skips comments", () => {
    const parsed = parseExposition(
      [
        "# HELP a_total help",
        "# TYPE a_total counter",
        'a_total{verdict="AC",language="cpp20"} 3',
        "b_gauge 7",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual([
      { name: "a_total", labels: ["language", "verdict"] },
      { name: "b_gauge", labels: [] },
    ]);
  });

  it("would catch a label the declaration never mentioned", () => {
    // The reason this reads text: a metric registered directly with the
    // client bypasses buildMetrics entirely and appears only here.
    const parsed = parseExposition('sneaky_total{userId="u_1"} 1');
    expect(forbiddenLabels(parsed[0]!.labels)).toEqual(["userId"]);
  });
});
