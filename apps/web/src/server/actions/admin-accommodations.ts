"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma, type AccommodationStatus, type DbTx, type ProctorEventKind } from "@recx/db";
import { accommodationTermsSchema } from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import {
  loadStudentScope,
  requireAdminScopeAction,
  requireScopedStudent,
  scopedStudentSql,
  scopedStudentWhere,
  type StudentScope,
} from "@/lib/auth/scope";
import { db } from "@/lib/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";

/**
 * /admin/accommodations mutations. An ADMIN requests; only a SUPER_ADMIN
 * approves, rejects or revokes (requireSuperAdmin). Granted terms never
 * change: a change of terms is a new request that supersedes the current
 * grant when it is approved.
 *
 *   requestAccommodation   ADMIN  REQUESTED (SUPER_ADMIN may approve at once: approveNow)
 *   withdrawAccommodation  ADMIN  REQUESTED → WITHDRAWN (the requester or a SUPER_ADMIN)
 *   approveAccommodation   SUPER  REQUESTED → APPROVED (the superseded grant → SUPERSEDED first)
 *   rejectAccommodation    SUPER  REQUESTED → REJECTED
 *   revokeAccommodation    SUPER  APPROVED → REVOKED
 *
 * Every status change runs in one transaction that first locks (FOR UPDATE)
 * the target, the row it supersedes and any row superseding it. Audit
 * metadata never carries `kinds`, `reason` or `decisionNote` (a disability
 * label and its justification); a revoke carries `revokeReason`, which the
 * form asks to keep free of medical details. The database enforces the
 * state machine as well (schema.prisma, Accommodation).
 */

const idSchema = z.string().trim().min(1).max(64);
const reasonSchema = z
  .string()
  .trim()
  .min(10, "Describe the need in at least 10 characters.")
  .max(2000, "Keep the reason under 2,000 characters.");
const noteSchema = z
  .string()
  .trim()
  .min(5, "Give a note of at least 5 characters.")
  .max(1000, "Keep the note under 1,000 characters.");

interface LockedAccommodation {
  id: string;
  userId: string;
  status: AccommodationStatus;
  supersedesId: string | null;
  validUntil: Date;
  requestedById: string;
}

/**
 * Lock the given accommodations and every row superseding one of them, in
 * id order, inside the scope. Rows outside the scope are simply not returned.
 */
async function lockAccommodations(tx: DbTx, scope: StudentScope, ids: string[]): Promise<LockedAccommodation[]> {
  return tx.$queryRaw<LockedAccommodation[]>`
    SELECT a.id, a."userId", a.status::text AS status, a."supersedesId", a."validUntil", a."requestedById"
    FROM "Accommodation" a
    JOIN "User" u ON u.id = a."userId"
    WHERE (a.id = ANY(${ids}::text[]) OR a."supersedesId" = ANY(${ids}::text[]))
      AND ${scopedStudentSql(scope, "u")}
    ORDER BY a.id
    FOR UPDATE OF a`;
}

/** Lock a target (with its predecessor and successors) and return it, re-checked after the lock. */
async function lockTarget(tx: DbTx, scope: StudentScope, id: string) {
  const before = await tx.accommodation.findFirst({
    where: { id, user: scopedStudentWhere(scope) },
    select: { supersedesId: true },
  });
  if (!before) throw new NotFoundError("That accommodation was not found.");
  const rows = await lockAccommodations(tx, scope, before.supersedesId ? [id, before.supersedesId] : [id]);
  const target = rows.find((r) => r.id === id);
  if (!target) throw new NotFoundError("That accommodation was not found.");
  if (target.supersedesId !== before.supersedesId) {
    throw new ConflictError("This accommodation changed a moment ago. Reload the page and try again.");
  }
  const predecessor = target.supersedesId ? (rows.find((r) => r.id === target.supersedesId) ?? null) : null;
  return { target, predecessor, rows };
}

function auditMetadata(
  a: { id: string; validUntil: Date; extraTimePercent: number; extraTimeMinutes: number; exemptSignals: ProctorEventKind[] },
  from: AccommodationStatus | null,
  to: AccommodationStatus,
  supersedesId: string | null,
  extra: Record<string, string> = {},
): Prisma.InputJsonObject {
  // Allow-list: never kinds, reason or decisionNote.
  return {
    accommodationId: a.id,
    from,
    to,
    validUntil: a.validUntil.toISOString(),
    extraTimePercent: a.extraTimePercent,
    extraTimeMinutes: a.extraTimeMinutes,
    exemptSignals: [...a.exemptSignals],
    supersedesId,
    ...extra,
  };
}

