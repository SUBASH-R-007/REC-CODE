import { cookies } from "next/headers";
import { z } from "zod";
import {
  LANGUAGE_CATALOG,
  LANGUAGE_NOT_ACCEPTED_MESSAGE,
  LIMITS,
  SNAPSHOT_MAX_BYTES,
  acceptsLanguage,
} from "@recx/shared";
import { requireActionUser } from "@/lib/auth/guards";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session-token";
import { db } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { endAttemptSession, guardAttempt } from "@/lib/exam/attempt";
import { languagesOfQuestion } from "@/lib/exam/language";
import { attemptLayoutOf } from "@/lib/exam/layout";
import { writeSnapshot } from "@/lib/exam/snapshots";
import { enqueueJudge } from "@/lib/judge/queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exam/[attemptId]/run — run a sitting's answer against the
 * SAMPLE tests (Phase 12q, slice 5).
 *
 * The thing a sitting was missing. A candidate had an editor, a clock and a
 * Submit button, and no way to find out whether their program compiled —
 * while the practice workspace two clicks away has had a Run button and a
 * results console since Phase 1. The snapshot route has accepted
 * `trigger: "RUN"` from the beginning ("every 30s while dirty, plus on
 * every run and submit") and nothing in the product ever sent it, because
 * there was nothing to send it from.
 *
 * Samples only, and that is not a simplification: the samples are already
 * printed on the question, so running them tells a candidate what they
 * could work out by hand, only faster. Hidden tests stay hidden, and there
 * is no custom input — an exam is not the place to go fishing with inputs
 * of your own, and leaving it out removes the question of what a candidate
 * might learn from one.
 *
 * What the judge sees is an ordinary RunRequest on the RUN lane, which the
 * allocator keeps two slots per node for precisely so the editor stays
 * responsive while a contest or a sitting is being judged. Student code
 * never runs in this process; it never has.
 *
 * The run is read back through `/api/runs/[id]`, which is owner-scoped
 * already, so the sitting shares the practice console's whole result path:
 * the same stream, the same panel, the same wording. That is the point —
 * a candidate should not have to learn a second console under exam
 * conditions.
 */

const noStore = { "cache-control": "no-store" } as const;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: noStore });
}

const LANGUAGE_IDS = Object.keys(LANGUAGE_CATALOG) as [string, ...string[]];

