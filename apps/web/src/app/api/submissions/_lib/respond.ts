import "server-only";
import type { Redis } from "ioredis";
import { z } from "zod";
import { progressChannel, progressEventSchema, type JobKind } from "@recx/shared";

/** Students follow submissions and runs; validation jobs are authoring-only. */
type ViewableKind = Exclude<JobKind, "validation">;
import { getCurrentUser } from "@/lib/auth/session";
import type { StudentView } from "@/lib/judge/view";
import { newSubscriber } from "@/lib/redis";
import { getStudentView, type Viewer } from "@/server/queries/submissions";

/**
 * Shared by /api/submissions/[id](/stream) and /api/runs/[id](/stream): the
 * browser's read side of a judge job. The owner, a SUPER_ADMIN, or an ADMIN
 * whose scope covers the owner (canView); a row the viewer may not see is
 * indistinguishable from a missing one (404).
 * Everything returned is the student view (src/lib/judge/view.ts).
 */

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/** SSE keep-alive comment interval and the stream's hard lifetime. */
const PING_MS = 15_000;
const MAX_STREAM_MS = 5 * 60_000;
const REDIS_READY_TIMEOUT_MS = 3_000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

type Resolved =
  | { ok: true; viewer: Viewer; id: string; view: StudentView }
  | { ok: false; response: Response };

async function resolve(kind: ViewableKind, rawId: string): Promise<Resolved> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, response: json({ error: "Sign in to see this result." }, 401) };
  const id = idSchema.safeParse(rawId);
  if (!id.success) return { ok: false, response: json({ error: "Not found." }, 404) };
  const viewer: Viewer = { id: user.id, role: user.role };
  const view = await getStudentView(kind, id.data, viewer);
  if (!view) return { ok: false, response: json({ error: "Not found." }, 404) };
  return { ok: true, viewer, id: id.data, view };
}

/** GET …/[id] — the current student view as JSON (the polling fallback). */
export async function viewResponse(kind: ViewableKind, rawId: string): Promise<Response> {
  const resolved = await resolve(kind, rawId);
  return resolved.ok ? json(resolved.view) : resolved.response;
}

/** Resolve once the subscriber connection is usable, or reject (Redis down). */
function whenReady(client: Redis, timeoutMs: number): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const done = (error?: Error) => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
      if (error) reject(error);
      else resolvePromise();
    };
    const onReady = () => done();
    const onError = (error: Error) => done(error);
    const timer = setTimeout(() => done(new Error("Redis subscriber not ready")), timeoutMs);
    client.once("ready", onReady);
    client.once("error", onError);
  });
}

/**
 * GET …/[id]/stream — Server-Sent Events.
 *
 *   event: snapshot   the student view (always first)
 *   event: progress   a worker {type:"state"} / {type:"test"} event
 *   event: done       the last snapshot was terminal; the server closes
 *
 * Progress comes from Redis pub/sub (never a DB row per test). On the web
 * app's {type:"final"} (published after the result is committed) the row is
 * re-read and sent as the final snapshot. If Redis is unavailable the
 * snapshot is sent and the stream closes — the client polls instead.
 */
export async function streamResponse(request: Request, kind: ViewableKind, rawId: string): Promise<Response> {
  const resolved = await resolve(kind, rawId);
  if (!resolved.ok) return resolved.response;
  const { viewer, id, view: initial } = resolved;

  const encoder = new TextEncoder();
  let closed = false;
  let subscriber: Redis | null = null;
  let ping: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (ping) clearInterval(ping);
    if (lifetime) clearTimeout(lifetime);
    if (onAbort) request.signal.removeEventListener("abort", onAbort);
    if (subscriber) {
      subscriber.removeAllListeners("message");
      subscriber.disconnect();
      subscriber = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const close = () => {
        if (closed) return;
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      /** Re-read the row; send it; finish if terminal. */
      const refresh = async () => {
        const view = await getStudentView(kind, id, viewer).catch(() => null);
        if (closed) return;
        if (!view) return close();
        send("snapshot", view);
        if (view.terminal) {
          send("done", {});
          close();
        }
      };

      send("snapshot", initial);
      if (initial.terminal) {
        send("done", {});
        return close();
      }

      if (request.signal.aborted) return close();
      onAbort = close;
      request.signal.addEventListener("abort", onAbort);
      ping = setInterval(() => write(": ping\n\n"), PING_MS);
      lifetime = setTimeout(close, MAX_STREAM_MS);

      try {
        const sub = newSubscriber();
        subscriber = sub;
        await whenReady(sub, REDIS_READY_TIMEOUT_MS);
        if (closed) return;
        let finishing = false;
        sub.on("message", (_channel: string, raw: string) => {
          if (closed) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return;
          }
          const event = progressEventSchema.safeParse(parsed);
          if (!event.success) return;
          if (event.data.type === "final") {
            if (finishing) return;
            finishing = true;
            void refresh().finally(() => {
              finishing = false;
            });
            return;
          }
          send("progress", event.data);
        });
        await sub.subscribe(progressChannel(kind, id));
      } catch {
        // Redis is unavailable: the snapshot is out, the client polls.
        return close();
      }
      if (closed) return;
      // Close the gap between the first read and SUBSCRIBE: a result that
      // landed in between would otherwise never be announced.
      await refresh();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
