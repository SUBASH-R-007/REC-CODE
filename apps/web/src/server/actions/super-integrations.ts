"use server";

import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { enqueueEmail } from "@/lib/outbox";

/**
 * /super/settings/integrations is a read-only status page plus this test
 * email, SUPER_ADMIN only (supporting action). The mail goes through the
 * same outbox and scheduler drain as security mail, to the caller only.
 */

const inputSchema = z.object({}).strict().optional();

export async function sendTestEmail(input?: unknown): Promise<ActionResult<{ queued: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    inputSchema.parse(input);
    const queued = await db.$transaction((tx) =>
      enqueueEmail(tx, {
        kind: "integrations.test",
        toUserIds: [actor.id],
        subject: "REC Code test email",
        bodyText: [
          "This is a test email from REC Code (Super-admin → Settings → Integrations).",
          "If you can read it, the mail transport is delivering. No action is needed.",
        ].join("\n\n"),
        entityType: "User",
        entityId: actor.id,
      }),
    );
    await audit({
      actorId: actor.id,
      action: "integrations.test_email",
      entityType: "EmailOutbox",
      sensitivity: "NORMAL",
      metadata: { queued },
      ipHash: await requestIpHash(),
    });
    return { queued };
  }, "sendTestEmail");
}
