import {
  JUDGE_LANES,
  JUDGE_OFFLINE_AFTER_MS,
  LIMITS,
  type JudgeLane,
  type JudgeNodeStatus,
} from "@recx/shared";

/**
 * Pure helpers behind the /admin/judge health page: percentiles, lane
 * summaries and node-health derivations. No I/O — the page's queries
 * (src/server/queries/admin-judge.ts) feed them plain numbers.
 */

// ── Percentiles ────────────────────────────────────────────────────────

/**
 * The p-th percentile (0 ≤ p ≤ 1) by linear interpolation between closest
 * ranks — the same definition as SQL `percentile_cont`, so a value computed
 * here matches one computed in Postgres. Non-finite values are ignored;
 * null for an empty sample.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`percentile must be within [0, 1], got ${p}`);
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const pos = (xs.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = xs[lo] ?? 0;
  const b = xs[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

export function p50(values: readonly number[]): number | null {
  return percentile(values, 0.5);
}

export function p95(values: readonly number[]): number | null {
  return percentile(values, 0.95);
}

/** part / whole, or null when there is nothing to divide by. */
export function rate(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

// ── Lanes ──────────────────────────────────────────────────────────────

export interface QueueDepth {
  /** Not yet picked up: BullMQ "waiting" + "prioritized" + "paused". */
  waiting: number;
  active: number;
  delayed: number;
}

/**
 * BullMQ job counts → depth. Every judge job carries a priority, and BullMQ 5
 * keeps prioritised jobs in their own "prioritized" set, so "waiting" alone
 * would read zero under load; a globally paused queue holds its jobs in
 * "paused" (BullMQ's own Queue.count() sums the same lists).
 */
export function depthFromCounts(counts: Readonly<Record<string, number | undefined>>): QueueDepth {
  const n = (key: string) => {
    const v = counts[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  };
  return { waiting: n("waiting") + n("prioritized") + n("paused"), active: n("active"), delayed: n("delayed") };
}

/**
 * What a lane's latency figure measures: startedAt − queued time, the time
 * until a worker took the job (Submission, RunRequest and ValidationRun all
 * record startedAt at their first claim).
 */
export type LatencyKind = "wait";

/** One lane over the trailing window (jobs queued within it). */
export interface LaneWindowStats {
  lane: JudgeLane;
  latencyKind: LatencyKind;
  queued: number;
  /** Finished: DONE or INTERNAL_ERROR. */
  finished: number;
  internalErrors: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface LaneSummary extends LaneWindowStats {
  /** Null when Redis could not be read. */
  depth: QueueDepth | null;
  /** waiting + delayed: jobs not yet with a worker. */
  backlog: number | null;
  ieRate: number | null;
}

export function latencyKindFor(_lane: JudgeLane): LatencyKind {
  return "wait";
}

export function emptyWindow(lane: JudgeLane): LaneWindowStats {
  return { lane, latencyKind: latencyKindFor(lane), queued: 0, finished: 0, internalErrors: 0, p50Ms: null, p95Ms: null };
}

/** One summary per lane, in JUDGE_LANES order; lanes with no traffic are zero-filled. */
export function summariseLanes(
  depths: Partial<Record<JudgeLane, QueueDepth>> | null,
  stats: readonly LaneWindowStats[],
): LaneSummary[] {
  const byLane = new Map(stats.map((s) => [s.lane, s]));
  return JUDGE_LANES.map((lane) => {
    const window = byLane.get(lane) ?? emptyWindow(lane);
    const depth = depths?.[lane] ?? null;
    return {
      ...window,
      depth,
      backlog: depth ? depth.waiting + depth.delayed : null,
      ieRate: rate(window.internalErrors, window.finished),
    };
  });
}

/** Fleet-wide totals over the lane summaries. */
export function laneTotals(lanes: readonly LaneSummary[]): {
  backlog: number | null;
  active: number | null;
  queued: number;
  finished: number;
  internalErrors: number;
  ieRate: number | null;
} {
  const known = lanes.every((l) => l.depth !== null);
  const queued = lanes.reduce((s, l) => s + l.queued, 0);
  const finished = lanes.reduce((s, l) => s + l.finished, 0);
  const internalErrors = lanes.reduce((s, l) => s + l.internalErrors, 0);
  return {
    backlog: known ? lanes.reduce((s, l) => s + (l.backlog ?? 0), 0) : null,
    active: known ? lanes.reduce((s, l) => s + (l.depth?.active ?? 0), 0) : null,
    queued,
    finished,
    internalErrors,
    ieRate: rate(internalErrors, finished),
  };
}

// ── Nodes ──────────────────────────────────────────────────────────────

export interface NodeHealthInput {
  status: JudgeNodeStatus;
  lastHeartbeatAt: Date | null;
  calibrationScore: number | null;
  lastSelfCheckAt: Date | null;
  selfCheckOk: boolean | null;
}

/**
 * Median calibration score of the nodes that are ONLINE *and still
 * heartbeating* — the fleet median the heartbeat uses for sensitive-lane
 * eligibility (src/lib/judge/lanes.ts).
 *
 * The heartbeat matters (Phase 12p.5). A node keeps `status = ONLINE`
 * after it stops answering: nothing demotes a row, the console simply
 * marks it "not heartbeating". Counting those scores lets dead nodes set
 * the threshold that live ones are judged against — and the first time it
 * was looked at, on a workstation whose seed holds three nodes and whose
 * one real node was the only one running, the two that had never
 * heartbeated put the median 35.5 % away and withheld ASSESSMENT and
 * CONTEST from the only node that could serve them. The same shape in
 * production is worse: half a fleet dying would bar the surviving half
 * from exams, at exactly the wrong moment.
 */
export function fleetCalibrationMedian(nodes: readonly NodeHealthInput[], now: Date): number | null {
  const scores = nodes
    .filter(
      (n) =>
        n.status === "ONLINE" &&
        !isHeartbeatStale(n.lastHeartbeatAt, now) &&
        n.calibrationScore !== null &&
        n.calibrationScore > 0,
    )
    .map((n) => n.calibrationScore as number);
  return p50(scores);
}

/** Signed relative deviation from the fleet median (0.08 = 8 % faster). */
export function calibrationDeviation(score: number | null, median: number | null): number | null {
  if (score === null || median === null || median <= 0 || !Number.isFinite(score)) return null;
  return (score - median) / median;
}

/** More than LIMITS.calibration.maxDeviation off the median bars sensitive lanes. */
export function isCalibrationOutlier(deviation: number | null): boolean {
  return deviation !== null && Math.abs(deviation) > LIMITS.calibration.maxDeviation;
}

export function ageMs(at: Date | null, now: Date): number | null {
  return at ? Math.max(0, now.getTime() - at.getTime()) : null;
}

/** No heartbeat for longer than JUDGE_OFFLINE_AFTER_MS (or never). */
export function isHeartbeatStale(at: Date | null, now: Date): boolean {
  const age = ageMs(at, now);
  return age === null || age > JUDGE_OFFLINE_AFTER_MS;
}

export type CheckState = "ok" | "failed" | "stale" | "unknown";

/** Self-check: failed beats stale; stale after LIMITS.selfCheck.staleAfterMs. */
export function selfCheckState(ok: boolean | null, at: Date | null, now: Date): CheckState {
  if (ok === null || at === null) return "unknown";
  if (!ok) return "failed";
  const age = ageMs(at, now) ?? Infinity;
  return age > LIMITS.selfCheck.staleAfterMs ? "stale" : "ok";
}

export function hardeningState(hardened: boolean | null): CheckState {
  if (hardened === null) return "unknown";
  return hardened ? "ok" : "failed";
}

// ── Formatting ─────────────────────────────────────────────────────────

/** 850 ms · 1.2 s · 2 min 5 s · 3 h 10 min. */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const v = Math.max(0, ms);
  if (v < 1_000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1_000).toFixed(v < 10_000 ? 1 : 0)} s`;
  if (v < 3_600_000) {
    const m = Math.floor(v / 60_000);
    const s = Math.floor((v % 60_000) / 1_000);
    return s === 0 ? `${m} min` : `${m} min ${s} s`;
  }
  const h = Math.floor(v / 3_600_000);
  const m = Math.floor((v % 3_600_000) / 60_000);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Coarse age for "last seen": 4 s · 12 min · 3 h · 2 d. */
export function formatAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "never";
  const v = Math.max(0, ms);
  if (v < 60_000) return `${Math.floor(v / 1_000)} s`;
  if (v < 3_600_000) return `${Math.floor(v / 60_000)} min`;
  if (v < 86_400_000) return `${Math.floor(v / 3_600_000)} h`;
  return `${Math.floor(v / 86_400_000)} d`;
}

/** 0.125 → "12.5%"; null → "—". */
export function formatRate(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Number((value * 100).toFixed(digits))}%`;
}

/** +0.083 → "+8.3%"; −0.02 → "−2.0%". */
export function formatSignedRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const pct = (value * 100).toFixed(1);
  return value > 0 ? `+${pct}%` : value < 0 ? `−${pct.slice(1)}%` : "0.0%";
}

