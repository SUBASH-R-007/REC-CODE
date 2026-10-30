import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Prisma, type JudgeNode } from "@recx/db";
import {
  languageKeySchema,
  LIMITS,
  progressChannel,
  SENSITIVE_LANES,
  type ClaimRefusal,
  type ClaimRequest,
  type JobKind,
  type JudgeJobSpec,
  type JudgeLane,
  type ProgressEvent,
  engineForIoMode,
  type SqlJobSpec,
} from "@recx/shared";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { verdictReached } from "@/lib/metrics";
import { redis } from "@/lib/redis";
import { buildSqlJobSpec } from "@/lib/judge/sql-job-spec";
import { buildJudgeJobSpec, JobSpecError, type JobSpecChecker, type JobSpecInput } from "./job-spec";
import { isSensitiveLane } from "./lanes";

/**
 * Claiming a judge job. Postgres is the source of truth for who holds a job:
 * the lease is one conditional UPDATE, so two workers racing for the same
 * BullMQ job (a retry, a reconciler re-enqueue, a duplicate delivery) can
 * never both win. The winner gets a fresh claimToken that every later call
 * for this job (blob, result, release) must present.
 *
 * Three kinds share the lease: submission (Submission), run (RunRequest) and
 * validation (ValidationRun — a reference solution judged at authoring time).
 * A node whose sensitive lanes are withheld (src/lib/judge/lanes.ts) cannot
 * lease an ASSESSMENT or CONTEST submission: the job stays queued, with no
 * attempt consumed, for an eligible node.
 *
 * The lease SQL compares timestamp columns with now(); the database session
 * time zone must be UTC (Prisma stores DateTime as UTC wall-clock time).
 *
 * Literals in the lease: interval '2 minutes' = JUDGE_LEASE_SECONDS and
 * "attemptCount" < 3 = JUDGE_RETRY.attempts (held equal by
 * test/judge-claim-constants.test.ts).
 */

/**
 * Phase 12k: a claim answers with the spec of whichever ENGINE judges the
 * job — an isolate spec for a program, a SQL spec for a statement. The
 * route serialises either; each service parses only its own, so neither
 * can be handed work it cannot run.
 */
export type ClaimOutcome =
  | { claimed: true; spec: JudgeJobSpec | SqlJobSpec }
  | { claimed: false; refusal: ClaimRefusal };

export const JOB_TABLE: Readonly<Record<JobKind, Prisma.Sql>> = {
  submission: Prisma.raw('"Submission"'),
  run: Prisma.raw('"RunRequest"'),
  validation: Prisma.raw('"ValidationRun"'),
};

/** The column naming the person a job belongs to (for audit targetUserId). */
const OWNER_COLUMN: Readonly<Record<JobKind, Prisma.Sql>> = {
  submission: Prisma.raw('"userId"'),
  run: Prisma.raw('"userId"'),
  validation: Prisma.raw('"requestedById"'),
};

export const JOB_ENTITY: Readonly<Record<JobKind, string>> = {
  submission: "Submission",
  run: "RunRequest",
  validation: "ValidationRun",
};

const SENSITIVE_LANE_SQL = Prisma.join(SENSITIVE_LANES.map((lane) => Prisma.sql`${lane}`));

export function newClaimToken(): string {
  return randomBytes(32).toString("base64url");
}

function refuse(reason: ClaimRefusal["reason"]): ClaimOutcome {
  return { claimed: false, refusal: { refused: true, reason } };
}

