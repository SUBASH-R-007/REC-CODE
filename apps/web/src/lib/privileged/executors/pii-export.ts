import "server-only";
import { PII_EXPORT_WINDOW_MS } from "@recx/shared";
import { db } from "@/lib/db";
import type { Executor } from "@/lib/privileged/types";

/**
 * PII_EXPORT: approval opens a 24-hour download window. The CSV itself is
 * never stored: GET /super/data/exports/[id] streams it from the database
 * at download time (requester only, at most 3 downloads, each audited),
 * for exactly the accounts named in the approved payload.
 * The window end goes into the finishing UPDATE (the database requires it
 * there, CHECK PrivilegedOperation_export_artifact_check).
 */
export const executePiiExport: Executor<"PII_EXPORT"> = async (op) => {
  const rows = await db.user.count({ where: { id: { in: op.payload.userIds } } });
  const artifactAvailableUntil = new Date(Date.now() + PII_EXPORT_WINDOW_MS);
  return {
    result: { rowsAtApproval: rows, columns: [...op.payload.columns], availableUntil: artifactAvailableUntil.toISOString() },
    artifactAvailableUntil,
  };
};
