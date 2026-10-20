import { PII_EXPORT_MAX_DOWNLOADS } from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireSuperAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { csvRow } from "@/lib/privileged/csv";
import { parsePrivilegedPayload, userFilterWhere, type PiiExportColumn } from "@/lib/privileged/payloads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /super/data/exports/[id]: the CSV of an approved PII_EXPORT
 * (capability "pii.export"). The file is generated now, from the database,
 * and never stored. Only the super-admin who requested it, only while the
 * operation is EXECUTED and inside its 24-hour window, at most 3 times (a
 * conditional increment, so two parallel downloads cannot both take the
 * last one). Each download is a SECURITY audit row. Streamed a page of
 * accounts at a time, formula-escaped, never cached.
 */

const PAGE = 1_000;

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  let actorId: string;
  try {
    actorId = (await requireSuperAdmin()).id;
  } catch (error) {
    if (error instanceof AppError) return text(error.message, error.status);
    throw error;
  }
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return text("Not found.", 404);

  const op = await db.privilegedOperation.findUnique({
    where: { id },
    select: { id: true, kind: true, status: true, requestedById: true, payload: true, artifactAvailableUntil: true },
  });
  // Someone else's export, or another kind: indistinguishable from missing.
  if (!op || op.kind !== "PII_EXPORT" || op.requestedById !== actorId) return text("Not found.", 404);
  if (op.status !== "EXECUTED") return text("This export has not been approved and run.", 409);
  if (!op.artifactAvailableUntil || op.artifactAvailableUntil.getTime() <= Date.now()) {
    return text("The 24-hour download window has closed. Request a new export.", 410);
  }
  const payload = parsePrivilegedPayload("PII_EXPORT", op.payload);

  const claimed = await db.$queryRaw<{ artifactDownloads: number }[]>`
    UPDATE "PrivilegedOperation" SET "artifactDownloads" = "artifactDownloads" + 1
     WHERE id = ${op.id} AND status = 'EXECUTED' AND "artifactDownloads" < ${PII_EXPORT_MAX_DOWNLOADS}
       AND "artifactAvailableUntil" > (now() AT TIME ZONE 'UTC')
    RETURNING "artifactDownloads"`;
  const download = claimed[0]?.artifactDownloads;
  if (download === undefined) {
    return text(`All ${PII_EXPORT_MAX_DOWNLOADS} downloads of this export have been used. Request a new export.`, 410);
  }

  await audit({
    actorId,
    action: "pii.export.downloaded",
    entityType: "PrivilegedOperation",
    entityId: op.id,
    sensitivity: "SECURITY",
    metadata: { download, maxDownloads: PII_EXPORT_MAX_DOWNLOADS, columns: [...payload.columns] },
    ipHash: await requestIpHash(),
  });

  const columns: readonly PiiExportColumn[] = payload.columns;
  const where = userFilterWhere(payload.filter);
  const select = Object.fromEntries([["id", true], ...columns.map((c) => [c, true])]) as Record<string, true>;
  const encoder = new TextEncoder();
  let cursor: string | null = null;
  let headerSent = false;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!headerSent) {
          headerSent = true;
          controller.enqueue(encoder.encode(csvRow(columns)));
          return;
        }
        const rows = (await db.user.findMany({
          where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
          orderBy: { id: "asc" },
          take: PAGE,
          select,
        })) as Array<Record<string, unknown> & { id: string }>;
        if (rows.length === 0) {
          controller.close();
          return;
        }
        cursor = rows[rows.length - 1]!.id;
        controller.enqueue(encoder.encode(rows.map((r) => csvRow(columns.map((c) => r[c]))).join("")));
        if (rows.length < PAGE) controller.close();
      } catch (error) {
        console.error("[pii-export] stream failed:", error instanceof Error ? error.message : error);
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="recx-pii-export-${op.id}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