const termsAuditSelect = {
  id: true,
  userId: true,
  validUntil: true,
  extraTimePercent: true,
  extraTimeMinutes: true,
  exemptSignals: true,
  supersedesId: true,
} as const;

/**
 * The approving step shared by approveAccommodation and approve-now: the
 * superseded grant (if any) leaves APPROVED first, then the request becomes
 * APPROVED in one UPDATE that writes the whole decision.
 */
async function approveLocked(
  tx: DbTx,
  scope: StudentScope,
  actorId: string,
  target: LockedAccommodation,
  predecessor: LockedAccommodation | null,
  note: string | null,
  now: Date,
) {
  if (target.status !== "REQUESTED") throw new ConflictError("Only a requested accommodation can be approved.");
  if (target.validUntil <= now) {
    throw new ValidationError("This request's validity has already ended. Reject it and file a new request.");
  }
  if (target.supersedesId) {
    if (!predecessor || predecessor.status !== "APPROVED") {
      throw new ConflictError(
        "The accommodation this request would replace is no longer approved. Reject this request and file a new one.",
      );
    }
    const superseded = await tx.accommodation.updateMany({
      where: { id: predecessor.id, status: "APPROVED", user: scopedStudentWhere(scope) },
      data: { status: "SUPERSEDED" },
    });
    if (superseded.count !== 1) throw new ConflictError("The current accommodation changed a moment ago. Try again.");
  } else {
    const approved = await tx.accommodation.count({
      where: { userId: target.userId, status: "APPROVED", user: scopedStudentWhere(scope) },
    });
    if (approved > 0) {
      throw new ConflictError("This student already has an approved accommodation. Request a change to it instead.");
    }
  }
  const moved = await tx.accommodation.updateMany({
    where: { id: target.id, status: "REQUESTED", user: scopedStudentWhere(scope) },
    data: {
      status: "APPROVED",
      approvedBySuperAdminId: actorId,
      grantedAt: now,
      decidedById: actorId,
      decidedAt: now,
      ...(note ? { decisionNote: note } : {}),
    },
  });
  if (moved.count !== 1) throw new ConflictError("This accommodation changed a moment ago. Reload the page and try again.");
}

/** The row as it is after the change, for the audit allow-list. */
function auditRow(scope: StudentScope, id: string) {
  return db.accommodation.findFirstOrThrow({ where: { id, user: scopedStudentWhere(scope) }, select: termsAuditSelect });
}

function revalidateAccommodation(id: string, userId: string) {
  revalidatePath("/admin/accommodations");
  revalidatePath(`/admin/accommodations/${id}`);
  revalidatePath(`/admin/students/${userId}`);
}

// ── Request (ADMIN) ────────────────────────────────────────────────────

const requestSchema = z.object({
  userId: idSchema,
  terms: accommodationTermsSchema,
  reason: reasonSchema,
  supersedesId: idSchema.optional(),
  approveNow: z.boolean().optional(),
});
export type RequestAccommodationInput = z.input<typeof requestSchema>;

