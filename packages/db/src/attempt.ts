import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

/**
 * The two automatic writes of the attempt engine (Phase 6b), in one place
 * because SPEC §5 requires them from TWO callers and a second copy would
 * eventually disagree with the first:
 *
 *   Auto-submit: a 15s worker finalising status = IN_PROGRESS AND
 *   expiresAt <= now() inside SELECT ... FOR UPDATE SKIP LOCKED, plus a lazy
 *   expiry check in the attempt guard on every exam request, so a dead
 *   worker cannot grant anyone extra time.
 *
 * apps/scheduler is the worker; apps/web's attempt guard is the lazy check.
 * Both call `autoSubmitExpired` — the sweeper over a batch, the guard over
 * one id — so there is exactly one definition of "the deadline has passed".
 *
 * Auto-submit is the ONLY automatic action in the entire system (SPEC §5),
 * and it is a deadline, not a penalty: it submits the work the candidate has,
 * it does not void it, flag it or mark it. Nothing here writes
 * integrityScore, an IntegrityFlag or a VOIDED status; by §0 only a recorded
 * human verdict may do that, and the database trigger agrees — VOIDED is
 * reachable only from a finished status.
 *
 * This module holds raw SQL on purpose. `FOR UPDATE SKIP LOCKED` has no
 * Prisma equivalent, and without it two scheduler instances would block on
 * each other's rows instead of dividing the batch.
 */

/** Postgres' clock, in UTC, as the rest of the repo spells it. */
const DB_NOW = Prisma.raw("(now() AT TIME ZONE 'UTC')");
const LOCK_ROWS = Prisma.raw("FOR UPDATE SKIP LOCKED");

/**
 * Statuses the deadline still applies to.
 *
 * SPEC §5 says `status = IN_PROGRESS`, and that is one status short:
 * DISCONNECTED is also a sitting in progress — the candidate's wifi dropped,
 * their clock never stopped — so an attempt that disconnects before its
 * deadline would otherwise sit unfinalised for ever, holding a seat on the
 * invigilator's dashboard and never scoring the work it already has. The
 * status machine allows DISCONNECTED -> AUTO_SUBMITTED for exactly this
 * reason (packages/shared/src/attempt-clock.ts, and the
 * `AssessmentAttempt_machine` trigger). Recorded in docs/OPEN-QUESTIONS.md.
 */
const LIVE_STATUSES = Prisma.raw(`('IN_PROGRESS', 'DISCONNECTED')`);

/**
 * The deadline, in SQL, including paused time.
 *
 * `msRemaining = expiresAt + pausedMs - now()` (SPEC §5), so the moment a
 * sitting ends is `expiresAt + pausedMs` — NOT `expiresAt`, which the spec's
 * own one-line summary of the sweeper says. Sweeping on bare `expiresAt`
 * would auto-submit a candidate in the middle of an invigilator-granted
 * break, which is precisely "the bug that voids an exam" the spec warns
 * about two lines later. The clock module and this expression have to agree,
 * and attempt-autosubmit.db.test.ts asserts that they do.
 */
const DEADLINE = Prisma.raw(`("expiresAt" + make_interval(secs => "pausedMs"::double precision / 1000))`);

export interface AutoSubmittedAttempt {
  readonly id: string;
  readonly assessmentId: string;
  readonly userId: string;
  /** IN_PROGRESS or DISCONNECTED — which one is worth knowing in the audit row. */
  readonly previousStatus: string;
  readonly expiresAt: Date;
  readonly pausedMs: number;
  /** How late the finalisation was. A rising number means the sweeper is behind. */
  readonly lateMs: number;
}

const autoSubmitRowSchema = (row: unknown): AutoSubmittedAttempt => {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    assessmentId: String(r.assessmentId),
    userId: String(r.userId),
    previousStatus: String(r.previousStatus),
    expiresAt: r.expiresAt as Date,
    pausedMs: Number(r.pausedMs),
    lateMs: Math.max(0, Math.round(Number(r.lateMs ?? 0))),
  };
};

export interface AutoSubmitOptions {
  /** Finalise at most this many attempts. */
  readonly limit: number;
  /**
   * Only this attempt — the lazy check in the web guard. Omitted by the
   * sweeper, which takes whatever is due.
   */
  readonly attemptId?: string;
  /** Decide and report, write nothing (the scheduler's --dry-run). */
  readonly dryRun?: boolean;
}

/**
 * Force-submit every sitting whose deadline has passed, and report what it
 * did. Safe to run from two scheduler instances at once and from a web
 * request at the same time: SKIP LOCKED means a row another transaction is
 * already finalising is passed over rather than waited for, and the status
 * predicate makes a second finalisation a no-op rather than a second submit.
 *
 * MATERIALIZED matters here for the same reason it does in the reconciler's
 * TTL batches: Postgres may re-plan an un-materialized CTE and lock a
 * different set of rows during the update, so a batch would stop being a
 * batch.
 */
