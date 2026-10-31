import "server-only";
import type { AuditSensitivity, Prisma, PrivilegedOperationKind } from "@recx/db";
import { PRIVILEGED_APPROVAL_TTL_MS } from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { executeBulkStatusChange } from "@/lib/privileged/executors/bulk-status";
import { executeGlobalRejudge } from "@/lib/privileged/executors/global-rejudge";
import { executePiiExport } from "@/lib/privileged/executors/pii-export";
import { executeProblemDelete, executeVersionDelete } from "@/lib/privileged/executors/problem-delete";
import { executeSubmissionPurge } from "@/lib/privileged/executors/submission-purge";
import {
  parsePrivilegedPayload,
  payloadDigest,
  PRIVILEGED_KIND_LABEL,
  type PrivilegedPayload,
} from "@/lib/privileged/payloads";
import type { Executor, ExecutorActor, ExecutorOutcome } from "@/lib/privileged/types";

/**
 * PrivilegedOperation lifecycle: request → (second super-admin approves, or
 * the requester breaks glass) → execute. The decision actions live in
 * server/actions/privileged.ts; this module creates rows and runs the
 * executors. The database enforces the state machine, the two-person rule
 * and the 24-hour window (schema.prisma, PrivilegedOperation).
 */

export const PRIVILEGED_EXECUTORS: { readonly [K in PrivilegedOperationKind]: Executor<K> } = {
  BULK_STATUS_CHANGE: executeBulkStatusChange,
  SUBMISSION_PURGE: executeSubmissionPurge,
  GLOBAL_REJUDGE: executeGlobalRejudge,
  PII_EXPORT: executePiiExport,
  PROBLEM_DELETE: executeProblemDelete,
  VERSION_DELETE: executeVersionDelete,
};

/** PII export is SECURITY end to end; every other kind is SENSITIVE. */
export function privilegedSensitivity(kind: PrivilegedOperationKind): AuditSensitivity {
  return kind === "PII_EXPORT" ? "SECURITY" : "SENSITIVE";
}

export interface CreatePrivilegedOperationInput<K extends PrivilegedOperationKind> {
  kind: K;
  payload: PrivilegedPayload<K>;
  summary: string;
  affectedCount: number;
  reason: string;
  actor: { id: string };
}

/**
 * Record a PENDING request with its exact payload and digest, notify every
 * other ACTIVE super-admin in-app, and audit `privileged.requested`. The
 * request window is 24 hours from now (both timestamps from one clock, so
 * the database's 24-hour CHECK holds exactly).
 */
export async function createPrivilegedOperation<K extends PrivilegedOperationKind>(
  input: CreatePrivilegedOperationInput<K>,
): Promise<{ id: string; expiresAt: Date }> {
  const payload = parsePrivilegedPayload(input.kind, input.payload);
  const payloadSha256 = payloadDigest(payload);
  const requestedAt = new Date();
  const expiresAt = new Date(requestedAt.getTime() + PRIVILEGED_APPROVAL_TTL_MS);
  const label = PRIVILEGED_KIND_LABEL[input.kind];
  const summary = input.summary.slice(0, 300);

  const row = await db.$transaction(async (tx) => {
    const created = await tx.privilegedOperation.create({
      data: {
        kind: input.kind,
        payload: payload as Prisma.InputJsonValue,
        payloadSha256,
        summary,
        affectedCount: input.affectedCount,
        reason: input.reason,
        requestedById: input.actor.id,
        requestedAt,
        expiresAt,
      },
      select: { id: true, expiresAt: true },
    });
    const approvers = await tx.user.findMany({
      where: { role: "SUPER_ADMIN", status: "ACTIVE", id: { not: input.actor.id } },
      select: { id: true },
    });
    if (approvers.length > 0) {
      await tx.notification.createMany({
        data: approvers.map((u) => ({
          userId: u.id,
          kind: "privileged.pending",
          title: `${label} needs a second approval`,
          body: summary.slice(0, 200),
          link: "/super",
        })),
      });
    }
    return created;
  });

  await audit({
    actorId: input.actor.id,
    action: "privileged.requested",
    entityType: "PrivilegedOperation",
    entityId: row.id,
    sensitivity: input.kind === "PII_EXPORT" ? "SECURITY" : "SENSITIVE",
    metadata: {
      kind: input.kind,
      summary,
      affectedCount: input.affectedCount,
      reason: input.reason,
      payloadSha256,
      expiresAt: row.expiresAt.toISOString(),
    },
    ipHash: await requestIpHash(),
  });
  return row;
}

/** A short, secret-free error for the row and the audit (never a stack, never SQL parameters). */
function failureMessage(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name === "Error" ? "" : `${error.name}: `;
    return `${name}${error.message}`.slice(0, 500);
  }
  return "The operation failed.";
}

/**
 * Run an APPROVED operation. Claims it (APPROVED → EXECUTING, set once),
 * runs its executor, and finishes it EXECUTED (with the result) or FAILED
 * (with the error). Only one caller can win the claim. A process that dies
 * mid-run leaves the row EXECUTING; the scheduler's governance sweep fails
 * it after 15 minutes.
 */
export async function executePrivilegedOperation(
  id: string,
  actor: { id: string },
): Promise<{ status: "EXECUTED" | "FAILED"; error: string | null }> {
  const claimed = await db.privilegedOperation.updateMany({
    where: { id, status: "APPROVED" },
    data: { status: "EXECUTING", executionStartedAt: new Date() },
  });
  if (claimed.count !== 1) throw new ConflictError("This operation is already running or has finished.");
  const op = await db.privilegedOperation.findUniqueOrThrow({
    where: { id },
    select: { id: true, kind: true, payload: true, requestedById: true, decidedAt: true, summary: true },
  });
  const ipHash = await requestIpHash();
  const executorActor: ExecutorActor = { id: actor.id, ipHash };

  let outcome: ExecutorOutcome | null = null;
  let error: string | null = null;
  try {
    const payload = parsePrivilegedPayload(op.kind, op.payload);
    const executor = PRIVILEGED_EXECUTORS[op.kind] as Executor<typeof op.kind>;
    outcome = await executor(
      { id: op.id, payload, requestedById: op.requestedById, decidedAt: op.decidedAt ?? new Date() },
      executorActor,
    );
  } catch (cause) {
    error = failureMessage(cause);
    console.error(`[privileged] ${op.kind} ${op.id} failed:`, cause);
  }

  const status = outcome ? "EXECUTED" : "FAILED";
  await db.privilegedOperation.updateMany({
    where: { id, status: "EXECUTING" },
    data: outcome
      ? {
          status: "EXECUTED",
          executedAt: new Date(),
          result: outcome.result,
          ...(outcome.artifactAvailableUntil ? { artifactAvailableUntil: outcome.artifactAvailableUntil } : {}),
        }
      : { status: "FAILED", executedAt: new Date(), error },
  });

  await audit({
    actorId: actor.id,
    action: outcome ? "privileged.executed" : "privileged.failed",
    entityType: "PrivilegedOperation",
    entityId: op.id,
    sensitivity: privilegedSensitivity(op.kind),
    metadata: outcome
      ? { kind: op.kind, summary: op.summary, result: outcome.result }
      : { kind: op.kind, summary: op.summary, error },
    ipHash,
  });
  return { status, error };
}
