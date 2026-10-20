import type { Db } from "@recx/db";
import { JUDGE_LANES, type JudgeLane } from "@recx/shared";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { observeHeartbeats, observeQueue, renderMetrics } from "../src/metrics";
import { observeJudgeMetrics, type QueueCounts } from "../src/observe";

/**
 * The once-a-tick observer (Phase 10a).
 *
 * Two properties matter here and neither is about a number being right.
 *
 * The first is that this can never affect a tick: it reads and publishes, and
 * a Redis hiccup or a database timeout inside it must be a missing data point,
 * not a failed reconciliation. Every test that makes something throw asserts
 * that `observeJudgeMetrics` resolves anyway.
 *
 * The second is that it publishes EVERY lane and EVERY node each tick,
 * including the empty and the idle ones, because a gauge that stops being set
 * is the failure mode that makes an alert fire on a queue that drained an
 * hour ago.
 */

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);

function logger(): { log: Logger; warnings: unknown[] } {
  const warnings: unknown[] = [];
  const noop = () => {};
  const log = {
    warn: (...args: unknown[]) => warnings.push(args),
    info: noop,
    debug: noop,
    error: noop,
    fatal: noop,
    trace: noop,
  } as unknown as Logger;
  return { log, warnings };
}

/** A queue port that answers from a plain map, with an optional failure. */
function queues(options: {
  ready?: boolean;
  depths?: Partial<Record<JudgeLane, { waiting: number; oldestAgeSeconds: number }>>;
  throwOn?: JudgeLane;
}): QueueCounts & { asked: JudgeLane[] } {
  const asked: JudgeLane[] = [];
  return {
    asked,
    ready: () => options.ready ?? true,
    depth: async (lane) => {
      asked.push(lane);
      if (options.throwOn === lane) throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      return options.depths?.[lane] ?? { waiting: 0, oldestAgeSeconds: 0 };
    },
  };
}

type NodeRow = { hostname: string; lastHeartbeatAt: Date | null };

/** A database that answers `judgeNode.findMany` and records the query. */
function db(rows: NodeRow[] | Error): Db & { queries: unknown[] } {
  const queries: unknown[] = [];
  return {
    queries,
    judgeNode: {
      findMany: async (args: unknown) => {
        queries.push(args);
        if (rows instanceof Error) throw rows;
        return rows;
      },
    },
  } as unknown as Db & { queries: unknown[] };
}

const value = async (pattern: RegExp): Promise<number> => {
  const text = await renderMetrics();
  return Number(pattern.exec(text)?.[1] ?? "-1");
};
const depthOf = (lane: string) => value(new RegExp(`^judge_queue_depth\\{queue="${lane}"\\} (\\d+(?:\\.\\d+)?)`, "m"));
const ageOf = (lane: string) =>
  value(new RegExp(`^judge_oldest_job_age_seconds\\{queue="${lane}"\\} (\\d+(?:\\.\\d+)?)`, "m"));
const heartbeatOf = (worker: string) =>
  value(new RegExp(`^judge_worker_heartbeat_age_seconds\\{worker="${worker}"\\} (\\d+(?:\\.\\d+)?)`, "m"));

/**
 * A reading no real tick would ever produce, written to every lane before
 * each test.
 *
 * It makes "published zero" and "not published at all" tell apart: a lane
 * this file never touches again still reads 99, so an assertion of 0 proves
 * something actively set it.
 */
const SENTINEL = 99;

beforeEach(() => {
  for (const lane of JUDGE_LANES) observeQueue(lane, SENTINEL, SENTINEL);
  observeHeartbeats([]);
});

describe("the lanes", () => {
  it("asks every lane and publishes what it finds", async () => {
    const port = queues({ depths: { CONTEST: { waiting: 7, oldestAgeSeconds: 33 } } });
    await observeJudgeMetrics({ db: db([]), queues: port, log: logger().log, now: () => NOW });
    expect(port.asked.sort()).toEqual([...JUDGE_LANES].sort());
    expect(await depthOf("CONTEST")).toBe(7);
    expect(await ageOf("CONTEST")).toBe(33);
  });

  it("publishes a lane with nothing in it as zero", async () => {
    await observeJudgeMetrics({
      db: db([]),
      queues: queues({ depths: { CONTEST: { waiting: 7, oldestAgeSeconds: 33 } } }),
      log: logger().log,
      now: () => NOW,
    });
    for (const lane of JUDGE_LANES.filter((l) => l !== "CONTEST")) {
      expect(await depthOf(lane), lane).toBe(0);
      expect(await ageOf(lane), lane).toBe(0);
    }
  });

  it("reports nothing about the lanes when Redis is not connected", async () => {
    /**
     * Redis down is a FACT about the lanes, not an error: with no connection
     * there is nothing to report, and publishing zeros would say "the queues
     * are empty" when the truth is "we cannot see them". What catches the
     * outage is the jobs that stop being dispatched.
     */
    const port = queues({ ready: false });
    await observeJudgeMetrics({ db: db([]), queues: port, log: logger().log, now: () => NOW });
    expect(port.asked).toEqual([]);
    expect(await depthOf("CONTEST"), "not published at all, not published as zero").toBe(SENTINEL);
  });

  it("still publishes the heartbeats when Redis is down", async () => {
    // The two halves fail independently: the node table lives in Postgres,
    // and a Redis outage is exactly when somebody wants to know which judge
    // hosts are still checking in.
    await observeJudgeMetrics({
      db: db([{ hostname: "judge-1", lastHeartbeatAt: new Date(NOW - 20_000) }]),
      queues: queues({ ready: false }),
      log: logger().log,
      now: () => NOW,
    });
    expect(await heartbeatOf("judge-1")).toBe(20);
  });
});

