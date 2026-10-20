import { Prisma, type Db, type DbTx } from "@recx/db";
import {
  JUDGE_LANES,
  JUDGE_NODE_STATUSES,
  LIMITS,
  SENSITIVE_LANES,
  jobKindSchema,
  type JobKind,
  type JudgeLane,
  type ProgressEvent,
} from "@recx/shared";
import type { Logger } from "pino";
import { z } from "zod";
import {
  BATCH_SIZE,
  MAX_BATCHES_PER_PHASE,
  MAX_TTL_BATCHES,
  QUEUED_GRACE_MS,
  RETENTION_DELETE_BATCH,
  RETENTION_SETTING_KEY,
  SELF_CHECK_STALE_RESTRICTION,
  TTL_DELETE_BATCH,
  classifyLease,
  classifyNode,
  classifyNodeLanes,
  classifyQueued,
  classifyRetention,
  jobLane,
  partition,
  type RetentionDecision,
} from "./classify";
import { ensureJob, type JudgeQueuePort } from "./queues";

/**
 * The judge reconciler — one tick every RECONCILER_INTERVAL_MS.
 *
 * Postgres is truth, Redis is transport: a Redis flush loses queue position
 * and zero submissions, because every tick re-derives what must be queued
 * from the rows themselves. Three kinds of row are judged — Submission (on
 * its own lane: ASSESSMENT, CONTEST, RUN, PRACTICE or REJUDGE), RunRequest
 * (always RUN) and ValidationRun (always REJUDGE) — and each is reconciled
 * the same way. One tick, in order:
 *
 *   (c) node sweep   ONLINE/DRAINING nodes silent for > JUDGE_OFFLINE_AFTER_MS
 *                    go OFFLINE and their JUDGING leases (all three kinds) are
 *                    expired now, so (b) below reclaims that work in this same
 *                    tick. In the same pass, lane hygiene (e): an ONLINE node
 *                    still marked sensitiveLanesOk whose self-check is older
 *                    than LIMITS.selfCheck.staleAfterMs loses ASSESSMENT and
 *                    CONTEST (defence in depth — the web app's heartbeat
 *                    normally recomputes this every 5 s);
 *   (a) dispatch     QUEUED rows older than QUEUED_GRACE_MS get a live BullMQ
 *                    job (jobId = row id) and judgeState DISPATCHED;
 *   (b) leases       JUDGING rows whose lease lapsed go back to QUEUED and are
 *                    re-enqueued, or — on the last attempt — become
 *                    INTERNAL_ERROR with verdict IE (excluded from scoring; a
 *                    ValidationRun's outcome becomes FAILED);
 *   (d) TTL          RunRequest rows past expiresAt are deleted;
 *   (f) retention    SubmissionTestDetail rows older than
 *                    LIMITS.detail.retentionDays are deleted, one batch of
 *                    RETENTION_DELETE_BATCH per table per tick.
 *
 * A PlatformSetting `retention` = `{ legalHold: true }` suspends (d) and (f):
 * nothing is deleted while a legal hold is set, and the tick says so in the
 * log. Later phases add their purges to (f) under the same hold: SubmissionSource
 * archival (archivedAt), proctoring evidence retention, and the rest of the
 * retention schedule.
 *
 * Only one scheduler instance acts per tick (session advisory lock, released
 * at the end of the tick). State changes happen in short transactions over
 * batches of ≤ BATCH_SIZE rows taken with FOR UPDATE SKIP LOCKED, so a row
 * mid-claim in the web app is skipped rather than waited on; enqueueing
 * happens only after the transaction commits. The decisions themselves are
 * the pure functions in classify.ts — the SQL here only selects and applies.
 *
 * Timestamps: Prisma stores DateTime as UTC in `timestamp(3)` columns, so
 * every SQL comparison uses `now() AT TIME ZONE 'UTC'`, which is correct
 * whatever the server's TimeZone setting.
 */

export interface ReconcilerDeps {
  /** Must be a single-connection client on the DIRECT URL (see config.ts). */
  db: Db;
  queues: JudgeQueuePort;
  log: Logger;
  /** Read and decide, but write nothing to Postgres or Redis. */
  dryRun?: boolean;
}

