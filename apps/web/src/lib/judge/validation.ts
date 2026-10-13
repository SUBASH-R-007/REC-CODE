import "server-only";
import type { DbTx, Prisma } from "@recx/db";
import {
  deriveTimeLimitMs,
  isLanguageKey,
  languageRuntimeSchema,
  supportsFunctionMode,
  type IoMode,
  type Verdict,
} from "@recx/shared";
import { CPP_MODEL_LANGUAGES, contentErrors, versionContentIssues } from "@recx/shared/authoring";
import { effectiveVerdict, validationOutcome } from "@recx/shared/harness";
import { audit } from "@/lib/audit";
import { loadVersionContentInput } from "@/lib/authoring/content-input";
import { testSetFingerprint } from "@/lib/authoring/fingerprint";
import { db } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { readBlobBytes, sha256Hex } from "@/lib/testdata/blobs";
import { prepareBundle, putBundle, testBundleFiles, type BundleTest, type PreparedBundle } from "@/lib/testdata/bundle";
import { getTestDataStore, type TestDataStore } from "@/lib/testdata/store";
import { enqueueJudge } from "./queue";
import { retryingTransaction } from "@/lib/authoring/retry";

/**
 * The validation pipeline: before a problem version is published, its
 * reference solutions are judged on real judge nodes (job kind "validation",
 * REJUDGE lane, never scored).
 *
 *   Stage 1  every model solution (expected AC) runs at the CPU ceiling, so
 *            it is measured rather than cut off. All must be AC.
 *   Limits   ProblemLanguageLimit for every enabled language: a language with
 *            a measured model solution gets deriveTimeLimitMs(2.5 × its worst
 *            model), the others the catalog's fallback multiplier.
 *   Stage 2  every deliberately-wrong solution runs at those derived limits
 *            and must produce its expected verdict (a brute force must TLE,
 *            a wrong answer must WA) — proof that the tests and limits
 *            actually separate right from wrong.
 *
 * Publishing is blocked unless a C++ (cpp17 / cpp20) model solution exists
 * and matched, every model solution matched, and every deliberately-wrong
 * solution matched (it did not pass). Reference solutions that cannot run —
 * a language that is not enabled, or (FUNCTION problems) a language with no
 * function harness — are reported, not counted.
 *
 * Validation is tied to the content it judged: every ValidationRun records
 * the version's judgeSeq, and only runs of the current judgeSeq count. An
 * edit that changes judging (tests, limits, references, comparator …) bumps
 * judgeSeq (src/lib/authoring/draft.ts), so earlier results stop counting.
 *
 * Publishing (publishVersion) additionally needs: the revision APPROVED by a
 * reviewer, no content errors (versionContentIssues, which includes the
 * declared-comparator rule), and the problem not RETIRED. The test bundle is
 * computed before the publish transaction, pinned in the UPDATE that freezes
 * the version and written to the store after the commit — drafts never
 * write bundles.
 *
 * This is a library: callers do their own RBAC (the CLI runs as an operator;
 * admin actions use the guards), and every mutation is audited here.
 */

// ── Pure decisions ───────────────────────────────────────────────────────

/** Shared with the import pipeline and the golden test: @recx/shared is the one definition. */
export { CPP_MODEL_LANGUAGES, effectiveVerdict, validationOutcome };

export type ValidationOutcomeValue = "PENDING" | "MATCHED" | "MISMATCHED" | "FAILED";
type JobStatus = "QUEUED" | "JUDGING" | "DONE" | "INTERNAL_ERROR" | "CANCELLED";

/** Stage 1 measures model solutions; stage 2 proves the deliberately-wrong ones fail. */
export function stageOf(expectedVerdict: Verdict): 1 | 2 {
  return expectedVerdict === "AC" ? 1 : 2;
}

export interface ValidationRunState {
  id: string;
  status: JobStatus;
  outcome: ValidationOutcomeValue;
  verdict: Verdict | null;
  measuredMs: number | null;
  createdAt: Date;
}

/** Why a reference solution cannot run here. */
export type UnrunnableReason = "disabled" | "no-harness";

export interface ReferenceState {
  id: string;
  language: string;
  label: string | null;
  expectedVerdict: Verdict;
  /** An enabled, current LanguageConfig exists for the language (and, for a FUNCTION problem, a harness). */
  runnable: boolean;
  /** When not runnable: why. Absent means "its language is not enabled". */
  unrunnable?: UnrunnableReason;
  /** The newest validation run of this reference solution (current judgeSeq), if any. */
  latest: ValidationRunState | null;
}

export type ValidationPhase =
  | "NOT_STARTED"
  | "STAGE1_RUNNING"
  | "STAGE1_FAILED"
  | "STAGE2_NEEDED"
  | "STAGE2_RUNNING"
  | "COMPLETE";

export interface ValidationSummary {
  phase: ValidationPhase;
  publishable: boolean;
  /** Why publishing is blocked right now (empty when publishable). */
  blockers: string[];
  /** Informational: reference solutions that cannot run here. */
  notes: string[];
  /** Runs still queued or judging in the current round. */
  pending: number;
  /** Stage-1 runs of the current round (model solutions), when stage 1 has started. */
  stage1RunIds: string[];
  /** Deliberately-wrong references that still need a stage-2 run in this round. */
  stage2Needed: string[];
}

