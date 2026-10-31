import { requireMentorAction } from "@/lib/auth/guards";
import { AppError } from "@/lib/errors";
import { mirrorFor } from "@/server/queries/mock-interviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/mock/[interviewId]/live` — the candidate's editor, to the
 * interviewer, over Server-Sent Events (Phase 12h).
 *
 * The transport and the shape copy the invigilation dashboard: a periodic
 * indexed read rather than a pub/sub fan-out, and a frame only when
 * something changed. One viewer, one row, every two seconds costs nothing
 * and keeps the candidate's hot path — typing — entirely free of it.
 *
 * The ACTION guard rather than the page one, for the reason that route
 * records: a page guard redirects, and an EventSource can do nothing with
 * a 307. Who may read is decided in `mirrorFor`, which answers only for
 * the interview's own mentor and only while it is running.
 */

const POLL_MS = 2_000;
const PING_MS = 15_000;
const MAX_STREAM_MS = 10 * 60_000;

export async function GET(request: Request, context: { params: Promise<{ interviewId: string }> }) {
  const { interviewId } = await context.params;

  let viewer;
  try {
    // The mentor ROLE first, then the per-interview ownership check in
    // `mirrorFor`. Either alone would do the job; both because this is the
    // one route in the product that shows one student's draft code to
    // somebody else, and the capability registry is entitled to see a role
    // guard on it rather than a promise that the body checks.
    viewer = await requireMentorAction();
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
    }
    throw error;
  }

  const first = await mirrorFor(viewer.id, interviewId);
  if (!first.ok) {
    return Response.json({ error: first.error }, { status: first.status, headers: { "cache-control": "no-store" } });
  }

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (view: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(view)}\n\n`));
      const stop = () => {
        if (timer) clearInterval(timer);
        if (ping) clearInterval(ping);
        if (deadline) clearTimeout(deadline);
        timer = ping = null;
        deadline = null;
        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      };

      send(first.view);
      let last = JSON.stringify(first.view);

      timer = setInterval(() => {
        void mirrorFor(viewer.id, interviewId)
          .then((next) => {
            // The interview ended, or the viewer stopped being allowed to
            // watch it. Either way the mirror is over.
            if (!next.ok) {
              send({ ended: true });
              stop();
              return;
            }
            const signature = JSON.stringify(next.view);
            if (signature === last) return;
            last = signature;
            send(next.view);
          })
          .catch((error: unknown) => {
            console.warn(`[mock] mirror ${interviewId} read failed`, error);
          });
      }, POLL_MS);

      ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          stop();
        }
      }, PING_MS);

      deadline = setTimeout(stop, MAX_STREAM_MS);
      request.signal.addEventListener("abort", stop);
    },
    cancel() {
      if (timer) clearInterval(timer);
      if (ping) clearInterval(ping);
      if (deadline) clearTimeout(deadline);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
