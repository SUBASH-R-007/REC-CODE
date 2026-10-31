import type { JudgeNodeStatus, Prisma } from "@recx/db";
import {
  JUDGE_OFFLINE_AFTER_MS,
  heartbeatRequestSchema,
  heartbeatResponseSchema,
  type HeartbeatRequest,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import {
  allowUnhardenedNodes,
  lanesFor,
  nextNodeStatus,
  sensitiveLaneEligibility,
  type NodeHealth,
} from "@/lib/judge/lanes";
import { authenticateNode, judgeJson, judgeRoute, readJudgeBody } from "@/lib/judge/node-auth";

export const runtime = "nodejs";

/** Stored failure lists are capped (a misbehaving node cannot bloat its row). */
const MAX_FAILURES = 50;
const MAX_FAILURE_CHARS = 500;

const capFailures = (failures: readonly string[]) =>
  failures.slice(0, MAX_FAILURES).map((f) => f.slice(0, MAX_FAILURE_CHARS));

/**
 * A node-reported timestamp. Unparseable → `fallback`; a time in the future
 * is clamped to now, so a skewed (or dishonest) clock can never keep a
 * calibration or self-check fresh for longer than it really is.
 */
function reportedAt(value: string, now: Date, fallback: Date | null): Date | null {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return fallback;
  return at.getTime() > now.getTime() ? now : at;
}

interface HeartbeatWrite {
  data: Prisma.JudgeNodeUpdateManyMutationInput;
  health: NodeHealth;
}

/**
 * What this heartbeat stores. Calibration, host hardening and startup credit
 * are what the worker reports now (null = not measured by this process yet);
 * a heartbeat without a self-check keeps the last one reported, which goes
 * stale after LIMITS.selfCheck.staleAfterMs.
 */
function heartbeatWrite(
  hb: HeartbeatRequest,
  stored: { selfCheckOk: boolean | null; lastSelfCheckAt: Date | null },
  now: Date,
): HeartbeatWrite {
  const calibratedAt =
    hb.calibrationScore !== null && hb.calibratedAt !== null ? reportedAt(hb.calibratedAt, now, null) : null;
  const data: Prisma.JudgeNodeUpdateManyMutationInput = {
    hostname: hb.hostname,
    workerVersion: hb.workerVersion,
    isolateVersion: hb.isolateVersion,
    /**
     * Phase 12k, slice 5. The engine's own version, for a driver whose
     * engine is not isolate: PostgreSQL's `server_version` on a SQL node.
     * Kept apart from `isolateVersion` rather than folded into it, because
     * a column named after one engine holding another engine's version is
     * the kind of small lie that costs an hour during an incident.
     */
    engineVersion: hb.engineVersion,
    driver: hb.driver,
    languages: hb.languages,
    slots: hb.slots,
    busySlots: hb.busySlots,
    calibrationScore: hb.calibrationScore,
    calibratedAt,
    hostHardened: hb.hostHardening?.ok ?? null,
    hardeningFailures: hb.hostHardening ? capFailures(hb.hostHardening.failures) : [],
    startupMs: hb.startupMs,
    lastHeartbeatAt: now,
  };
  const health: NodeHealth = {
    calibrationScore: hb.calibrationScore,
    calibratedAt,
    selfCheckOk: stored.selfCheckOk,
    lastSelfCheckAt: stored.lastSelfCheckAt,
    hostHardened: hb.hostHardening?.ok ?? null,
  };
  if (hb.selfCheck) {
    const at = reportedAt(hb.selfCheck.at, now, now)!;
    data.lastSelfCheckAt = at;
    data.selfCheckOk = hb.selfCheck.ok;
    data.selfCheckFailures = capFailures(hb.selfCheck.failures);
    health.selfCheckOk = hb.selfCheck.ok;
    health.lastSelfCheckAt = at;
  }
  return { data, health };
}

/**
 * Node heartbeat (every JUDGE_HEARTBEAT_MS). Records the node's capabilities,
 * calibration, self-check, host hardening and startup credit; decides which
 * lanes it may serve (src/lib/judge/lanes.ts) and persists that decision for
 * the claim route; and moves its status: a failed self-check or a failed
 * hardening check quarantines it (audited), an OFFLINE node comes back
 * ONLINE, and admin-set DRAINING / QUARANTINED are never lifted here.
 */
export async function POST(request: Request) {
  return judgeRoute("heartbeat", async () => {
    const auth = await authenticateNode(request);
    if (!auth.ok) return auth.response;
    const read = await readJudgeBody(request, heartbeatRequestSchema);
    if (!read.ok) return read.response;
    const hb = read.body;
    const node = auth.node;
    const now = new Date();
    const allowUnhardened = allowUnhardenedNodes();

    const { data, health } = heartbeatWrite(hb, node, now);
    /**
     * The fleet median is over nodes of the SAME ENGINE (Phase 12k).
     * Calibration is a hello-world CPU benchmark: a number from an isolate
     * host and a number from a database host measure different things, and
     * mixing them into one median would move the threshold every node is
     * judged against for no reason anybody could explain.
     *
     * And over nodes that are STILL HEARTBEATING (Phase 12p.5). A node
     * keeps `status = ONLINE` after it stops answering — nothing demotes
     * the row — so without this a dead node's last score keeps setting the
     * threshold that live ones are measured against. It is not theoretical:
     * on the workstation where this was found, two seeded nodes that had
     * never heartbeated put the median 35.5 % away from the only running
     * node and withheld ASSESSMENT and CONTEST from it.
     */
    const others = await db.judgeNode.findMany({
      where: {
        status: "ONLINE",
        id: { not: node.id },
        driver: hb.driver,
        calibrationScore: { not: null },
        lastHeartbeatAt: { gt: new Date(now.getTime() - JUDGE_OFFLINE_AFTER_MS) },
      },
      select: { calibrationScore: true },
    });
    const eligibility = sensitiveLaneEligibility({
      health,
      otherOnlineScores: others.map((o) => o.calibrationScore),
      now,
      allowUnhardened,
      driver: hb.driver,
    });
    // Stored as "may serve ASSESSMENT / CONTEST right now": eligible AND ONLINE.
    const withLanes = (s: JudgeNodeStatus): Prisma.JudgeNodeUpdateManyMutationInput => ({
      ...data,
      sensitiveLanesOk: eligibility.sensitiveLanesOk && s === "ONLINE",
      laneRestrictions: eligibility.restrictions,
    });

    let current: JudgeNodeStatus = node.status;
    let status: JudgeNodeStatus | null = null;
    // The status move is conditional on the status we read, so an admin's
    // concurrent change is never overwritten; on a lost race, recompute once.
    for (let attempt = 0; attempt < 2 && status === null; attempt++) {
      const next = nextNodeStatus(current, hb, allowUnhardened);
      if (next.status === current) break;
      const moved = await db.judgeNode.updateMany({
        where: { id: node.id, status: current },
        data: { ...withLanes(next.status), status: next.status },
      });
      if (moved.count === 1) {
        status = next.status;
        if (next.status === "QUARANTINED" && next.quarantineReason) {
          const failures =
            next.quarantineReason === "self-check failed" ? hb.selfCheck?.failures : hb.hostHardening?.failures;
          console.error(`[judge] !!! node ${node.id} quarantined: ${next.quarantineReason}`, (failures ?? []).slice(0, 5));
          await audit({
            actorId: null,
            action: "judge.node.quarantined",
            entityType: "JudgeNode",
            entityId: node.id,
            sensitivity: "SECURITY",
            metadata: {
              reason: next.quarantineReason,
              previousStatus: current,
              hostname: hb.hostname,
              workerVersion: hb.workerVersion,
              failures: (failures ?? []).slice(0, 10).map((f) => f.slice(0, 200)),
            },
          });
        }
      } else {
        const fresh = await db.judgeNode.findUnique({ where: { id: node.id }, select: { status: true } });
        if (!fresh) return judgeJson({ error: "Judge node authentication failed." }, 401);
        current = fresh.status;
      }
    }
    if (status === null) {
      const row = await db.judgeNode.update({ where: { id: node.id }, data: withLanes(current), select: { status: true } });
      status = row.status;
    }

    const sensitiveNow = eligibility.sensitiveLanesOk && status === "ONLINE";
    if (node.sensitiveLanesOk !== sensitiveNow) {
      // A change (not every heartbeat) is worth a record: whether a node
      // could judge assessments at a given time is auditable.
      console.warn(`[judge] node ${node.id}: sensitive lanes ${sensitiveNow ? "granted" : "withheld"}`, eligibility.restrictions);
      await audit({
        actorId: null,
        action: sensitiveNow ? "judge.node.sensitive_lanes_granted" : "judge.node.sensitive_lanes_withheld",
        entityType: "JudgeNode",
        entityId: node.id,
        metadata: { restrictions: eligibility.restrictions.slice(0, 10), status },
      });
    }

    const restrictions =
      status === "ONLINE" ? eligibility.restrictions : [`node is ${status}: no lanes`, ...eligibility.restrictions];
    return judgeJson(
      heartbeatResponseSchema.parse({
        status,
        serverTime: now.toISOString(),
        lanes: lanesFor(status, eligibility),
        laneRestrictions: restrictions,
      }),
    );
  });
}