/** The lease. Returns the new attemptCount, or null when nothing was claimed. */
async function lease(kind: JobKind, id: string, node: JudgeNode, token: string): Promise<number | null> {
  let rows: { attemptCount: number }[];
  if (kind === "submission") {
    rows = await db.$queryRaw<{ attemptCount: number }[]>`
      UPDATE "Submission"
      SET status = 'JUDGING'::"SubmissionStatus", "judgeState" = 'RUNNING'::"JudgeState",
          "claimedByNodeId" = ${node.id}, "claimToken" = ${token},
          "leaseExpiresAt" = now() + interval '2 minutes',
          "attemptCount" = "attemptCount" + 1,
          "startedAt" = COALESCE("startedAt", now())
      WHERE id = ${id}
        AND status IN ('QUEUED'::"SubmissionStatus", 'JUDGING'::"SubmissionStatus")
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
        AND "attemptCount" < 3
        AND (${node.sensitiveLanesOk}::boolean OR lane::text NOT IN (${SENSITIVE_LANE_SQL}))
      RETURNING "attemptCount"`;
  } else {
    // RunRequest and ValidationRun have no lane column (RUN and REJUDGE
    // respectively); otherwise the identical lease.
    rows = await db.$queryRaw<{ attemptCount: number }[]>`
      UPDATE ${JOB_TABLE[kind]}
      SET status = 'JUDGING'::"SubmissionStatus", "judgeState" = 'RUNNING'::"JudgeState",
          "claimedByNodeId" = ${node.id}, "claimToken" = ${token},
          "leaseExpiresAt" = now() + interval '2 minutes',
          "attemptCount" = "attemptCount" + 1,
          "startedAt" = COALESCE("startedAt", now())
      WHERE id = ${id}
        AND status IN ('QUEUED'::"SubmissionStatus", 'JUDGING'::"SubmissionStatus")
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
        AND "attemptCount" < 3
      RETURNING "attemptCount"`;
  }
  return rows[0]?.attemptCount ?? null;
}

/**
 * Put a claimed job straight back in the queue. By default the lease is
 * expired now, so a retry claims it at once, and the attempt stays counted.
 * With `refundAttempt` (a result discarded through no fault of the job) the
 * lease is cleared and the attempt is given back.
 */
export async function requeueLease(
  kind: JobKind,
  id: string,
  nodeId: string,
  claimToken: string,
  options: { refundAttempt?: boolean } = {},
): Promise<{ attemptCount: number } | null> {
  const attempts = options.refundAttempt
    ? Prisma.sql`, "attemptCount" = GREATEST("attemptCount" - 1, 0), "leaseExpiresAt" = NULL`
    : Prisma.sql`, "leaseExpiresAt" = now()`;
  const rows = await db.$queryRaw<{ attemptCount: number }[]>`
    UPDATE ${JOB_TABLE[kind]}
    SET status = 'QUEUED'::"SubmissionStatus", "judgeState" = 'DISPATCHED'::"JudgeState",
        "claimToken" = NULL ${attempts}
    WHERE id = ${id} AND "claimToken" = ${claimToken} AND "claimedByNodeId" = ${nodeId}
      AND "judgeState" IN ('DISPATCHED'::"JudgeState", 'RUNNING'::"JudgeState")
    RETURNING "attemptCount"`;
  return rows[0] ?? null;
}

/** Fail-open live-progress publish (Redis is transport; the row is already committed). */
export async function publishProgress(kind: JobKind, id: string, event: ProgressEvent): Promise<void> {
  try {
    await redis().publish(progressChannel(kind, id), JSON.stringify(event));
  } catch (error) {
    console.warn(`[judge] progress publish failed for ${kind} ${id}:`, (error as Error).message);
  }
}

type FailWhere = { claimToken: string; nodeId: string } | { exhausted: true };

/**
 * Terminal infrastructure failure: INTERNAL_ERROR / FAILED / IE (and, for a
 * validation run, outcome FAILED). An IE is never a statement about the
 * student's code and is excluded from scoring.
 */
