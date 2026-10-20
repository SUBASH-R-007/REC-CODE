import type { Db } from "@recx/db";
import { JUDGE_LANES, type JudgeLane } from "@recx/shared";
import type { Logger } from "pino";
import { observeEmptyLanes, observeHeartbeats, observeQueue } from "./metrics";

/**
 * Publishing the scheduler's gauges, once a tick (Phase 10a).
 *
 * Its own module so the reconciler stays about reconciling: this reads and
 * publishes and changes nothing, and a failure here must never affect a
 * tick's real work. Hence one try/catch around the whole thing — SPEC §10's
 * metrics exist to describe failures, not to cause them.
 *
 * All three gauges are published EVERY tick, for every lane and every node,
 * including the empty and the idle ones. A gauge that simply stops being set
 * keeps its last value for ever in some scrape configurations and disappears
 * in others, and "queue depth > 200 for 2 min" would then alert on a lane
 * that drained an hour ago.
 */

/** What `observeJudgeMetrics` needs of the queue port. */
export interface QueueCounts {
  ready(): boolean;
  /** Jobs waiting in a lane, and the age of the oldest, in seconds. */
  depth(lane: JudgeLane): Promise<{ waiting: number; oldestAgeSeconds: number }>;
}

export interface ObserveDeps {
  readonly db: Db;
  readonly queues: QueueCounts;
  readonly log: Logger;
  readonly now?: () => number;
}

export async function observeJudgeMetrics(deps: ObserveDeps): Promise<void> {
  try {
    await observeLanes(deps);
    await observeNodes(deps);
  } catch (error) {
    deps.log.warn({ err: error }, "could not publish judge metrics this tick");
  }
}

async function observeLanes(deps: ObserveDeps): Promise<void> {
  /**
   * Redis down is not an error here, it is a FACT about the lanes: with no
   * connection there is nothing to report, and publishing zeros would say
   * "the queues are empty" when the truth is "we cannot see them". The
   * oldest-job alert is what catches the outage, through the jobs that stop
   * being dispatched.
   */
  if (!deps.queues.ready()) return;

  const seen = new Set<JudgeLane>();
  for (const lane of JUDGE_LANES) {
    const counts = await deps.queues.depth(lane);
    observeQueue(lane, counts.waiting, counts.oldestAgeSeconds);
    seen.add(lane);
  }
  observeEmptyLanes(seen);
}

async function observeNodes(deps: ObserveDeps): Promise<void> {
  /**
   * Every node the table knows, not only the healthy ones: a node that has
   * stopped checking in is exactly what this gauge is for, and filtering on
   * `status = 'ONLINE'` would hide it the moment the sweep marked it
   * OFFLINE — which is the moment somebody needs to see it.
   *
   * QUARANTINED nodes are included too. A quarantined node is still a host
   * somebody owns, and "it is quarantined AND it stopped checking in" is a
   * different problem from either alone.
   */
  const rows = await deps.db.judgeNode.findMany({
    select: { hostname: true, lastHeartbeatAt: true },
    orderBy: { hostname: "asc" },
    take: 200,
  });
  const now = deps.now?.() ?? Date.now();
  observeHeartbeats(
    rows.map((row) => ({
      hostname: row.hostname,
      /**
       * A node that has NEVER checked in reports its age from zero rather
       * than being skipped: a registered node with no heartbeat at all is a
       * node somebody provisioned and never started, and silence is the
       * wrong way to report that.
       */
      ageSeconds: row.lastHeartbeatAt ? Math.max(0, (now - row.lastHeartbeatAt.getTime()) / 1000) : Number.MAX_SAFE_INTEGER / 1000,
    })),
  );
}
