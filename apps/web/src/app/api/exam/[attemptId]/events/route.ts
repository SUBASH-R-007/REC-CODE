import { cookies } from "next/headers";
import {
  EVENT_PAYLOAD_MAX_BYTES,
  proctorEventBatchResponseSchema,
  proctorEventBatchSchema,
} from "@recx/shared";
import { requireActionUser } from "@/lib/auth/guards";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session-token";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { autoSubmitOnFocusLimit, endAttemptSession, guardAttempt } from "@/lib/exam/attempt";
import { ingestProctorEvents } from "@/lib/exam/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exam/[attemptId]/events — client telemetry (Phase 6c).
 *
 * The exam client flushes here on a 5-second tick, on the 25th event, and via
 * `navigator.sendBeacon` when the page is going away. SPEC §5 bounds the
 * payload: "Payloads ≤32 KB; reject >64 KB with 413."
 *
 * The response is what makes the covering overlay honest. SPEC §5: "Write the
 * ProctorEvent server-side before the overlay becomes dismissible." The
 * client therefore cannot compose its own warning text or decide its own
 * warning number — both come back from here, after the row is committed.
 *
 * A beacon's response is never read by the browser, so the status codes here
 * are for the keepalive-fetch path, the tests and the logs.
 */

const noStore = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}

/**
 * Read at most `limit` bytes; null when the body is larger. Checked by
 * streaming rather than trusting `content-length`, which a client sets.
 */
async function readBounded(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function currentSessionId(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    select: { id: true },
  });
  return session?.id ?? null;
}

export async function POST(request: Request, context: { params: Promise<{ attemptId: string }> }) {
  const { attemptId } = await context.params;

  let user;
  try {
    user = await requireActionUser();
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    throw error;
  }

  // Size before shape: a 10 MB body should cost a 413, not a parse.
  const raw = await readBounded(request, EVENT_PAYLOAD_MAX_BYTES);
  if (raw === null) {
    return json({ error: `Telemetry payloads are limited to ${EVENT_PAYLOAD_MAX_BYTES} bytes.` }, 413);
  }

  let parsedJson: unknown;
  try {
    // text/plain from sendBeacon, application/json from fetch — both arrive
    // as the same JSON envelope.
    parsedJson = JSON.parse(raw);
  } catch {
    return json({ error: "Malformed telemetry batch." }, 400);
  }
  const batch = proctorEventBatchSchema.safeParse(parsedJson);
  if (!batch.success) return json({ error: "Malformed telemetry batch." }, 400);

  const sessionId = await currentSessionId();
  const guard = await guardAttempt({ request, attemptId, userId: user.id, sessionId });
  if (!guard.ok) {
    await endAttemptSession(attemptId, guard.reason);
    // 409: the events are real but there is no live sitting to attach them
    // to. Distinct from a 403 so the client stops flushing rather than
    // retrying, and carries the reason so it can show the right screen.
    return json({ error: guard.message, revokeReason: guard.reason }, 409);
  }

  const assessment = await db.assessment.findUniqueOrThrow({
    where: { id: guard.attempt.assessmentId },
    select: { maxFocusWarnings: true, onLimit: true },
  });

  const result = await ingestProctorEvents(guard, batch.data.events, assessment);

  // Only after the rows are committed, and only when the policy says so.
  if (result.autoSubmit) {
    const submitted = await autoSubmitOnFocusLimit({
      attemptId: guard.attempt.id,
      userId: guard.attempt.userId,
      warnings: result.focusWarning?.warningNumber ?? 0,
      maxWarnings: result.focusWarning?.maxWarnings ?? 0,
      now: guard.now,
    });
    if (submitted) await endAttemptSession(attemptId, "submitted");
  }

  return json(
    proctorEventBatchResponseSchema.parse({
      accepted: result.accepted,
      dropped: result.dropped,
      focusWarning: result.focusWarning,
      aggregatesOnly: result.aggregatesOnly,
    }),
  );
}
