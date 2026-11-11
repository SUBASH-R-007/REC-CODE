"use server";

import { createHash } from "node:crypto";
import {
  ANSWER_REFUSALS,
  DEBUG_REFUSALS,
  INTERACTIVE_REFUSALS,
  LIMITS,
  SQL_LIMITS,
  SQL_REFUSALS,
  countEditedLines,
  debugOverBudget,
  isAnswerLanguage,
  isSqlLanguage,
  looksLikeMultipleStatements,
  utf8Length,
  type CompareMode,
  type IoMode,
  type JobKind,
  type JudgeLane,
  type LanguageKey,
} from "@recx/shared";
import { functionSignatureSchema, supportsFunctionMode, validateFunctionInput, type FunctionSignature } from "@recx/shared/harness";
import { requireActionUser } from "@/lib/auth/guards";
import { findLiveContestEntry } from "@/lib/contests/entry";
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
  /** DEBUGGING problems (Phase 12m): the most lines this answer may change. */
  editBudget: number | null;
  /** DEBUGGING problems: the broken program, in the language being answered in. */
  starter: string | null;
}

/** The published problem's live version + the current config for a language. */
/**
 * Phase 12k: the language is a string rather than a `LanguageKey`, because
 * `sql17` is a language a student submits in and not a toolchain. Which
 * languages a given problem accepts is decided below, against the version:
 * a SQL problem takes SQL and nothing else, and no other problem takes SQL.
 */
