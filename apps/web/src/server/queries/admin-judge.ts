import "server-only";
import { Queue } from "bullmq";
import { z } from "zod";
import type { JudgeLane as DbJudgeLane, JudgeNodeStatus, SubmissionOrigin, SubmissionStatus } from "@recx/db";
import {
  JUDGE_ENGINES,
  JUDGE_LANES,
  LIMITS,
  isVerdict,
  queueNameFor,
  type JudgeEngine,
  type JudgeLane,
  type Verdict,
} from "@recx/shared";
import { db } from "@/lib/db";
import { scopedStudentWhere, staffOnlyWhere, type StudentScope } from "@/lib/auth/scope";
import { activeOverride, defaultCaps, type JudgeCaps } from "@/lib/judge/caps";
import {
  ageMs,
  calibrationDeviation,
  depthFromCounts,
  fleetCalibrationMedian,
  hardeningState,
  isCalibrationOutlier,
  isHeartbeatStale,
  latencyKindFor,
  selfCheckState,
  summariseLanes,
  type CheckState,
  type LaneSummary,
  type LaneWindowStats,
  type QueueDepth,
} from "@/lib/judge/metrics";
import { redis } from "@/lib/redis";

/**
 * Read side of /admin/judge. Every figure is computed on request (the page
 * refreshes every 10 s); nothing here writes. BullMQ is read through
 * getJobCounts only, on the shared Redis connection, and a Redis outage
 * degrades to "unavailable" instead of failing the page.
 */

const HOUR_MS = 3_600_000;
/** QUEUED / JUDGING for longer than this is listed as stuck. */
export const STUCK_AFTER_MS = 2 * 60_000;
/** INTERNAL_ERROR rows from this far back are listed for rejudge. */
export const IE_LOOKBACK_MS = 7 * 24 * HOUR_MS;
const LIST_LIMIT = 50;
const REDIS_TIMEOUT_MS = 2_000;

const stringList = z.array(z.string()).catch([]);
function strings(value: unknown): string[] {
  return stringList.parse(value).slice(0, 50);
}

// ── Nodes ──────────────────────────────────────────────────────────────

export interface AdminNodeRow {
  id: string;
  hostname: string;
  status: JudgeNodeStatus;
  driver: string;
  /** Which engine judges here, from the driver (Phase 12k). */
  engine: JudgeEngine;
  workerVersion: string;
  isolateVersion: string;
  /** The engine's own version: PostgreSQL's on a SQL node, "" on an isolate one. */
  engineVersion: string;
  slots: number;
  busySlots: number;
  heartbeatAgeMs: number | null;
  heartbeatStale: boolean;
  calibrationScore: number | null;
  calibrationAgeMs: number | null;
  /** Signed deviation from the ONLINE fleet's median score. */
  calibrationDeviation: number | null;
  calibrationOutlier: boolean;
  selfCheckState: CheckState;
  selfCheckAgeMs: number | null;
  selfCheckFailures: string[];
  hardeningState: CheckState;
  hardeningFailures: string[];
  sensitiveLanesOk: boolean;
  laneRestrictions: string[];
  languages: string[];
  consecutiveIe: number;
  /** For the action buttons. */
  selfCheckOk: boolean | null;
  hostHardened: boolean | null;
}

