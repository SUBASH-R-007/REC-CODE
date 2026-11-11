import { METRICS, forbiddenLabels, metricsFor, parseExposition } from "@recx/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { compileCacheHit, renderMetrics, runCompleted, sandboxInitFailed } from "../src/metrics";

/**
 * The judge worker's three metrics, asserted against the served text
 * (Phase 10a).
 *
 * The same rule as `apps/web/test/metrics-contract.test.ts`: every assertion
 * reads the exposition this process would hand a scrape, not the `METRICS`
 * array it was built from. A metric registered straight with the client,
 * bypassing `buildMetrics`, appears in the text and nowhere else — and the
 * label rule exists precisely to catch a metric that did not go through the
 * contract.
 */

let exposition: string;
let served: Array<{ name: string; labels: string[] }>;

beforeAll(async () => {
  /**
   * Sample all three first. A Prometheus counter with no observations is not
   * in the exposition at all, so a test over an untouched registry would
   * assert over a near-empty string and pass whatever was wrong.
   */
  runCompleted(1.25);
  sandboxInitFailed();
  compileCacheHit();
  exposition = await renderMetrics();
  served = parseExposition(exposition);
});

describe("the worker registry exposes exactly its three", () => {
  it("serves them, with the type and help text from the contract", () => {
    const owned = metricsFor("judge-worker");
    expect(owned.map((m) => m.name)).toEqual([
      "judge_run_duration_seconds",
      "judge_sandbox_init_failures_total",
      "judge_compile_cache_hits_total",
    ]);
    for (const metric of owned) {
      expect(exposition, metric.name).toContain(`# HELP ${metric.name} ${metric.help}`);
      expect(exposition, metric.name).toContain(`# TYPE ${metric.name} ${metric.type}`);
    }
  });

  it("serves no metric belonging to another process", () => {
    const names = new Set(served.map((m) => m.name));
    for (const metric of METRICS.filter((m) => m.owner !== "judge-worker")) {
      expect(names.has(metric.name), metric.name).toBe(false);
    }
  });

  it("does not serve the heartbeat age, which only the scheduler can know", () => {
    /**
     * Called out on its own because it is the one a future change is most
     * likely to get wrong: the worker knows when it last checked in, so
     * publishing it here looks obvious. It is wrong — a worker that has died
     * cannot report that its heartbeat is old, which is the case the metric
     * exists for. `packages/shared/src/metrics.ts` assigns it to the
     * scheduler, derived from `JudgeNode.lastHeartbeatAt`.
     */
    expect(exposition).not.toContain("judge_worker_heartbeat_age_seconds");
  });

  it("serves no default process metric", () => {
    const names = served.map((m) => m.name);
    expect(names.filter((n) => n.startsWith("process_") || n.startsWith("nodejs_"))).toEqual([]);
  });

  it("carries no label at all, so nothing here can name a submission", () => {
    /**
     * All three are declared label-free, and on this host that is the
     * strongest version of the rule: the worker is the one process holding a
     * submission's source, and a `submissionId` label would put a
     * per-student record in the least access-controlled datastore in the
     * system.
     */
    for (const metric of served) {
      expect(forbiddenLabels(metric.labels), metric.name).toEqual([]);
      /**
       * `le` is excluded because it is not a label of the metric: it is how
       * the Prometheus text format spells a histogram's bucket boundaries,
       * and it appears on `judge_run_duration_seconds_bucket` whatever the
       * contract says. Every label the contract itself declares for these
       * three is checked by the emptiness below.
       */
      expect(metric.labels.filter((label) => label !== "le"), metric.name).toEqual([]);
    }
    for (const metric of metricsFor("judge-worker")) expect(metric.labels, metric.name).toEqual([]);
  });
});

describe("the recorders", () => {
  const read = async (pattern: RegExp): Promise<number> => {
    const text = await renderMetrics();
    return Number(pattern.exec(text)?.[1] ?? "-1");
  };
  const runs = () => read(/^judge_run_duration_seconds_count (\d+)/m);
  const initFailures = () => read(/^judge_sandbox_init_failures_total (\d+)/m);
  const cacheHits = () => read(/^judge_compile_cache_hits_total (\d+)/m);

  it("records one run per judged job", async () => {
    const before = await runs();
    runCompleted(0.5);
    runCompleted(12);
    expect(await runs()).toBe(before + 2);
  });

  it("drops a nonsense duration rather than poisoning the histogram", async () => {
    const before = await runs();
    runCompleted(Number.NaN);
    runCompleted(-1);
    runCompleted(Number.POSITIVE_INFINITY);
    expect(await runs(), "a non-finite or negative sample is not an observation").toBe(before);
  });

  it("counts a sandbox init failure and a compile cache hit", async () => {
    const failures = await initFailures();
    const hits = await cacheHits();
    sandboxInitFailed();
    compileCacheHit();
    compileCacheHit();
    expect(await initFailures()).toBe(failures + 1);
    expect(await cacheHits()).toBe(hits + 2);
  });

  it("never throws, whatever it is handed", () => {
    /**
     * The reason every recorder is wrapped: a throw from here would surface
     * as an InfraError, release the lease, and make a perfectly good
     * submission look like a judge failure. Metrics may be wrong; they may
     * not fail a student's run.
     */
    expect(() => runCompleted(Number.NaN)).not.toThrow();
    expect(() => runCompleted(Number.MAX_VALUE)).not.toThrow();
    expect(() => sandboxInitFailed()).not.toThrow();
    expect(() => compileCacheHit()).not.toThrow();
  });
});
