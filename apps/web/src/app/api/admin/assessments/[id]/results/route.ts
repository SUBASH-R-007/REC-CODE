import { csvCell, formatMarks } from "@recx/shared";
import { audit } from "@/lib/audit";
import { requireAdminScopeAction } from "@/lib/auth/scope";
import { isEmptyScope } from "@/lib/auth/scope-where";
import { AppError } from "@/lib/errors";
import { db } from "@/lib/db";
import { getAssessmentResults } from "@/server/queries/admin-assessment-results";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/assessments/[id]/results — the marks as a CSV (Phase 12y.4).
 *
 * A department marks a paper and then has to do something with the marks:
 * paste them into the university's own system, mail them to a head of
 * department, keep them with the question paper. Until this route the only
 * way off the screen was the clipboard.
 *
 * Three things make it safe to hand out:
 *
 *   - **Scoped.** The rows are `getAssessmentResults(scope, id)`, the same
 *     read the page uses, so an ADMIN with one department exports one
 *     department. A file is the easiest thing in the world to forward, and
 *     a scope that held on screen and not in the export would be worse
 *     than no scope at all.
 *   - **Audited before a byte is written.** "Who took the marks, and when"
 *     is the question this record answers, and a download that failed
 *     halfway still happened.
 *   - **Provenance in the file.** The first line names the paper, the
 *     person who pulled it and the moment, the way the placement export
 *     does — so a spreadsheet found on a shared drive in March can still
 *     say where it came from.
 *
 * What it does NOT carry: any integrity band, score or verdict. Those are
 * `/admin/integrity`'s, where a person decides with the reasoning beside
 * them; in a spreadsheet column next to a mark they would be read as part
 * of the mark. The watched COUNTS are here, because they are facts about
 * the sitting and an examiner asked for them.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  let actorId: string;
  let actorLabel: string;
  let scope: Awaited<ReturnType<typeof requireAdminScopeAction>>["scope"];
  try {
    const guard = await requireAdminScopeAction();
    actorId = guard.user.id;
    // A roll number and a name, not a cuid: the provenance line is read by
    // a person six months later, on a spreadsheet found on a shared drive.
    actorLabel = `${guard.user.collegeId} (${guard.user.firstName} ${guard.user.lastName})`.trim();
    scope = guard.scope;
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
    }
    throw error;
  }

  const { id } = await context.params;
  const paper = await db.assessment.findUnique({ where: { id }, select: { slug: true, title: true } });
  if (!paper) return Response.json({ error: "That assessment was not found." }, { status: 404 });

  if (isEmptyScope(scope)) {
    return Response.json(
      { error: "You have no student scope, so there is nothing to export. Ask a super-admin for a grant." },
      { status: 403 },
    );
  }

  const results = await getAssessmentResults(scope, id);

  await audit({
    actorId,
    action: "assessment.results.exported",
    entityType: "Assessment",
    entityId: id,
    sensitivity: "SENSITIVE",
    metadata: { slug: paper.slug, rows: results.rows.length, maxPoints: results.maxPoints },
  });

  const at = new Date().toISOString();
  const header = [
    "roll_number",
    "name",
    "department",
    "batch",
    "attempt",
    "status",
    "started_at",
    "submitted_at",
    "hall",
    "seat",
    "marks",
    "out_of",
    "percent",
    "provisional",
    "mcq_right",
    "mcq_wrong",
    "mcq_blank",
    "code_accepted",
    "code_partial",
    "code_rejected",
    "code_blank",
    "code_open",
    "tab_switches",
    "fullscreen_exits",
    "pastes",
    "longest_gap_seconds",
  ];

  const lines = [
    // Provenance first, as the placement export does: a file on a shared
    // drive in March can still say where it came from.
    `# REC Code · ${paper.title} (${paper.slug}) · exported ${at} by ${actorLabel} · ${results.rows.length} candidates in scope`,
    header.join(","),
    ...results.rows.map((row) =>
      [
        row.collegeId,
        row.name,
        row.departmentCode ?? "",
        row.batchYear ?? "",
        row.attemptNumber,
        row.status,
        row.startedAt.toISOString(),
        row.submittedAt?.toISOString() ?? "",
        row.hall ?? "",
        row.seatLabel ?? "",
        row.result ? formatMarks(row.result.points) : "",
        row.result ? formatMarks(row.result.maxPoints) : "",
        row.result?.percent === null || row.result === null ? "" : Math.round(row.result.percent),
        row.result === null ? "" : row.result.provisional ? "yes" : "no",
        row.result?.mcq.correct ?? "",
        row.result?.mcq.wrong ?? "",
        row.result?.mcq.blank ?? "",
        row.result?.coding.accepted ?? "",
        row.result?.coding.partial ?? "",
        row.result?.coding.rejected ?? "",
        row.result?.coding.blank ?? "",
        row.result === null ? "" : row.result.coding.pending + row.result.coding.unjudged,
        row.watched.focusLosses,
        row.watched.fullscreenExits,
        row.watched.pastes,
        row.watched.longestGapSeconds,
      ]
        .map(csvCell)
        .join(","),
    ),
  ];

  const filename = `recx-results-${paper.slug}-${at.slice(0, 10)}.csv`;
  return new Response(`${lines.join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
