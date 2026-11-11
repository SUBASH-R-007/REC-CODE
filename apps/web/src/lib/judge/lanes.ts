import {
  JUDGE_LANES,
  LIMITS,
  SENSITIVE_LANES,
  type HeartbeatRequest,
  type JudgeLane,
  type JudgeNodeStatus,
} from "@recx/shared";

/**
 * Which lanes a judge node may serve, decided on every heartbeat. Pure: the
 * heartbeat route gathers the inputs, this module decides, and the route
 * persists the result (JudgeNode.sensitiveLanesOk / laneRestrictions) so the
 * claim route can refuse sensitive work without recomputing anything.
 *
 * ASSESSMENT and CONTEST (SENSITIVE_LANES) are withheld from a node when any
 * of these hold:
 *   (a) its calibration score deviates more than LIMITS.calibration.maxDeviation
 *       from the median of every ONLINE node's score (a lone node is its own
 *       median), or it has no calibration, or the calibration is stale;
 *   (b) its adversarial self-check failed, was never reported, or is stale
 *       (LIMITS.selfCheck.staleAfterMs);
 *   (c) its kernel hardening check failed or was not reported — unless the
 *       development-only override JUDGE_ALLOW_UNHARDENED_NODES=true is set,
 *       which is refused (ignored, and logged) when NODE_ENV=production.
 *
 * A node that is not ONLINE serves no lane at all.
 *
 * Phase 12k read rule (a) as a hello-world CPU benchmark, which the SQL
 * engine does not run and could not interpret — a query's limit is the
 * database's own `statement_timeout`, not a scaled C++ time — so a
 * `postgres` node reported no calibration, was told so in words, and was
 * refused the sensitive lanes until a benchmark for the query engine
 * existed.
 *
 * **Phase 16n built it** (`apps/sql-judge/src/calibration.ts`): per-row CPU
 * throughput on the cluster that will judge, measured through the same
 * sandbox, the same student role and the same `statement_timeout` a
 * candidate's query gets. So rule (a) now applies to a SQL node exactly as
 * it applies to an isolate one, with no special case here at all — and the
 * fleet median it is compared against is over nodes of the SAME ENGINE
 * (the heartbeat route), so a query score is never measured against a C++
 * one.
 *
 * What the benchmark is for, since it is not for scaling a limit: to notice
 * that one node is materially slower than its neighbours. A 5-second
 * statement timeout set with a healthy cluster in mind is a different exam
 * on a cluster half the speed. (docs/OPEN-QUESTIONS.md.)
 */

/** Calibration is refreshed every 6 h (LIMITS.calibration.intervalMs) and goes stale after 6.5 h. */
export const CALIBRATION_STALE_AFTER_MS = LIMITS.calibration.staleAfterMs;

/** The node's health as stored after this heartbeat (reported now, or kept from an earlier one). */
export interface NodeHealth {
  calibrationScore: number | null;
  calibratedAt: Date | null;
  selfCheckOk: boolean | null;
  lastSelfCheckAt: Date | null;
  hostHardened: boolean | null;
}

export interface LaneEligibility {
  /** May this node serve ASSESSMENT and CONTEST right now? */
  sensitiveLanesOk: boolean;
  /** Why not, one human-readable reason each (empty when eligible). */
  restrictions: string[];
}

function isUsableScore(score: number | null | undefined): score is number {
  return typeof score === "number" && Number.isFinite(score) && score > 0;
}

