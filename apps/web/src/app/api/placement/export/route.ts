import { createHash } from "node:crypto";
import {
  PLACEMENT_EXPORT_COLUMNS,
  assertExportColumns,
  campusDayDate,
  formatCampusTime,
  placementCsvHeader,
  placementCsvProvenance,
  placementCsvRow,
  type PlacementExportRow,
} from "@recx/shared";
import { requirePlacementAction } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { requestIpHash } from "@/lib/ip";
import { latestRunDay } from "@/server/queries/placement-cohort";
import { describeCohort, parseCohortFilter } from "@/lib/placement/filter";
import { buildExportRows } from "@/server/queries/placement-export-rows";

/**
 * `POST /api/placement/export` — the cohort CSV (Phase 9e).
 *
 * The guard runs FIRST, before the body is read. That is the shape every
 * mutating route in this repo uses, and the reason is that parsing an
 * attacker's body before deciding whether they may be here at all is work
 * done on their behalf.
 *
 * It is a POST although it only reads, and deliberately: it WRITES a
 * `PlacementExport` row, so it is not idempotent and must not be
 * prefetchable, link-shareable or retried by a browser that thought a GET was
 * safe to repeat. A GET that recorded an export every time a tab was
 * refreshed would make the record useless.
 *
 * Three things the file carries that a spreadsheet cannot infer:
 *
 *   - a provenance line naming the requester, the run and this export's id,
 *     so a leaked file is attributable to a person;
 *   - the measurable weight beside every score, repeated inside the file
 *     because the file outlives the page that explained it;
 *   - only the columns on `PLACEMENT_EXPORT_COLUMNS`, which throws rather
 *     than filters — a silent filter would turn a request for a forbidden
 *     column into a file that merely lacked it, and nobody would learn that
 *     something tried.
 */

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requirePlacementAction();

    const form = await request.formData();
    const filter = parseCohortFilter({
      dept: String(form.get("dept") ?? ""),
      batch: String(form.get("batch") ?? ""),
      section: String(form.get("section") ?? ""),
    });
    const asked = form.getAll("column").map(String).filter(Boolean);
    const columns = asked.length > 0 ? asked : PLACEMENT_EXPORT_COLUMNS.map((column) => column.key);
    // Throws on anything off the allowlist, which `toErrorResponse` turns
    // into a 400 naming the column.
    assertExportColumns(columns);

    const computedOn = await latestRunDay();
    const rows: PlacementExportRow[] = computedOn ? await buildExportRows(computedOn, filter) : [];

    const requestedAt = new Date();
    /**
     * The id is minted here rather than taken from the created row, because
     * the FILE has to name it and the row has to carry the digest OF that
     * file. One of the two has to come first, and the file is the thing a
     * human ends up holding.
     */
    const exportId = `pex_${createHash("sha256")
      .update(`${actor.id}:${requestedAt.toISOString()}:${rows.length}`)
      .digest("hex")
      .slice(0, 24)}`;

    const body =
      placementCsvProvenance({
        exportId,
        requestedBy: actor.collegeId,
        requestedAt: formatCampusTime(requestedAt),
        computedOn,
        rowCount: rows.length,
      }) +
      placementCsvHeader(columns) +
      rows.map((row) => placementCsvRow(row, columns)).join("");

    const sha256 = createHash("sha256").update(body, "utf8").digest("hex");

    await db.placementExport.create({
      data: {
        id: exportId,
        requestedById: actor.id,
        requestedAt,
        filters: { ...filter, describes: describeCohort(filter) },
        columns,
        rowCount: rows.length,
        computedOn: computedOn ? campusDayDate(new Date(`${computedOn}T00:00:00.000Z`)) : null,
        sha256,
      },
    });

    await audit({
      actorId: actor.id,
      action: "placement.export",
      entityType: "PlacementExport",
      entityId: exportId,
      sensitivity: "SENSITIVE",
      metadata: { rowCount: rows.length, columns: columns.length, cohort: describeCohort(filter) },
      ipHash: await requestIpHash(),
    });

    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="recx-placement-${exportId}.csv"`,
        // Never cached, by anything: the file names a person and a cohort.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    /**
     * `assertExportColumns` throws a plain Error for a column off the
     * allowlist, and its message names the column — which is the whole point
     * of throwing rather than filtering, so it is returned rather than
     * swallowed into "something went wrong". Everything else is logged and
     * generalised, because an unexpected failure here is a failure while
     * assembling a file about students.
     */
    if (error instanceof AppError) {
      return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    }
    if (error instanceof Error && error.message.startsWith("Not exportable")) {
      return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
    }
    console.error("[placement] export failed:", error);
    return Response.json({ error: "The export could not be built." }, { status: 500, headers: NO_STORE });
  }
}

const NO_STORE = { "cache-control": "no-store" } as const;
