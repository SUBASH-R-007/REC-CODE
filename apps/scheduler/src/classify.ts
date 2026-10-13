import {
  JUDGE_OFFLINE_AFTER_MS,
  JUDGE_RETRY,
  LIMITS,
  RETENTION_SETTING_KEY,
  retentionSettingSchema,
  type JobKind,
  type JudgeLane,
  type JudgeNodeStatus,
} from "@recx/shared";

/**
 * The reconciler's decisions, as pure functions of (row, now). No I/O here:
 * reconciler.ts selects rows with thin SQL, asks these functions what to do,
 * and applies the answer. Every threshold is a strict "older than" so the
 * SQL pre-filters (which use `<`) and these functions agree at the boundary.
 *
 * `now` is always the DATABASE clock (read in the same transaction as the
 * rows), never the scheduler host's clock, so a skewed host cannot expire
 * leases early.
 */

/**
 * A QUEUED row younger than this is left alone: the web app's own
 * commit → enqueue → mark-DISPATCHED sequence may still be in flight.
 */
export const QUEUED_GRACE_MS = 5_000;
/** Rows locked and decided per transaction. */
export const BATCH_SIZE = 500;
/** Batches per phase per tick; a larger backlog continues on the next tick. */
export const MAX_BATCHES_PER_PHASE = 20;
/** RunRequest TTL deletes per statement. */
export const TTL_DELETE_BATCH = 10_000;
/** TTL delete statements per tick. */
export const MAX_TTL_BATCHES = 10;
/** Retention purge: rows deleted per statement — and per table per tick (one batch each). */
export const RETENTION_DELETE_BATCH = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Lanes ───────────────────────────────────────────────────────────────

/**
 * Kinds whose rows have no lane column, and the lane their jobs always use.
 * A RunRequest is the editor's Run button (RUN). A ValidationRun judges a
 * reference solution at authoring time; it rides the REJUDGE lane, whose
 * share drops to zero while an assessment backlog exists, so authoring work
 * never competes with a live exam. A Submission carries its own lane.
 */
export const FIXED_LANE: Readonly<Record<JobKind, JudgeLane | null>> = {
  submission: null,
  run: "RUN",
  validation: "REJUDGE",
};

/** The queue a row's job belongs on: its kind's fixed lane, else the row's own `lane` column. */
export function jobLane(kind: JobKind, storedLane: JudgeLane | null): JudgeLane {
  const fixed = FIXED_LANE[kind];
  if (fixed !== null) return fixed;
  if (storedLane === null) throw new Error(`a ${kind} row must carry its own lane`);
  return storedLane;
}

// ── Judge rows ──────────────────────────────────────────────────────────

export interface QueuedRow {
  id: string;
  attemptCount: number;
  /** Submission.queuedAt / RunRequest.createdAt / ValidationRun.createdAt. */
  since: Date;
}

/**
 * - `wait`     — inside the grace window; the web app is still dispatching it.
 * - `dispatch` — make sure a live BullMQ job exists and mark it DISPATCHED.
 * - `fail`     — every judge attempt is spent. The claim route refuses such a
 *                row (ATTEMPTS_EXHAUSTED), so leaving it QUEUED would re-enqueue
 *                it forever; it becomes INTERNAL_ERROR / IE instead.
 */
export type QueuedAction = "wait" | "dispatch" | "fail";

export function classifyQueued(
  row: QueuedRow,
  now: Date,
  graceMs: number = QUEUED_GRACE_MS,
  maxAttempts: number = JUDGE_RETRY.attempts,
): QueuedAction {
  if (now.getTime() - row.since.getTime() <= graceMs) return "wait";
  return row.attemptCount >= maxAttempts ? "fail" : "dispatch";
}

export interface LeasedRow {
  id: string;
  attemptCount: number;
  /** Null on a JUDGING row means nobody holds a lease — the claim route treats it as claimable, and so do we. */
  leaseExpiresAt: Date | null;
}

/**
 * - `keep`    — the lease is still live; a worker is judging it.
 * - `requeue` — the lease lapsed with attempts to spare: back to QUEUED.
 * - `fail`    — the lease lapsed on the last attempt: INTERNAL_ERROR / IE,
 *               excluded from scoring.
 */
export type LeaseAction = "keep" | "requeue" | "fail";

export function classifyLease(row: LeasedRow, now: Date, maxAttempts: number = JUDGE_RETRY.attempts): LeaseAction {
  const expired = row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() < now.getTime();
  if (!expired) return "keep";
  return row.attemptCount >= maxAttempts ? "fail" : "requeue";
}

export interface NodeRow {
  id: string;
  status: JudgeNodeStatus;
  lastHeartbeatAt: Date | null;
}

/**
 * ONLINE / DRAINING nodes whose last heartbeat is older than
 * JUDGE_OFFLINE_AFTER_MS go OFFLINE (and their leases are expired so the
 * lease pass reclaims the work). OFFLINE and QUARANTINED nodes are never
 * touched — quarantine is an admin decision.
 */
export type NodeAction = "keep" | "offline";