function describe(ref: ReferenceState): string {
  return `${ref.label ?? "reference solution"} (${ref.language}, expected ${ref.expectedVerdict})`;
}

function unrunnableNote(ref: ReferenceState): string {
  return ref.unrunnable === "no-harness"
    ? `${describe(ref)} was not run: its language has no function harness`
    : `${describe(ref)} was not run: its language is not enabled`;
}

const isPendingStatus = (s: JobStatus) => s === "QUEUED" || s === "JUDGING";

function runProblem(ref: ReferenceState, run: ValidationRunState): string | null {
  if (run.outcome === "MATCHED") return null;
  if (run.status === "INTERNAL_ERROR" || run.outcome === "FAILED") {
    return `${describe(ref)}: the judge failed to run it (internal error)`;
  }
  return `${describe(ref)}: produced ${run.verdict ?? "no verdict"}`;
}

/**
 * Where a version's validation stands, from each reference solution's newest
 * run. The current round starts at the oldest stage-1 run of the newest
 * stage-1 set; a stage-2 run older than that belongs to an earlier round
 * (judged with earlier limits) and does not count.
 */
export function summarizeValidation(refs: readonly ReferenceState[]): ValidationSummary {
  const blockers: string[] = [];
  const notes = refs.filter((r) => !r.runnable).map(unrunnableNote);
  const models = refs.filter((r) => r.runnable && stageOf(r.expectedVerdict) === 1);
  const wrongs = refs.filter((r) => r.runnable && stageOf(r.expectedVerdict) === 2);

  const cppModels = refs.filter((r) => stageOf(r.expectedVerdict) === 1 && CPP_MODEL_LANGUAGES.includes(r.language));
  if (cppModels.length === 0) blockers.push("No C++ (cpp17 / cpp20) model solution exists.");
  else if (!cppModels.some((r) => r.runnable)) blockers.push("Every C++ model solution is in a language that is not enabled.");

  const result = (phase: ValidationPhase, extra: Partial<ValidationSummary> = {}): ValidationSummary => ({
    phase,
    publishable: phase === "COMPLETE" && blockers.length === 0,
    blockers,
    notes,
    pending: 0,
    stage1RunIds: [],
    stage2Needed: [],
    ...extra,
  });

  if (models.length === 0) {
    blockers.push("No model solution (expected AC) can be run.");
    return result("NOT_STARTED");
  }
  const stage1 = models.map((r) => r.latest);
  if (stage1.some((run) => run === null || run.status === "CANCELLED")) {
    blockers.push("Validation has not been started for every model solution.");
    return result("NOT_STARTED");
  }
  const stage1Runs = stage1 as ValidationRunState[];
  const stage1RunIds = stage1Runs.map((r) => r.id);
  const roundStart = Math.min(...stage1Runs.map((r) => r.createdAt.getTime()));

  const stage1Pending = stage1Runs.filter((r) => isPendingStatus(r.status)).length;
  if (stage1Pending > 0) {
    blockers.push(`Validation is still running: ${stage1Pending} model solution run(s) pending.`);
    return result("STAGE1_RUNNING", { pending: stage1Pending, stage1RunIds });
  }
  const stage1Problems = models.map((r) => runProblem(r, r.latest!)).filter((p): p is string => p !== null);
  if (stage1Problems.length > 0) {
    blockers.push(...stage1Problems.map((p) => `Model solution failed: ${p}.`));
    return result("STAGE1_FAILED", { stage1RunIds });
  }

  const current = (r: ReferenceState) =>
    r.latest !== null && r.latest.status !== "CANCELLED" && r.latest.createdAt.getTime() >= roundStart;
  const stage2Needed = wrongs.filter((r) => !current(r)).map((r) => r.id);
  if (stage2Needed.length > 0) {
    blockers.push(`Deliberately-wrong solutions have not been judged at the derived limits yet (${stage2Needed.length}).`);
    return result("STAGE2_NEEDED", { stage1RunIds, stage2Needed });
  }
  const stage2Pending = wrongs.filter((r) => isPendingStatus(r.latest!.status)).length;
  if (stage2Pending > 0) {
    blockers.push(`Validation is still running: ${stage2Pending} deliberately-wrong solution run(s) pending.`);
    return result("STAGE2_RUNNING", { pending: stage2Pending, stage1RunIds });
  }
  const stage2Problems = wrongs.map((r) => runProblem(r, r.latest!)).filter((p): p is string => p !== null);
  blockers.push(...stage2Problems.map((p) => `Deliberately-wrong solution did not fail as expected: ${p}.`));
  return result("COMPLETE", { stage1RunIds });
}

export interface EnabledLanguage {
  key: string;
  fallbackMultiplier: number;
  fallbackExtraMs: number;
}

export interface ModelMeasurement {
  language: string;
  measuredMs: number;
  /** "<workerVersion>/<nodeId>/<calibrationScore>" of the node that measured it. */
  generation: string;
}

export interface LanguageLimitRow {
  language: string;
  timeLimitMs: number;
  memoryLimitKb: number;
  measuredModelMs: number | null;
  measuredOnGeneration: string | null;
}

/**
 * ProblemLanguageLimit rows for every enabled language: measured languages
 * from their worst (slowest) model solution, the rest from the fallback
 * multiplier. Memory is the version's limit for every language.
 */
