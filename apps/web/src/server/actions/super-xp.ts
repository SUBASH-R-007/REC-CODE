"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { bucketKeys } from "@/lib/progress/rules";

/**
 * Void one XP award (capability "xp.void"). The ledger is append-only, so a
 * void is a compensating REVERSAL row (idempotencyKey "void:{eventId}",
 * reversesEventId = the original) inserted under the same per-user advisory
 * lock as the judge-finalise transaction. The three period buckets of the
 * original moment and UserStats.xpTotal move down by the same amount.
 * Solved counters, problem status and frozen LeaderboardSnapshot rows are
 * never touched.
 */

const voidSchema = z.object({
  eventId: z.string().trim().regex(/^\d{1,19}$/, "Enter the numeric id of an XP event."),
  reason: z
    .string()
    .trim()
    .min(10, "Give a reason of at least 10 characters. It is recorded in the audit log.")
    .max(500, "Keep the reason under 500 characters."),
});
export type VoidXpEventInput = z.input<typeof voidSchema>;

export async function voidXpEvent(
  input: VoidXpEventInput,
): Promise<ActionResult<{ reversalOf: string; amount: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = voidSchema.parse(input);
    const eventId = BigInt(parsed.eventId);
    const event = await db.xpEvent.findUnique({
      where: { id: eventId },
      select: { id: true, userId: true, kind: true, amount: true, rulesVersion: true, occurredAt: true },
    });
    if (!event) throw new NotFoundError("That XP event was not found.");
    if (event.kind === "REVERSAL") throw new ValidationError("A reversal cannot itself be voided.");
    if (event.amount <= 0) throw new ValidationError("Only an award of positive XP can be voided.");

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"user:" + event.userId}))`;
      const inserted = await tx.xpEvent.createMany({
        data: [
          {
            userId: event.userId,
            kind: "REVERSAL",
            amount: -event.amount,
            idempotencyKey: `void:${event.id.toString()}`,
            rulesVersion: event.rulesVersion,
            reversesEventId: event.id,
            grantedById: actor.id,
            meta: { reason: parsed.reason, voidedKind: event.kind },
          },
        ],
        skipDuplicates: true,
      });
      if (inserted.count !== 1) throw new ConflictError("This XP event has already been voided.");
      for (const { period, periodKey } of bucketKeys(event.occurredAt)) {
        await tx.xpBucket.updateMany({
          where: { userId: event.userId, period, periodKey },
          data: { xp: { decrement: event.amount } },
        });
      }
      await tx.userStats.updateMany({
        where: { userId: event.userId },
        data: { xpTotal: { decrement: event.amount } },
      });
    });

    await audit({
      actorId: actor.id,
      action: "xp.voided",
      entityType: "XpEvent",
      entityId: event.id.toString(),
      targetUserId: event.userId,
      sensitivity: "SENSITIVE",
      metadata: {
        kind: event.kind,
        amount: event.amount,
        occurredAt: event.occurredAt.toISOString(),
        reason: parsed.reason,
      },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super/users");
    return { reversalOf: event.id.toString(), amount: event.amount };
  }, "voidXpEvent");
}
