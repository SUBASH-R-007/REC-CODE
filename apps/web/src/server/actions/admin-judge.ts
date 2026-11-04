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
import { PURGED_SOURCE_MESSAGE, SOURCE_NOT_ARCHIVED_SQL, resetForRejudge } from "@/lib/judge/rejudge";
import { revalidateLanguageConfigs } from "@/server/queries/judge-languages";
import { revalidatePath } from "next/cache";

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

// ── Rejudge one paper ──────────────────────────────────────────────────

/**
 * Submissions a single rejudge of one paper may move.
 *
 * A paper is a cohort times its programs: three hundred candidates and
 * four coding questions is twelve hundred, which the REJUDGE lane's
 * weighted ceiling absorbs without starving a live exam. Above this it is
 * a college-wide event rather than a correction to one paper, and the
 * SUPER_ADMIN global rejudge — two-person approved, per problem — is the
 * instrument for that. Refusing is better than half-doing it.
 */
const REJUDGE_PAPER_MAX = 2_000;

/** Sittings whose answers are final enough to rejudge. */
const REJUDGEABLE_ATTEMPT_STATUSES = ["SUBMITTED", "AUTO_SUBMITTED", "TERMINATED", "EXPIRED", "VOIDED"];

const rejudgePaperSchema = z.object({ assessmentId: idSchema, reason: reasonSchema });
export type RejudgeAssessmentInput = z.input<typeof rejudgePaperSchema>;

/**
 * Rejudge every program handed in for one assessment (Phase 13h.3).
 *
 * The gap this fills: when a question's tests turn out to be wrong — the
 * commonest reason a cohort all fails one question — the results page's
 * only advice was to rejudge from `/admin/judge`, which takes one
 * submission id at a time. Three hundred candidates meant three hundred
 * trips. The SUPER_ADMIN global rejudge is not the same act: it is per
 * PROBLEM across the whole college with two-person approval, so it also
 * moves every practice and contest submission of that problem, and it
 * cannot be reached by the department that set the paper.
 *
 * Bounded deliberately:
 *
 *   - **Finished sittings only.** Rejudging a program handed in by
 *     somebody still sitting the paper would take their verdict away
 *     while they are looking at it.
 *   - **In scope only**, like every staff read or write about a
 *     candidate, and asserted twice — the attempt rows and the
 *     submissions both carry the filter.
 *   - **Never a purged source.** A submission whose code was purged keeps
 *     its verdict forever; rejudging it would compile an empty file over
 *     the top of that verdict.
 *   - **Capped**, and refused rather than truncated above the cap.
 *
 * One audit row, naming the paper and the count: a row per submission
 * would bury the fact that this was one deliberate act by one person.
 * Whether the marks had already been released is recorded in it, because
 * that is the detail somebody will want months later.
 */
export async function rejudgeAssessment(
  input: RejudgeAssessmentInput,
): Promise<ActionResult<{ count: number; dispatched: number }>> {
  return runAction(async () => {
    const actor = await requireActionRole(...ADMIN_ROLES);
    const scope = await loadStudentScope(actor);
    const parsed = rejudgePaperSchema.parse(input);
    const paper = await db.assessment.findUnique({
      where: { id: parsed.assessmentId },
      select: { id: true, slug: true, title: true, resultsPublishedAt: true },
    });
    if (!paper) throw new NotFoundError("That assessment was not found.");

    const ids = await db.$transaction(async (tx) => {
      /**
       * Locked in id order, which is what keeps two of these from
       * deadlocking against each other, and the same `FOR UPDATE` the
       * single rejudge takes: a finalise committing concurrently is
       * either fully before this reset or refused after it.
       */
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "Submission".id
          FROM "Submission"
          JOIN "User" u ON u.id = "Submission"."userId"
          JOIN "AssessmentAttempt" att ON att.id = "Submission"."assessmentAttemptId"
         WHERE att."assessmentId" = ${paper.id}
           AND att.status::text = ANY(${REJUDGEABLE_ATTEMPT_STATUSES}::text[])
           AND "Submission".status IN ('DONE', 'INTERNAL_ERROR')
           AND ${scopedStudentSql(scope, "u")}
           AND ${SOURCE_NOT_ARCHIVED_SQL}
         ORDER BY "Submission".id
         LIMIT ${REJUDGE_PAPER_MAX + 1}
         FOR UPDATE OF "Submission"`;
      if (locked.length === 0) {
        throw new ValidationError(
          "There is nothing to rejudge on this paper: no finished sitting of yours has a judged program whose code is still stored.",
        );
      }
      if (locked.length > REJUDGE_PAPER_MAX) {
        throw new ValidationError(
          `This paper has more than ${REJUDGE_PAPER_MAX.toLocaleString("en-IN")} judged programs. A rejudge that size is a college-wide operation — ask a super-admin to run a global rejudge of the question instead.`,
        );
      }
      const list = locked.map((row) => row.id);
      await resetForRejudge(tx, list, new Date());
      return list;
    });

    /**
     * After commit, like every enqueue: a row Redis refused stays QUEUED
     * on lane REJUDGE and the reconciler picks it up, so a judge that was
     * down when this ran costs a delay rather than a lost rejudge.
     */
    let dispatched = 0;
    for (const id of ids) {
      if (await enqueueJudge("submission", id, "REJUDGE")) dispatched += 1;
    }
    if (dispatched > 0) {
      await db.submission.updateMany({
        where: { id: { in: ids }, judgeState: "PENDING", user: scopedStudentWhere(scope) },
        data: { judgeState: "DISPATCHED" },
      });
    }

    await audit({
      actorId: actor.id,
      action: "judge.rejudge",
      entityType: "Assessment",
      entityId: paper.id,
      sensitivity: "SENSITIVE",
      metadata: {
        scope: "assessment",
        slug: paper.slug,
        count: ids.length,
        dispatched,
        // The detail somebody will ask about later: were the marks out?
        resultsWereReleased: paper.resultsPublishedAt !== null,
        reason: parsed.reason,
      },
      ipHash: await requestIpHash(),
    });

    revalidatePath(`/admin/assessments/${paper.id}/results`);
    return { count: ids.length, dispatched };
  }, "rejudgeAssessment");
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
