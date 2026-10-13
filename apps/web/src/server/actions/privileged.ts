"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { appendAuditEntriesInTx } from "@recx/db/audit";
import { BREAK_GLASS_JUSTIFICATION_MIN } from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { isFeatureEnabled } from "@/lib/flags";
import { requestIpHash } from "@/lib/ip";
import { activeSuperAdminIds, enqueueEmail } from "@/lib/outbox";
import { executePrivilegedOperation, privilegedSensitivity } from "@/lib/privileged/operations";
import { PRIVILEGED_KIND_LABEL } from "@/lib/privileged/payloads";
import { REQUESTER_IS_ACTIVE_SUPER_ADMIN_SQL, requesterIsActiveSuperAdmin } from "@/lib/privileged/requester";
import {
  canApprove,
  canCancel,
  canReject,
  canSelfApprove,
  DECISION_MESSAGES,
  effectiveStatus,
  type DecisionCheck,
} from "@/lib/privileged/policy";

/**
 * Deciding a PrivilegedOperation (supporting actions, SUPER_ADMIN only):
 *
 *   approvePrivilegedOperation      a second super-admin; privileged.approved (SECURITY), then executes
 *   selfApprovePrivilegedOperation  break-glass by the requester; privileged.break_glass (SECURITY),
 *                                   email to every ACTIVE super-admin (outbox) + in-app notices, then executes
 *   rejectPrivilegedOperation       a second super-admin; privileged.rejected (SENSITIVE)
 *   cancelPrivilegedOperation       the requester; privileged.cancelled (NORMAL)
 *
 * Each decision is ONE conditional UPDATE that the database checks again
 * (status machine, two-person CHECK, 24-hour window on the database clock).
 * The approver approves the exact payload digest they reviewed.
 */

const idSchema = z.string().trim().min(1).max(64);
const shaSchema = z.string().trim().regex(/^[0-9a-f]{64}$/, "The request digest is missing. Reload the page.");

type OperationRow = {
  id: string;
  kind: Parameters<typeof privilegedSensitivity>[0];
  status: Parameters<typeof effectiveStatus>[0]["status"];
  expiresAt: Date;
  requestedById: string;
  payloadSha256: string;
  summary: string;
};

async function loadOperation(id: string): Promise<OperationRow> {
  const op = await db.privilegedOperation.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      status: true,
      expiresAt: true,
      requestedById: true,
      payloadSha256: true,
      summary: true,
    },
  });
  if (!op) throw new NotFoundError("That request was not found.");
  return op;
}

function enforce(check: DecisionCheck): void {
  if (!check.ok) throw new ValidationError(check.reason);
}

/** A decision UPDATE matched no row (or the database refused it): say why. */
async function refusalAfterRace(id: string): Promise<never> {
  const op = await loadOperation(id);
  const status = effectiveStatus(op, new Date());
  if (status === "PENDING" && !(await requesterIsActiveSuperAdmin(op.requestedById))) {
    throw new AppError(DECISION_MESSAGES.requesterGone, 409);
  }
  throw new AppError(status === "EXPIRED" ? DECISION_MESSAGES.expired : DECISION_MESSAGES.decided, 409);
}

function isCheckViolation(error: unknown): boolean {
  const text = error instanceof Error ? error.message : "";
  return /23514|check_violation|expired at|can no longer be/i.test(text);
}

/** Run a decision UPDATE; a database refusal near the expiry boundary reads as "expired". */
async function decide(id: string, run: () => Promise<number>): Promise<void> {
  let count: number;
  try {
    count = await run();
  } catch (error) {
    if (isCheckViolation(error)) await refusalAfterRace(id);
    throw error;
  }
  if (count !== 1) await refusalAfterRace(id);
}

const approveSchema = z.object({
  id: idSchema,
  payloadSha256: shaSchema,
  note: z.string().trim().max(500).optional(),
});
export type ApprovePrivilegedOperationInput = z.input<typeof approveSchema>;

