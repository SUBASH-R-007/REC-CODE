import { NextResponse } from "next/server";
import { SNAPSHOT_MAX_BYTES } from "@recx/shared";
import { requireActionUser } from "@/lib/auth/guards";
import { AppError } from "@/lib/errors";
import { MAX_JSON_BYTES, readJsonBody } from "@/lib/http/body";
import { pushSnapshotAs } from "@/lib/mock/interviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/mock/[interviewId]/snapshot` — the candidate's editor, as the
 * interviewer sees it (Phase 12h).
 *
 * A route handler rather than a server action because it fires every few
 * seconds from a `setInterval` and on `visibilitychange`: an action would
 * drag the whole RSC round trip along with it, and the payload is one
 * string.
 *
 * Everything that decides whether this is allowed is in
 * `pushSnapshotAs` — the caller must BE the candidate and the interview
 * must BE running. A mirror that kept accepting writes after the end would
 * be a channel nobody is watching and nobody closed.
 */
export async function POST(request: Request, context: { params: Promise<{ interviewId: string }> }): Promise<Response> {
  const { interviewId } = await context.params;
  try {
    const user = await requireActionUser();
    // The editor's contents, so the cap is the one that already bounds
    // a snapshot, with room for the JSON around it. Before Phase 17's
    // audit this read whatever arrived, every few seconds, from every
    // candidate in a mock interview.
    const read = await readJsonBody(request, SNAPSHOT_MAX_BYTES + MAX_JSON_BYTES);
    if (!read.ok) return NextResponse.json({ error: read.message }, { status: read.status });
    await pushSnapshotAs(user.id, interviewId, read.value);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "That is not JSON." }, { status: 400 });
    throw error;
  }
}
