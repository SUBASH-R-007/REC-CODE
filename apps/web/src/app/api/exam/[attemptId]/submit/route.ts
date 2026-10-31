import { cookies } from "next/headers";
import { z } from "zod";
import { LANGUAGE_CATALOG, SNAPSHOT_MAX_BYTES } from "@recx/shared";
import { requireActionUser } from "@/lib/auth/guards";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session-token";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { endAttemptSession, guardAttempt } from "@/lib/exam/attempt";
import { attemptLayoutOf } from "@/lib/exam/layout";
import { submitAttempt } from "@/lib/exam/submit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exam/[attemptId]/submit — the candidate submits (Phase 6c).
 *
 * A route rather than a server action because it carries every answer at
 * once, can be several hundred kilobytes, and must be refused by size before
 * anything is parsed. It also needs the attempt guard, which is
 * request-shaped (the attempt token arrives in a header or a path-scoped
 * cookie).
 *
 * Under /api/exam/ with the heartbeat, the telemetry and the snapshots, for
 * two reasons: `/api` is already in the service worker's bypass list, and
 * `tests/repo`/`capabilities.test.ts` REQUIRES every mutating route under
 * `app/api/` to be bound to a capability and to call a guard. An earlier
 * draft of this route sat under `app/(exam)/…`, where it was a mutating POST
 * that no fence required to be bound — the kind of hole that is invisible
 * until someone goes looking.
 */

const noStore = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}

const LANGUAGE_IDS = Object.keys(LANGUAGE_CATALOG) as [string, ...string[]];

const bodySchema = z
  .object({
    answers: z
      .array(
        z
          .object({
            questionId: z.string().min(1).max(64),
            language: z.enum(LANGUAGE_IDS),
            source: z.string().max(SNAPSHOT_MAX_BYTES),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

/** Every answer, plus the envelope. Refused by size before it is parsed. */
const MAX_REQUEST_BYTES = 200 * SNAPSHOT_MAX_BYTES;

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

  const raw = await readBounded(request, MAX_REQUEST_BYTES);
  if (raw === null) return json({ error: "That submission is too large." }, 413);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return json({ error: "Malformed submission." }, 400);
  }
  const body = bodySchema.safeParse(parsedJson);
  if (!body.success) return json({ error: "Malformed submission." }, 400);

  const sessionId = await currentSessionId();
  const guard = await guardAttempt({ request, attemptId, userId: user.id, sessionId });
  if (!guard.ok) {
    await endAttemptSession(attemptId, guard.reason);
    // Already over — by the deadline, the focus limit, or another tab. The
    // candidate's work up to that point is already recorded; this is not a
    // loss, and the client shows the finished screen.
    return json({ error: guard.message, revokeReason: guard.reason }, 409);
  }

  // Only questions that are actually on this candidate's paper.
  const layout = attemptLayoutOf(guard.attempt);
  const onPaper = new Set(layout.questions.map((question) => question.questionId));
  const answers = body.data.answers.filter((answer) => onPaper.has(answer.questionId));

  const result = await submitAttempt(guard, layout, answers);
  if (!result.submitted) {
    return json({ error: "This sitting is already finished.", revokeReason: "submitted" }, 409);
  }
  await endAttemptSession(attemptId, "submitted");

  return json({ submitted: true, submissions: result.submissionIds.length, blank: result.blank });
}