export function deriveLanguageLimits(input: {
  baseMs: number;
  memoryLimitKb: number;
  languages: readonly EnabledLanguage[];
  measurements: readonly ModelMeasurement[];
}): LanguageLimitRow[] {
  const worst = new Map<string, ModelMeasurement>();
  for (const m of input.measurements) {
    const seen = worst.get(m.language);
    if (!seen || m.measuredMs > seen.measuredMs) worst.set(m.language, m);
  }
  return [...input.languages]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((lang) => {
      const measured = worst.get(lang.key) ?? null;
      return {
        language: lang.key,
        timeLimitMs: deriveTimeLimitMs({
          baseMs: input.baseMs,
          measuredModelMs: measured ? measured.measuredMs : null,
          multiplier: lang.fallbackMultiplier,
          extraMs: lang.fallbackExtraMs,
        }),
        memoryLimitKb: input.memoryLimitKb,
        measuredModelMs: measured ? measured.measuredMs : null,
        measuredOnGeneration: measured ? measured.generation : null,
      };
    });
}

export function generationOf(run: { judgeNodeId: string | null; calibrationScore: number | null }, workerVersion: string | null): string {
  return `${workerVersion || "unknown"}/${run.judgeNodeId ?? "unknown"}/${run.calibrationScore ?? "uncalibrated"}`;
}

function sameLimits(a: readonly LanguageLimitRow[], b: readonly LanguageLimitRow[]): boolean {
  if (a.length !== b.length) return false;
  const key = (r: LanguageLimitRow) =>
    [r.language, r.timeLimitMs, r.memoryLimitKb, r.measuredModelMs, r.measuredOnGeneration].join("|");
  const left = new Set(a.map(key));
  return b.every((r) => left.has(key(r)));
}

/** Whether a reference solution can run here, and why not. */
export function referenceRunnability(
  language: string,
  ioMode: IoMode,
  enabled: ReadonlySet<string>,
): { runnable: boolean; unrunnable?: UnrunnableReason } {
  if (ioMode === "FUNCTION" && !(isLanguageKey(language) && supportsFunctionMode(language))) {
    return { runnable: false, unrunnable: "no-harness" };
  }
  if (!enabled.has(language)) return { runnable: false, unrunnable: "disabled" };
  return { runnable: true };
}

// ── Database ─────────────────────────────────────────────────────────────

export class ValidationSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationSetupError";
  }
}

type Client = typeof db | DbTx;

/** Serialises validation, edits and publish of one revision (transaction-scoped). */
export const lockVersion = (tx: DbTx, versionId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"validation:" + versionId}))`;

/** Serialises revision creation (one open draft per problem) and import of one problem. */
export const lockProblem = (tx: DbTx, problemId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"problem:" + problemId}))`;

/** Enabled, current LanguageConfig rows, one per language key (newest wins). */
async function enabledConfigs(client: Client): Promise<Map<string, { id: string; language: EnabledLanguage }>> {
  const rows = await client.languageConfig.findMany({
    where: { enabled: true, isCurrent: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, key: true, runtime: true },
  });
  const out = new Map<string, { id: string; language: EnabledLanguage }>();
  for (const row of rows) {
    const runtime = languageRuntimeSchema.safeParse(row.runtime);
    if (!runtime.success || runtime.data.key !== row.key) {
      console.error(`[validation] LanguageConfig ${row.id} (${row.key}) has an invalid runtime; skipped`);
      continue;
    }
    out.set(row.key, {
      id: row.id,
      language: {
        key: row.key,
        fallbackMultiplier: runtime.data.fallbackMultiplier,
        fallbackExtraMs: runtime.data.fallbackExtraMs,
      },
    });
  }
  return out;
}

const runSelect = {
  id: true,
  referenceSolutionId: true,
  status: true,
  outcome: true,
  verdict: true,
  measuredMs: true,
  createdAt: true,
  judgeNodeId: true,
  calibrationScore: true,
} satisfies Prisma.ValidationRunSelect;

type RunRow = Prisma.ValidationRunGetPayload<{ select: typeof runSelect }>;

interface LoadedState {
  version: {
    id: string;
    problemId: string;
    revision: number;
    frozenAt: Date | null;
    timeLimitMs: number;
    memoryLimitKb: number;
    ioMode: IoMode;
    judgeSeq: number;
    status: "DRAFT" | "IN_REVIEW" | "PUBLISHED" | "RETIRED";
    approvedAt: Date | null;
  };
  refs: ReferenceState[];
  latestRuns: Map<string, RunRow>;
  configs: Map<string, { id: string; language: EnabledLanguage }>;
}

