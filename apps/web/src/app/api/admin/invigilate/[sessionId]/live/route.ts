import { requireActionRole } from "@/lib/auth/guards";
import { AppError } from "@/lib/errors";
import { getHallView } from "@/server/queries/admin-invigilator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/invigilate/[sessionId]/live — the hall, over Server-Sent
 * Events (Phase 6e).
 *
 * Under /api/admin, not /api/exam, because it reads
 * `server/queries/admin-invigilator.ts` — and the `admin-` prefix marks a
 * module only admin code may reach (docs/CONVENTIONS.md, "Sensitive paths",
 * enforced by tests/repo/student-exposure.test.ts R4/R5). Moving the route
 * rather than exempting it is the honest fix: this IS an administrator's API.
 *
 * SPEC §5 asks for "the invigilator dashboard and its SSE". The transport is
 * SSE; the SOURCE is a periodic read of Postgres rather than Redis pub/sub,
 * and that is a deliberate departure from how `/api/submissions/[id]/stream`
 * works.
 *
 * The reason is the heartbeat. Publishing each one to Redis so a dashboard
 * could subscribe would be 5,000 candidates ÷ 10 seconds = 500 publishes a
 * second during a college-wide sitting, on the hot path of the one request
 * that must never be slow — and a dashboard with maybe two viewers would be
 * the only subscriber. Reading the hall every few seconds costs one indexed
 * query per viewer and nothing at all per candidate.
 *
 * The clock in every frame is the SERVER's. An invigilator's screen never
 * computes a candidate's remaining time, for the same reason the candidate's
 * own screen does not.
 */

/** How often the hall is re-read. Faster than this buys nothing: the
 *  candidates' own heartbeats are 10 seconds apart. */
const POLL_MS = 3_000;
/** A comment line, so a proxy does not close an idle stream. */
const PING_MS = 15_000;
/** Hard lifetime; the browser's EventSource reconnects on its own. */
const MAX_STREAM_MS = 10 * 60_000;

export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await context.params;
  // Staff only, and the ACTION guard rather than the page one: a page guard
  // redirects, and a route handler that redirects instead of answering gives
  // an EventSource a 307 it cannot do anything with. Caught by the live
  // canary sweep, which calls every route as a student.
  try {
    await requireActionRole("ADMIN", "SUPER_ADMIN");
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
    }
    throw error;
  }

  const first = await getHallView(sessionId);
  if (!first) {
    return Response.json({ error: "That exam session was not found." }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (view: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(view)}\n\n`));
      };
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

      send(first);

      // Only send a frame when something a viewer can see has changed. A hall
      // of 60 candidates sitting quietly should not stream 20 identical
      // frames a minute to every invigilator watching it.
      let lastSignature = signatureOf(first);

      timer = setInterval(() => {
        void getHallView(sessionId)
          .then((view) => {
            if (!view) {
              stop();
              return;
            }
            const signature = signatureOf(view);
            if (signature === lastSignature) return;
            lastSignature = signature;
            send(view);
          })
          .catch((error: unknown) => {
            // A dropped read is not worth ending the stream over; the next
            // tick retries and the dashboard shows its own staleness.
            console.warn(`[invigilate] hall ${sessionId} read failed`, error);
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
      // Caddy and nginx both buffer SSE without this.
      "x-accel-buffering": "no",
    },
  });
}

/**
 * What counts as "changed". Deliberately coarse: the clock ticks every
 * second and is not worth a frame, so remaining time is bucketed to ten
 * seconds — which is also the candidates' own heartbeat interval, so no
 * genuine change is ever more than one bucket late.
 */
function signatureOf(view: Awaited<ReturnType<typeof getHallView>>): string {
  if (!view) return "";
  return view.candidates
    .map((candidate) =>
      [
        candidate.attemptId,
        candidate.status,
        candidate.presence,
        Math.floor(candidate.msRemaining / 10_000),
        candidate.counts.focusLosses,
        candidate.counts.fullscreenExits,
        candidate.counts.pastes,
        candidate.pendingMessages,
        candidate.terminationPending ? 1 : 0,
        candidate.pausedMs,
      ].join(":"),
    )
    .join("|");
}
