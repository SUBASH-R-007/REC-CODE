import "server-only";
import {
  AI_REFUSALS,
  AI_SYSTEM_PROMPT,
  buildAiPrompt,
  type AiAskKind,
  type HelpContext,
} from "@recx/shared";
import { db } from "@/lib/db";
import { askProvider, AiProviderError } from "@/lib/ai/provider";
import { askAiSchema } from "@/lib/ai/schema";
import { aiUsable, getAiRuntime } from "@/lib/ai/settings";
import { AppError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { aiAllowed, getHelpState } from "@/lib/help/access";
import { istDayStart } from "@/lib/judge/caps";
import { renderUntrustedMarkdown } from "@/lib/markdown";

/**
 * The body of the askAiHelper server action, with the help context as an
 * explicit server-side argument (the action passes the workspace's; tests
 * pass CONTEST and ASSESSMENT, and get nothing).
 *
 * The order of the checks is the point. The chokepoint decides first —
 * practice, enough effort, inside the daily allowance — and only then does
 * anything leave this server. A refusal costs the college nothing and tells
 * the student why in a sentence they can act on.
 *
 * Like a hint reveal, an ask is not audited: it is the student's own study
 * activity, and the AiAssist row with its timestamp IS the record the
 * ASSISTED rule reads.
 */

const NOT_AVAILABLE = "That problem is not available.";

/** A provider that could not answer. The student is told to try again, not given a stack trace. */
export class AiUnavailableError extends AppError {
  constructor() {
    super(AI_REFUSALS.unavailable, 503);
    this.name = "AiUnavailableError";
  }
}

export interface AiAnswer {
  kind: AiAskKind;
  /** Sanitised HTML (renderUntrustedMarkdown: no links). */
  html: string;
  /** Questions left today after this one. */
  remainingToday: number;
  /** True when this answer will make a later first solve ASSISTED. */
  marksAssisted: boolean;
}

export async function askAiHelperFor(userId: string, input: unknown, context: HelpContext): Promise<AiAnswer> {
  const { problemId, kind } = askAiSchema.parse(input);

  const runtime = await getAiRuntime();
  if (!runtime.setting.enabled) throw new ForbiddenError(AI_REFUSALS.off);
  if (!aiUsable(runtime) || !runtime.model) throw new ForbiddenError(AI_REFUSALS.unconfigured);

  const state = await getHelpState(userId, problemId, context);
  if (!state) throw new NotFoundError(NOT_AVAILABLE);

  const askedToday = await countAsksToday(userId, state.now);
  const access = aiAllowed(state, runtime.setting, askedToday);
  if (!access.allowed) throw new ForbiddenError(access.reason ?? AI_REFUSALS.off);

  const material = await loadMaterial(userId, state.problemId, state.liveVersionId);
  const prompt = buildAiPrompt({ kind, ...material });

  const startedAt = Date.now();
  let completion;
  try {
    completion = await askProvider({
      model: runtime.model,
      system: AI_SYSTEM_PROMPT,
      prompt,
      maxOutputTokens: runtime.setting.maxOutputTokens,
    });
  } catch (error) {
    // Recorded, so a super-admin can see the helper is failing rather than
    // hearing it from students. A failure costs no quota: answer IS NULL.
    await db.aiAssist.create({
      data: {
        userId,
        problemId: state.problemId,
        context: state.context,
        kind,
        modelId: runtime.model.id,
        answer: null,
        failed: true,
        latencyMs: Date.now() - startedAt,
      },
    });
    if (error instanceof AiProviderError) throw new AiUnavailableError();
    throw error;
  }

  await db.aiAssist.create({
    data: {
      userId,
      problemId: state.problemId,
      context: state.context,
      kind,
      modelId: runtime.model.id,
      answer: completion.text,
      failed: false,
      tokensIn: completion.tokensIn,
      tokensOut: completion.tokensOut,
      latencyMs: Date.now() - startedAt,
    },
  });

  return {
    kind,
    html: renderUntrustedMarkdown(completion.text),
    remainingToday: Math.max(0, runtime.setting.dailyPerStudent - (askedToday + 1)),
    marksAssisted: access.marksAssisted,
  };
}

/** Answered asks since IST midnight. A failure is not one. */
export async function countAsksToday(userId: string, now: Date): Promise<number> {
  return db.aiAssist.count({ where: { userId, failed: false, askedAt: { gte: istDayStart(now) } } });
}

interface Material {
  problemTitle: string;
  statement: string;
  language: string;
  source: string;
  lastVerdict: string | null;
  failedSample: { input: string; expected: string; got: string } | null;
}

/**
 * Everything the model is given, and nothing else: the public statement, the
 * student's own newest draft, the verdict of their own last practice
 * submission, and the one sample case it failed — which the product already
 * shows them on the submission page. Hidden tests are never read here, and
 * no other student's work is reachable from these queries.
 */
async function loadMaterial(userId: string, problemId: string, liveVersionId: string): Promise<Material> {
  const [version, draft, submission] = await Promise.all([
    db.problemVersion.findUniqueOrThrow({
      where: { id: liveVersionId },
      select: { title: true, statementMd: true },
    }),
    db.codeDraft.findFirst({
      where: { userId, problemId },
      orderBy: { updatedAt: "desc" },
      select: { language: true, source: true },
    }),
    db.submission.findFirst({
      where: { userId, problemId, origin: "PRACTICE", status: "DONE", verdict: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { id: true, verdict: true, firstFailedIndex: true },
    }),
  ]);

  let failedSample: Material["failedSample"] = null;
  if (submission && submission.firstFailedIndex !== null) {
    const detail = await db.submissionTestDetail.findUnique({
      where: { submissionId_testIndex: { submissionId: submission.id, testIndex: submission.firstFailedIndex } },
      select: { input: true, expected: true, stdout: true },
    });
    // A detail row exists only for a SAMPLE case (lib/judge/finalize.ts
    // stores sample texts and nothing else), so there is no hidden test to
    // leak here even if a later change widened what the judge reports.
    if (detail && detail.input !== null && detail.expected !== null) {
      failedSample = { input: detail.input, expected: detail.expected, got: detail.stdout ?? "" };
    }
  }

  return {
    problemTitle: version.title,
    statement: version.statementMd,
    language: draft?.language ?? "no language chosen yet",
    source: draft?.source ?? "",
    lastVerdict: submission?.verdict ?? null,
    failedSample,
  };
}