export async function loadJudgeNodes(now: Date): Promise<{ nodes: AdminNodeRow[]; fleetMedian: number | null }> {
  const rows = await db.judgeNode.findMany({
    orderBy: { id: "asc" },
    select: {
      id: true,
      hostname: true,
      status: true,
      driver: true,
      workerVersion: true,
      isolateVersion: true,
      engineVersion: true,
      slots: true,
      busySlots: true,
      lastHeartbeatAt: true,
      calibrationScore: true,
      calibratedAt: true,
      selfCheckOk: true,
      lastSelfCheckAt: true,
      selfCheckFailures: true,
      hostHardened: true,
      hardeningFailures: true,
      sensitiveLanesOk: true,
      laneRestrictions: true,
      languages: true,
      consecutiveIe: true,
    },
  });
  // Per ENGINE, like the heartbeat's own median: a hello-world CPU score
  // from a database host measures nothing a C++ time limit is derived from.
  const fleetMedian = fleetCalibrationMedian(
    rows.filter((n) => n.driver !== "postgres"),
    now,
  );
  const nodes = rows.map((n): AdminNodeRow => {
    const deviation = calibrationDeviation(n.calibrationScore, fleetMedian);
    return {
      id: n.id,
      hostname: n.hostname,
      status: n.status,
      driver: n.driver,
      engine: n.driver === "postgres" ? "postgres" : "isolate",
      workerVersion: n.workerVersion,
      isolateVersion: n.isolateVersion,
      engineVersion: n.engineVersion,
      slots: n.slots,
      busySlots: n.busySlots,
      heartbeatAgeMs: ageMs(n.lastHeartbeatAt, now),
      heartbeatStale: isHeartbeatStale(n.lastHeartbeatAt, now),
      calibrationScore: n.calibrationScore,
      calibrationAgeMs: ageMs(n.calibratedAt, now),
      calibrationDeviation: deviation,
      calibrationOutlier: isCalibrationOutlier(deviation),
      selfCheckState: selfCheckState(n.selfCheckOk, n.lastSelfCheckAt, now),
      selfCheckAgeMs: ageMs(n.lastSelfCheckAt, now),
      selfCheckFailures: strings(n.selfCheckFailures),
      hardeningState: hardeningState(n.hostHardened),
      hardeningFailures: strings(n.hardeningFailures),
      sensitiveLanesOk: n.sensitiveLanesOk,
      laneRestrictions: strings(n.laneRestrictions),
      languages: strings(n.languages),
      consecutiveIe: n.consecutiveIe,
      selfCheckOk: n.selfCheckOk,
      hostHardened: n.hostHardened,
    };
  });
  return { nodes, fleetMedian };
}

// ── Queue depth (BullMQ, read-only) ────────────────────────────────────

const globalForAdminQueues = globalThis as unknown as { recxAdminQueues?: Map<string, Queue> };

function laneQueue(engine: JudgeEngine, lane: JudgeLane): Queue {
  globalForAdminQueues.recxAdminQueues ??= new Map();
  const name = queueNameFor(engine, lane);
  let q = globalForAdminQueues.recxAdminQueues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redis() });
    q.on("error", (err) => console.error(`[admin-judge] queue ${name} error:`, err.message));
    globalForAdminQueues.recxAdminQueues.set(name, q);
  }
  return q;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** One lane's depth summed over the engines, and the per-engine split. */
export interface LaneDepths {
  byLane: Partial<Record<JudgeLane, QueueDepth>>;
  byEngine: Record<JudgeEngine, QueueDepth>;
}

const emptyDepth = (): QueueDepth => ({ waiting: 0, active: 0, delayed: 0 });

function addDepth(into: QueueDepth, part: QueueDepth): QueueDepth {
  return {
    waiting: into.waiting + part.waiting,
    active: into.active + part.active,
    delayed: into.delayed + part.delayed,
  };
}

/**
 * Waiting / active / delayed per lane, or null when Redis cannot be read.
 *
 * Phase 12k: a lane has one queue PER ENGINE, and a lane's figure is the
 * sum — the question "is anybody waiting on PRACTICE" is about the lane,
 * not about which engine will take the job. The per-engine split is
 * returned beside it, because the answer to "why is PRACTICE backed up"
 * is usually one engine rather than both, and a page that only has the
 * sum cannot say which.
 */
