"use server";

import { z } from "zod";
import type { AuditSensitivity, JudgeNodeStatus } from "@recx/db";
import { requireActionRole, requireSuperAdmin } from "@/lib/auth/guards";
import { findScopedStudent, loadStudentScope, scopedStudentSql, scopedStudentWhere } from "@/lib/auth/scope";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { AppError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { CAP_TIME_ZONE, parseIstLocalDateTime } from "@/lib/judge/caps";
import { allowUnhardenedNodes } from "@/lib/judge/lanes";
import { isHeartbeatStale, NODE_ACTIONS, planNodeTransition } from "@/lib/judge/metrics";
import { enqueueJudge } from "@/lib/judge/queue";
import { PURGED_SOURCE_MESSAGE, resetForRejudge } from "@/lib/judge/rejudge";
import { revalidateLanguageConfigs } from "@/server/queries/judge-languages";

/**
 * /admin/judge mutations. Every one is guarded server-side, validated with
 * zod and audited (hash-chained, src/lib/audit.ts):
 *
 *   setJudgeNodeStatus      ADMIN    judge.node.drained / .quarantined (SECURITY) / .returned
 *   rejudgeSubmission       ADMIN    judge.rejudge (one submission; previous verdict recorded)
 *   setLanguageEnabled      ADMIN    judge.language.enabled_changed
 *   grantJudgeQuotaOverride SUPER    judge.quota.override (LIMITS.userCaps: "super-admin may override")
 *
 * Bulk / global rejudge is SUPER_ADMIN with two-person approval and arrives
 * in Phase 4; it is deliberately not offered here.
 */

const ADMIN_ROLES = ["ADMIN", "SUPER_ADMIN"] as const;

const reasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason of at least 5 characters — it is recorded in the audit log.")
  .max(500, "Keep the reason under 500 characters.");

const idSchema = z.string().trim().min(1).max(64);

// ── Node status ────────────────────────────────────────────────────────

const nodeStatusSchema = z.object({
  nodeId: idSchema,
  action: z.enum(NODE_ACTIONS),
  reason: reasonSchema,
});
export type SetJudgeNodeStatusInput = z.input<typeof nodeStatusSchema>;

const NODE_AUDIT_ACTION: Record<JudgeNodeStatus, string> = {
  DRAINING: "judge.node.drained",
  QUARANTINED: "judge.node.quarantined",
  ONLINE: "judge.node.returned",
  OFFLINE: "judge.node.returned",
};

function nodeSensitivity(from: JudgeNodeStatus, to: JudgeNodeStatus): AuditSensitivity {
  // Quarantining, and lifting a quarantine, are security events.
  if (to === "QUARANTINED" || from === "QUARANTINED") return "SECURITY";
  return "SENSITIVE";
}

export async function setJudgeNodeStatus(
  input: SetJudgeNodeStatusInput,
): Promise<ActionResult<{ status: JudgeNodeStatus }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...ADMIN_ROLES);
    const parsed = nodeStatusSchema.parse(input);
    const node = await db.judgeNode.findUnique({
      where: { id: parsed.nodeId },
      select: {
        id: true,
        hostname: true,
        status: true,
        selfCheckOk: true,
        hostHardened: true,
        lastHeartbeatAt: true,
        consecutiveIe: true,
      },
    });
    if (!node) throw new NotFoundError("That judge node was not found.");

    const plan = planNodeTransition(
      node.status,
      parsed.action,
      {
        selfCheckOk: node.selfCheckOk,
        hostHardened: node.hostHardened,
        heartbeatStale: isHeartbeatStale(node.lastHeartbeatAt, new Date()),
      },
      allowUnhardenedNodes(),
    );
    if (!plan.ok) throw new ValidationError(plan.reason);

    // Conditional on the status we read: a concurrent heartbeat, sweep or
    // another admin's change is never silently overwritten.
    const moved = await db.judgeNode.updateMany({
      where: { id: node.id, status: node.status },
      // Returning a node to service clears the auto-drain counter, or the
      // next release would drain it again at once.
      data: { status: plan.to, ...(parsed.action === "online" ? { consecutiveIe: 0 } : {}) },
    });
    if (moved.count !== 1) {
      throw new AppError("This node's status changed a moment ago. Refresh the page and try again.", 409);
    }

    await audit({
      actorId: actor.id,
      action: NODE_AUDIT_ACTION[plan.to],
      entityType: "JudgeNode",
      entityId: node.id,
      sensitivity: nodeSensitivity(node.status, plan.to),
      metadata: {
        hostname: node.hostname,
        from: node.status,
        to: plan.to,
        reason: parsed.reason,
        ...(parsed.action === "online" ? { consecutiveIeCleared: node.consecutiveIe } : {}),
      },
      ipHash: await requestIpHash(),
    });
    return { status: plan.to };
  }, "setJudgeNodeStatus");
}

