"use server";

import { createHash } from "node:crypto";
import {
  INTERACTIVE_REFUSALS,
  LIMITS,
  SQL_LIMITS,
  SQL_REFUSALS,
  isSqlLanguage,
  looksLikeMultipleStatements,
  utf8Length,
  type CompareMode,
  type IoMode,
  type JobKind,
  type LanguageKey,
} from "@recx/shared";
import { functionSignatureSchema, supportsFunctionMode, validateFunctionInput, type FunctionSignature } from "@recx/shared/harness";
import { requireActionUser } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { NotFoundError, RateLimitError, ValidationError, runAction, type ActionResult } from "@/lib/errors";
import {
  evaluateRunCaps,
  evaluateSubmitCaps,
  loadCaps,
  loadRunUsage,
  loadSubmitUsage,
} from "@/lib/judge/caps";
import { enqueueJudge } from "@/lib/judge/queue";
import {
  runCodeSchema,
  submitSolutionSchema,
  type RunCodeInput,
  type SubmitSolutionInput,
} from "@/lib/judge/submit-schema";

/**
 * The workspace's Submit and Run buttons.
 *
 * Postgres is truth, Redis is transport: the row (QUEUED / PENDING) is
 * committed first, THEN enqueued, then marked DISPATCHED. If Redis is down
 * the row simply stays PENDING and the scheduler's reconciler enqueues it.
 * Student code is never executed here — only stored and queued.
 *
 * Practice submissions and runs are not audited: they are not sensitive
 * mutations, and the Submission / RunRequest row is itself the record.
 *
 * Per-user caps (src/lib/judge/caps.ts, LIMITS.userCaps): 2 submissions and
 * 1 run in flight, 300 practice submissions per IST day, 60 runs in the
 * trailing hour, 20 CPU-minutes of judging per IST day — each checked under
 * the user's advisory lock, with any active JudgeQuotaOverride applied.
 */

type UserJobKind = Extract<JobKind, "submission" | "run">;

interface JudgeTarget {
  problemId: string;
  versionId: string;
  languageConfigId: string;
  sampleCount: number;
  totalCases: number;
  ioMode: IoMode;
  /** INTERACTIVE means the answer is a conversation (Phase 12l). */
  compareMode: CompareMode;
  /** FUNCTION problems: the live version signature (custom Run input is validated against it). */
  signature: FunctionSignature | null;
}

/** The published problem's live version + the current config for a language. */
/**
 * Phase 12k: the language is a string rather than a `LanguageKey`, because
 * `sql17` is a language a student submits in and not a toolchain. Which
 * languages a given problem accepts is decided below, against the version:
 * a SQL problem takes SQL and nothing else, and no other problem takes SQL.
 */