/** Median of a list (mean of the middle two for an even count); null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Relative deviation |score − median| / median (median > 0). */
export function calibrationDeviation(score: number, fleetMedian: number): number {
  return Math.abs(score - fleetMedian) / fleetMedian;
}

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)} h`;
const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

/**
 * Eligibility for the sensitive lanes.
 *
 * `otherOnlineScores` are the calibration scores of every OTHER node that is
 * ONLINE right now; this node's own score is added to them, so the median is
 * always over the fleet including the node being decided (and a single node
 * is its own median).
 */
export function sensitiveLaneEligibility(input: {
  health: NodeHealth;
  otherOnlineScores: readonly (number | null)[];
  now: Date;
  allowUnhardened: boolean;
  /**
   * The node's engine. Kept on the input although rule (a) no longer
   * branches on it (Phase 16n): the heartbeat route uses it to take the
   * fleet median over nodes of the same engine, and a caller that passes
   * health without an engine would otherwise look correct.
   */
  driver?: string;
}): LaneEligibility {
  const { health, now } = input;
  const restrictions: string[] = [];

  // (a) calibration
  const score = health.calibrationScore;
  if (!isUsableScore(score) || health.calibratedAt === null) {
    /**
     * The engine still shapes the SENTENCE, because it decides which process
     * an operator should go and look at — the SQL judge or the isolate
     * worker. It no longer shapes the DECISION (Phase 16n).
     */
    restrictions.push(
      input.driver === "postgres"
        ? "calibration missing: the SQL judge has not reported a benchmark for this cluster"
        : "calibration missing: no calibration benchmark has been reported",
    );
  } else {
    const age = now.getTime() - health.calibratedAt.getTime();
    if (age > CALIBRATION_STALE_AFTER_MS) {
      restrictions.push(
        `calibration is stale: measured ${hours(age)} ago (limit ${hours(CALIBRATION_STALE_AFTER_MS)})`,
      );
    }
    const fleet = [...input.otherOnlineScores.filter(isUsableScore), score];
    const fleetMedian = median(fleet)!;
    const deviation = calibrationDeviation(score, fleetMedian);
    if (deviation > LIMITS.calibration.maxDeviation) {
      restrictions.push(
        `calibration ${score.toFixed(1)} deviates ${percent(deviation)} from the fleet median ` +
          `${fleetMedian.toFixed(1)} (limit ${percent(LIMITS.calibration.maxDeviation)})`,
      );
    }
  }

  // (b) self-check
  if (health.selfCheckOk === false) {
    restrictions.push("self-check failed");
  } else if (health.selfCheckOk === null || health.lastSelfCheckAt === null) {
    restrictions.push("self-check not reported yet");
  } else {
    const age = now.getTime() - health.lastSelfCheckAt.getTime();
    if (age > LIMITS.selfCheck.staleAfterMs) {
      restrictions.push(`self-check is stale: ran ${hours(age)} ago (limit ${hours(LIMITS.selfCheck.staleAfterMs)})`);
    }
  }

  // (c) host hardening
  if (health.hostHardened !== true && !input.allowUnhardened) {
    restrictions.push(
      health.hostHardened === false ? "host hardening check failed" : "host hardening not verified yet",
    );
  }

  return { sensitiveLanesOk: restrictions.length === 0, restrictions };
}

/** The lanes a node in `status` may serve: all five, minus the sensitive ones when withheld; none unless ONLINE. */
export function lanesFor(status: JudgeNodeStatus, eligibility: LaneEligibility): JudgeLane[] {
  if (status !== "ONLINE") return [];
  if (eligibility.sensitiveLanesOk) return [...JUDGE_LANES];
  return JUDGE_LANES.filter((lane) => !SENSITIVE_LANES.includes(lane));
}

export function isSensitiveLane(lane: JudgeLane): boolean {
  return SENSITIVE_LANES.includes(lane);
}

export interface StatusDecision {
  status: JudgeNodeStatus;
  /** Set when this heartbeat quarantines the node (the route audits it). */
  quarantineReason: string | null;
}

/**
 * Node status after a heartbeat. A failed self-check quarantines the node; a
 * failed host-hardening check quarantines it too (unless the development
 * override is in effect); an OFFLINE node that heartbeats is ONLINE again;
 * admin-set DRAINING and QUARANTINED are kept — only an admin lifts them.
 */
export function nextNodeStatus(
  current: JudgeNodeStatus,
  report: Pick<HeartbeatRequest, "selfCheck" | "hostHardening">,
  allowUnhardened: boolean,
): StatusDecision {
  if (report.selfCheck && !report.selfCheck.ok) {
    return { status: "QUARANTINED", quarantineReason: current === "QUARANTINED" ? null : "self-check failed" };
  }
  if (report.hostHardening && !report.hostHardening.ok && !allowUnhardened) {
    return {
      status: "QUARANTINED",
      quarantineReason: current === "QUARANTINED" ? null : "host hardening check failed",
    };
  }
  if (current === "OFFLINE") return { status: "ONLINE", quarantineReason: null };
  return { status: current, quarantineReason: null };
}

let warnedProductionOverride = false;

/**
 * The development-only override JUDGE_ALLOW_UNHARDENED_NODES=true (a WSL2
 * dev kernel cannot pass the hardening check). Refused in production: there
 * the flag is ignored and the refusal is logged once per process.
 */
export function allowUnhardenedNodes(environment: Record<string, string | undefined> = process.env): boolean {
  if (environment.JUDGE_ALLOW_UNHARDENED_NODES !== "true") return false;
  if (environment.NODE_ENV === "production") {
    if (!warnedProductionOverride) {
      warnedProductionOverride = true;
      console.error(
        "[judge] !!! JUDGE_ALLOW_UNHARDENED_NODES=true is refused in production and ignored: " +
          "unhardened nodes are quarantined and never serve ASSESSMENT or CONTEST.",
      );
    }
    return false;
  }
  return true;
}
