import { APTITUDE_IMPORT_LIMITS, isAptitudeArea, isAptitudeTopic } from "@recx/shared";
import { requireActionRole } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { runAptitudeImport } from "@/lib/aptitude/import";
import { AppError } from "@/lib/errors";
import { isSameOrigin } from "@/lib/help/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/aptitude/import — upload an aptitude question CSV.
 *
 * A route handler and not a server action, for one concrete reason: a Next
 * server action's body limit is 1 MB, and an aptitude CSV is allowed 4 MB
 * because a row carries a 4 KB stem and an 8 KB worked explanation (SPEC §5
 * makes the explanation mandatory). Raising the action limit would raise it
 * for the whole app; a route handler raises it here and nowhere else.
 *
 * Checks, in order and BEFORE any byte of the body is read: same origin
 * (403), ADMIN / SUPER_ADMIN (401 / 403), content type (415), declared size
 * (413). Then the body is read with a hard cap (413) and the import runs,
 * answering with the per-row counts and an id — the page at
 * `/admin/aptitude/import/<id>` shows every line, applied or not, with every
 * reason.
 *
 * It runs INLINE rather than after the response. A 2,000-row CSV is a few
 * seconds of work, and an operator who uploads a file wants to know what it
 * did — unlike the problem-package import, which unpacks archives and judges
 * reference solutions.
 */

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/** A readable base name only: no path, no control characters. */
function fileNameOf(request: Request): string {
  const raw = request.headers.get("x-recx-file-name");
  if (!raw) return "upload.csv";
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return "upload.csv";
  }
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = [...base]
    .filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f)
    .join("")
    .trim()
    .slice(0, 200);
  return clean.length > 0 ? clean : "upload.csv";
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
  if (type !== "text/csv" && type !== "text/plain") {
    return json({ error: "Upload a .csv file (content-type text/csv)." }, 415);
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > APTITUDE_IMPORT_LIMITS.maxBytes) {
    return json(
      {
        error: `The file is larger than ${APTITUDE_IMPORT_LIMITS.maxBytes / 1024 / 1024} MB. Split it and upload the parts — each part imports on its own.`,
      },
      413,
    );
  }

  // The area and topic to use for rows that name none. An LMS export carries
  // neither, so the operator chooses here and the choice is recorded with the
  // file: a bank imported under the wrong topic is a weakness heatmap that
  // lies, and the only way to find out which upload did it is to have
  // written it down.
  const url = new URL(request.url);
  const areaParam = url.searchParams.get("area");
  const topicParam = url.searchParams.get("topic");
  if (areaParam !== null && !isAptitudeArea(areaParam)) return json({ error: "That is not an area." }, 400);
  if (topicParam !== null && !isAptitudeTopic(topicParam)) return json({ error: "That is not a topic." }, 400);
  const sourceBatch = (url.searchParams.get("batch") ?? "").trim().slice(0, 120) || null;

  const body = await request.arrayBuffer();
  if (body.byteLength > APTITUDE_IMPORT_LIMITS.maxBytes) {
    return json({ error: `The file is larger than ${APTITUDE_IMPORT_LIMITS.maxBytes / 1024 / 1024} MB.` }, 413);
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);

  const outcome = await runAptitudeImport({
    text,
    fileName: fileNameOf(request),
    uploadedById: actorId,
    via: "upload",
    defaultArea: areaParam === null ? null : areaParam,
    defaultTopic: topicParam === null ? null : topicParam,
    sourceBatch,
  });

  await audit({
    actorId,
    action: "aptitude.import.ran",
    entityType: "AptitudeImport",
    entityId: outcome.importId,
    metadata: {
      status: outcome.status,
      total: outcome.total,
      created: outcome.created,
      revised: outcome.revised,
      unchanged: outcome.unchanged,
      failed: outcome.failed,
      defaultArea: areaParam,
      defaultTopic: topicParam,
    },
  });

  // 200 even for a file-level failure: the import ROW exists either way and
  // carries the reason, and the caller needs its id to show it.
  return json(outcome, 200);
}
