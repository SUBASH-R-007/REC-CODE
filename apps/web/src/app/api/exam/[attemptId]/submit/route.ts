import { cookies } from "next/headers";
import { z } from "zod";
import {
  ANSWER_LANGUAGE_KEY,
  LANGUAGE_CATALOG,
  LANGUAGE_NOT_ACCEPTED_MESSAGE,
  SNAPSHOT_MAX_BYTES,
  SQL_LANGUAGE_KEY,
} from "@recx/shared";
import { requireActionUser } from "@/lib/auth/guards";
import { readBoundedText } from "@/lib/http/body";
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

/**
 * The keys an answer may carry.
 *
 * The eleven toolchains, plus `answer1` since Phase 16f and `sql17` since
 * Phase 16o — neither of which is a toolchain, and both of which are
 * accepted here only so that an output-only question can be handed in and a
 * query can. Whether this particular question may use one is decided by
 * `submitAttempt` against the frozen layout, not by this enum: a key that
 * parses is not a key this question accepts.
 */
const LANGUAGE_IDS = [ANSWER_LANGUAGE_KEY, SQL_LANGUAGE_KEY, ...Object.keys(LANGUAGE_CATALOG)] as [
  string,
  ...string[],
];

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

  const raw = await readBoundedText(request, MAX_REQUEST_BYTES);
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
    /**
     * The reason, said accurately (Phase 13a).
     *
     * Every refusal used to be reported as "this sitting is already
     * finished", which is right for the common one and a lie for the
     * others: a candidate whose language the paper does not accept, or
     * whose toolchain has been disabled, was told their sitting was over
     * while it was in fact still live and still savable. The two below
     * leave the attempt IN_PROGRESS on purpose, so the message has to be
     * one a candidate can act on.
     */
    if (result.reason === "language_not_accepted") {
      return json({ error: LANGUAGE_NOT_ACCEPTED_MESSAGE }, 400);
    }
    /**
     * Phase 16g. A debugging question over its edit budget. Like the two
     * below it the attempt is left IN_PROGRESS on purpose: nothing has
     * been finalised, the clock is still running, and the message names
     * the question so the candidate knows where to go.
     */
    if (result.reason === "over_edit_budget") {
      return json({ error: result.overBudget ?? "A question changes more lines than it allows." }, 400);
    }
    if (result.reason === "no_language") {
      return json(
        {
          error:
            "One of the languages this paper accepts is no longer available on the judge, so nothing was submitted. Tell your invigilator -- your work is saved and your sitting is still open.",
        },
        409,
      );
    }
    return json({ error: "This sitting is already finished.", revokeReason: "submitted" }, 409);
  }
  await endAttemptSession(attemptId, "submitted");

  return json({ submitted: true, submissions: result.submissionIds.length, blank: result.blank });
}