export async function requestAccommodation(
  input: RequestAccommodationInput,
): Promise<ActionResult<{ id: string; status: AccommodationStatus }>> {
  return runAction(async () => {
    const { user, scope } = await requireAdminScopeAction();
    const parsed = requestSchema.parse(input);
    // approveNow is honoured only for a SUPER_ADMIN (and re-checked by the guard).
    const approveNow = parsed.approveNow === true && user.role === "SUPER_ADMIN";
    if (approveNow) await requireSuperAdmin();
    const now = new Date();

    const created = await db.$transaction(async (tx) => {
      const student = await requireScopedStudent(scope, parsed.userId, tx);
      let predecessor: LockedAccommodation | null = null;
      if (parsed.supersedesId) {
        const rows = await lockAccommodations(tx, scope, [parsed.supersedesId]);
        predecessor = rows.find((r) => r.id === parsed.supersedesId) ?? null;
        if (!predecessor || predecessor.userId !== student.scopedId) {
          throw new NotFoundError("The accommodation to replace was not found.");
        }
        if (predecessor.status !== "APPROVED") {
          throw new ConflictError("Only an approved accommodation can be replaced.");
        }
      } else {
        const approved = await tx.accommodation.count({
          where: { userId: student.scopedId, status: "APPROVED" },
        });
        if (approved > 0) {
          throw new ConflictError("This student already has an approved accommodation. Request a change to it instead.");
        }
      }

      let row: { id: string; status: AccommodationStatus };
      try {
        row = await tx.accommodation.create({
          data: {
            userId: student.scopedId,
            kinds: parsed.terms.kinds,
            exemptSignals: parsed.terms.exemptSignals,
            extraTimePercent: parsed.terms.extraTimePercent,
            extraTimeMinutes: parsed.terms.extraTimeMinutes,
            allowBreaks: parsed.terms.allowBreaks,
            breakMinutes: parsed.terms.breakMinutes,
            fontScalePercent: parsed.terms.fontScalePercent,
            allowScribe: parsed.terms.allowScribe,
            highContrast: parsed.terms.highContrast,
            validUntil: parsed.terms.validUntil,
            reason: parsed.reason,
            requestedById: user.id,
            // The same clock reading as an approve-now decision below: the database
            // refuses a decision dated before the request (Accommodation_*_after_request_check).
            requestedAt: now,
            supersedesId: parsed.supersedesId ?? null,
          },
          select: { id: true, status: true },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          throw new ConflictError("This student already has an open request. Decide or withdraw it first.");
        }
        throw error;
      }

      if (approveNow) {
        const target: LockedAccommodation = {
          id: row.id,
          userId: student.scopedId,
          status: "REQUESTED",
          supersedesId: parsed.supersedesId ?? null,
          validUntil: parsed.terms.validUntil,
          requestedById: user.id,
        };
        await approveLocked(tx, scope, user.id, target, predecessor, null, now);
        return { id: row.id, status: "APPROVED" as const, userId: student.scopedId };
      }
      return { id: row.id, status: row.status, userId: student.scopedId };
    });

    const a = await auditRow(scope, created.id);
    await audit({
      actorId: user.id,
      action: created.status === "APPROVED" ? "accommodation.approved" : "accommodation.requested",
      entityType: "Accommodation",
      entityId: created.id,
      targetUserId: created.userId,
      sensitivity: "SENSITIVE",
      metadata: auditMetadata(a, null, created.status, a.supersedesId, created.status === "APPROVED" ? { approvedNow: "true" } : {}),
      ipHash: await requestIpHash(),
    });
    revalidateAccommodation(created.id, created.userId);
    return { id: created.id, status: created.status };
  }, "requestAccommodation");
}

// ── Withdraw (requester or SUPER_ADMIN) ────────────────────────────────

const idInput = z.object({ id: idSchema });
export type AccommodationIdInput = z.input<typeof idInput>;

export async function withdrawAccommodation(input: AccommodationIdInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const { user, scope } = await requireAdminScopeAction();
    const { id } = idInput.parse(input);
    const now = new Date();
    const userId = await db.$transaction(async (tx) => {
      const { target } = await lockTarget(tx, scope, id);
      if (target.requestedById !== user.id && user.role !== "SUPER_ADMIN") {
        throw new ForbiddenError("Only the person who requested it, or a super-admin, can withdraw this request.");
      }
      if (target.status !== "REQUESTED") throw new ConflictError("Only a requested accommodation can be withdrawn.");
      const moved = await tx.accommodation.updateMany({
        where: { id, status: "REQUESTED", user: scopedStudentWhere(scope) },
        data: { status: "WITHDRAWN", decidedById: user.id, decidedAt: now, supersedesId: null },
      });
      if (moved.count !== 1) throw new ConflictError("This accommodation changed a moment ago. Reload the page and try again.");
      return target.userId;
    });
    const a = await auditRow(scope, id);
    await audit({
      actorId: user.id,
      action: "accommodation.withdrawn",
      entityType: "Accommodation",
      entityId: id,
      targetUserId: userId,
      sensitivity: "SENSITIVE",
      metadata: auditMetadata(a, "REQUESTED", "WITHDRAWN", null),
      ipHash: await requestIpHash(),
    });
    revalidateAccommodation(id, userId);
    return { id };
  }, "withdrawAccommodation");
}

// ── Decide (SUPER_ADMIN only) ──────────────────────────────────────────

const approveSchema = z.object({ id: idSchema, note: noteSchema.optional() });
export type ApproveAccommodationInput = z.input<typeof approveSchema>;