export async function loadQueueDepths(): Promise<LaneDepths | null> {
  const pairs = JUDGE_ENGINES.flatMap((engine) => JUDGE_LANES.map((lane) => ({ engine, lane })));
  try {
    const counts = await withTimeout(
      Promise.all(
        pairs.map(({ engine, lane }) =>
          laneQueue(engine, lane).getJobCounts("waiting", "prioritized", "active", "delayed"),
        ),
      ),
      REDIS_TIMEOUT_MS,
    );
    const byLane: Partial<Record<JudgeLane, QueueDepth>> = {};
    const byEngine = Object.fromEntries(JUDGE_ENGINES.map((e) => [e, emptyDepth()])) as Record<JudgeEngine, QueueDepth>;
    pairs.forEach(({ engine, lane }, k) => {
      const depth = depthFromCounts(counts[k] ?? {});
      byLane[lane] = addDepth(byLane[lane] ?? emptyDepth(), depth);
      byEngine[engine] = addDepth(byEngine[engine], depth);
    });
    return { byLane, byEngine };
  } catch (error) {
    console.warn("[admin-judge] queue depth unavailable:", (error as Error).message);
    return null;
  }
}

// ── Queue latency over the last hour ──────────────────────────────────

const windowRowSchema = z.object({
  lane: z.string(),
  queued: z.coerce.number(),
  finished: z.coerce.number(),
  internalErrors: z.coerce.number(),
  p50: z.coerce.number().nullable(),
  p95: z.coerce.number().nullable(),
});
const laneSchema = z.enum(JUDGE_LANES);

function toWindow(raw: unknown, laneOverride?: JudgeLane): LaneWindowStats | null {
  const row = windowRowSchema.safeParse(raw);
  if (!row.success) return null;
  const lane = laneOverride ?? laneSchema.safeParse(row.data.lane).data;
  if (!lane) return null;
  return {
    lane,
    latencyKind: latencyKindFor(lane),
    queued: row.data.queued,
    finished: row.data.finished,
    internalErrors: row.data.internalErrors,
    p50Ms: row.data.p50,
    p95Ms: row.data.p95,
  };
}

/**
 * Submissions queued in the last hour, per lane. Wait = startedAt − queuedAt
 * for jobs a worker has taken; a job still QUEUED counts with its age so far
 * (a lower bound), so a backlog raises p95 instead of hiding from it. The
 * judgeState IN-list lets Postgres use the (judgeState, queuedAt) index.
 */
async function submissionWindows(): Promise<LaneWindowStats[]> {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT lane::text AS lane,
           count(*)::int AS queued,
           count(*) FILTER (WHERE status IN ('DONE', 'INTERNAL_ERROR'))::int AS finished,
           count(*) FILTER (WHERE status = 'INTERNAL_ERROR')::int AS "internalErrors",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY w.ms) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY w.ms) AS p95
    FROM "Submission" s
    CROSS JOIN LATERAL (
      SELECT CASE
               WHEN s."startedAt" IS NOT NULL THEN EXTRACT(EPOCH FROM (s."startedAt" - s."queuedAt")) * 1000
               WHEN s.status = 'QUEUED' THEN EXTRACT(EPOCH FROM (now() - s."queuedAt")) * 1000
             END AS ms
    ) w
    WHERE s."judgeState" IN ('PENDING', 'DISPATCHED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED')
      AND s."queuedAt" >= now() - interval '1 hour'
    GROUP BY lane`;
  return rows.map((r) => toWindow(r)).filter((w): w is LaneWindowStats => w !== null);
}

/**
 * Runs created in the last hour. Wait = startedAt − createdAt (a run still
 * waiting counts its wait so far). expiresAt = createdAt + TTL is indexed; it
 * narrows the scan, createdAt makes the edge exact.
 */
async function runWindow(): Promise<LaneWindowStats | null> {
  const narrowHours = LIMITS.customRun.ttlHours - 1;
  const rows = await db.$queryRaw<unknown[]>`
    SELECT 'RUN' AS lane,
           count(*)::int AS queued,
           count(*) FILTER (WHERE status IN ('DONE', 'INTERNAL_ERROR'))::int AS finished,
           count(*) FILTER (WHERE status = 'INTERNAL_ERROR')::int AS "internalErrors",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE("startedAt", now()) - "createdAt")) * 1000) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE("startedAt", now()) - "createdAt")) * 1000) AS p95
    FROM "RunRequest"
    WHERE "expiresAt" >= now() + make_interval(hours => ${narrowHours}::int) - interval '5 minutes'
      AND "createdAt" >= now() - interval '1 hour'`;
  return toWindow(rows[0], "RUN");
}

export interface ValidationWindow {
  queued: number;
  finished: number;
  internalErrors: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** Authoring-time validations (small volume): queue wait, like runs. */
async function validationWindow(): Promise<ValidationWindow> {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT 'VALIDATION' AS lane,
           count(*)::int AS queued,
           count(*) FILTER (WHERE status IN ('DONE', 'INTERNAL_ERROR'))::int AS finished,
           count(*) FILTER (WHERE status = 'INTERNAL_ERROR')::int AS "internalErrors",
           percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE("startedAt", now()) - "createdAt")) * 1000) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (COALESCE("startedAt", now()) - "createdAt")) * 1000) AS p95
    FROM "ValidationRun"
    WHERE "createdAt" >= now() - interval '1 hour'`;
  const row = windowRowSchema.safeParse(rows[0]);
  if (!row.success) return { queued: 0, finished: 0, internalErrors: 0, p50Ms: null, p95Ms: null };
  return {
    queued: row.data.queued,
    finished: row.data.finished,
    internalErrors: row.data.internalErrors,
    p50Ms: row.data.p50,
    p95Ms: row.data.p95,
  };
}

