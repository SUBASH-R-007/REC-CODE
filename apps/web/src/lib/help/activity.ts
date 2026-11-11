import "server-only";
import { campusDay } from "@recx/shared";
import { db } from "@/lib/db";
import { ACTIVITY_POLICY } from "@/lib/help/activity-policy";

/**
 * Active-time crediting for POST /api/activity. The browser reports how many
 * active seconds it saw; the server decides how many to believe:
 *
 *   credit = min(claimed, wall-clock seconds since the last accepted ping, 60)
 *
 * and accepts at most one ping per 20 s per student and problem. The first
 * ping for a problem only starts the clock (credits 0). So the credited
 * total can never run ahead of the wall clock, whatever a client sends —
 * the hint tiers' "N minutes of work" cannot be reached early by forging.
 *
 * The rate limit is enforced in Postgres, not Redis: the credit write is a
 * compare-and-set on lastPingAt, so concurrent pings cannot both be credited
 * and the cap holds even when Redis is down.
 */

export type PingDecision = { accepted: true; credit: number } | { accepted: false; retryAfterMs: number };

/** Pure: how much of a claim to credit, given the last accepted ping. */
export function decidePing(input: { claimedSeconds: number; lastPingAt: Date; now: Date }): PingDecision {
  const elapsedMs = input.now.getTime() - input.lastPingAt.getTime();
  if (!(elapsedMs >= ACTIVITY_POLICY.minPingGapMs)) {
    // Too soon — or the clock went backwards (another instance's skew).
    return { accepted: false, retryAfterMs: ACTIVITY_POLICY.minPingGapMs - Math.max(0, elapsedMs) };
  }
  const claimed = Number.isFinite(input.claimedSeconds) ? Math.floor(input.claimedSeconds) : 0;
  const credit = Math.max(0, Math.min(claimed, Math.floor(elapsedMs / 1000), ACTIVITY_POLICY.maxCreditSeconds));
  return { accepted: true, credit };
}

export type PingOutcome =
  /** Accepted: `credited` seconds were added; `activeSeconds` is the problem's new total. */
  | { status: "accepted"; credited: number; activeSeconds: number }
  | { status: "rate-limited"; retryAfterMs: number }
  /** No such problem, or it is not published. */
  | { status: "not-found" };

export async function recordActivityPing(input: {
  userId: string;
  problemId: string;
  seconds: number;
  now?: Date;
}): Promise<PingOutcome> {
  const { userId, problemId } = input;
  const now = input.now ?? new Date();
  const key = { userId_problemId: { userId, problemId } };

  // An existing row proves the problem was published when tracking began;
  // only the first ping pays for the publication check.
  const row = await db.problemActivity.findUnique({ where: key, select: { activeSeconds: true, lastPingAt: true } });

  if (!row) {
    // First ping for this problem: it starts the clock and credits nothing,
    // so even the opening claim is bounded by real time.
    const problem = await db.problem.findFirst({
      where: { id: problemId, status: "PUBLISHED", liveVersionId: { not: null } },
      select: { id: true },
    });
    if (!problem) return { status: "not-found" };
    const created = await db.problemActivity.createMany({
      data: [{ userId, problemId, activeSeconds: 0, lastPingAt: now }],
      skipDuplicates: true,
    });
    // count 0: a concurrent first ping won the insert.
    return created.count === 1
      ? { status: "accepted", credited: 0, activeSeconds: 0 }
      : { status: "rate-limited", retryAfterMs: ACTIVITY_POLICY.minPingGapMs };
  }

  const decision = decidePing({ claimedSeconds: input.seconds, lastPingAt: row.lastPingAt, now });
  if (!decision.accepted) return { status: "rate-limited", retryAfterMs: decision.retryAfterMs };
  const credit = decision.credit;

  return db.$transaction(async (tx): Promise<PingOutcome> => {
    // Compare-and-set on the lastPingAt we decided from: a concurrent ping
    // that got there first changed it, so this one matches nothing.
    const updated = await tx.problemActivity.updateMany({
      where: { userId, problemId, lastPingAt: row.lastPingAt },
      data: { activeSeconds: { increment: credit }, lastPingAt: now },
    });
    if (updated.count !== 1) return { status: "rate-limited", retryAfterMs: ACTIVITY_POLICY.minPingGapMs };

    if (credit > 0) {
      await tx.$executeRaw`
        INSERT INTO "ActivityDay" ("userId", "date", "activeSeconds")
        VALUES (${userId}, ${campusDay(now)}::date, ${credit})
        ON CONFLICT ("userId", "date") DO UPDATE SET
          "activeSeconds" = LEAST("ActivityDay"."activeSeconds" + EXCLUDED."activeSeconds", ${ACTIVITY_POLICY.maxDaySeconds})`;
    }
    return { status: "accepted", credited: credit, activeSeconds: row.activeSeconds + credit };
  });
}