export async function approvePrivilegedOperation(
  input: ApprovePrivilegedOperationInput,
): Promise<ActionResult<{ status: "EXECUTED" | "FAILED"; error: string | null }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = approveSchema.parse(input);
    const op = await loadOperation(parsed.id);
    enforce(canApprove(op, actor.id, parsed.payloadSha256, new Date(), await requesterIsActiveSuperAdmin(op.requestedById)));
    const note = parsed.note ? parsed.note : null;
    const ipHash = await requestIpHash();
    // The decision and its SECURITY audit row commit together (or not at all).
    await decide(op.id, () =>
      db.$transaction(async (tx) => {
        const decided = await tx.$executeRaw`
          UPDATE "PrivilegedOperation"
             SET status = 'APPROVED', "decidedById" = ${actor.id},
                 "decidedAt" = GREATEST((statement_timestamp() AT TIME ZONE 'UTC'), "requestedAt"),
                 "decisionNote" = ${note}, "breakGlass" = false
           WHERE id = ${op.id} AND status = 'PENDING' AND "payloadSha256" = ${parsed.payloadSha256}
             AND "requestedById" <> ${actor.id}
             AND "expiresAt" > (statement_timestamp() AT TIME ZONE 'UTC')
             AND ${REQUESTER_IS_ACTIVE_SUPER_ADMIN_SQL}`;
        if (decided === 1) {
          await appendAuditEntriesInTx(tx, [
            {
              actorId: actor.id,
              action: "privileged.approved",
              entityType: "PrivilegedOperation",
              entityId: op.id,
              sensitivity: "SECURITY",
              metadata: { kind: op.kind, summary: op.summary, requestedById: op.requestedById, note },
              ipHash,
            },
          ]);
        }
        return decided;
      }),
    );
    const outcome = await executePrivilegedOperation(op.id, actor);
    revalidatePath("/super");
    return outcome;
  }, "approvePrivilegedOperation");
}

const selfApproveSchema = z.object({
  id: idSchema,
  payloadSha256: shaSchema,
  justification: z
    .string()
    .trim()
    .min(
      BREAK_GLASS_JUSTIFICATION_MIN,
      `Explain the emergency in at least ${BREAK_GLASS_JUSTIFICATION_MIN} characters. Every super-admin is emailed.`,
    )
    .max(1000, "Keep the justification under 1,000 characters."),
});
export type SelfApprovePrivilegedOperationInput = z.input<typeof selfApproveSchema>;

/** Break-glass: allowed, never quiet. */
export async function selfApprovePrivilegedOperation(
  input: SelfApprovePrivilegedOperationInput,
): Promise<ActionResult<{ status: "EXECUTED" | "FAILED"; error: string | null; emailed: number }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = selfApproveSchema.parse(input);
    const op = await loadOperation(parsed.id);
    const enabled = await isFeatureEnabled("breakGlassSelfApproval");
    enforce(canSelfApprove(op, actor.id, parsed.payloadSha256, new Date(), enabled));
    const label = PRIVILEGED_KIND_LABEL[op.kind];
    const actorName = `${actor.firstName} ${actor.lastName}`.trim();
    let emailed = 0;
    let decided = 0;
    const ipHash = await requestIpHash();
    try {
      // The decision, the emails, the notifications and the SECURITY audit
      // row commit together: break-glass is never quiet.
      await db.$transaction(async (tx) => {
        decided = await tx.$executeRaw`
          UPDATE "PrivilegedOperation"
             SET status = 'APPROVED', "decidedById" = ${actor.id},
                 "decidedAt" = GREATEST((statement_timestamp() AT TIME ZONE 'UTC'), "requestedAt"),
                 "decisionNote" = ${parsed.justification}, "breakGlass" = true
           WHERE id = ${op.id} AND status = 'PENDING' AND "payloadSha256" = ${parsed.payloadSha256}
             AND "requestedById" = ${actor.id}
             AND "expiresAt" > (statement_timestamp() AT TIME ZONE 'UTC')`;
        if (decided !== 1) return;
        const recipients = await activeSuperAdminIds(tx);
        emailed = await enqueueEmail(tx, {
          kind: "security.break_glass",
          toUserIds: recipients,
          subject: `Break-glass approval: ${label}`,
          bodyText: [
            `${actorName} approved their own privileged operation without a second super-admin (break-glass).`,
            `Operation: ${label}`,
            `Summary: ${op.summary}`,
            `Justification: ${parsed.justification}`,
            `Review it at ${env().APP_URL}/super (the audit log records it as privileged.break_glass).`,
          ].join("\n"),
          entityType: "PrivilegedOperation",
          entityId: op.id,
        });
        await tx.notification.createMany({
          data: recipients.map((userId) => ({
            userId,
            kind: "privileged.break_glass",
            title: `Break-glass: ${label}`,
            body: `${actorName} self-approved: ${op.summary}`.slice(0, 200),
            link: "/super",
          })),
        });
        await appendAuditEntriesInTx(tx, [
          {
            actorId: actor.id,
            action: "privileged.break_glass",
            entityType: "PrivilegedOperation",
            entityId: op.id,
            sensitivity: "SECURITY",
            metadata: { kind: op.kind, summary: op.summary, justification: parsed.justification, emailed },
            ipHash,
          },
        ]);
      });
    } catch (error) {
      if (isCheckViolation(error)) await refusalAfterRace(op.id);
      throw error;
    }
    if (decided !== 1) await refusalAfterRace(op.id);
    const outcome = await executePrivilegedOperation(op.id, actor);
    revalidatePath("/super");
    return { ...outcome, emailed };
  }, "selfApprovePrivilegedOperation");
}