export async function markInternalError(
  kind: JobKind,
  id: string,
  where: FailWhere,
  context: { nodeId: string; reason: string; auditAction?: string },
): Promise<boolean> {
  const condition =
    "claimToken" in where
      ? Prisma.sql`"claimToken" = ${where.claimToken} AND "claimedByNodeId" = ${where.nodeId}
          AND "judgeState" IN ('DISPATCHED'::"JudgeState", 'RUNNING'::"JudgeState")`
      : // No live lease (a lease ending exactly now() is not claimable either).
        Prisma.sql`status IN ('QUEUED'::"SubmissionStatus", 'JUDGING'::"SubmissionStatus")
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= now())
          AND "attemptCount" >= 3`;
  const outcome = kind === "validation" ? Prisma.sql`, outcome = 'FAILED'::"ValidationOutcome"` : Prisma.empty;
  const rows = await db.$queryRaw<{ ownerId: string | null; attemptCount: number; language: string }[]>`
    UPDATE ${JOB_TABLE[kind]}
    SET status = 'INTERNAL_ERROR'::"SubmissionStatus", "judgeState" = 'FAILED'::"JudgeState",
        verdict = 'IE'::"Verdict", "claimToken" = NULL, "leaseExpiresAt" = NULL, "judgedAt" = now()
        ${outcome}
    WHERE id = ${id} AND ${condition}
    RETURNING ${OWNER_COLUMN[kind]} AS "ownerId", "attemptCount", "language"`;
  const row = rows[0];
  if (!row) return false;

  /**
   * Phase 10b. An IE written HERE is the only kind the verdict counter would
   * otherwise miss, and it is the one the alert is about: SPEC §10 calls the
   * INTERNAL_ERROR rate "the canary for a broken compiler image or a cgroup
   * misconfiguration after a host upgrade". A worker that hits an InfraError
   * never posts a verdict at all — it releases the lease and the job retries
   * — so `judge_verdict_total{verdict="IE"}` would have stayed at zero
   * however broken the judge hosts were, and the rule would have been a
   * comment.
   */
  verdictReached("IE", row.language);

  console.error(
    `[judge] !!! ${kind} ${id} marked INTERNAL_ERROR after ${row.attemptCount} attempt(s) ` +
      `(node ${context.nodeId}): ${context.reason}`,
  );
  await audit({
    actorId: null,
    action: context.auditAction ?? `judge.${kind}.internal_error`,
    entityType: JOB_ENTITY[kind],
    entityId: id,
    targetUserId: kind === "validation" ? null : row.ownerId,
    metadata: { attemptCount: row.attemptCount, nodeId: context.nodeId, reason: context.reason.slice(0, 500) },
  });
  await publishProgress(kind, id, { type: "final" });
  return true;
}

/** Why the lease UPDATE matched nothing. */
async function diagnose(kind: JobKind, id: string, node: JudgeNode): Promise<ClaimRefusal["reason"]> {
  const lane = kind === "submission" ? Prisma.sql`lane::text` : Prisma.sql`NULL::text`;
  const rows = await db.$queryRaw<
    { status: string; attemptCount: number; leaseLive: boolean; lane: string | null }[]
  >`
    SELECT status::text AS status, "attemptCount", ${lane} AS lane,
           ("leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" > now()) AS "leaseLive"
    FROM ${JOB_TABLE[kind]} WHERE id = ${id}`;
  const row = rows[0];
  if (!row) return "NOT_FOUND";
  if (row.lane !== null && !node.sensitiveLanesOk && isSensitiveLane(row.lane as JudgeLane)) {
    // Not this node's to judge; an eligible node will take it. No attempt is
    // consumed and nothing about the row changes.
    console.warn(`[judge] node ${node.id} may not claim ${row.lane} ${kind} ${id}: sensitive lanes withheld`);
    return "NOT_CLAIMABLE";
  }
  if (row.status !== "QUEUED" && row.status !== "JUDGING") return "NOT_CLAIMABLE";
  if (row.leaseLive) return "LEASED_ELSEWHERE";
  if (row.attemptCount >= 3) {
    const marked = await markInternalError(kind, id, { exhausted: true }, {
      nodeId: node.id,
      reason: "infrastructure retries exhausted",
    });
    // Not marked: another request changed the row in between; nothing to do.
    return marked ? "ATTEMPTS_EXHAUSTED" : "NOT_CLAIMABLE";
  }
  // The row became claimable between the UPDATE and this read (a lease
  // expired at that instant) — another worker will pick it up.
  return "LEASED_ELSEWHERE";
}