/** Tables the retention purge (f) deletes from. */
export type RetentionTable = "SubmissionTestDetail";

export interface TickReport {
  lock: "acquired" | "busy";
  dryRun: boolean;
  nodesOffline: number;
  /** JUDGING rows whose lease (b) will reclaim because their node went OFFLINE. */
  leasesExpiredByNodeSweep: number;
  /** ONLINE nodes whose sensitive lanes were withdrawn for a stale self-check. */
  nodesLaneRestricted: number;
  /** QUEUED rows whose judgeState was set to DISPATCHED. */
  markedDispatched: number;
  /** Lapsed leases returned to QUEUED. */
  requeued: number;
  /** Rows finalised as INTERNAL_ERROR / IE because every attempt was spent. */
  failed: number;
  jobs: {
    kept: number;
    added: number;
    replaced: number;
    /** BullMQ refused to remove a stale job (locked); retried next tick. */
    removeRefused: number;
    /** Redis was not connected; the rows stay QUEUED and the next tick retries. */
    deferred: number;
    errors: number;
  };
  runsDeleted: number;
  retention: {
    /** Why (d) and (f) were skipped this tick, if they were. */
    hold: "none" | "legal-hold" | "invalid-setting";
    /** Rows deleted (or, in a dry run, that would be) per table this tick. */
    purged: Record<RetentionTable, number>;
  };
  /** Phases that hit their per-tick batch cap; the backlog continues next tick. */
  capped: string[];
  durationMs: number;
}

/** Two-int advisory lock key: namespace "recx" (ASCII as int4), lock #1 = reconciler. */
export const LOCK_NAMESPACE = 0x72656378;
export const RECONCILER_LOCK = 1;

const KINDS: readonly JobKind[] = jobKindSchema.options;
const TX_OPTIONS = { maxWait: 5_000, timeout: 15_000 } as const;
/** Concurrent BullMQ calls while ensuring a batch of jobs. */
const ENSURE_CONCURRENCY = 16;

/**
 * Per-kind SQL fragments. Identifiers come from this fixed table only, never
 * from input. Only Submission has a lane column; the other kinds select NULL
 * and take their fixed lane from jobLane() (classify.ts).
 */
const SOURCE: Record<JobKind, { table: Prisma.Sql; lane: Prisma.Sql; since: Prisma.Sql }> = {
  submission: { table: Prisma.raw(`"Submission"`), lane: Prisma.raw(`"lane"::text`), since: Prisma.raw(`"queuedAt"`) },
  run: { table: Prisma.raw(`"RunRequest"`), lane: Prisma.raw(`NULL::text`), since: Prisma.raw(`"createdAt"`) },
  validation: { table: Prisma.raw(`"ValidationRun"`), lane: Prisma.raw(`NULL::text`), since: Prisma.raw(`"createdAt"`) },
};

/**
 * Retention rules for (f). Identifiers come from this fixed table only. Each
 * rule deletes rows whose `column` is strictly older than `retentionDays`
 * (classifyRetentionAge in classify.ts states the same rule).
 */
const RETENTION_RULES: ReadonlyArray<{
  name: RetentionTable;
  table: Prisma.Sql;
  column: Prisma.Sql;
  retentionDays: number;
}> = [
  {
    name: "SubmissionTestDetail",
    table: Prisma.raw(`"SubmissionTestDetail"`),
    column: Prisma.raw(`"createdAt"`),
    retentionDays: LIMITS.detail.retentionDays,
  },
];

const DB_NOW = Prisma.raw(`(now() AT TIME ZONE 'UTC')`);
const LOCK_ROWS = Prisma.raw(`FOR UPDATE SKIP LOCKED`);

// Raw rows are a trust boundary like any other: validate their shape.
const laneSchema = z.enum(JUDGE_LANES);
const queuedRowSchema = z.object({
  id: z.string(),
  lane: laneSchema.nullable(),
  attemptCount: z.number().int(),
  judgeState: z.string(),
  since: z.date(),
  dbNow: z.date(),
});
const leasedRowSchema = z.object({
  id: z.string(),
  lane: laneSchema.nullable(),
  attemptCount: z.number().int(),
  leaseExpiresAt: z.date().nullable(),
  claimedByNodeId: z.string().nullable(),
  dbNow: z.date(),
});
const nodeRowSchema = z.object({
  id: z.string(),
  status: z.enum(JUDGE_NODE_STATUSES),
  lastHeartbeatAt: z.date().nullable(),
  sensitiveLanesOk: z.boolean(),
  lastSelfCheckAt: z.date().nullable(),
  dbNow: z.date(),
});