// ── Stuck and failed submissions ───────────────────────────────────────

export interface StuckSubmissionRow {
  id: string;
  status: SubmissionStatus;
  verdict: Verdict | null;
  lane: DbJudgeLane;
  origin: SubmissionOrigin;
  language: string;
  attemptCount: number;
  queuedAt: Date;
  judgedAt: Date | null;
  leaseExpiresAt: Date | null;
  nodeId: string | null;
  /** False for a submission of someone outside the viewer's AdminScope: identity redacted, no rejudge. */
  inScope: boolean;
  collegeId: string | null;
  studentName: string | null;
  problemCode: string;
  problemTitle: string;
}

export interface StuckSubmissions {
  stuck: StuckSubmissionRow[];
  stuckTotal: number;
  failed: StuckSubmissionRow[];
  failedTotal: number;
}

const stuckSelect = {
  id: true,
  status: true,
  verdict: true,
  lane: true,
  origin: true,
  language: true,
  attemptCount: true,
  queuedAt: true,
  judgedAt: true,
  leaseExpiresAt: true,
  claimedByNodeId: true,
  judgeNodeId: true,
  // No identity here: the fleet lists are unscoped; names come from a scoped lookup.
  userId: true,
  problem: { select: { displayCode: true, title: true } },
} as const;

type StuckRecord = {
  id: string;
  status: SubmissionStatus;
  verdict: string | null;
  lane: DbJudgeLane;
  origin: SubmissionOrigin;
  language: string;
  attemptCount: number;
  queuedAt: Date;
  judgedAt: Date | null;
  leaseExpiresAt: Date | null;
  claimedByNodeId: string | null;
  judgeNodeId: string | null;
  userId: string;
  problem: { displayCode: string; title: string };
};

type Identity = { collegeId: string; firstName: string; lastName: string };

function stuckRow(r: StuckRecord, identities: Map<string, Identity>): StuckSubmissionRow {
  const who = identities.get(r.userId);
  return {
    id: r.id,
    status: r.status,
    verdict: isVerdict(r.verdict) ? r.verdict : null,
    lane: r.lane,
    origin: r.origin,
    language: r.language,
    attemptCount: r.attemptCount,
    queuedAt: r.queuedAt,
    judgedAt: r.judgedAt,
    leaseExpiresAt: r.leaseExpiresAt,
    nodeId: r.claimedByNodeId ?? r.judgeNodeId,
    inScope: who !== undefined,
    collegeId: who ? who.collegeId : null,
    studentName: who ? `${who.firstName} ${who.lastName}` : null,
    problemCode: r.problem.displayCode,
    problemTitle: r.problem.title,
  };
}

