import "server-only";
import { PII_EXPORT_MAX_DOWNLOADS } from "@recx/shared";
import { db } from "@/lib/db";
import { toOperationViews, type OperationView } from "@/server/queries/super-dashboard";

/** Reads for /super/data (SUPER_ADMIN; the page guards itself): the viewer's own data operations. */

export interface DataOperationView extends OperationView {
  /** PII export ready for this viewer to download now. */
  downloadable: boolean;
  downloadsLeft: number;
  availableUntil: Date | null;
}

export async function loadMyDataOperations(actorId: string, now: Date): Promise<DataOperationView[]> {
  const rows = await db.privilegedOperation.findMany({
    where: { requestedById: actorId, kind: { in: ["PII_EXPORT", "SUBMISSION_PURGE"] } },
    orderBy: { requestedAt: "desc" },
    take: 30,
    select: {
      id: true,
      kind: true,
      status: true,
      summary: true,
      reason: true,
      affectedCount: true,
      payloadSha256: true,
      requestedById: true,
      requestedAt: true,
      expiresAt: true,
      decidedById: true,
      decidedAt: true,
      breakGlass: true,
      error: true,
      artifactAvailableUntil: true,
      artifactDownloads: true,
    },
  });
  const views = await toOperationViews(rows);
  return views.map((view, i) => {
    const row = rows[i]!;
    const left = Math.max(0, PII_EXPORT_MAX_DOWNLOADS - row.artifactDownloads);
    return {
      ...view,
      availableUntil: row.artifactAvailableUntil,
      downloadsLeft: left,
      downloadable:
        row.kind === "PII_EXPORT" &&
        row.status === "EXECUTED" &&
        row.artifactAvailableUntil !== null &&
        row.artifactAvailableUntil.getTime() > now.getTime() &&
        left > 0,
    };
  });
}