const versionSelect = {
  ioMode: true,
  sqlDialect: true,
  sqlOrdered: true,
  functionSignature: true,
  compareMode: true,
  floatEpsilon: true,
  scoringMode: true,
  stopOnFirstFailure: true,
  timeLimitMs: true,
  memoryLimitKb: true,
  checkerSha256: true,
  interactorSha256: true,
  testlibId: true,
  testCases: {
    orderBy: { index: "asc" },
    select: {
      index: true,
      isSample: true,
      points: true,
      subtaskIndex: true,
      input: { select: { sha256: true, sizeBytes: true } },
      output: { select: { sha256: true, sizeBytes: true } },
    },
  },
  subtasks: {
    orderBy: { index: "asc" },
    select: { index: true, points: true, aggregation: true, dependsOn: true },
  },
  languageLimits: { select: { language: true, timeLimitMs: true, memoryLimitKb: true } },
} satisfies Prisma.ProblemVersionSelect;

type VersionRow = Prisma.ProblemVersionGetPayload<{ select: typeof versionSelect }>;

const startupMsSchema = z.record(languageKeySchema, z.number().int().nonnegative());

/**
 * The node's startup credit for a language (JudgeNode.startupMs, reported at
 * boot); 0 when unknown. Capped at LIMITS.startupCredit.maxMs: a larger
 * credit means a broken toolchain, not a slow one (published on /judge).
 */
export function startupCreditFor(startupMs: unknown, language: string): number {
  const parsed = startupMsSchema.safeParse(startupMs);
  if (!parsed.success) return 0;
  const key = languageKeySchema.safeParse(language);
  return key.success ? Math.min(parsed.data[key.data] ?? 0, LIMITS.startupCredit.maxMs) : 0;
}

/** The version-derived parts of a spec input: tests, subtasks, checker, per-language limit. */
async function versionParts(
  row: VersionRow,
  language: string,
): Promise<Pick<JobSpecInput, "version" | "tests" | "subtasks" | "checker" | "interactor" | "languageLimit">> {
  const { testCases, subtasks, languageLimits, checkerSha256, interactorSha256, testlibId, ...version } = row;
  const testlibProgram = async (sha256: string, what: string): Promise<JobSpecChecker> => {
    const blob = await db.testBlob.findUnique({ where: { sha256 }, select: { sizeBytes: true } });
    if (!blob) throw new JobSpecError(`The version's ${what} blob is missing.`);
    return { sha256, sizeBytes: blob.sizeBytes, testlibId };
  };
  let checker: JobSpecChecker | null = null;
  if (version.compareMode === "CHECKER" && checkerSha256) {
    checker = await testlibProgram(checkerSha256, "checker");
  }
  // Phase 12l: the same resolution for the interactor, which a version has
  // instead of a checker rather than as well as one.
  let interactor: JobSpecChecker | null = null;
  if (version.compareMode === "INTERACTIVE" && interactorSha256) {
    interactor = await testlibProgram(interactorSha256, "interactor");
  }
  const limit = languageLimits.find((l) => l.language === language) ?? null;
  return {
    version,
    tests: testCases,
    subtasks,
    checker,
    interactor,
    languageLimit: limit ? { timeLimitMs: limit.timeLimitMs, memoryLimitKb: limit.memoryLimitKb } : null,
  };
}