// ── Admin node actions ─────────────────────────────────────────────────

export const NODE_ACTIONS = ["drain", "quarantine", "online"] as const;
export type NodeAction = (typeof NODE_ACTIONS)[number];

export type NodeTransition = { ok: true; to: JudgeNodeStatus } | { ok: false; reason: string };

/**
 * What an admin's Drain / Quarantine / Return-to-ONLINE does to a node.
 * OFFLINE nodes come back by heartbeat, never by hand; a node whose last
 * self-check (or, outside development, host hardening check) failed cannot
 * be returned — its next heartbeat would quarantine it again; a node that is
 * not heartbeating is returned as OFFLINE so its next heartbeat decides.
 */
export function planNodeTransition(
  current: JudgeNodeStatus,
  action: NodeAction,
  node: { selfCheckOk: boolean | null; hostHardened: boolean | null; heartbeatStale: boolean },
  allowUnhardened = false,
): NodeTransition {
  switch (action) {
    case "drain":
      if (current === "DRAINING") return { ok: false, reason: "This node is already draining." };
      if (current === "QUARANTINED") {
        return { ok: false, reason: "This node is quarantined, which already stops new work. Return it to service first." };
      }
      return { ok: true, to: "DRAINING" };
    case "quarantine":
      if (current === "QUARANTINED") return { ok: false, reason: "This node is already quarantined." };
      return { ok: true, to: "QUARANTINED" };
    case "online":
      if (current === "ONLINE") return { ok: false, reason: "This node is already online." };
      if (current === "OFFLINE") {
        return { ok: false, reason: "An offline node returns to ONLINE by itself on its next heartbeat." };
      }
      if (node.selfCheckOk === false) {
        return {
          ok: false,
          reason: "This node's last self-check failed. Rebuild or fix the host and let it pass a self-check first.",
        };
      }
      if (node.hostHardened === false && !allowUnhardened) {
        return {
          ok: false,
          reason: "This node failed its host hardening check. Rebuild the host so the check passes first.",
        };
      }
      return { ok: true, to: node.heartbeatStale ? "OFFLINE" : "ONLINE" };
  }
}