/** A row whose lane has been resolved for its kind. */
type Laned<R extends { lane: JudgeLane | null }> = Omit<R, "lane"> & { lane: JudgeLane };
type QueuedDbRow = Laned<z.infer<typeof queuedRowSchema>>;
type LeasedDbRow = Laned<z.infer<typeof leasedRowSchema>>;

function withLane<R extends { lane: JudgeLane | null }>(kind: JobKind, rows: R[]): Array<Laned<R>> {
  return rows.map((row) => ({ ...row, lane: jobLane(kind, row.lane) }));
}

// ── Tick ────────────────────────────────────────────────────────────────

export async function runReconcilerTick(deps: ReconcilerDeps): Promise<TickReport> {
  const started = performance.now();
  const report = emptyReport(deps.dryRun ?? false);
  if (!(await tryLock(deps.db))) {
    report.lock = "busy";
    report.durationMs = Math.round(performance.now() - started);
    return report;
  }
  try {
    await sweepNodes(deps, report);
    for (const kind of KINDS) await dispatchQueued(deps, kind, report);
    for (const kind of KINDS) await reclaimLeases(deps, kind, report);
    if (await retentionAllowsDeletes(deps, report)) {
      await purgeExpiredRuns(deps, report);
      for (const rule of RETENTION_RULES) await purgeRetention(deps, rule, report);
    }
  } finally {
    await releaseLock(deps);
    report.durationMs = Math.round(performance.now() - started);
  }
  return report;
}

/** A report of a tick that has done nothing yet. */
export function emptyReport(dryRun: boolean): TickReport {
  return {
    lock: "acquired",
    dryRun,
    nodesOffline: 0,
    leasesExpiredByNodeSweep: 0,
    nodesLaneRestricted: 0,
    markedDispatched: 0,
    requeued: 0,
    failed: 0,
    jobs: { kept: 0, added: 0, replaced: 0, removeRefused: 0, deferred: 0, errors: 0 },
    runsDeleted: 0,
    retention: { hold: "none", purged: { SubmissionTestDetail: 0 } },
    capped: [],
    durationMs: 0,
  };
}

/**
 * True when the report records anything worth an info-level log line. A
 * legal hold alone is not "work": it already gets its own line every tick.
 */
export function tickDidWork(r: TickReport): boolean {
  const j = r.jobs;
  const purged = Object.values(r.retention.purged).reduce((sum, n) => sum + n, 0);
  return (
    r.nodesOffline + r.leasesExpiredByNodeSweep + r.nodesLaneRestricted > 0 ||
    r.markedDispatched + r.requeued + r.failed + r.runsDeleted + purged > 0 ||
    j.added + j.replaced + j.removeRefused + j.deferred + j.errors > 0 ||
    r.capped.length > 0
  );
}

// ── Advisory lock ───────────────────────────────────────────────────────