async function loadState(client: Client, versionId: string): Promise<LoadedState> {
  const version = await client.problemVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      problemId: true,
      revision: true,
      frozenAt: true,
      timeLimitMs: true,
      memoryLimitKb: true,
      ioMode: true,
      judgeSeq: true,
      status: true,
      approvedAt: true,
      referenceSolutions: {
        orderBy: { createdAt: "asc" },
        select: { id: true, language: true, label: true, expectedVerdict: true },
      },
    },
  });
  if (!version) throw new ValidationSetupError(`Problem version ${versionId} does not exist.`);
  const configs = await enabledConfigs(client);
  // Only runs of the current content count: an edit that changes judging bumps judgeSeq.
  const runs = await client.validationRun.findMany({
    where: { problemVersionId: versionId, judgeSeq: version.judgeSeq },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: runSelect,
  });
  const latestRuns = new Map<string, RunRow>();
  for (const run of runs) if (!latestRuns.has(run.referenceSolutionId)) latestRuns.set(run.referenceSolutionId, run);

  const enabled = new Set(configs.keys());
  const refs: ReferenceState[] = version.referenceSolutions.map((r) => {
    const run = latestRuns.get(r.id) ?? null;
    return {
      id: r.id,
      language: r.language,
      label: r.label,
      expectedVerdict: r.expectedVerdict,
      ...referenceRunnability(r.language, version.ioMode, enabled),
      latest: run
        ? {
            id: run.id,
            status: run.status,
            outcome: run.outcome,
            verdict: run.verdict,
            measuredMs: run.measuredMs,
            createdAt: run.createdAt,
          }
        : null,
    };
  });
  const { referenceSolutions: _refs, ...versionRow } = version;
  return { version: versionRow, refs, latestRuns, configs };
}

/** The language limits a completed stage 1 implies. */
async function computeLimits(client: Client, state: LoadedState, summary: ValidationSummary): Promise<LanguageLimitRow[]> {
  const stage1 = new Set(summary.stage1RunIds);
  const modelRuns = [...state.latestRuns.values()].filter((r) => stage1.has(r.id));
  const nodeIds = [...new Set(modelRuns.map((r) => r.judgeNodeId).filter((id): id is string => id !== null))];
  const nodes = await client.judgeNode.findMany({ where: { id: { in: nodeIds } }, select: { id: true, workerVersion: true } });
  const workerVersion = new Map(nodes.map((n) => [n.id, n.workerVersion]));
  const refLanguage = new Map(state.refs.map((r) => [r.id, r.language]));
  const measurements: ModelMeasurement[] = modelRuns.flatMap((run) => {
    const language = refLanguage.get(run.referenceSolutionId);
    if (!language || run.measuredMs === null) return [];
    return [
      {
        language,
        measuredMs: run.measuredMs,
        generation: generationOf(run, run.judgeNodeId ? (workerVersion.get(run.judgeNodeId) ?? null) : null),
      },
    ];
  });
  return deriveLanguageLimits({
    baseMs: state.version.timeLimitMs,
    memoryLimitKb: state.version.memoryLimitKb,
    languages: [...state.configs.values()].map((c) => c.language),
    measurements,
  });
}

/** Replace a DRAFT version's ProblemLanguageLimit rows when they differ. Returns true when written. */
async function writeLimits(tx: DbTx, versionId: string, rows: readonly LanguageLimitRow[]): Promise<boolean> {
  const existing = await tx.problemLanguageLimit.findMany({
    where: { problemVersionId: versionId },
    select: { language: true, timeLimitMs: true, memoryLimitKb: true, measuredModelMs: true, measuredOnGeneration: true },
  });
  if (sameLimits(existing, rows)) return false;
  await tx.problemLanguageLimit.deleteMany({ where: { problemVersionId: versionId } });
  await tx.problemLanguageLimit.createMany({ data: rows.map((r) => ({ problemVersionId: versionId, ...r })) });
  return true;
}

/** Enqueue committed validation runs on the background lane and mark them DISPATCHED. */
async function dispatchRuns(ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const queued = await enqueueJudge("validation", id, "REJUDGE");
    if (queued) await db.validationRun.updateMany({ where: { id, judgeState: "PENDING" }, data: { judgeState: "DISPATCHED" } });
  }
}

/**
 * Make sure every QUEUED validation run of a version has a live BullMQ job
 * (enqueueJudge is idempotent per job id and replaces a completed one) — for
 * a run whose enqueue failed while Redis was down, or whose job ended without
 * a result. The CLI calls this while it waits; it is what the reconciler
 * does for submissions and runs.
 */
export async function redispatchQueuedRuns(versionId: string): Promise<number> {
  const queued = await db.validationRun.findMany({
    where: { problemVersionId: versionId, status: "QUEUED" },
    select: { id: true },
  });
  await dispatchRuns(queued.map((r) => r.id));
  return queued.length;
}

export interface ValidationStatus extends ValidationSummary {
  versionId: string;
  problemId: string;
  revision: number;
  frozen: boolean;
  /** The content generation the counted runs judged (ProblemVersion.judgeSeq). */
  judgeSeq: number;
  /** status IN_REVIEW with approvedAt set. */
  approved: boolean;
}

function statusOf(state: LoadedState, versionId: string): ValidationStatus {
  return {
    ...summarizeValidation(state.refs),
    versionId,
    problemId: state.version.problemId,
    revision: state.version.revision,
    frozen: state.version.frozenAt !== null,
    judgeSeq: state.version.judgeSeq,
    approved: state.version.status === "IN_REVIEW" && state.version.approvedAt !== null,
  };
}

export async function getValidationStatus(versionId: string): Promise<ValidationStatus> {
  return statusOf(await loadState(db, versionId), versionId);
}

/** The same, read inside a caller's transaction (the approve gate). */
export async function getValidationStatusTx(tx: DbTx, versionId: string): Promise<ValidationStatus> {
  return statusOf(await loadState(tx, versionId), versionId);
}