async function loadTarget(slug: string, language: string, pinnedVersionId?: string): Promise<JudgeTarget> {
  const problem = await db.problem.findUnique({
    where: { slug },
    select: {
      id: true,
      status: true,
      liveVersion: {
        select: { id: true, ioMode: true, compareMode: true, functionSignature: true, maxEditedLines: true },
      },
    },
  });
  if (!problem || problem.status !== "PUBLISHED" || !problem.liveVersion) {
    throw new NotFoundError("That problem is not available.");
  }
  /**
   * A contest pins a version, and that is the one answered — a problem
   * republished mid-contest must not change the question, the same rule as
   * a sitting (`lib/exam/submit.ts`). `problemId` is in the `where` so a
   * version id from anywhere else cannot drag another problem's tests in.
   */
  let version = problem.liveVersion;
  if (pinnedVersionId && pinnedVersionId !== problem.liveVersion.id) {
    const pinned = await db.problemVersion.findFirst({
      where: { id: pinnedVersionId, problemId: problem.id },
      select: { id: true, ioMode: true, compareMode: true, functionSignature: true, maxEditedLines: true },
    });
    if (!pinned) throw new NotFoundError("That problem is not available.");
    version = pinned;
  }
  const sqlProblem = version.ioMode === "SQL";
  if (sqlProblem !== isSqlLanguage(language)) {
    throw new ValidationError(
      sqlProblem
        ? "That problem is answered with a SQL query."
        : "SQL is only for a SQL problem; choose a programming language.",
    );
  }
  /**
   * Phase 12n: the same pairing, for the language that is not a language.
   * An output-only problem's submission is the ANSWER, and no other
   * problem accepts one — a text answer judged as a program would be a CE
   * nobody could explain.
   */
  const answerProblem = version.ioMode === "OUTPUT_ONLY";
  if (answerProblem !== isAnswerLanguage(language)) {
    throw new ValidationError(
      answerProblem
        ? "That problem asks for the answer itself, not a program."
        : "An answer file is only for an output-only problem; choose a programming language.",
    );
  }
  if (version.ioMode === "FUNCTION" && !supportsFunctionMode(language as LanguageKey)) {
    throw new ValidationError("This problem is not available in that language yet.");
  }

  const config = await db.languageConfig.findFirst({
    where: { key: language, enabled: true, isCurrent: true },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!config) throw new ValidationError("That language is not available right now. Choose another one.");

  const versionId = version.id;
  /**
   * Phase 12m. A debugging problem is offered in the languages its broken
   * program is written in and no others — the workspace builds its picker
   * the same way — because a language with no program to repair would be
   * an empty editor with a two-line budget. The starter comes back with
   * the target so the budget is measured against the program the student
   * was actually given.
   */
  const editBudget = version.maxEditedLines;
  let starter: string | null = null;
  if (editBudget !== null) {
    const row = await db.starterCode.findUnique({
      where: { problemVersionId_language: { problemVersionId: versionId, language } },
      select: { code: true },
    });
    starter = row?.code ?? null;
    if (starter === null || starter.trim().length === 0) throw new ValidationError(DEBUG_REFUSALS.noProgram);
  }
  const [totalCases, sampleCount] = await Promise.all([
    db.testCase.count({ where: { problemVersionId: versionId } }),
    db.testCase.count({ where: { problemVersionId: versionId, isSample: true } }),
  ]);
  const parsedSig =
    version.ioMode === "FUNCTION" ? functionSignatureSchema.safeParse(version.functionSignature) : null;
  const signature = parsedSig?.success ? parsedSig.data : null;
  return {
    problemId: problem.id,
    versionId,
    languageConfigId: config.id,
    sampleCount,
    totalCases,
    ioMode: version.ioMode,
    compareMode: version.compareMode,
    signature,
    editBudget,
    starter,
  };
}

/**
 * The problem's id from its address, before anything else is read.
 *
 * The contest entry is looked up by problem rather than by version — a
 * contest pins one version and the catalogue serves another, and a student
 * answering problem B during a contest that holds problem B is answering
 * the contest's B whichever page they came from.
 */
async function problemIdOf(slug: string): Promise<string> {
  const row = await db.problem.findUnique({ where: { slug }, select: { id: true, status: true } });
  if (!row || row.status !== "PUBLISHED") throw new NotFoundError("That problem is not available.");
  return row.id;
}

/**
 * The edit budget of a debugging problem (Phase 12m), checked before
 * anything is written.
 *
 * Before the row on purpose: a submission that cannot be judged on its
 * merits must not cost a student one of their daily submissions, and a Run
 * that quietly judged an over-budget program would teach them that the rule
 * does not apply until it suddenly does. The judge is not the place for
 * this — it has no starter, and no business having one.
 */
function refuseOverBudget(target: JudgeTarget, source: string): void {
  if (target.editBudget === null || target.starter === null) return;
  const changed = countEditedLines(target.starter, source);
  if (changed > target.editBudget) throw new ValidationError(debugOverBudget(changed, target.editBudget));
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
async function dispatch(kind: UserJobKind, id: string, lane: JudgeLane) {
  const queued = await enqueueJudge(kind, id, lane);
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
    /**
     * Which contest, if any, this submission belongs to (Phase 12q.3). It
     * is derived from the rows rather than passed by the page, so the
     * arena's button, the catalogue and a bookmark all count the same way
     * and there is nothing for a student to forge. Read before the target
     * because it decides which VERSION is answered.
     */
    const problemId = await problemIdOf(parsed.slug);
    const entry = await findLiveContestEntry(db, { userId: user.id, problemId, now: new Date() });
    const target = await loadTarget(parsed.slug, parsed.language, entry?.problemVersionId);
    if (target.totalCases === 0) throw new ValidationError("This problem has no tests yet.");
    if (target.ioMode === "SQL") refuseBadSql(parsed.source);
    refuseOverBudget(target, parsed.source);

    const sourceSha256 = createHash("sha256").update(parsed.source, "utf8").digest("hex");
    const sourceBytes = utf8Length(parsed.source);

    const id = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userLockKey("submission", user.id)}))`;
      const now = new Date();
      const caps = await loadCaps(tx, user.id, now);
      const decision = evaluateSubmitCaps(caps, await loadSubmitUsage(tx, user.id, now), {
        practice: entry === null,
      });
      if (!decision.ok) throw new RateLimitError(decision.message);
      const row = await tx.submission.create({
        data: {
          userId: user.id,
          problemId: target.problemId,
          problemVersionId: target.versionId,
          languageConfigId: target.languageConfigId,
          language: parsed.language,
          origin: entry ? "CONTEST" : "PRACTICE",
          lane: entry ? "CONTEST" : "PRACTICE",
          contestId: entry?.contestId ?? null,
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

    await dispatch("submission", id, entry ? "CONTEST" : "PRACTICE");
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
    /**
     * Phase 12n. There is nothing to run: the answer IS the submission, and
     * the one case it would run against is the one it is judged against.
     * A Run here would spend a student's quota to tell them the verdict
     * they were about to get anyway.
     */
    if (target.ioMode === "OUTPUT_ONLY") throw new ValidationError(ANSWER_REFUSALS.noRun);
    if (parsed.customInput === null && target.sampleCount === 0) {
      throw new ValidationError("This problem has no sample tests. Run it with custom input instead.");
    }
    refuseOverBudget(target, parsed.source);
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

    await dispatch("run", id, "RUN");
    await touchLastActive(user.id);
    return { id };
  }, "runCode");
}