export async function loadStuckSubmissions(scope: StudentScope, now: Date): Promise<StuckSubmissions> {
  const stuckWhere = {
    status: { in: ["QUEUED", "JUDGING"] as SubmissionStatus[] },
    queuedAt: { lt: new Date(now.getTime() - STUCK_AFTER_MS) },
  };
  const since = new Date(now.getTime() - IE_LOOKBACK_MS);
  const failedWhere = {
    status: "INTERNAL_ERROR" as const,
    OR: [{ judgedAt: { gte: since } }, { judgedAt: null, queuedAt: { gte: since } }],
  };
  const [stuck, stuckTotal, failed, failedTotal] = await Promise.all([
    db.submission.findMany({ where: stuckWhere, orderBy: { queuedAt: "asc" }, take: LIST_LIMIT, select: stuckSelect }),
    db.submission.count({ where: stuckWhere }),
    db.submission.findMany({ where: failedWhere, orderBy: { queuedAt: "desc" }, take: LIST_LIMIT, select: stuckSelect }),
    db.submission.count({ where: failedWhere }),
  ]);
  // Identities only for students inside the viewer's scope; the rest stay redacted.
  const userIds = [...new Set([...stuck, ...failed].map((r) => r.userId))];
  const people = userIds.length
    ? await db.user.findMany({
        where: scopedStudentWhere(scope, { id: { in: userIds } }),
        select: { id: true, collegeId: true, firstName: true, lastName: true },
      })
    : [];
  const identities = new Map(people.map((p) => [p.id, p] as const));
  return {
    stuck: stuck.map((r) => stuckRow(r, identities)),
    stuckTotal,
    failed: failed.map((r) => stuckRow(r, identities)),
    failedTotal,
  };
}

// ── Language mix and verdicts (last 24 h) ──────────────────────────────

export interface LanguageMixRow {
  language: string;
  submissions: number;
  judged: number;
  accepted: number;
}

const languageMixSchema = z.object({
  language: z.string(),
  submissions: z.coerce.number(),
  judged: z.coerce.number(),
  accepted: z.coerce.number(),
});

async function languageMix(): Promise<LanguageMixRow[]> {
  const rows = await db.$queryRaw<unknown[]>`
    SELECT language,
           count(*)::int AS submissions,
           count(*) FILTER (WHERE status = 'DONE')::int AS judged,
           count(*) FILTER (WHERE status = 'DONE' AND verdict = 'AC')::int AS accepted
    FROM "Submission"
    WHERE "createdAt" >= now() - interval '24 hours'
    GROUP BY language
    ORDER BY submissions DESC, language ASC`;
  return rows.flatMap((r) => {
    const parsed = languageMixSchema.safeParse(r);
    return parsed.success ? [parsed.data] : [];
  });
}

export interface VerdictCount {
  verdict: Verdict;
  count: number;
}

async function verdictDistribution(now: Date): Promise<VerdictCount[]> {
  const groups = await db.submission.groupBy({
    by: ["verdict"],
    where: { createdAt: { gte: new Date(now.getTime() - 24 * HOUR_MS) }, verdict: { not: null } },
    _count: { _all: true },
  });
  return groups
    .flatMap((g) => (isVerdict(g.verdict) ? [{ verdict: g.verdict, count: g._count._all }] : []))
    .sort((a, b) => b.count - a.count);
}

// ── Language configuration ─────────────────────────────────────────────

export interface LanguageConfigRow {
  id: string;
  key: string;
  label: string;
  toolchainId: string;
  version: string;
  enabled: boolean;
  isCurrent: boolean;
  retired: boolean;
}