async function loadSpecInput(
  kind: JobKind,
  id: string,
  claimToken: string,
  attempt: number,
  node: JudgeNode,
): Promise<JobSpecInput> {
  const common = { kind, id, claimToken, attempt };

  if (kind === "submission") {
    const row = await db.submission.findUnique({
      where: { id },
      select: {
        lane: true,
        language: true,
        source: { select: { source: true, archivedAt: true } },
        languageConfig: { select: { runtime: true } },
        problemVersion: { select: versionSelect },
      },
    });
    if (!row) throw new JobSpecError("The submission disappeared after it was claimed.");
    if (!row.source) throw new JobSpecError("The submission has no stored source.");
    // Rejudge selection already skips purged submissions; never judge an empty file.
    if (row.source.archivedAt || row.source.source === "") throw new JobSpecError("The submission's source was purged.");
    return {
      ...common,
      lane: row.lane,
      language: row.language,
      runtime: row.languageConfig.runtime,
      source: row.source.source,
      startupCreditMs: startupCreditFor(node.startupMs, row.language),
      ...(await versionParts(row.problemVersion, row.language)),
    };
  }

  if (kind === "run") {
    const row = await db.runRequest.findUnique({
      where: { id },
      select: {
        language: true,
        source: true,
        customInput: true,
        languageConfig: { select: { runtime: true } },
        problemVersion: { select: versionSelect },
      },
    });
    if (!row) throw new JobSpecError("The run request disappeared after it was claimed.");
    return {
      ...common,
      lane: "RUN",
      language: row.language,
      runtime: row.languageConfig.runtime,
      source: row.source,
      customInput: row.customInput,
      startupCreditMs: startupCreditFor(node.startupMs, row.language),
      ...(await versionParts(row.problemVersion, row.language)),
    };
  }

  const row = await db.validationRun.findUnique({
    where: { id },
    select: {
      language: true,
      languageConfig: { select: { runtime: true } },
      referenceSolution: { select: { source: true, expectedVerdict: true } },
      problemVersion: { select: versionSelect },
    },
  });
  if (!row) throw new JobSpecError("The validation run disappeared after it was claimed.");
  return {
    ...common,
    lane: "REJUDGE",
    language: row.language,
    runtime: row.languageConfig.runtime,
    source: row.referenceSolution.source,
    expectedVerdict: row.referenceSolution.expectedVerdict,
    startupCreditMs: startupCreditFor(node.startupMs, row.language),
    ...(await versionParts(row.problemVersion, row.language)),
  };
}

/** Claim a job for a node and build its spec, or explain why not. */
export async function claimJob(node: JudgeNode, request: ClaimRequest): Promise<ClaimOutcome> {
  if (node.status !== "ONLINE") return refuse("NOT_CLAIMABLE");
  const { kind, id } = request;
  const token = newClaimToken();

  const attempt = await lease(kind, id, node, token);
  if (attempt === null) return refuse(await diagnose(kind, id, node));

  try {
    const input = await loadSpecInput(kind, id, token, attempt, node);
    const spec =
      engineForIoMode(input.version.ioMode) === "postgres"
        ? buildSqlJobSpec({
            kind: input.kind,
            id: input.id,
            lane: input.lane,
            claimToken: input.claimToken,
            attempt: input.attempt,
            source: input.source,
            version: {
              sqlDialect: input.version.sqlDialect ?? null,
              sqlOrdered: input.version.sqlOrdered ?? null,
              stopOnFirstFailure: input.version.stopOnFirstFailure,
            },
            tests: [...input.tests],
          })
        : buildJudgeJobSpec(input);
    return { claimed: true, spec };
  } catch (error) {
    if (error instanceof JobSpecError) {
      // Bad data (corrupt runtime json, a version without tests …): no retry
      // can fix it, so fail the job now instead of burning three attempts.
      await markInternalError(kind, id, { claimToken: token, nodeId: node.id }, { nodeId: node.id, reason: error.message });
      return refuse("NOT_CLAIMABLE");
    }
    // Unexpected (e.g. a database hiccup): hand the lease back for a retry.
    await requeueLease(kind, id, node.id, token).catch(() => undefined);
    throw error;
  }
}