// ── Rejudge one submission ─────────────────────────────────────────────

const rejudgeSchema = z.object({ submissionId: idSchema });
export type RejudgeSubmissionInput = z.input<typeof rejudgeSchema>;

export async function rejudgeSubmission(
  input: RejudgeSubmissionInput,
): Promise<ActionResult<{ id: string; dispatched: boolean }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...ADMIN_ROLES);
    // AdminScope: only an in-scope student's submission can be rejudged
    // (out of scope reads as not found).
    const scope = await loadStudentScope(actor);
    const { submissionId } = rejudgeSchema.parse(input);

    const previous = await db.$transaction(async (tx) => {
      // Row lock: a finalise committing concurrently is either fully before
      // this reset (and recorded as the previous verdict) or refused after
      // it (its claimToken no longer matches).
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT s.id FROM "Submission" s JOIN "User" u ON u.id = s."userId"
        WHERE s.id = ${submissionId} AND ${scopedStudentSql(scope, "u")} FOR UPDATE OF s`;
      if (locked.length === 0) throw new NotFoundError("That submission was not found.");
      const row = await tx.submission.findFirst({
        where: { id: submissionId, user: scopedStudentWhere(scope) },
        select: {
          id: true,
          userId: true,
          status: true,
          verdict: true,
          score: true,
          lane: true,
          origin: true,
          attemptCount: true,
          judgeNodeId: true,
          source: { select: { archivedAt: true } },
        },
      });
      if (!row) throw new NotFoundError("That submission was not found.");
      if (row.status === "CANCELLED") throw new ValidationError("A cancelled submission cannot be rejudged.");
      if (row.source?.archivedAt) throw new ValidationError(PURGED_SOURCE_MESSAGE);

      await resetForRejudge(tx, [submissionId], new Date());
      return row;
    });

    // After commit, like every enqueue: if Redis is down the row stays
    // QUEUED on lane REJUDGE and the reconciler enqueues it.
    const dispatched = await enqueueJudge("submission", submissionId, "REJUDGE");
    if (dispatched) {
      await db.submission.updateMany({
        where: { id: submissionId, judgeState: "PENDING", user: scopedStudentWhere(scope) },
        data: { judgeState: "DISPATCHED" },
      });
    }

    await audit({
      actorId: actor.id,
      action: "judge.rejudge",
      entityType: "Submission",
      entityId: submissionId,
      targetUserId: previous.userId,
      sensitivity: "SENSITIVE",
      metadata: {
        scope: "single",
        previousStatus: previous.status,
        previousVerdict: previous.verdict,
        previousScore: previous.score,
        previousLane: previous.lane,
        previousAttempts: previous.attemptCount,
        previousJudgeNodeId: previous.judgeNodeId,
        origin: previous.origin,
      },
      ipHash: await requestIpHash(),
    });
    return { id: submissionId, dispatched };
  }, "rejudgeSubmission");
}

// ── Language configuration ─────────────────────────────────────────────

const languageEnabledSchema = z.object({
  languageConfigId: idSchema,
  enabled: z.boolean(),
  reason: reasonSchema,
});
export type SetLanguageEnabledInput = z.input<typeof languageEnabledSchema>;

export async function setLanguageEnabled(
  input: SetLanguageEnabledInput,
): Promise<ActionResult<{ enabled: boolean }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...ADMIN_ROLES);
    const parsed = languageEnabledSchema.parse(input);
    const config = await db.languageConfig.findUnique({
      where: { id: parsed.languageConfigId },
      select: { id: true, key: true, toolchainId: true, label: true, enabled: true, isCurrent: true, retiredAt: true },
    });
    if (!config) throw new NotFoundError("That language configuration was not found.");
    if (config.enabled === parsed.enabled) {
      throw new ValidationError(`${config.label} is already ${parsed.enabled ? "enabled" : "disabled"}.`);
    }
    if (parsed.enabled && config.retiredAt) {
      throw new ValidationError("A retired toolchain cannot be enabled. Enable the current one instead.");
    }

    const moved = await db.languageConfig.updateMany({
      where: { id: config.id, enabled: config.enabled },
      data: { enabled: parsed.enabled },
    });
    if (moved.count !== 1) {
      throw new AppError("This language was changed a moment ago. Refresh the page and try again.", 409);
    }

    await audit({
      actorId: actor.id,
      action: "judge.language.enabled_changed",
      entityType: "LanguageConfig",
      entityId: config.id,
      sensitivity: "SENSITIVE",
      metadata: {
        key: config.key,
        toolchainId: config.toolchainId,
        isCurrent: config.isCurrent,
        from: config.enabled,
        to: parsed.enabled,
        reason: parsed.reason,
      },
      ipHash: await requestIpHash(),
    });
    // /judge and /help list the enabled languages (cached; this refreshes them).
    revalidateLanguageConfigs();
    return { enabled: parsed.enabled };
  }, "setLanguageEnabled");
}

// ── Per-user judge caps ────────────────────────────────────────────────

/** An optional positive whole number from a form field ("" = keep the default). */
function optionalCap(max: number, label: string) {
  return z.preprocess(
    (v) => (v === "" || v === undefined || v === null ? null : typeof v === "string" ? Number(v) : v),
    z
      .number({ invalid_type_error: `${label} must be a whole number.` })
      .int(`${label} must be a whole number.`)
      .min(1, `${label} must be at least 1.`)
      .max(max, `${label} can be at most ${max}.`)
      .nullable(),
  );
}

const quotaOverrideSchema = z.object({
  collegeId: z.string().trim().min(1, "Enter a roll number.").max(64),
  practicePerDay: optionalCap(10_000, "Practice submissions per day"),
  runsPerHour: optionalCap(1_000, "Runs per hour"),
  cpuMinutesPerDay: optionalCap(600, "CPU-minutes per day"),
  reason: reasonSchema,
  /** datetime-local in IST; empty = no expiry. */
  expiresAt: z
    .string()
    .trim()
    .max(32)
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      const date = parseIstLocalDateTime(v);
      if (!date) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter the expiry as a date and time." });
        return z.NEVER;
      }
      return date;
    }),
});
export type GrantJudgeQuotaOverrideInput = z.input<typeof quotaOverrideSchema>;

export async function grantJudgeQuotaOverride(
  input: GrantJudgeQuotaOverrideInput,
): Promise<ActionResult<{ id: string; collegeId: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const parsed = quotaOverrideSchema.parse(input);
    if (parsed.expiresAt && parsed.expiresAt.getTime() <= Date.now()) {
      throw new ValidationError("The expiry must be in the future.");
    }
    // A SUPER_ADMIN's scope is the whole college; scoping still limits the
    // lookup to student accounts.
    const student = await findScopedStudent(await loadStudentScope(actor), {
      collegeId: { equals: parsed.collegeId, mode: "insensitive" },
    });
    if (!student) throw new NotFoundError(`No student has the roll number ${parsed.collegeId}.`);
    const user = { id: student.scopedId, collegeId: student.collegeId };

    const row = await db.judgeQuotaOverride.create({
      data: {
        userId: student.scopedId,
        practicePerDay: parsed.practicePerDay,
        runsPerHour: parsed.runsPerHour,
        cpuMinutesPerDay: parsed.cpuMinutesPerDay,
        reason: parsed.reason,
        grantedById: actor.id,
        expiresAt: parsed.expiresAt,
      },
      select: { id: true },
    });

    await audit({
      actorId: actor.id,
      action: "judge.quota.override",
      entityType: "JudgeQuotaOverride",
      entityId: row.id,
      targetUserId: user.id,
      sensitivity: "SENSITIVE",
      metadata: {
        collegeId: user.collegeId,
        practicePerDay: parsed.practicePerDay,
        runsPerHour: parsed.runsPerHour,
        cpuMinutesPerDay: parsed.cpuMinutesPerDay,
        expiresAt: parsed.expiresAt ? parsed.expiresAt.toISOString() : null,
        timeZone: CAP_TIME_ZONE,
        reason: parsed.reason,
      },
      ipHash: await requestIpHash(),
    });
    return { id: row.id, collegeId: user.collegeId };
  }, "grantJudgeQuotaOverride");
}
