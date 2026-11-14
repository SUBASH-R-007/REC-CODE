import { cookies } from "next/headers";
import { z } from "zod";
import { requireActionUser } from "@/lib/auth/guards";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session-token";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { readJsonBody } from "@/lib/http/body";
import { endAttemptSession, guardAttempt } from "@/lib/exam/attempt";
import { attemptLayoutOf } from "@/lib/exam/layout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exam/[attemptId]/mcq — record one multiple-choice answer
 * (Phase 12r).
 *
 * The whole of "save and next" for an MCQ. There is no judge in this path
 * and nothing to compile: the answer is an index, and the marking is a
 * comparison made at submit time (`@recx/shared/exam-mcq`).
 *
 * `chosenIndex` is a position in the order THIS candidate was shown, which
 * their layout records. That is the only index a browser is in a position
 * to report honestly: the author's order is never sent to it, so it cannot
 * report one even if it wanted to, and the marker maps the click back. The
 * alternative — trusting the page to un-shuffle before it reports — would
 * make a corrupt answer indistinguishable from a wrong one.
 *
 * An answer can be changed as often as a candidate likes while the sitting
 * is open, which is what an upsert is for: they are ticking a box, not
 * filing a submission, and a paper that refused a change of mind would be
 * a worse paper. `answeredAt` moves with it, so the timeline shows when
 * they last settled on it.
 *
 * Deleting an answer is deliberately not offered. "I would rather leave
 * this blank" is a thing a candidate may want, but an endpoint that can
 * remove recorded work is a bigger risk than the convenience is worth, and
 * a blank and a wrong answer score the same.
 */

const noStore = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}

const bodySchema = z
  .object({
    mcqId: z.string().min(1).max(64),
    /** A position in the order this candidate was shown. */
    chosenIndex: z.number().int().min(0).max(7),
  })
  .strict();

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

  // Bounded before it is parsed (Phase 17 audit, `lib/http/body.ts`).
  const read = await readJsonBody(request);
  if (!read.ok) return json({ error: read.status === 413 ? "Answer too large." : "Malformed answer." }, read.status);
  const body = bodySchema.safeParse(read.value);
  if (!body.success) return json({ error: "Malformed answer." }, 400);

  const sessionId = await currentSessionId();
  const guard = await guardAttempt({ request, attemptId, userId: user.id, sessionId });
  if (!guard.ok) {
    await endAttemptSession(attemptId, guard.reason);
    // 409, as for snapshots, runs and telemetry: there is no live sitting
    // to attach this to, and the client should stop rather than retry.
    return json({ error: guard.message, revokeReason: guard.reason }, 409);
  }

  /**
   * The question, and the number of options, come from the attempt's own
   * layout — never from the request. A candidate cannot answer a question
   * that is not on their paper, and cannot pick an option their paper did
   * not show them.
   */
  const layout = attemptLayoutOf(guard.attempt);
  const mcq = (layout.mcqs ?? []).find((m) => m.mcqId === body.data.mcqId);
  if (!mcq) return json({ error: "That question is not part of this assessment." }, 404);
  if (body.data.chosenIndex >= mcq.optionOrder.length) {
    return json({ error: "That is not one of the options." }, 400);
  }

  await db.assessmentMcqAnswer.upsert({
    where: { attemptId_mcqId: { attemptId: guard.attempt.id, mcqId: mcq.mcqId } },
    create: { attemptId: guard.attempt.id, mcqId: mcq.mcqId, chosenIndex: body.data.chosenIndex },
    update: { chosenIndex: body.data.chosenIndex },
  });

  return json({ saved: true, chosenIndex: body.data.chosenIndex });
}
