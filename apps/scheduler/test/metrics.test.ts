import { JUDGE_LANES, METRICS, forbiddenLabels, metricsFor, parseExposition } from "@recx/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { observeEmptyLanes, observeHeartbeats, observeQueue, renderMetrics } from "../src/metrics";

/**
 * The scheduler's three metrics, asserted against the served text
 * (Phase 10a).
 *
 * These are the three gauges, and a gauge is the one metric type that can be
 * silently wrong for hours: a counter that stops moving is visible, whereas a
 * gauge that stops being SET keeps its last value in some scrape
 * configurations and vanishes in others. So the assertions below are mostly
 * about what happens when there is nothing to report — an empty lane, a
 * removed node — because that is where a gauge lies.
 */

let served: Array<{ name: string; labels: string[] }>;

const value = async (pattern: RegExp): Promise<number> => {
  const text = await renderMetrics();
  return Number(pattern.exec(text)?.[1] ?? "-1");
};
const depthOf = (lane: string) => value(new RegExp(`^judge_queue_depth\\{queue="${lane}"\\} (\\d+(?:\\.\\d+)?)`, "m"));
const ageOf = (lane: string) =>
  value(new RegExp(`^judge_oldest_job_age_seconds\\{queue="${lane}"\\} (\\d+(?:\\.\\d+)?)`, "m"));
const heartbeatOf = (worker: string) =>
  value(new RegExp(`^judge_worker_heartbeat_age_seconds\\{worker="${worker}"\\} (\\d+(?:\\.\\d+)?)`, "m"));

beforeAll(async () => {
  observeQueue("PRACTICE", 3, 12);
  observeHeartbeats([{ hostname: "judge-1", ageSeconds: 7 }]);
  served = parseExposition(await renderMetrics());
});

describe("the scheduler registry exposes exactly its three", () => {
  it("serves them, with the type and help text from the contract", async () => {
    const owned = metricsFor("scheduler");
    expect(owned.map((m) => m.name)).toEqual([
      "judge_queue_depth",
      "judge_oldest_job_age_seconds",
      "judge_worker_heartbeat_age_seconds",
    ]);
    const exposition = await renderMetrics();
    for (const metric of owned) {
      expect(exposition, metric.name).toContain(`# HELP ${metric.name} ${metric.help}`);
      expect(exposition, metric.name).toContain(`# TYPE ${metric.name} ${metric.type}`);
    }
  });

  it("serves no metric belonging to another process", () => {
    const names = new Set(served.map((m) => m.name));
    for (const metric of METRICS.filter((m) => m.owner !== "scheduler")) {
      expect(names.has(metric.name), metric.name).toBe(false);
    }
  });

  it("serves no default process metric", () => {
    const names = served.map((m) => m.name);
    expect(names.filter((n) => n.startsWith("process_") || n.startsWith("nodejs_"))).toEqual([]);
  });

  it("labels by lane and by hostname, and by nothing that names a person", () => {
    for (const metric of served) expect(forbiddenLabels(metric.labels), metric.name).toEqual([]);
    const byName = new Map(served.map((m) => [m.name, m.labels]));
    expect(byName.get("judge_queue_depth")).toEqual(["queue"]);
    expect(byName.get("judge_oldest_job_age_seconds")).toEqual(["queue"]);
    /**
     * `worker` is a HOSTNAME. It is bounded (one series per judge host, and
     * there will be single digits of them), it is not a person, and it is
     * the only thing an operator can act on: "which box" is the first
     * question asked when a heartbeat goes stale.
     */
    expect(byName.get("judge_worker_heartbeat_age_seconds")).toEqual(["worker"]);
  });
});

describe("the queue gauges", () => {
  it("sets a lane's depth and oldest age, and sets them again next tick", async () => {
    observeQueue("CONTEST", 200, 61);
    expect(await depthOf("CONTEST")).toBe(200);
    expect(await ageOf("CONTEST")).toBe(61);
    // A gauge is SET, not accumulated: the next tick's reading replaces it.
    observeQueue("CONTEST", 1, 0.5);
    expect(await depthOf("CONTEST")).toBe(1);
    expect(await ageOf("CONTEST")).toBe(0.5);
  });

  it("publishes an empty lane as zero rather than leaving it absent", async () => {
    /**
     * The whole reason `observeEmptyLanes` exists. SPEC §10's rule is "queue
     * depth > 200 for 2 min"; a lane that drained but stopped being
     * published would keep its last value and alert for ever on a queue that
     * is empty.
     */
    observeQueue("PRACTICE", 42, 99);
    expect(await depthOf("PRACTICE")).toBe(42);
    observeEmptyLanes(new Set(["CONTEST"]));
    expect(await depthOf("PRACTICE"), "a lane that reported nothing this tick is zero").toBe(0);
    expect(await ageOf("PRACTICE")).toBe(0);
  });

  it("leaves a lane that DID report alone", async () => {
    observeQueue("CONTEST", 5, 5);
    observeEmptyLanes(new Set(["CONTEST"]));
    expect(await depthOf("CONTEST")).toBe(5);
  });

  it("publishes every lane, so no lane is ever a missing series", async () => {
    for (const lane of JUDGE_LANES) observeQueue(lane, 0, 0);
    const text = await renderMetrics();
    for (const lane of JUDGE_LANES) {
      expect(text, lane).toContain(`judge_queue_depth{queue="${lane}"}`);
      expect(text, lane).toContain(`judge_oldest_job_age_seconds{queue="${lane}"}`);
    }
  });

  it("clamps a negative reading to zero instead of publishing it", async () => {
    // Clock skew between the app and Redis can make an age negative. A
    // negative depth cannot happen, and if it ever does it is a bug here,
    // not a queue with less than nothing in it.
    observeQueue("RUN", -4, -30);
    expect(await depthOf("RUN")).toBe(0);
    expect(await ageOf("RUN")).toBe(0);
  });
});

describe("the heartbeat gauge", () => {
  it("publishes one series per node", async () => {
    observeHeartbeats([
      { hostname: "judge-1", ageSeconds: 4 },
      { hostname: "judge-2", ageSeconds: 300 },
    ]);
    expect(await heartbeatOf("judge-1")).toBe(4);
    expect(await heartbeatOf("judge-2")).toBe(300);
  });

  it("drops a node that is no longer in the table", async () => {
    /**
     * `reset()` before publishing, and this is the one place where a
     * disappearing series is RIGHT: a node removed from `JudgeNode` is gone,
     * not silent, and a gauge left at its last age would have somebody
     * paging a host that no longer exists.
     */
    observeHeartbeats([
      { hostname: "judge-1", ageSeconds: 4 },
      { hostname: "judge-gone", ageSeconds: 9 },
    ]);
    expect(await heartbeatOf("judge-gone")).toBe(9);
    observeHeartbeats([{ hostname: "judge-1", ageSeconds: 5 }]);
    expect(await heartbeatOf("judge-gone"), "a removed node stops being published").toBe(-1);
    expect(await heartbeatOf("judge-1")).toBe(5);
  });

  it("publishes nothing at all when the table is empty, rather than a stale set", async () => {
    observeHeartbeats([{ hostname: "judge-1", ageSeconds: 5 }]);
    observeHeartbeats([]);
    const text = await renderMetrics();
    expect(text).not.toContain('judge_worker_heartbeat_age_seconds{worker="judge-1"}');
  });
});
