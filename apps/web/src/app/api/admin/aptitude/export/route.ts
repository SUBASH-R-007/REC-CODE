import { isAptitudeArea } from "@recx/shared";
import { requireActionRole } from "@/lib/auth/guards";
import { audit } from "@/lib/audit";
import { AppError } from "@/lib/errors";
import { aptitudeExportCsv } from "@/server/queries/admin-aptitude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/aptitude/export — the question bank as a CSV.
 *
 * It carries the ANSWER KEY and the worked explanations. That is deliberate
 * (`docs/OPEN-QUESTIONS.md`): a bank with the keys stripped is not a bank a
 * faculty member can review, and the whole point of the export is that it
 * re-imports, so a reviewer can open it, correct a stem and upload it back.
 *
 * Which makes it the one artefact that must never reach a student mailbox.
 * So: ADMIN / SUPER_ADMIN only, same-origin, `audit()` on every download
 * BEFORE a byte is streamed, and `Content-Disposition: attachment` so a
 * browser never renders it inline. There is no student-facing export at all.
 *
 * Streamed rather than buffered: 2,000 questions with worked explanations is
 * several megabytes, and holding it in memory to send it would be the one
 * place this product reads an unbounded table into a response.
 */

export async function GET(request: Request): Promise<Response> {
  let actorId: string;
  try {
    const actor = await requireActionRole("ADMIN", "SUPER_ADMIN");
    actorId = actor.id;
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
    }
    throw error;
  }

  const url = new URL(request.url);
  const areaParam = url.searchParams.get("area");
  if (areaParam !== null && !isAptitudeArea(areaParam)) {
    return Response.json({ error: "That is not an area." }, { status: 400 });
  }
  const statusParam = url.searchParams.get("status");

  // Audited BEFORE the stream opens: a download that failed halfway still
  // happened, and "who took the answer keys" is the question this record
  // exists to answer.
  await audit({
    actorId,
    action: "aptitude.export.downloaded",
    entityType: "AptitudeQuestion",
    sensitivity: "SENSITIVE",
    metadata: {
      area: areaParam,
      status: statusParam,
      note: "This file carries the answer key and the worked explanations.",
    },
  });

  const rows = aptitudeExportCsv({
    ...(areaParam === null ? {} : { area: areaParam }),
    ...(statusParam === null ? {} : { status: statusParam }),
  });
  const encoder = new TextEncoder();

  /**
   * The first chunks are pulled HERE, before the Response exists.
   *
   * A database failure inside a stream that has already been returned is an
   * unhandled rejection and a half-written file on somebody's disk — a
   * truncated answer bank that looks complete. Priming turns the common case
   * (the query fails at once) into an honest 500, and the capability matrix
   * found it: its stubbed database threw from inside `pull` and the rejection
   * escaped the handler entirely.
   */
  const primed: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const next = await rows.next();
      if (next.done) break;
      primed.push(next.value);
    }
  } catch (error) {
    console.error("[aptitude-export] the query failed before streaming", error);
    return Response.json(
      { error: "The export could not be prepared. Nothing was downloaded." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const buffered = primed.shift();
        if (buffered !== undefined) {
          controller.enqueue(encoder.encode(buffered));
          return;
        }
        const next = await rows.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        // Error the stream rather than close it: a truncated CSV that ends
        // cleanly is a bank somebody would trust.
        console.error("[aptitude-export] the query failed mid-stream", error);
        controller.error(error);
      }
    },
    async cancel() {
      await rows.return(undefined);
    },
  });

  const today = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      // Never inline: a browser rendering this would put an answer key on a
      // screen somebody might be sharing.
      "content-disposition": `attachment; filename="aptitude-bank-${today}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