/**
 * Start a validation round for an unpublished version: stage-1 runs for
 * every runnable model solution (pending runs of an earlier round are
 * cancelled). Stage 2 follows automatically when stage 1 has matched
 * (advanceValidation, called after every validation result). Every run
 * records the version's current judgeSeq.
 */
export async function startValidation(
  versionId: string,
  options: { requestedById: string | null; via: string; ipHash?: string | null },
): Promise<{ runIds: string[]; cancelled: number; notes: string[] }> {
  const { runIds, cancelled, notes, problemId, revision, judgeSeq } = await retryingTransaction(
    async (tx) => {
      await lockVersion(tx, versionId);
      const state = await loadState(tx, versionId);
      if (state.version.frozenAt) throw new ValidationSetupError("This version is published and frozen; create a new revision.");
      const models = state.refs.filter((r) => stageOf(r.expectedVerdict) === 1 && r.runnable);
      if (models.length === 0) throw new ValidationSetupError("No model solution (expected AC) in an enabled language.");

      const superseded = await tx.validationRun.updateMany({
        where: { problemVersionId: versionId, status: { in: ["QUEUED", "JUDGING"] } },
        data: { status: "CANCELLED", judgeState: "CANCELLED", claimToken: null, leaseExpiresAt: null },
      });
      const ids: string[] = [];
      for (const ref of models) {
        const run = await tx.validationRun.create({
          data: {
            problemVersionId: versionId,
            referenceSolutionId: ref.id,
            language: ref.language,
            languageConfigId: state.configs.get(ref.language)!.id,
            requestedById: options.requestedById,
            judgeSeq: state.version.judgeSeq,
          },
          select: { id: true },
        });
        ids.push(run.id);
      }
      return {
        runIds: ids,
        cancelled: superseded.count,
        notes: summarizeValidation(state.refs).notes,
        problemId: state.version.problemId,
        revision: state.version.revision,
        judgeSeq: state.version.judgeSeq,
      };
    },
    { timeout: 30_000 },
  );

  await audit({
    actorId: options.requestedById,
    action: "problem.validation.started",
    entityType: "ProblemVersion",
    entityId: versionId,
    sensitivity: "NORMAL",
    metadata: { problemId, revision, stage: 1, runs: runIds.length, cancelled, judgeSeq, via: options.via },
    ipHash: options.ipHash ?? null,
  });
  await dispatchRuns(runIds);
  return { runIds, cancelled, notes };
}

/**
 * Move a version's validation forward. Idempotent and safe to call from
 * anywhere at any time (it is called after every validation result, and the
 * CLI calls it while it waits): once every model solution matched it writes
 * the derived ProblemLanguageLimit rows to the draft and starts stage 2 for
 * deliberately-wrong solutions that have no run in this round yet.
 */
export async function advanceValidation(versionId: string): Promise<{ stage2Runs: string[]; limitsWritten: boolean }> {
  const outcome = await retryingTransaction(
    async (tx) => {
      await lockVersion(tx, versionId);
      const state = await loadState(tx, versionId);
      if (state.version.frozenAt) return { stage2Runs: [], limitsWritten: false, problemId: state.version.problemId };
      const summary = summarizeValidation(state.refs);
      if (!["STAGE2_NEEDED", "STAGE2_RUNNING", "COMPLETE"].includes(summary.phase)) {
        return { stage2Runs: [], limitsWritten: false, problemId: state.version.problemId };
      }
      const limitsWritten = await writeLimits(tx, versionId, await computeLimits(tx, state, summary));
      const ids: string[] = [];
      for (const refId of summary.stage2Needed) {
        const ref = state.refs.find((r) => r.id === refId)!;
        const run = await tx.validationRun.create({
          data: {
            problemVersionId: versionId,
            referenceSolutionId: ref.id,
            language: ref.language,
            languageConfigId: state.configs.get(ref.language)!.id,
            judgeSeq: state.version.judgeSeq,
          },
          select: { id: true },
        });
        ids.push(run.id);
      }
      return { stage2Runs: ids, limitsWritten, problemId: state.version.problemId };
    },
    { timeout: 30_000 },
  );

  if (outcome.limitsWritten || outcome.stage2Runs.length > 0) {
    await audit({
      actorId: null,
      action: "problem.validation.stage2_started",
      entityType: "ProblemVersion",
      entityId: versionId,
      sensitivity: "NORMAL",
      metadata: { problemId: outcome.problemId, limitsWritten: outcome.limitsWritten, runs: outcome.stage2Runs.length },
    });
  }
  await dispatchRuns(outcome.stage2Runs);
  return { stage2Runs: outcome.stage2Runs, limitsWritten: outcome.limitsWritten };
}

// ── Bundles (written once, after the freeze) ──────────────────────────────

const bundleTestSelect = {
  index: true,
  isSample: true,
  subtaskIndex: true,
  points: true,
  inputSha256: true,
  outputSha256: true,
  input: { select: { sha256: true, sizeBytes: true, inline: true, storageKey: true } },
  output: { select: { sha256: true, sizeBytes: true, inline: true, storageKey: true } },
} satisfies Prisma.TestCaseSelect;