async function loadTarget(slug: string, language: string): Promise<JudgeTarget> {
  const problem = await db.problem.findUnique({
    where: { slug },
    select: {
      id: true,
      status: true,
      liveVersion: { select: { id: true, ioMode: true, compareMode: true, functionSignature: true } },
    },
  });
  if (!problem || problem.status !== "PUBLISHED" || !problem.liveVersion) {
    throw new NotFoundError("That problem is not available.");
  }
  const sqlProblem = problem.liveVersion.ioMode === "SQL";
  if (sqlProblem !== isSqlLanguage(language)) {
    throw new ValidationError(
      sqlProblem
        ? "That problem is answered with a SQL query."
        : "SQL is only for a SQL problem; choose a programming language.",
    );
  }
  if (problem.liveVersion.ioMode === "FUNCTION" && !supportsFunctionMode(language as LanguageKey)) {
    throw new ValidationError("This problem is not available in that language yet.");
  }

  const config = await db.languageConfig.findFirst({
    where: { key: language, enabled: true, isCurrent: true },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!config) throw new ValidationError("That language is not available right now. Choose another one.");

  const versionId = problem.liveVersion.id;
  const [totalCases, sampleCount] = await Promise.all([
    db.testCase.count({ where: { problemVersionId: versionId } }),
    db.testCase.count({ where: { problemVersionId: versionId, isSample: true } }),
  ]);
  const parsedSig =
    problem.liveVersion.ioMode === "FUNCTION" ? functionSignatureSchema.safeParse(problem.liveVersion.functionSignature) : null;
  const signature = parsedSig?.success ? parsedSig.data : null;
  return {
    problemId: problem.id,
    versionId,
    languageConfigId: config.id,
    sampleCount,
    totalCases,
    ioMode: problem.liveVersion.ioMode,
    compareMode: problem.liveVersion.compareMode,
    signature,
  };
}

/**
 * The two SQL rules a server can state before anything is queued
 * (Phase 12k): one statement, and a length a query has no business
 * exceeding. Neither is the fence — the sandbox refuses a second command
 * outright and the role it runs as cannot write — but a student should
 * read a sentence rather than wait for a verdict to learn it.
 */
function refuseBadSql(source: string): void {
  if (utf8Length(source) > SQL_LIMITS.submissionBytes) throw new ValidationError(SQL_REFUSALS.tooLong);
  if (looksLikeMultipleStatements(source)) throw new ValidationError(SQL_REFUSALS.multiple);
}

/**
 * Enqueue after commit; mark DISPATCHED only if the job reached Redis and
 * the row is still PENDING (a fast worker may already have claimed it).
 */
async function dispatch(kind: UserJobKind, id: string) {
  const queued = await enqueueJudge(kind, id, kind === "submission" ? "PRACTICE" : "RUN");
  if (!queued) return;
  const where = { id, judgeState: "PENDING" as const };
  const data = { judgeState: "DISPATCHED" as const };
  if (kind === "submission") await db.submission.updateMany({ where, data });
  else await db.runRequest.updateMany({ where, data });
}

async function touchLastActive(userId: string) {
  await db.user.update({ where: { id: userId }, data: { lastActiveAt: new Date() } }).catch(() => undefined);
}

/** Serialise one user's submit/run requests so the in-flight caps hold under double-clicks. */
function userLockKey(kind: UserJobKind, userId: string) {
  return `judge:${kind}:${userId}`;
}

export async function submitSolution(input: SubmitSolutionInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = submitSolutionSchema.parse(input);
    const target = await loadTarget(parsed.slug, parsed.language);
    if (target.totalCases === 0) throw new ValidationError("This problem has no tests yet.");
    if (target.ioMode === "SQL") refuseBadSql(parsed.source);

    const sourceSha256 = createHash("sha256").update(parsed.source, "utf8").digest("hex");
    const sourceBytes = utf8Length(parsed.source);

    const id = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userLockKey("submission", user.id)}))`;
      const now = new Date();
      const caps = await loadCaps(tx, user.id, now);
      const decision = evaluateSubmitCaps(caps, await loadSubmitUsage(tx, user.id, now));
      if (!decision.ok) throw new RateLimitError(decision.message);
      const row = await tx.submission.create({
        data: {
          userId: user.id,
          problemId: target.problemId,
          problemVersionId: target.versionId,
          languageConfigId: target.languageConfigId,
          language: parsed.language,
          origin: "PRACTICE",
          lane: "PRACTICE",
          status: "QUEUED",
          judgeState: "PENDING",
          totalCases: target.totalCases,
          sourceSha256,
          sourceBytes,
          source: { create: { source: parsed.source } },
        },
        select: { id: true },
      });
      return row.id;
    });

    await dispatch("submission", id);
    await touchLastActive(user.id);
    return { id };
  }, "submitSolution");
}

export async function runCode(input: RunCodeInput): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const user = await requireActionUser();
    const parsed = runCodeSchema.parse(input);
    const target = await loadTarget(parsed.slug, parsed.language);
    if (target.ioMode === "SQL") {
      refuseBadSql(parsed.source);
      // A SQL question's input IS its dataset, and the author's datasets
      // are what the question means, so there is nothing to type here.
      if (parsed.customInput !== null) throw new ValidationError(SQL_REFUSALS.customInput);
      if (target.sampleCount === 0) throw new ValidationError(SQL_REFUSALS.noSampleCase);
    }
    /**
     * Phase 12l. A conversation has no input to type: what a case gives
     * the examiner is the author's, and the program's input is whatever
     * the examiner replies. The console offers no tab for it either.
     */
    if (target.compareMode === "INTERACTIVE") {
      if (parsed.customInput !== null) throw new ValidationError(INTERACTIVE_REFUSALS.customInput);
      if (target.sampleCount === 0) throw new ValidationError(INTERACTIVE_REFUSALS.noSampleCase);
    }
    if (parsed.customInput === null && target.sampleCount === 0) {
      throw new ValidationError("This problem has no sample tests. Run it with custom input instead.");
    }
    // FUNCTION custom input: one valid value per parameter line, checked before anything is queued.
    if (parsed.customInput !== null && target.signature) {
      const issues = validateFunctionInput(target.signature, parsed.customInput);
      if (issues.length > 0) throw new ValidationError(`Custom input — ${issues.join(" ")}`);
    }

    const expiresAt = new Date(Date.now() + LIMITS.customRun.ttlHours * 3_600_000);
    const id = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userLockKey("run", user.id)}))`;
      const now = new Date();
      const caps = await loadCaps(tx, user.id, now);
      const decision = evaluateRunCaps(caps, await loadRunUsage(tx, user.id, now, caps), now);
      if (!decision.ok) throw new RateLimitError(decision.message);
      const row = await tx.runRequest.create({
        data: {
          userId: user.id,
          problemVersionId: target.versionId,
          languageConfigId: target.languageConfigId,
          language: parsed.language,
          source: parsed.source,
          customInput: parsed.customInput,
          status: "QUEUED",
          judgeState: "PENDING",
          expiresAt,
        },
        select: { id: true },
      });
      return row.id;
    });

    await dispatch("run", id);
    await touchLastActive(user.id);
    return { id };
  }, "runCode");
}
