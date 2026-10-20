import { cookies } from "next/headers";
import { z } from "zod";
import { LANGUAGE_CATALOG, SNAPSHOT_MAX_BYTES } from "@recx/shared";
import { requireActionUser } from "@/lib/auth/guards";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session-token";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { endAttemptSession, guardAttempt } from "@/lib/exam/attempt";
import { writeSnapshot } from "@/lib/exam/snapshots";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exam/[attemptId]/snapshot — one editor snapshot (Phase 6c).
 *
 * SPEC §5: "Every 30s while dirty, plus on every run and submit." The client
 * also writes ahead to IndexedDB BEFORE calling this, so a snapshot that
 * never reaches the server is not work the candidate has lost — which is
 * what lets the save-state pill tell the truth instead of hiding a failure.
 *
 * The response is what the pill renders, so it says plainly whether the
 * snapshot was stored and, if not, why: an unchanged file, one over the
 * size limit, or an attempt that has spent its snapshot budget. "Saved" when
 * nothing was saved is the one thing this must never say.
 */

const noStore = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}

const LANGUAGE_IDS = Object.keys(LANGUAGE_CATALOG) as [string, ...string[]];

const bodySchema = z
  .object({
    /** The AssessmentProblem this editor belongs to. */
    questionId: z.string().min(1).max(64),
    language: z.enum(LANGUAGE_IDS),
    /** The editor's whole text. Bounded here and again by the writer. */
    source: z.string().max(SNAPSHOT_MAX_BYTES),
    trigger: z.enum(["TICK", "RUN", "SUBMIT", "PASTE"]),
    atMs: z.number().int().min(0),
  })
  .strict();

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

/** The envelope, not the source, is what the extra headroom is for. */
const MAX_REQUEST_BYTES = SNAPSHOT_MAX_BYTES + 4 * 1024;

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
  if (raw === null) {
    return json({ error: `A snapshot is limited to ${SNAPSHOT_MAX_BYTES} bytes.` }, 413);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return json({ error: "Malformed snapshot." }, 400);
  }
  const body = bodySchema.safeParse(parsedJson);
  if (!body.success) return json({ error: "Malformed snapshot." }, 400);

  const sessionId = await currentSessionId();
  const guard = await guardAttempt({ request, attemptId, userId: user.id, sessionId });
  if (!guard.ok) {
    await endAttemptSession(attemptId, guard.reason);
    // 409, as for telemetry: the work is real but there is no live sitting to
    // attach it to, and the client should stop rather than retry.
    return json({ error: guard.message, revokeReason: guard.reason }, 409);
  }

  // The question must belong to this candidate's assessment. Without this a
  // candidate could file snapshots against somebody else's paper.
  const question = await db.assessmentProblem.findFirst({
    where: { id: body.data.questionId, assessmentId: guard.attempt.assessmentId },
    select: { id: true },
  });
  if (!question) return json({ error: "That question is not part of this assessment." }, 404);

  const result = await writeSnapshot(guard, body.data);
  return json({
    stored: result.stored,
    reason: result.reason ?? null,
    contentHash: result.contentHash,
    count: result.count,
  });
}
