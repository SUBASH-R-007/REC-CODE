import { cookies } from "next/headers";
import {
  EXAM_HEARTBEAT_INTERVAL_MS,
  examHeartbeatRequestSchema,
  examHeartbeatResponseSchema,
} from "@recx/shared";
import { requireActionUser } from "@/lib/auth/guards";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session-token";
import { AppError } from "@/lib/errors";
import { db } from "@/lib/db";
import { endAttemptSession, guardAttempt } from "@/lib/exam/attempt";
import { applyHeartbeat } from "@/lib/exam/heartbeat";
import { hashUserAgent, requestIpHash } from "@/lib/ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exam/[attemptId]/hb — the exam heartbeat (Phase 6b).
 *
 * SPEC §5: "Heartbeat POST /api/exam/[attemptId]/hb every 10s returns
 * { serverNow, msRemaining, pendingInvigilatorMessages, revokeReason? }. The
 * client renders msRemaining and never consults local Date.now() for
 * anything authoritative."
 *
 * So this route is the candidate's clock. It answers with the server's time
 * and the server's remaining milliseconds on every beat, which is why the
 * exam surface (Phase 6c) can render a countdown without ever trusting the
 * machine it is running on.
 *
 * It always answers 200 with a body the client can render — including when it
 * turns the client away. A heartbeat that 403s leaves a candidate staring at
 * a frozen timer with no explanation; a 200 carrying
 * `revokeReason: "expired"` and `msRemaining: 0` tells them what happened.
 * The one exception is an unauthenticated or malformed request, which is not
 * a candidate mid-exam and gets the ordinary status code.
 */

const noStore = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}

/**
 * The id of the session this request arrived on. The attempt is pinned to it
 * (`lockSessionId`), so the guard can tell a resume from a second live
 * client. Null when there is no usable session cookie.
 */
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

  // The shared action guard, which also refuses while a super-admin is
  // viewing as someone else: a heartbeat writes to the sitting it beats at,
  // and there is nothing sensible for an impersonated session to beat at.
  let user;
  try {
    user = await requireActionUser();
  } catch (error) {
    // The guard's own message and status: 401 when signed out, 403 while a
    // super-admin is viewing as someone else. Not reworded here, so the
    // sentence a candidate sees is the same one every other route gives.
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Malformed heartbeat." }, 400);
  }
  const parsed = examHeartbeatRequestSchema.safeParse(body);
  if (!parsed.success) return json({ error: "Malformed heartbeat." }, 400);

  const sessionId = await currentSessionId();
  const guard = await guardAttempt({ request, attemptId, userId: user.id, sessionId });

  if (!guard.ok) {
    await endAttemptSession(attemptId, guard.reason);
    return json(
      examHeartbeatResponseSchema.parse({
        serverNow: guard.now.toISOString(),
        msRemaining: 0,
        status: guard.attempt?.status ?? "NOT_STARTED",
        pendingInvigilatorMessages: [],
        revokeReason: guard.reason,
        nextHeartbeatMs: EXAM_HEARTBEAT_INTERVAL_MS,
      }),
    );
  }

  const outcome = await applyHeartbeat(guard, parsed.data, {
    ipHash: await requestIpHash(),
    uaHash: (() => {
      const ua = request.headers.get("user-agent");
      return ua ? hashUserAgent(ua) : null;
    })(),
  });

  return json(
    examHeartbeatResponseSchema.parse({
      serverNow: outcome.serverNow.toISOString(),
      msRemaining: outcome.msRemaining,
      status: outcome.status,
      // Phase 6e fills this from the invigilator desk. The field is in the
      // contract from the first beat so the client never has to change.
      pendingInvigilatorMessages: [],
      revokeReason: null,
      nextHeartbeatMs: outcome.nextHeartbeatMs,
    }),
  );
}