async function languageConfigs(): Promise<LanguageConfigRow[]> {
  const rows = await db.languageConfig.findMany({
    orderBy: [{ key: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      key: true,
      label: true,
      toolchainId: true,
      version: true,
      enabled: true,
      isCurrent: true,
      retiredAt: true,
    },
  });
  return rows.map(({ retiredAt, ...r }) => ({ ...r, retired: retiredAt !== null }));
}

// ── Judge caps ─────────────────────────────────────────────────────────

export interface QuotaOverrideRow {
  id: string;
  collegeId: string;
  studentName: string;
  practicePerDay: number | null;
  runsPerHour: number | null;
  cpuMinutesPerDay: number | null;
  /** False when a newer active override for the same student replaces it. */
  inEffect: boolean;
  reason: string;
  grantedBy: string;
  expiresAt: Date | null;
  createdAt: Date;
}

async function activeQuotaOverrides(scope: StudentScope, now: Date): Promise<QuotaOverrideRow[]> {
  const rows = await db.judgeQuotaOverride.findMany({
    where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }], user: scopedStudentWhere(scope) },
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
    select: {
      id: true,
      userId: true,
      practicePerDay: true,
      runsPerHour: true,
      cpuMinutesPerDay: true,
      reason: true,
      grantedById: true,
      expiresAt: true,
      createdAt: true,
      user: { select: { collegeId: true, firstName: true, lastName: true } },
    },
  });
  const grantorIds = [...new Set(rows.map((r) => r.grantedById))];
  const grantors = grantorIds.length
    ? await db.user.findMany({
        where: staffOnlyWhere({ id: { in: grantorIds } }),
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const grantorName = new Map(grantors.map((g) => [g.id, `${g.firstName} ${g.lastName}`]));

  const byUser = new Map<string, typeof rows>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r]);

  return rows.map((r) => {
    const current = activeOverride(byUser.get(r.userId) ?? [], now);
    return {
      id: r.id,
      collegeId: r.user.collegeId,
      studentName: `${r.user.firstName} ${r.user.lastName}`,
      practicePerDay: r.practicePerDay,
      runsPerHour: r.runsPerHour,
      cpuMinutesPerDay: r.cpuMinutesPerDay,
      inEffect: current?.id === r.id,
      reason: r.reason,
      grantedBy: grantorName.get(r.grantedById) ?? "Unknown account",
      expiresAt: r.expiresAt,
      createdAt: r.createdAt,
    };
  });
}

// ── The page ───────────────────────────────────────────────────────────

export interface JudgeHealth {
  generatedAt: Date;
  nodes: AdminNodeRow[];
  fleetMedian: number | null;
  lanes: LaneSummary[];
  queueDepthAvailable: boolean;
  /** The same backlog, split by judging engine (Phase 12k). */
  engineDepths: Record<JudgeEngine, QueueDepth> | null;
  validation: ValidationWindow;
  stuck: StuckSubmissions;
  languageMix: LanguageMixRow[];
  verdicts: VerdictCount[];
  languages: LanguageConfigRow[];
  defaultCaps: JudgeCaps;
  overrides: QuotaOverrideRow[];
}

/**
 * Fleet figures are aggregates over every submission (no per-student rows);
 * the stuck and failed lists name only students inside `scope`, and only
 * their overrides are listed.
 */
export async function loadJudgeHealth(scope: StudentScope, now = new Date()): Promise<JudgeHealth> {
  const [nodeData, depths, submissionStats, runStats, validation, stuck, mix, verdicts, languages, overrides] =
    await Promise.all([
      loadJudgeNodes(now),
      loadQueueDepths(),
      submissionWindows(),
      runWindow(),
      validationWindow(),
      loadStuckSubmissions(scope, now),
      languageMix(),
      verdictDistribution(now),
      languageConfigs(),
      activeQuotaOverrides(scope, now),
    ]);
  const windows = runStats ? [...submissionStats.filter((w) => w.lane !== "RUN"), runStats] : submissionStats;
  return {
    generatedAt: now,
    nodes: nodeData.nodes,
    fleetMedian: nodeData.fleetMedian,
    lanes: summariseLanes(depths?.byLane ?? null, windows),
    queueDepthAvailable: depths !== null,
    engineDepths: depths?.byEngine ?? null,
    validation,
    stuck,
    languageMix: mix,
    verdicts,
    languages,
    defaultCaps: defaultCaps(),
    overrides,
  };
}
