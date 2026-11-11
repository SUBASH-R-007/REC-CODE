"use server";

import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { verifyAuditDay, type ChainDayVerdict } from "@/server/queries/super-audit";

/**
 * Verify one UTC day of the AuditLog hash chain, SUPER_ADMIN only
 * (capability "audit.readFull"). The chain is tamper-EVIDENT, not
 * tamper-resistant: an intact day proves nobody edited it without also
 * rewriting every later link, and the exported terminal hash pins it.
 *
 *   intact  → audit.chain_verified (NORMAL)
 *   broken  → audit.chain_break_detected (SECURITY)
 */

const daySchema = z.object({
  day: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a day (yyyy-mm-dd).")
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "Pick a real day."),
});
export type VerifyAuditChainDayInput = z.input<typeof daySchema>;

export async function verifyAuditChainDay(input: VerifyAuditChainDayInput): Promise<ActionResult<ChainDayVerdict>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const { day } = daySchema.parse(input);
    const verdict = await verifyAuditDay(db, day);
    await audit({
      actorId: actor.id,
      action: verdict.intact ? "audit.chain_verified" : "audit.chain_break_detected",
      entityType: "AuditLog",
      entityId: day,
      sensitivity: verdict.intact ? "NORMAL" : "SECURITY",
      metadata: {
        day,
        rows: verdict.rows,
        intact: verdict.intact,
        firstBadId: verdict.firstBadId,
        terminalHash: verdict.terminalHash,
      },
      ipHash: await requestIpHash(),
    });
    return verdict;
  }, "verifyAuditChainDay");
}