const rejectSchema = z.object({
  id: idSchema,
  note: z
    .string()
    .trim()
    .min(5, "Say why in at least 5 characters. The requester sees it.")
    .max(500, "Keep the note under 500 characters."),
});
export type RejectPrivilegedOperationInput = z.input<typeof rejectSchema>;

export async function rejectPrivilegedOperation(
  input: RejectPrivilegedOperationInput,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = rejectSchema.parse(input);
    const op = await loadOperation(parsed.id);
    enforce(canReject(op, actor.id, new Date()));
    await decide(op.id, () =>
      db.$executeRaw`
        UPDATE "PrivilegedOperation"
           SET status = 'REJECTED', "decidedById" = ${actor.id},
               "decidedAt" = GREATEST((statement_timestamp() AT TIME ZONE 'UTC'), "requestedAt"),
               "decisionNote" = ${parsed.note}, "breakGlass" = false
         WHERE id = ${op.id} AND status = 'PENDING' AND "requestedById" <> ${actor.id}
           AND "expiresAt" > (statement_timestamp() AT TIME ZONE 'UTC')`,
    );
    await db.notification.create({
      data: {
        userId: op.requestedById,
        kind: "privileged.rejected",
        title: `${PRIVILEGED_KIND_LABEL[op.kind]} rejected`,
        body: parsed.note.slice(0, 200),
        link: "/super",
      },
    });
    await audit({
      actorId: actor.id,
      action: "privileged.rejected",
      entityType: "PrivilegedOperation",
      entityId: op.id,
      sensitivity: "SENSITIVE",
      metadata: { kind: op.kind, summary: op.summary, note: parsed.note },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super");
    return { id: op.id };
  }, "rejectPrivilegedOperation");
}

const cancelSchema = z.object({ id: idSchema });
export type CancelPrivilegedOperationInput = z.input<typeof cancelSchema>;

export async function cancelPrivilegedOperation(
  input: CancelPrivilegedOperationInput,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = cancelSchema.parse(input);
    const op = await loadOperation(parsed.id);
    enforce(canCancel(op, actor.id, new Date()));
    // CANCELLED carries no decider (CHECK PrivilegedOperation_undecided_close_check).
    const moved = await db.privilegedOperation.updateMany({
      where: { id: op.id, status: "PENDING", requestedById: actor.id },
      data: { status: "CANCELLED" },
    });
    if (moved.count !== 1) await refusalAfterRace(op.id);
    await audit({
      actorId: actor.id,
      action: "privileged.cancelled",
      entityType: "PrivilegedOperation",
      entityId: op.id,
      sensitivity: "NORMAL",
      metadata: { kind: op.kind, summary: op.summary },
      ipHash: await requestIpHash(),
    });
    revalidatePath("/super");
    return { id: op.id };
  }, "cancelPrivilegedOperation");
}
