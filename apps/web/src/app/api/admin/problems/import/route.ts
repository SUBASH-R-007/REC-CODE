import { unlink } from "node:fs/promises";
import { after } from "next/server";
import { IMPORT_LIMITS } from "@recx/shared/authoring";
import { requireActionRole } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { processSpooledImport } from "@/lib/authoring/import/process";
import { IMPORT_STALE_AFTER_MS, sweepStaleImports } from "@/lib/authoring/import/run";
import { spoolDir, spoolRequestBody, sweepSpoolFiles } from "@/lib/authoring/import/spool";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { isSameOrigin } from "@/lib/help/same-origin";
import { requestIpHash } from "@/lib/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/problems/import — upload a bulk-import zip (package
 * format 1, docs/AUTHORING.md). The body is the raw archive
 * (content-type application/zip), not a server action: a server action's
 * 1 MB body limit would have to be raised for the whole app.
 *
 * Checks, in order: same origin (403), ADMIN / SUPER_ADMIN (401 / 403) —
 * before any byte of the body is read — content-type (415), declared size
 * (413), no other import of yours still running (409). The body is then
 * streamed to a private spool file with a byte cap (413), a ProblemImport
 * row is created and the import runs after the response (202 {importId});
 * the page at /admin/problems/import/<id> shows its progress row by row.
 * The original file name comes URI-encoded in x-recx-file-name.
 */

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function fileNameOf(request: Request): string {
  const raw = request.headers.get("x-recx-file-name");
  if (!raw) return "upload.zip";
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return "upload.zip";
  }
  // Keep a readable base name only: no path, no control characters.
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = [...base]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join("")
    .trim()
    .slice(0, 200);
  return clean.length > 0 ? clean : "upload.zip";
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return json({ error: "Cross-site request refused." }, 403);
  let actorId: string;
  try {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    actorId = actor.id;
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    throw error;
  }

  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/zip") return json({ error: "Upload a .zip archive (content-type application/zip)." }, 415);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > IMPORT_LIMITS.archiveBytes) {
    return json({ error: `The archive is larger than ${IMPORT_LIMITS.archiveBytes / 1024 / 1024} MB.` }, 413);
  }

  await sweepStaleImports();
  // Archives left by an import that was interrupted (a restart during after()).
  await sweepSpoolFiles(spoolDir(env().IMPORT_SPOOL_DIR), IMPORT_STALE_AFTER_MS);
  const running = await db.problemImport.findFirst({
    where: { uploadedById: actorId, status: "PROCESSING" },
    select: { id: true },
  });
  if (running) return json({ error: "Your previous import is still running. Wait for it to finish.", importId: running.id }, 409);

  let spool: { path: string; sizeBytes: number; sha256: string };
  try {
    spool = await spoolRequestBody(request, { maxBytes: IMPORT_LIMITS.archiveBytes, dir: spoolDir(env().IMPORT_SPOOL_DIR) });
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    throw error;
  }

  const fileName = fileNameOf(request);
  let record: { id: string };
  let ipHash: string | null;
  try {
    ipHash = await requestIpHash();
    record = await db.problemImport.create({
      data: { uploadedById: actorId, fileName, sizeBytes: BigInt(spool.sizeBytes), archiveSha256: spool.sha256, via: "upload" },
      select: { id: true },
    });
  } catch (error) {
    // Nothing will process the file: do not leave up to 256 MB behind.
    await unlink(spool.path).catch(() => undefined);
    throw error;
  }
  await audit({
    actorId,
    action: "problem.import.started",
    entityType: "ProblemImport",
    entityId: record.id,
    sensitivity: "NORMAL",
    metadata: { fileName, sizeBytes: spool.sizeBytes, archiveSha256: spool.sha256, via: "upload" },
    ipHash,
  });
  after(() => processSpooledImport(record.id, spool.path, { actorId, via: "upload", ipHash }));
  return json({ importId: record.id }, 202);
}