interface VersionBundle {
  problemId: string;
  revision: number;
  frozenAt: Date | null;
  bundleKey: string | null;
  manifestSha256: string | null;
  /** testSetFingerprint of the tests the bundle was built from. */
  fingerprint: string;
  prepared: PreparedBundle;
}

/** Read a version's tests from the store and compute (not write) its bundle. */
async function computeVersionBundle(versionId: string, store: TestDataStore): Promise<VersionBundle> {
  const version = await db.problemVersion.findUnique({
    where: { id: versionId },
    select: {
      problemId: true,
      revision: true,
      frozenAt: true,
      bundleKey: true,
      manifestSha256: true,
      testCases: { orderBy: { index: "asc" }, select: bundleTestSelect },
    },
  });
  if (!version) throw new ValidationSetupError(`Problem version ${versionId} does not exist.`);
  const tests: BundleTest[] = [];
  for (const t of version.testCases) {
    tests.push({
      index: t.index,
      isSample: t.isSample,
      subtask: t.subtaskIndex,
      input: await readBlobBytes(store, t.input),
      output: await readBlobBytes(store, t.output),
    });
  }
  const prepared = await prepareBundle({ problemId: version.problemId, revision: version.revision, files: testBundleFiles(tests) });
  return {
    problemId: version.problemId,
    revision: version.revision,
    frozenAt: version.frozenAt,
    bundleKey: version.bundleKey,
    manifestSha256: version.manifestSha256,
    fingerprint: testSetFingerprint(version.testCases),
    prepared,
  };
}

/** True when the store already holds other bytes under one of the bundle's keys (a stale pre-Phase-4 draft bundle). */
async function bundleKeysTaken(store: TestDataStore, prepared: PreparedBundle): Promise<boolean> {
  for (const [key, bytes] of [
    [prepared.bundleKey, prepared.archive],
    [prepared.manifestKey, prepared.manifestBytes],
  ] as const) {
    if (!(await store.exists(key))) continue;
    if (sha256Hex(await store.get(key)) !== sha256Hex(bytes)) return true;
  }
  return false;
}

export type BundleRepairStatus = "ok" | "written" | "no-bundle" | "mismatch";

/**
 * Repair a published revision's bundle: recompute its deterministic bytes
 * from the frozen tests and write them if the store lacks them (a put that
 * failed after the publish committed). Refuses to write when the recomputed
 * manifest does not match the pinned manifestSha256. Never touches the row
 * (it is frozen).
 */
export async function ensurePublishedBundle(versionId: string): Promise<{ status: BundleRepairStatus; bundleKey: string | null }> {
  const store = getTestDataStore();
  const bundle = await computeVersionBundle(versionId, store);
  if (!bundle.frozenAt) throw new ValidationSetupError("Only a published revision has a bundle; drafts never write one.");
  if (!bundle.bundleKey || !bundle.manifestSha256) return { status: "no-bundle", bundleKey: null };
  if (bundle.prepared.manifestSha256 !== bundle.manifestSha256 || bundle.prepared.bundleKey !== bundle.bundleKey) {
    return { status: "mismatch", bundleKey: bundle.bundleKey };
  }
  const present = (await store.exists(bundle.prepared.bundleKey)) && (await store.exists(bundle.prepared.manifestKey));
  if (present && !(await bundleKeysTaken(store, bundle.prepared))) return { status: "ok", bundleKey: bundle.bundleKey };
  if (present) return { status: "mismatch", bundleKey: bundle.bundleKey };
  await putBundle(bundle.prepared, store);
  return { status: "written", bundleKey: bundle.bundleKey };
}

// ── Publish ──────────────────────────────────────────────────────────────

export type PublishResult =
  | { ok: true; problemId: string; versionId: string; revision: number }
  | { ok: false; reason: "BLOCKED"; blockers: string[] }
  | { ok: false; reason: "CONFLICT"; message: string };

class PublishAbort extends Error {
  constructor(readonly result: Extract<PublishResult, { ok: false }>) {
    super(result.reason);
  }
}

export const ALREADY_PUBLISHED_MESSAGE = "This version is already published.";
export const PUBLISH_CONFLICT_MESSAGE = "The problem was published or changed concurrently. Reload and try again.";
export const NOT_APPROVED_BLOCKER =
  "This revision has not been approved. Submit it for review; a second admin must approve it before it can be published.";
export const RETIRED_BLOCKER = "The problem is retired. A retired problem cannot be published again.";

export interface PublishOptions {
  actorId: string | null;
  via: string;
  /** Problem.version the caller saw. Omitted (CLI): the current one. */
  expectedProblemVersion?: number;
  /**
   * Default true: only an APPROVED revision (status IN_REVIEW, approvedAt
   * set) publishes. The pre-review library tests pass false.
   */
  requireApproval?: boolean;
  ipHash?: string | null;
}

/**
 * Publish a validated, approved revision: write its language limits and
 * model timings, freeze it with its bundle keys, and flip
 * Problem.liveVersionId — all in one transaction. The flip is guarded by
 * Problem.version (optimistic concurrency): of two concurrent publishes of
 * the same problem exactly one succeeds and the other gets CONFLICT and
 * changes nothing. The bundle bytes are written after the commit; a failed
 * write is audited and repaired by ensurePublishedBundle (RUNBOOK).
 */
