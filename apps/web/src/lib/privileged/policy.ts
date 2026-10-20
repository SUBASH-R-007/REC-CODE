import type { PrivilegedOperationStatus } from "@recx/db";
import { BULK_STATUS_DIRECT_MAX, BULK_STATUS_MAX } from "@recx/shared";

/**
 * Who may decide a PrivilegedOperation, and when. Pure: the server actions
 * (server/actions/privileged.ts) call these before their conditional
 * UPDATE, and the database enforces the same rules again (two-person CHECK,
 * expiry trigger, status machine) — see the PrivilegedOperation comment in
 * schema.prisma.
 */

export type DecisionCheck = { ok: true } | { ok: false; reason: string };

export interface DecidableOperation {
  status: PrivilegedOperationStatus;
  expiresAt: Date;
  requestedById: string;
  payloadSha256: string;
}

export const DECISION_MESSAGES = {
  expired: "This request has expired (requests wait at most 24 hours). Ask for it again if it is still needed.",
  decided: "This request has already been decided.",
  ownRequest:
    "You requested this operation, so a second super-admin must approve it. Use break-glass only in an emergency.",
  notRequester: "Only the super-admin who requested this operation can do that.",
  changed: "This request is not the one you reviewed. Reload the page and review it again.",
  breakGlassOff: "Break-glass self-approval is switched off (Super-admin → Flags).",
  ownReject: "You requested this operation. Cancel it instead of rejecting it.",
} as const;

/** PENDING past its expiry reads as EXPIRED even before the sweep writes it. */
export function effectiveStatus(
  op: { status: PrivilegedOperationStatus; expiresAt: Date },
  now: Date,
): PrivilegedOperationStatus {
  if (op.status === "PENDING" && op.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return op.status;
}

function pending(op: DecidableOperation, now: Date): DecisionCheck {
  const status = effectiveStatus(op, now);
  if (status === "EXPIRED") return { ok: false, reason: DECISION_MESSAGES.expired };
  if (status !== "PENDING") return { ok: false, reason: DECISION_MESSAGES.decided };
  return { ok: true };
}

/** A second super-admin approves the exact payload they reviewed. */
export function canApprove(op: DecidableOperation, actorId: string, sha: string, now: Date): DecisionCheck {
  const open = pending(op, now);
  if (!open.ok) return open;
  if (op.requestedById === actorId) return { ok: false, reason: DECISION_MESSAGES.ownRequest };
  if (op.payloadSha256 !== sha) return { ok: false, reason: DECISION_MESSAGES.changed };
  return { ok: true };
}

/** Break-glass: only the requester, only while the flag is on. Never quiet (SECURITY audit + email). */
export function canSelfApprove(
  op: DecidableOperation,
  actorId: string,
  sha: string,
  now: Date,
  breakGlassEnabled: boolean,
): DecisionCheck {
  const open = pending(op, now);
  if (!open.ok) return open;
  if (op.requestedById !== actorId) return { ok: false, reason: DECISION_MESSAGES.notRequester };
  if (!breakGlassEnabled) return { ok: false, reason: DECISION_MESSAGES.breakGlassOff };
  if (op.payloadSha256 !== sha) return { ok: false, reason: DECISION_MESSAGES.changed };
  return { ok: true };
}

export function canReject(op: DecidableOperation, actorId: string, now: Date): DecisionCheck {
  const open = pending(op, now);
  if (!open.ok) return open;
  if (op.requestedById === actorId) return { ok: false, reason: DECISION_MESSAGES.ownReject };
  return { ok: true };
}

export function canCancel(op: DecidableOperation, actorId: string, now: Date): DecisionCheck {
  const open = pending(op, now);
  if (!open.ok) return open;
  if (op.requestedById !== actorId) return { ok: false, reason: DECISION_MESSAGES.notRequester };
  return { ok: true };
}

/**
 * A status change of up to 25 accounts runs directly (single super-admin);
 * 26 to 5,000 needs a two-person PrivilegedOperation; more is refused.
 */
export function bulkStatusRoute(count: number): "direct" | "privileged" | "too-large" {
  if (count <= BULK_STATUS_DIRECT_MAX) return "direct";
  if (count <= BULK_STATUS_MAX) return "privileged";
  return "too-large";
}