async function tryLock(db: Db): Promise<boolean> {
  const rows = await db.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${LOCK_NAMESPACE}::int, ${RECONCILER_LOCK}::int) AS locked`;
  return rows[0]?.locked === true;
}

async function releaseLock({ db, log }: ReconcilerDeps): Promise<void> {
  try {
    const rows = await db.$queryRaw<{ unlocked: boolean }[]>`
      SELECT pg_advisory_unlock(${LOCK_NAMESPACE}::int, ${RECONCILER_LOCK}::int) AS unlocked`;
    // False means the session that took the lock is gone (connection reset
    // mid-tick) — Postgres already released it with that session.
    if (rows[0]?.unlocked !== true) log.warn("reconciler lock was not held at release (connection reset mid-tick?)");
  } catch (err) {
    log.warn({ err }, "could not release the reconciler lock; it is released when the session closes");
  }
}

// ── (c) Node sweep + (e) lane hygiene ───────────────────────────────────

async function sweepNodes(deps: ReconcilerDeps, report: TickReport): Promise<void> {
  const { db, log, dryRun } = deps;
  let cursor = "";
  for (let batch = 0; batch < MAX_BATCHES_PER_PHASE; batch++) {
    const result = await db.$transaction(async (tx) => {
      const rows = z.array(nodeRowSchema).parse(
        await tx.$queryRaw<unknown[]>`
          SELECT id, status::text AS status, "lastHeartbeatAt", "sensitiveLanesOk", "lastSelfCheckAt",
                 ${DB_NOW} AS "dbNow"
          FROM "JudgeNode"
          WHERE status IN ('ONLINE', 'DRAINING') AND id > ${cursor}
          ORDER BY id
          LIMIT ${BATCH_SIZE}::int
          ${LOCK_ROWS}`,
      );
      const offline: typeof rows = [];
      const restrict: typeof rows = [];
      for (const row of rows) {
        if (classifyNode(row, row.dbNow) === "offline") offline.push(row);
        // A node going OFFLINE now is not restricted as well: its next
        // heartbeat brings it back ONLINE and the web app recomputes its lanes.
        else if (classifyNodeLanes(row, row.dbNow) === "restrict") restrict.push(row);
      }
      const now = rows[0]?.dbNow;
      let leases = 0;
      let restricted = restrict.length;
      if (!dryRun && now && offline.length > 0) {
        const ids = offline.map((n) => n.id);
        await tx.judgeNode.updateMany({
          where: { id: { in: ids }, status: { in: ["ONLINE", "DRAINING"] } },
          data: { status: "OFFLINE" },
        });
        // Expire (not reclaim) the dead nodes' leases: the lease pass below
        // owns the attempt-cap decision for every lapsed lease.
        const lease = { where: { status: "JUDGING" as const, claimedByNodeId: { in: ids } }, data: { leaseExpiresAt: now } };
        leases += (await tx.submission.updateMany(lease)).count;
        leases += (await tx.runRequest.updateMany(lease)).count;
        leases += (await tx.validationRun.updateMany(lease)).count;
      }
      if (!dryRun && restrict.length > 0) {
        // The rows are locked, so a heartbeat carrying a fresh self-check
        // waits for this commit and then overwrites these values with its own.
        restricted = (
          await tx.judgeNode.updateMany({
            where: { id: { in: restrict.map((n) => n.id) }, status: "ONLINE", sensitiveLanesOk: true },
            data: { sensitiveLanesOk: false, laneRestrictions: [SELF_CHECK_STALE_RESTRICTION] },
          })
        ).count;
      }
      return { rows, offline, restrict, restricted, leases };
    }, TX_OPTIONS);

    for (const node of result.offline) {
      log.warn(
        { nodeId: node.id, lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null, dryRun },
        "judge node missed its heartbeats; marked OFFLINE",
      );
    }
    for (const node of result.restrict) {
      log.warn(
        {
          nodeId: node.id,
          lastSelfCheckAt: node.lastSelfCheckAt?.toISOString() ?? null,
          staleAfterMs: LIMITS.selfCheck.staleAfterMs,
          lanesWithdrawn: SENSITIVE_LANES,
          dryRun,
        },
        "judge node self-check is stale; sensitive lanes withdrawn",
      );
    }
    report.nodesOffline += result.offline.length;
    report.leasesExpiredByNodeSweep += result.leases;
    report.nodesLaneRestricted += result.restricted;

    const last = result.rows.at(-1);
    if (!last || result.rows.length < BATCH_SIZE) return;
    cursor = last.id;
  }
  report.capped.push("nodes");
}

// ── (a) Dispatch QUEUED rows ────────────────────────────────────────────

async function dispatchQueued(deps: ReconcilerDeps, kind: JobKind, report: TickReport): Promise<void> {
  const { db, dryRun } = deps;
  const src = SOURCE[kind];
  let cursor = "";
  for (let batch = 0; batch < MAX_BATCHES_PER_PHASE; batch++) {
    const result = await db.$transaction(async (tx) => {
      const rows = withLane(
        kind,
        z.array(queuedRowSchema).parse(
          await tx.$queryRaw<unknown[]>`
            SELECT id, ${src.lane} AS lane, "attemptCount", "judgeState"::text AS "judgeState",
                   ${src.since} AS since, ${DB_NOW} AS "dbNow"
            FROM ${src.table}
            WHERE status = 'QUEUED'
              AND ${src.since} < ${DB_NOW} - (${QUEUED_GRACE_MS}::int * interval '1 millisecond')
              AND id > ${cursor}
            ORDER BY id
            LIMIT ${BATCH_SIZE}::int
            ${LOCK_ROWS}`,
        ),
      );
      const groups = partition(rows, (row) => classifyQueued(row, row.dbNow));
      const dispatch = groups.get("dispatch") ?? [];
      const failed = groups.get("fail") ?? [];
      const toMark = dispatch.filter((row) => row.judgeState !== "DISPATCHED").map((row) => row.id);
      const now = rows[0]?.dbNow;
      let marked = toMark.length;
      if (!dryRun && now) {
        await updateRows(tx, kind, failed.map((row) => row.id), "QUEUED", failedPatch(now));
        marked = await updateRows(tx, kind, toMark, "QUEUED", { judgeState: "DISPATCHED" });
      }
      return { rows, dispatch, failed, marked };
    }, TX_OPTIONS);

    // Committed — now talk to Redis.
    report.markedDispatched += result.marked;
    await finaliseFailed(deps, kind, result.failed, report);
    await ensureJobs(deps, kind, result.dispatch, report);

    const last = result.rows.at(-1);
    if (!last || result.rows.length < BATCH_SIZE) return;
    cursor = last.id;
  }
  report.capped.push(`dispatch:${kind}`);
}

// ── (b) Reclaim lapsed leases ───────────────────────────────────────────

async function reclaimLeases(deps: ReconcilerDeps, kind: JobKind, report: TickReport): Promise<void> {
  const { db, log, dryRun } = deps;
  const src = SOURCE[kind];
  let cursor = "";
  for (let batch = 0; batch < MAX_BATCHES_PER_PHASE; batch++) {
    const result = await db.$transaction(async (tx) => {
      const rows = withLane(
        kind,
        z.array(leasedRowSchema).parse(
          await tx.$queryRaw<unknown[]>`
            SELECT id, ${src.lane} AS lane, "attemptCount", "leaseExpiresAt", "claimedByNodeId",
                   ${DB_NOW} AS "dbNow"
            FROM ${src.table}
            WHERE status = 'JUDGING'
              AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < ${DB_NOW})
              AND id > ${cursor}
            ORDER BY id
            LIMIT ${BATCH_SIZE}::int
            ${LOCK_ROWS}`,
        ),
      );
      const groups = partition(rows, (row) => classifyLease(row, row.dbNow));
      const requeue = groups.get("requeue") ?? [];
      const failed = groups.get("fail") ?? [];
      const now = rows[0]?.dbNow;
      if (!dryRun && now) {
        await updateRows(tx, kind, failed.map((row) => row.id), "JUDGING", failedPatch(now));
        // A late result from the old holder now fails the claimToken guard
        // in /api/judge/result (409 stale) instead of overwriting a re-judge.
        await updateRows(tx, kind, requeue.map((row) => row.id), "JUDGING", {
          status: "QUEUED",
          judgeState: "DISPATCHED",
          claimToken: null,
          claimedByNodeId: null,
          leaseExpiresAt: null,
        });
      }
      return { rows, requeue, failed };
    }, TX_OPTIONS);

    // Committed — now talk to Redis.
    for (const row of result.requeue) {
      log.info(
        { kind, id: row.id, lane: row.lane, attemptCount: row.attemptCount, lastNodeId: row.claimedByNodeId, dryRun },
        "judge lease lapsed; returned to QUEUED",
      );
    }
    report.requeued += result.requeue.length;
    await finaliseFailed(deps, kind, result.failed, report);
    await publishAll(deps, kind, result.requeue, { type: "state", state: "QUEUED" });
    await ensureJobs(deps, kind, result.requeue, report);

    const last = result.rows.at(-1);
    if (!last || result.rows.length < BATCH_SIZE) return;
    cursor = last.id;
  }
  report.capped.push(`leases:${kind}`);
}

// ── Legal hold ──────────────────────────────────────────────────────────

/** Reads PlatformSetting `retention` once per tick; false (logged) while deletes are suspended. */
async function retentionAllowsDeletes({ db, log, dryRun }: ReconcilerDeps, report: TickReport): Promise<boolean> {
  const row = await db.platformSetting.findUnique({ where: { key: RETENTION_SETTING_KEY }, select: { value: true } });
  const decision: RetentionDecision = classifyRetention(row ? row.value : undefined);
  if (decision.action === "purge") return true;
  report.retention.hold = decision.reason;
  if (decision.reason === "legal-hold") {
    log.info(
      { setting: RETENTION_SETTING_KEY, dryRun },
      "legal hold is set: retention purges and the RunRequest TTL are skipped this tick",
    );
  } else {
    log.error(
      { setting: RETENTION_SETTING_KEY, issue: decision.issue, dryRun },
      "retention setting is malformed; nothing is deleted until it is fixed",
    );
  }
  return false;
}

// ── (d) RunRequest TTL ──────────────────────────────────────────────────

async function purgeExpiredRuns({ db, dryRun }: ReconcilerDeps, report: TickReport): Promise<void> {
  if (dryRun) {
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM "RunRequest" WHERE "expiresAt" < ${DB_NOW}
        LIMIT ${MAX_TTL_BATCHES * TTL_DELETE_BATCH}::int
      ) expired`;
    report.runsDeleted = rows[0]?.n ?? 0;
    return;
  }
  for (let batch = 0; batch < MAX_TTL_BATCHES; batch++) {
    // MATERIALIZED: Postgres may re-run an IN (… LIMIT … SKIP LOCKED)
    // subquery during the delete and lock a second, different set of rows;
    // a materialized CTE is evaluated exactly once, so a batch stays a batch.
    const deleted = await db.$executeRaw`
      WITH batch AS MATERIALIZED (
        SELECT id FROM "RunRequest" WHERE "expiresAt" < ${DB_NOW}
        LIMIT ${TTL_DELETE_BATCH}::int
        ${LOCK_ROWS}
      )
      DELETE FROM "RunRequest" AS target USING batch WHERE target.id = batch.id`;
    report.runsDeleted += deleted;
    if (deleted < TTL_DELETE_BATCH) return;
  }
  report.capped.push("ttl:run");
}

