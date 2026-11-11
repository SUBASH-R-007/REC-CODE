import { NextResponse } from "next/server";
import { requireActionUser } from "@/lib/auth/guards";
import { AppError } from "@/lib/errors";
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
    await pushSnapshotAs(user.id, interviewId, await request.json());
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof AppError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "That is not JSON." }, { status: 400 });
    throw error;
  }
}