export async function approveAccommodation(input: ApproveAccommodationInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const scope = await loadStudentScope(actor);
    const parsed = approveSchema.parse(input);
    const now = new Date();
    const out = await db.$transaction(async (tx) => {
      const { target, predecessor } = await lockTarget(tx, scope, parsed.id);
      await approveLocked(tx, scope, actor.id, target, predecessor, parsed.note ?? null, now);
      return { userId: target.userId, supersedesId: target.supersedesId };
    });
    const a = await auditRow(scope, parsed.id);
    await audit({
      actorId: actor.id,
      action: "accommodation.approved",
      entityType: "Accommodation",
      entityId: parsed.id,
      targetUserId: out.userId,
      sensitivity: "SENSITIVE",
      metadata: auditMetadata(a, "REQUESTED", "APPROVED", out.supersedesId),
      ipHash: await requestIpHash(),
    });
    revalidateAccommodation(parsed.id, out.userId);
    return { id: parsed.id };
  }, "approveAccommodation");
}

const rejectSchema = z.object({ id: idSchema, note: noteSchema });
export type RejectAccommodationInput = z.input<typeof rejectSchema>;

export async function rejectAccommodation(input: RejectAccommodationInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const scope = await loadStudentScope(actor);
    const parsed = rejectSchema.parse(input);
    const now = new Date();
    const out = await db.$transaction(async (tx) => {
      const { target } = await lockTarget(tx, scope, parsed.id);
      if (target.status !== "REQUESTED") throw new ConflictError("Only a requested accommodation can be rejected.");
      const moved = await tx.accommodation.updateMany({
        where: { id: parsed.id, status: "REQUESTED", user: scopedStudentWhere(scope) },
        data: { status: "REJECTED", decidedById: actor.id, decidedAt: now, decisionNote: parsed.note, supersedesId: null },
      });
      if (moved.count !== 1) throw new ConflictError("This accommodation changed a moment ago. Reload the page and try again.");
      return { userId: target.userId, supersedesId: target.supersedesId };
    });
    const a = await auditRow(scope, parsed.id);
    await audit({
      actorId: actor.id,
      action: "accommodation.rejected",
      entityType: "Accommodation",
      entityId: parsed.id,
      targetUserId: out.userId,
      sensitivity: "SENSITIVE",
      metadata: auditMetadata(a, "REQUESTED", "REJECTED", out.supersedesId),
      ipHash: await requestIpHash(),
    });
    revalidateAccommodation(parsed.id, out.userId);
    return { id: parsed.id };
  }, "rejectAccommodation");
}

const revokeSchema = z.object({
  id: idSchema,
  reason: z
    .string()
    .trim()
    .min(5, "Give a reason of at least 5 characters — it is recorded in the audit log.")
    .max(500, "Keep the reason under 500 characters."),
});
export type RevokeAccommodationInput = z.input<typeof revokeSchema>;

/**
 * End an approved accommodation now. The reason is recorded in the audit
 * row (the database keeps the decision fields as they were at approval);
 * the form asks for no medical or disability details.
 */
export async function revokeAccommodation(input: RevokeAccommodationInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const actor = await requireSuperAdmin();
    const scope = await loadStudentScope(actor);
    const parsed = revokeSchema.parse(input);
    const now = new Date();
    const userId = await db.$transaction(async (tx) => {
      const { target } = await lockTarget(tx, scope, parsed.id);
      if (target.status !== "APPROVED") throw new ConflictError("Only an approved accommodation can be revoked.");
      const moved = await tx.accommodation.updateMany({
        where: { id: parsed.id, status: "APPROVED", user: scopedStudentWhere(scope) },
        data: { status: "REVOKED", revokedAt: now, revokedById: actor.id },
      });
      if (moved.count !== 1) throw new ConflictError("This accommodation changed a moment ago. Reload the page and try again.");
      return target.userId;
    });
    const a = await auditRow(scope, parsed.id);
    await audit({
      actorId: actor.id,
      action: "accommodation.revoked",
      entityType: "Accommodation",
      entityId: parsed.id,
      targetUserId: userId,
      sensitivity: "SENSITIVE",
      metadata: auditMetadata(a, "APPROVED", "REVOKED", a.supersedesId, { revokeReason: parsed.reason }),
      ipHash: await requestIpHash(),
    });
    revalidateAccommodation(parsed.id, userId);
    return { id: parsed.id };
  }, "revokeAccommodation");
}