export async function autoSubmitExpired(
  db: Pick<PrismaClient, "$queryRaw">,
  options: AutoSubmitOptions,
): Promise<AutoSubmittedAttempt[]> {
  const limit = Math.max(0, Math.floor(options.limit));
  if (limit === 0) return [];
  const only =
    options.attemptId === undefined ? Prisma.empty : Prisma.sql`AND "id" = ${options.attemptId}`;

  if (options.dryRun === true) {
    const rows = await db.$queryRaw<unknown[]>`
      SELECT "id", "assessmentId", "userId", "status"::text AS "previousStatus", "expiresAt", "pausedMs",
             (EXTRACT(EPOCH FROM (${DB_NOW} - ${DEADLINE})) * 1000)::double precision AS "lateMs"
        FROM "AssessmentAttempt"
       WHERE "status"::text IN ${LIVE_STATUSES}
         AND ${DEADLINE} <= ${DB_NOW}
         ${only}
       ORDER BY ${DEADLINE}
       LIMIT ${limit}::int`;
    return rows.map(autoSubmitRowSchema);
  }

  const rows = await db.$queryRaw<unknown[]>`
    WITH due AS MATERIALIZED (
      SELECT "id", "status"::text AS "previousStatus", "expiresAt", "pausedMs",
             (EXTRACT(EPOCH FROM (${DB_NOW} - ${DEADLINE})) * 1000)::double precision AS "lateMs"
        FROM "AssessmentAttempt"
       WHERE "status"::text IN ${LIVE_STATUSES}
         AND ${DEADLINE} <= ${DB_NOW}
         ${only}
       ORDER BY ${DEADLINE}
       LIMIT ${limit}::int
       ${LOCK_ROWS}
    )
    UPDATE "AssessmentAttempt" AS a
       SET "status" = 'AUTO_SUBMITTED'::"AttemptStatus",
           -- The deadline, not the moment the sweeper happened to notice it.
           -- A sweeper that runs late must not record a later submission
           -- time than the candidate actually had.
           "submittedAt" = due."expiresAt" + make_interval(secs => due."pausedMs"::double precision / 1000),
           "version" = a."version" + 1,
           "updatedAt" = ${DB_NOW}
      FROM due
     WHERE a."id" = due."id"
    RETURNING a."id", a."assessmentId", a."userId",
              due."previousStatus", due."expiresAt", due."pausedMs", due."lateMs"`;
  return rows.map(autoSubmitRowSchema);
}

export interface DisconnectedAttempt {
  readonly id: string;
  readonly userId: string;
  readonly lastHeartbeatAt: Date | null;
  readonly silentSeconds: number;
}

/**
 * Move sittings that have stopped beating to DISCONNECTED.
 *
 * SPEC §5: "Missing heartbeats for 45s -> DISCONNECTED, amber on the
 * invigilator dashboard." The heartbeat route cannot do this — the whole
 * point is that no heartbeat arrived — so the sweeper does it.
 *
 * DISCONNECTED is a presence state and NOT a flag (SPEC §5: "DISCONNECTED is
 * never a flag. Resume on the same token with the same frozen paper, deadline
 * unchanged"). So this writes `status` and nothing else: no integrityScore,
 * no event, no counter. The reconnecting heartbeat records the gap it can
 * measure exactly from the bitmap; guessing it here would double-count.
 *
 * Attempts past their deadline are left alone, so a sitting that both expired
 * and went quiet is auto-submitted by the pass above rather than parked in
 * DISCONNECTED first.
 */
export async function markDisconnectedAttempts(
  db: Pick<PrismaClient, "$queryRaw">,
  options: { readonly silentAfterSeconds: number; readonly limit: number; readonly dryRun?: boolean },
): Promise<DisconnectedAttempt[]> {
  const limit = Math.max(0, Math.floor(options.limit));
  if (limit === 0) return [];
  const silent = Prisma.sql`
       WHERE "status"::text = 'IN_PROGRESS'
         AND "lastHeartbeatAt" IS NOT NULL
         AND "lastHeartbeatAt" < ${DB_NOW} - make_interval(secs => ${options.silentAfterSeconds}::double precision)
         AND ${DEADLINE} > ${DB_NOW}`;

  const select = Prisma.sql`
      SELECT "id", "userId", "lastHeartbeatAt",
             EXTRACT(EPOCH FROM (${DB_NOW} - "lastHeartbeatAt"))::double precision AS "silentSeconds"
        FROM "AssessmentAttempt"
       ${silent}
       ORDER BY "lastHeartbeatAt"
       LIMIT ${limit}::int`;

  const shape = (rows: unknown[]): DisconnectedAttempt[] =>
    rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        userId: String(r.userId),
        lastHeartbeatAt: (r.lastHeartbeatAt as Date | null) ?? null,
        silentSeconds: Math.max(0, Math.round(Number(r.silentSeconds ?? 0))),
      };
    });

  if (options.dryRun === true) return shape(await db.$queryRaw<unknown[]>`${select}`);

  const rows = await db.$queryRaw<unknown[]>`
    WITH quiet AS MATERIALIZED (
      ${select}
      ${LOCK_ROWS}
    )
    UPDATE "AssessmentAttempt" AS a
       SET "status" = 'DISCONNECTED'::"AttemptStatus",
           "version" = a."version" + 1,
           "updatedAt" = ${DB_NOW}
      FROM quiet
     WHERE a."id" = quiet."id"
    RETURNING a."id", a."userId", quiet."lastHeartbeatAt", quiet."silentSeconds"`;
  return shape(rows);
}