export function classifyNode(row: NodeRow, now: Date, offlineAfterMs: number = JUDGE_OFFLINE_AFTER_MS): NodeAction {
  if (row.status !== "ONLINE" && row.status !== "DRAINING") return "keep";
  if (row.lastHeartbeatAt === null) return "offline";
  return now.getTime() - row.lastHeartbeatAt.getTime() > offlineAfterMs ? "offline" : "keep";
}

/** The laneRestrictions entry the scheduler writes when it withdraws sensitive lanes. */
export const SELF_CHECK_STALE_RESTRICTION = "self-check stale";

export interface NodeLaneRow {
  status: JudgeNodeStatus;
  sensitiveLanesOk: boolean;
  lastSelfCheckAt: Date | null;
}

/**
 * Lane hygiene, defence in depth. The web app recomputes a node's sensitive
 * lanes (ASSESSMENT, CONTEST) on every heartbeat; the scheduler only checks
 * that an ONLINE node still marked sensitiveLanesOk has a self-check younger
 * than LIMITS.selfCheck.staleAfterMs. If not — including a node that never
 * reported one — it withdraws them:
 * - `keep`     — not ONLINE, sensitive lanes already withheld, or a fresh self-check;
 * - `restrict` — set sensitiveLanesOk=false, laneRestrictions ["self-check stale"].
 * Staleness is strict ("older than"), like every other threshold here.
 */
export type NodeLaneAction = "keep" | "restrict";

export function classifyNodeLanes(
  row: NodeLaneRow,
  now: Date,
  staleAfterMs: number = LIMITS.selfCheck.staleAfterMs,
): NodeLaneAction {
  if (row.status !== "ONLINE" || !row.sensitiveLanesOk) return "keep";
  if (row.lastSelfCheckAt === null) return "restrict";
  return now.getTime() - row.lastSelfCheckAt.getTime() > staleAfterMs ? "restrict" : "keep";
}

// ── Retention ───────────────────────────────────────────────────────────

/**
 * PlatformSetting key whose value `{ legalHold: true }` suspends every purge.
 * One source with the web app (packages/shared/src/governance.ts), which
 * writes it from /super/settings/policy. Other keys are allowed (later
 * phases may add per-table overrides); only `legalHold` changes behaviour,
 * and it must be a real boolean.
 */
export { RETENTION_SETTING_KEY };

/**
 * - `purge`                  — no hold: purges and TTL deletes run;
 * - `hold` / `legal-hold`    — `{ legalHold: true }`: nothing is deleted this tick;
 * - `hold` / `invalid-setting` — the row exists but is malformed. Deletion is
 *   irreversible and keeping data is not, so an unreadable setting holds too
 *   (and is logged as an error every tick until it is fixed).
 */
export type RetentionDecision =
  | { action: "purge" }
  | { action: "hold"; reason: "legal-hold" }
  | { action: "hold"; reason: "invalid-setting"; issue: string };

/** `setting` is the PlatformSetting row's `value`, or `undefined` when there is no row. */
export function classifyRetention(setting: unknown): RetentionDecision {
  if (setting === undefined) return { action: "purge" };
  const parsed = retentionSettingSchema.safeParse(setting);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      action: "hold",
      reason: "invalid-setting",
      issue: issue ? `${issue.path.join(".") || "value"}: ${issue.message}` : "unreadable value",
    };
  }
  return parsed.data.legalHold === true ? { action: "hold", reason: "legal-hold" } : { action: "purge" };
}

/**
 * Whether a row created at `createdAt` is past a retention window of
 * `retentionDays` (strictly older, matching the purge SQL's
 * `"createdAt" < now - N days`). SubmissionTestDetail uses
 * LIMITS.detail.retentionDays (30).
 */
export type RetentionAction = "keep" | "purge";

export function classifyRetentionAge(
  createdAt: Date,
  now: Date,
  retentionDays: number = LIMITS.detail.retentionDays,
): RetentionAction {
  return now.getTime() - createdAt.getTime() > retentionDays * DAY_MS ? "purge" : "keep";
}

/**
 * What to do with the BullMQ job (jobId = row id) of a row that must be
 * dispatched, given `Queue.getJobState()`:
 * - `keep`    — waiting / prioritized / delayed (a retry backoff) / active
 *               (a worker holds it; BullMQ's stall detection recovers a dead
 *               holder) — a live job already exists.
 * - `replace` — completed / failed: BullMQ dedupes on jobId, so the stale
 *               job must be removed before the same id can be added again.
 * - `add`     — no job at all (e.g. Redis was flushed or down at submit).
 */
export type JobAction = "keep" | "replace" | "add";

export function classifyJobState(state: string): JobAction {
  switch (state) {
    case "completed":
    case "failed":
      return "replace";
    case "unknown":
      return "add";
    // waiting, prioritized, delayed, active, waiting-children, and any state
    // a future BullMQ adds: a job exists, so adding would be a no-op anyway.
    default:
      return "keep";
  }
}

/** Group rows by the action a classifier picks for each. */
export function partition<R, A extends string>(rows: readonly R[], decide: (row: R) => A): Map<A, R[]> {
  const groups = new Map<A, R[]>();
  for (const row of rows) {
    const action = decide(row);
    const group = groups.get(action);
    if (group) group.push(row);
    else groups.set(action, [row]);
  }
  return groups;
}