// ── (f) Retention purge ─────────────────────────────────────────────────

/** One batch (≤ RETENTION_DELETE_BATCH rows) for one table; a backlog continues next tick. */
async function purgeRetention(
  { db, log, dryRun }: ReconcilerDeps,
  rule: (typeof RETENTION_RULES)[number],
  report: TickReport,
): Promise<void> {
  let deleted: number;
  if (dryRun) {
    const rows = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM (
        SELECT 1 FROM ${rule.table}
        WHERE ${rule.column} < ${DB_NOW} - (${rule.retentionDays}::int * interval '1 day')
        LIMIT ${RETENTION_DELETE_BATCH}::int
      ) expired`;
    deleted = rows[0]?.n ?? 0;
  } else {
    // MATERIALIZED for the same reason as the run TTL above: observed
    // deleting 10,001 rows from a 10,000-row batch without it.
    deleted = await db.$executeRaw`
      WITH batch AS MATERIALIZED (
        SELECT id FROM ${rule.table}
        WHERE ${rule.column} < ${DB_NOW} - (${rule.retentionDays}::int * interval '1 day')
        LIMIT ${RETENTION_DELETE_BATCH}::int
        ${LOCK_ROWS}
      )
      DELETE FROM ${rule.table} AS target USING batch WHERE target.id = batch.id`;
  }
  report.retention.purged[rule.name] += deleted;
  const entry = { table: rule.name, deleted, retentionDays: rule.retentionDays, batchLimit: RETENTION_DELETE_BATCH, dryRun };
  if (deleted > 0) log.info(entry, "retention purge");
  else log.debug(entry, "retention purge");
  if (deleted >= RETENTION_DELETE_BATCH) report.capped.push(`retention:${rule.name}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────

type RowPatch = {
  status?: "QUEUED" | "INTERNAL_ERROR";
  judgeState?: "DISPATCHED" | "FAILED";
  verdict?: "IE";
  claimToken?: null;
  claimedByNodeId?: null;
  leaseExpiresAt?: Date | null;
  judgedAt?: Date;
  /** ValidationRun only; dropped for the other kinds. */
  outcome?: "FAILED";
};

/**
 * Every judge attempt is spent: Internal Error, excluded from scoring. A
 * ValidationRun's outcome becomes FAILED too — its reference solution was
 * never judged, so it neither MATCHED nor MISMATCHED.
 */
function failedPatch(now: Date): RowPatch {
  return {
    status: "INTERNAL_ERROR",
    judgeState: "FAILED",
    verdict: "IE",
    claimToken: null,
    leaseExpiresAt: null,
    judgedAt: now,
    outcome: "FAILED",
  };
}

/** Apply `patch` to rows `ids` still in `status` (the rows are locked, so this is belt and braces). */
async function updateRows(
  tx: DbTx,
  kind: JobKind,
  ids: string[],
  status: "QUEUED" | "JUDGING",
  patch: RowPatch,
): Promise<number> {
  if (ids.length === 0) return 0;
  const { outcome, ...data } = patch;
  const where = { id: { in: ids }, status };
  switch (kind) {
    case "submission":
      return (await tx.submission.updateMany({ where, data })).count;
    case "run":
      return (await tx.runRequest.updateMany({ where, data })).count;
    case "validation":
      return (await tx.validationRun.updateMany({ where, data: outcome ? { ...data, outcome } : data })).count;
  }
}

async function finaliseFailed(
  deps: ReconcilerDeps,
  kind: JobKind,
  rows: ReadonlyArray<QueuedDbRow | LeasedDbRow>,
  report: TickReport,
): Promise<void> {
  if (rows.length === 0) return;
  report.failed += rows.length;
  for (const row of rows) {
    // Surfaced to admins by log alerting (the scheduler has no audit() of its own).
    deps.log.error(
      { kind, id: row.id, lane: row.lane, attemptCount: row.attemptCount, dryRun: deps.dryRun ?? false },
      "judge attempts exhausted; marked INTERNAL_ERROR (verdict IE, excluded from scoring)",
    );
  }
  // An open submission / run / validation page is waiting on this stream; tell it to re-read.
  await publishAll(deps, kind, rows, { type: "final" });
}

/** Best-effort live progress. Never throws; skipped in a dry run or while Redis is down. */
async function publishAll(
  { queues, log, dryRun }: ReconcilerDeps,
  kind: JobKind,
  rows: ReadonlyArray<{ id: string }>,
  event: ProgressEvent,
): Promise<void> {
  if (dryRun || rows.length === 0 || !queues.ready()) return;
  const results = await Promise.allSettled(rows.map((row) => queues.publish(kind, row.id, event)));
  const failure = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure) log.warn({ err: failure.reason, kind, event: event.type }, "could not publish judge progress");
}

/** After commit: make sure every row has a live BullMQ job on its lane's queue. */
async function ensureJobs(
  deps: ReconcilerDeps,
  kind: JobKind,
  rows: ReadonlyArray<{ id: string; lane: JudgeLane }>,
  report: TickReport,
): Promise<void> {
  if (rows.length === 0) return;
  const { queues, log } = deps;
  if (!queues.ready()) {
    // The rows stay QUEUED in Postgres; the next tick tries again.
    report.jobs.deferred += rows.length;
    return;
  }
  let firstError: unknown = null;
  await forEachLimit(rows, ENSURE_CONCURRENCY, async (row) => {
    try {
      const outcome = await ensureJob(queues, row.lane, { kind, id: row.id }, deps.dryRun ?? false);
      if (outcome === "kept") report.jobs.kept++;
      else if (outcome === "added") report.jobs.added++;
      else if (outcome === "replaced") report.jobs.replaced++;
      else report.jobs.removeRefused++;
    } catch (err) {
      report.jobs.errors++;
      firstError ??= err;
    }
  });
  if (firstError) log.warn({ err: firstError, kind }, "some judge jobs could not be enqueued; retrying next tick");
}

async function forEachLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(lanes);
}
