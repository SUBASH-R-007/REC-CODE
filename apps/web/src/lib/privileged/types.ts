import type { Prisma, PrivilegedOperationKind } from "@recx/db";
import type { PrivilegedPayload } from "@/lib/privileged/payloads";

/** What an executor receives: the approved operation (payload already re-parsed). */
export interface ExecutorInput<K extends PrivilegedOperationKind> {
  id: string;
  payload: PrivilegedPayload<K>;
  requestedById: string;
  decidedAt: Date;
}

/**
 * What an executor hands back to the finishing UPDATE (EXECUTING →
 * EXECUTED). PII_EXPORT must return `artifactAvailableUntil`: the database
 * only accepts it in that same UPDATE.
 */
export interface ExecutorOutcome {
  result: Prisma.InputJsonObject;
  artifactAvailableUntil?: Date;
}

/** Who runs it (the approver, or the requester on break-glass) and the request ipHash for effect audit rows. */
export interface ExecutorActor {
  id: string;
  ipHash: string | null;
}

export type Executor<K extends PrivilegedOperationKind> = (
  op: ExecutorInput<K>,
  actor: ExecutorActor,
) => Promise<ExecutorOutcome>;

/** Executors work in transactions of at most this many rows. */
export const EXECUTOR_BATCH = 500;