describe("the nodes", () => {
  it("publishes one age per node, from the row the reconciler reads", async () => {
    await observeJudgeMetrics({
      db: db([
        { hostname: "judge-1", lastHeartbeatAt: new Date(NOW - 5_000) },
        { hostname: "judge-2", lastHeartbeatAt: new Date(NOW - 600_000) },
      ]),
      queues: queues({}),
      log: logger().log,
      now: () => NOW,
    });
    expect(await heartbeatOf("judge-1")).toBe(5);
    expect(await heartbeatOf("judge-2")).toBe(600);
  });

  it("filters on no status, so an OFFLINE node is still published", async () => {
    /**
     * The assertion is on the QUERY, because that is where the mistake would
     * be made: `where: { status: "ONLINE" }` reads as an optimisation and
     * would hide a node the moment the sweep marked it OFFLINE — which is
     * the moment somebody needs to see it. A quarantined node is published
     * for the same reason: "quarantined AND not checking in" is a different
     * problem from either alone.
     */
    const database = db([]);
    await observeJudgeMetrics({ db: database, queues: queues({}), log: logger().log, now: () => NOW });
    const query = database.queries[0] as { where?: unknown; select?: Record<string, boolean> };
    expect(query.where, "no status filter").toBeUndefined();
    expect(Object.keys(query.select ?? {}).sort()).toEqual(["hostname", "lastHeartbeatAt"]);
  });

  it("reports a node that has never checked in as impossibly old", async () => {
    /**
     * A registered node with no heartbeat at all is a node somebody
     * provisioned and never started. Skipping it would report that by
     * silence, which is the one thing a gauge must not do.
     */
    await observeJudgeMetrics({
      db: db([{ hostname: "judge-new", lastHeartbeatAt: null }]),
      queues: queues({}),
      log: logger().log,
      now: () => NOW,
    });
    expect(await heartbeatOf("judge-new")).toBeGreaterThan(60 * 60 * 24 * 365);
  });

  it("clamps a heartbeat from the future to zero", async () => {
    // Clock skew between the app host and the judge host; a negative age is
    // not a node that will check in later.
    await observeJudgeMetrics({
      db: db([{ hostname: "judge-fast", lastHeartbeatAt: new Date(NOW + 30_000) }]),
      queues: queues({}),
      log: logger().log,
      now: () => NOW,
    });
    expect(await heartbeatOf("judge-fast")).toBe(0);
  });
});

describe("it can never break a tick", () => {
  it("swallows a queue failure and says so once", async () => {
    const { log, warnings } = logger();
    await expect(
      observeJudgeMetrics({ db: db([]), queues: queues({ throwOn: "CONTEST" }), log, now: () => NOW }),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("swallows a database failure", async () => {
    const { log, warnings } = logger();
    await expect(
      observeJudgeMetrics({ db: db(new Error("timeout")), queues: queues({}), log, now: () => NOW }),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("keeps the lane readings it managed to take before the failure", async () => {
    /**
     * One try/catch around both halves means a failure half way through
     * leaves what was already published in place. That is deliberate: a
     * partial reading is more use in an incident than none, and the next
     * tick overwrites it a minute later.
     */
    const { log } = logger();
    const [first, second] = JUDGE_LANES;
    const depths: Partial<Record<JudgeLane, { waiting: number; oldestAgeSeconds: number }>> = {};
    depths[first] = { waiting: 11, oldestAgeSeconds: 2 };
    const port = queues({ depths, throwOn: second });
    await observeJudgeMetrics({ db: db([]), queues: port, log, now: () => NOW });
    expect(await depthOf(first)).toBe(11);
    expect(await depthOf(second), "the lane that threw keeps its last reading").toBe(SENTINEL);
  });
});