export async function publishVersion(versionId: string, options: PublishOptions): Promise<PublishResult> {
  const requireApproval = options.requireApproval ?? true;
  const store = getTestDataStore();
  try {
    const head = await db.problemVersion.findUnique({ where: { id: versionId }, select: { frozenAt: true } });
    if (!head) throw new ValidationSetupError(`Problem version ${versionId} does not exist.`);
    if (head.frozenAt) throw new PublishAbort({ ok: false, reason: "CONFLICT", message: ALREADY_PUBLISHED_MESSAGE });
    const bundle = await computeVersionBundle(versionId, store);
    if (bundle.frozenAt) throw new PublishAbort({ ok: false, reason: "CONFLICT", message: ALREADY_PUBLISHED_MESSAGE });
    // A key that already holds other bytes cannot be written (keys are immutable): publish without a bundle.
    const keysTaken = await bundleKeysTaken(store, bundle.prepared);

    const published = await retryingTransaction(
      async (tx) => {
        await lockVersion(tx, versionId);
        const state = await loadState(tx, versionId);
        if (state.version.frozenAt) {
          throw new PublishAbort({ ok: false, reason: "CONFLICT", message: ALREADY_PUBLISHED_MESSAGE });
        }
        const problem = await tx.problem.findUnique({
          where: { id: state.version.problemId },
          select: { id: true, slug: true, version: true, liveVersionId: true, status: true },
        });
        if (!problem) throw new ValidationSetupError("The problem disappeared.");

        const summary = summarizeValidation(state.refs);
        const content = await loadVersionContentInput(tx, versionId);
        const blockers = [
          ...summary.blockers,
          ...(content ? contentErrors(versionContentIssues(content)).map((i) => i.message) : ["The revision has no content."]),
        ];
        if (requireApproval && !(state.version.status === "IN_REVIEW" && state.version.approvedAt !== null)) {
          blockers.push(NOT_APPROVED_BLOCKER);
        }
        if (problem.status === "RETIRED") blockers.push(RETIRED_BLOCKER);
        if (blockers.length > 0) throw new PublishAbort({ ok: false, reason: "BLOCKED", blockers });

        const rows = await tx.testCase.findMany({
          where: { problemVersionId: versionId },
          select: { index: true, isSample: true, subtaskIndex: true, points: true, inputSha256: true, outputSha256: true },
        });
        if (testSetFingerprint(rows) !== bundle.fingerprint) {
          throw new PublishAbort({
            ok: false,
            reason: "CONFLICT",
            message: "The tests of this revision changed while it was being published. Reload and try again.",
          });
        }
        const expected = options.expectedProblemVersion ?? problem.version;

        // Children first: once frozenAt is set, the version and its children are immutable.
        await writeLimits(tx, versionId, await computeLimits(tx, state, summary));
        const stage1 = new Set(summary.stage1RunIds);
        for (const run of state.latestRuns.values()) {
          if (!stage1.has(run.id) || run.measuredMs === null) continue;
          await tx.referenceSolution.update({ where: { id: run.referenceSolutionId }, data: { measuredMs: run.measuredMs } });
        }
        const now = new Date();
        const version = await tx.problemVersion.update({
          where: { id: versionId },
          data: {
            status: "PUBLISHED",
            frozenAt: now,
            publishedAt: now,
            bundleKey: keysTaken ? null : bundle.prepared.bundleKey,
            manifestSha256: keysTaken ? null : bundle.prepared.manifestSha256,
          },
          select: { title: true, difficulty: true },
        });
        const flipped = await tx.problem.updateMany({
          where: { id: problem.id, version: expected },
          data: {
            liveVersionId: versionId,
            status: "PUBLISHED",
            title: version.title,
            difficulty: version.difficulty,
            version: { increment: 1 },
          },
        });
        if (flipped.count === 0) {
          throw new PublishAbort({ ok: false, reason: "CONFLICT", message: PUBLISH_CONFLICT_MESSAGE });
        }
        return {
          problemId: problem.id,
          slug: problem.slug,
          previous: problem.liveVersionId,
          revision: state.version.revision,
          problemVersion: expected + 1,
        };
      },
      { timeout: 30_000 },
    );

    // After the commit: the frozen row pins the keys; write their bytes.
    let bundleWritten = false;
    if (!keysTaken) {
      try {
        await putBundle(bundle.prepared, store);
        bundleWritten = true;
      } catch (error) {
        console.error(`[publish] bundle write failed for ${versionId}; repair with scripts/check-approved.ts --repair-bundles`, error);
      }
    }
    if (!bundleWritten) {
      await audit({
        actorId: options.actorId,
        action: "problem.bundle.write_failed",
        entityType: "ProblemVersion",
        entityId: versionId,
        sensitivity: "SENSITIVE",
        metadata: {
          problemId: published.problemId,
          revision: published.revision,
          reason: keysTaken ? "key_holds_other_bytes" : "store_put_failed",
          bundleKey: bundle.prepared.bundleKey,
          via: options.via,
        },
        ipHash: options.ipHash ?? null,
      });
    }
    await audit({
      actorId: options.actorId,
      action: "problem.published",
      entityType: "Problem",
      entityId: published.problemId,
      sensitivity: "SENSITIVE",
      metadata: {
        slug: published.slug,
        revision: published.revision,
        versionId,
        previousVersionId: published.previous,
        problemVersion: published.problemVersion,
        bundleWritten,
        via: options.via,
      },
      ipHash: options.ipHash ?? null,
    });
    return { ok: true, problemId: published.problemId, versionId, revision: published.revision };
  } catch (error) {
    if (error instanceof PublishAbort) return error.result;
    throw error;
  }
}