const bodySchema = z
  .object({
    questionId: z.string().min(1).max(64),
    language: z.enum(LANGUAGE_IDS),
    source: z.string().max(SNAPSHOT_MAX_BYTES),
    /** Milliseconds since the sitting began, for the snapshot's timeline. */
    atMs: z.number().int().min(0),
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

  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return json({ error: "Malformed run." }, 400);

  const sessionId = await currentSessionId();
  const guard = await guardAttempt({ request, attemptId, userId: user.id, sessionId });
  if (!guard.ok) {
    await endAttemptSession(attemptId, guard.reason);
    // 409, as for snapshots and telemetry: there is no live sitting to run
    // against, and the client should stop rather than retry.
    return json({ error: guard.message, revokeReason: guard.reason }, 409);
  }

  /**
   * The question, and the VERSION, come from the attempt's own layout —
   * never from the request. A sitting is pinned to frozen versions so a
   * problem republished mid-exam cannot change what is being answered, and
   * a run has to go against the same text the candidate is reading.
   */
  const layout = attemptLayoutOf(guard.attempt);
  const question = layout.questions.find((q) => q.questionId === body.data.questionId);
  if (!question) return json({ error: "That question is not part of this assessment." }, 404);
  /**
   * Phase 16f. An output-only question has nothing to run: the submission
   * IS the answer, and there is no program, no compiler and no sample to
   * run it against. The client draws no Run button for one, so reaching
   * here means a client somebody has been editing — 409 and a sentence,
   * rather than a queued job no node could ever serve.
   */
  if (question.kind === "ANSWER") {
    return json({ error: "There is nothing to run on this question: hand in the answer itself." }, 409);
  }
  /**
   * The language must be one the paper accepts (Phase 13a).
   *
   * It used to have to be THE language: a sitting had one, nobody chose
   * it, and this route compared against it. A paper may now accept
   * several and a candidate picks per question, so the check is
   * membership of the attempt's frozen set -- derived in one place so the
   * page and this route cannot disagree, which is the Phase 12q.5 lesson.
   */
  // The QUESTION's list (Phase 13c), which is the paper's unless the
  // question narrows it. Asked of the layout, never of the current rows.
  const accepted = await languagesOfQuestion(layout, question.questionId);
  if (!acceptsLanguage(accepted, body.data.language)) {
    return json({ error: LANGUAGE_NOT_ACCEPTED_MESSAGE }, 400);
  }
  const runLanguage = body.data.language;
  if (body.data.source.trim() === "") return json({ error: "Write some code first." }, 400);

  const version = await db.problemVersion.findUnique({
    where: { id: question.problemVersionId },
    select: { id: true, _count: { select: { testCases: { where: { isSample: true } } } } },
  });
  if (!version) return json({ error: "That question is not available." }, 404);
  if (version._count.testCases === 0) {
    return json({ error: "This question has no sample tests to run." }, 409);
  }

  // The toolchain for the language the candidate chose, not the paper's
  // default: a run compiled with the wrong compiler is worse than no run.
  const config = await db.languageConfig.findFirst({
    where: { key: runLanguage, enabled: true, isCurrent: true },
    select: { id: true },
  });
  if (!config) return json({ error: "That language is not available right now." }, 409);

  /**
   * The budget, counted from the rows rather than kept anywhere: this
   * candidate's runs on this question since the sitting began. A sitting
   * pays no practice caps, so these two are all that stand between one
   * stuck key and a queue nobody else can get into.
   */
  const since = guard.attempt.startedAt;
  const [inFlight, used] = await Promise.all([
    db.runRequest.count({
      where: { userId: user.id, createdAt: { gte: since }, status: { in: ["QUEUED", "JUDGING"] } },
    }),
    db.runRequest.count({ where: { userId: user.id, problemVersionId: version.id, createdAt: { gte: since } } }),
  ]);
  if (inFlight >= LIMITS.examRun.inFlightPerAttempt) {
    return json({ error: "Your last run is still going. Wait for it to finish." }, 429);
  }
  if (used >= LIMITS.examRun.perQuestion) {
    return json({ error: `You have run this question ${LIMITS.examRun.perQuestion} times. Submit when you are ready.` }, 429);
  }

  /**
   * Snapshot BEFORE the run, with the trigger the design named. Two
   * reasons, and the second is the one that matters: the timeline a
   * reviewer reads should show what was in the editor when it was run, and
   * a candidate whose network dies during the run has still had this text
   * stored.
   */
  await writeSnapshot(guard, {
    questionId: question.questionId,
    language: runLanguage,
    source: body.data.source,
    trigger: "RUN",
    atMs: body.data.atMs,
  });

  const row = await db.runRequest.create({
    data: {
      userId: user.id,
      problemVersionId: version.id,
      languageConfigId: config.id,
      language: runLanguage,
      source: body.data.source,
      // Null means "run the sample tests" — there is no custom input here.
      customInput: null,
      status: "QUEUED",
      judgeState: "PENDING",
      expiresAt: new Date(Date.now() + LIMITS.customRun.ttlHours * 3_600_000),
    },
    select: { id: true },
  });

  // Postgres is truth, Redis is transport: the row is committed, then
  // enqueued. If Redis is down the reconciler picks it up.
  const queued = await enqueueJudge("run", row.id, "RUN");
  if (queued) {
    await db.runRequest.updateMany({
      where: { id: row.id, judgeState: "PENDING" },
      data: { judgeState: "DISPATCHED" },
    });
  }

  return json({ runId: row.id });
}