// ── New revisions ────────────────────────────────────────────────────────

/**
 * Clone a version (normally the live one) into a new DRAFT revision: every
 * child is copied — test cases (by blob reference), subtasks, reference
 * solutions, starter code, the hints, the editorial and the checker — but
 * not the language limits or validation runs, which belong to a validation
 * of the new revision, and not the review state (submission, approval) or
 * the import hash. Topic and company tags (ProblemTag, ProblemCompanyTag)
 * belong to the Problem, not to a version, so every revision keeps them
 * without a copy. No bundle is written: bundles are written once, by publish.
 *
 * refuseIfDraftExists (the admin UI and import): under the problem lock,
 * refuse with ConflictError when the problem already has an open draft —
 * one open draft per problem.
 */
export async function cloneVersionAsDraft(
  sourceVersionId: string,
  options: { createdById: string | null; via: string; refuseIfDraftExists?: boolean; ipHash?: string | null },
): Promise<{ versionId: string; revision: number }> {
  const source = await db.problemVersion.findUnique({
    where: { id: sourceVersionId },
    include: {
      testCases: true,
      starterCodes: true,
      referenceSolutions: true,
      subtasks: true,
      hints: { orderBy: { tier: "asc" } },
      editorial: true,
    },
  });
  if (!source) throw new ValidationSetupError(`Problem version ${sourceVersionId} does not exist.`);

  const created = await retryingTransaction(
    async (tx) => {
      if (options.refuseIfDraftExists) {
        await lockProblem(tx, source.problemId);
        const open = await tx.problemVersion.findFirst({
          where: { problemId: source.problemId, frozenAt: null },
          select: { revision: true },
        });
        if (open) throw new ConflictError(`Revision ${open.revision} is already an open draft of this problem.`);
      }
      const last = await tx.problemVersion.findFirst({
        where: { problemId: source.problemId },
        orderBy: { revision: "desc" },
        select: { revision: true },
      });
      const revision = (last?.revision ?? 0) + 1;
      const version = await tx.problemVersion.create({
        data: {
          problemId: source.problemId,
          revision,
          status: "DRAFT",
          title: source.title,
          difficulty: source.difficulty,
          statementMd: source.statementMd,
          constraints: source.constraints as Prisma.InputJsonValue,
          ioMode: source.ioMode,
          functionSignature: (source.functionSignature ?? undefined) as Prisma.InputJsonValue | undefined,
          compareMode: source.compareMode,
          floatEpsilon: source.floatEpsilon,
          scoringMode: source.scoringMode,
          stopOnFirstFailure: source.stopOnFirstFailure,
          timeLimitMs: source.timeLimitMs,
          memoryLimitKb: source.memoryLimitKb,
          checkerSha256: source.checkerSha256,
          testlibId: source.testlibId,
          origin: source.origin,
          createdById: options.createdById,
          lastEditedById: options.createdById,
        },
        select: { id: true },
      });
      const versionId = version.id;
      if (source.testCases.length > 0) {
        await tx.testCase.createMany({
          data: source.testCases.map((t) => ({
            problemVersionId: versionId,
            index: t.index,
            isSample: t.isSample,
            inputSha256: t.inputSha256,
            outputSha256: t.outputSha256,
            points: t.points,
            subtaskIndex: t.subtaskIndex,
          })),
        });
      }
      if (source.subtasks.length > 0) {
        await tx.subtask.createMany({
          data: source.subtasks.map((s) => ({
            problemVersionId: versionId,
            index: s.index,
            points: s.points,
            aggregation: s.aggregation,
            dependsOn: s.dependsOn,
          })),
        });
      }
      if (source.starterCodes.length > 0) {
        await tx.starterCode.createMany({
          data: source.starterCodes.map((s) => ({ problemVersionId: versionId, language: s.language, code: s.code })),
        });
      }
      if (source.referenceSolutions.length > 0) {
        await tx.referenceSolution.createMany({
          data: source.referenceSolutions.map((r) => ({
            problemVersionId: versionId,
            language: r.language,
            label: r.label,
            source: r.source,
            expectedVerdict: r.expectedVerdict,
          })),
        });
      }
      if (source.hints.length > 0) {
        await tx.hint.createMany({
          data: source.hints.map((h) => ({ problemVersionId: versionId, tier: h.tier, contentMd: h.contentMd })),
        });
      }
      if (source.editorial) {
        await tx.editorial.create({ data: { problemVersionId: versionId, contentMd: source.editorial.contentMd } });
      }
      return { versionId, revision };
    },
    { timeout: 30_000 },
  );

  await audit({
    actorId: options.createdById,
    action: "problem.revision.created",
    entityType: "ProblemVersion",
    entityId: created.versionId,
    sensitivity: "NORMAL",
    metadata: { problemId: source.problemId, revision: created.revision, fromVersionId: sourceVersionId, via: options.via },
    ipHash: options.ipHash ?? null,
  });
  return created;
}
