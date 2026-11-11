import type { Db, Prisma } from "@recx/db";
import { LEADERBOARD_SCOPES, periodKey, type LeaderboardScope } from "@recx/shared";
import type { Logger } from "pino";
import { z } from "zod";

/**
 * Leaderboard freeze. Once a WEEK or MONTH period has closed on the campus
 * calendar (Asia/Kolkata), its boards are frozen into LeaderboardSnapshot
 * rows — the top SNAPSHOT_TOP of the COLLEGE board and of every DEPARTMENT,
 * BATCH and SECTION present in that period's XpBucket rows — so a historical
 * board is a single row read and stops depending on late bucket writes.
 *
 * Ranking matches the live board (apps/web src/server/queries/leaderboard.ts):
 * XP descending, then whoever reached that XP first (lastXpAt ascending),
 * competition ranks ("1, 2, 2, 4") for exact ties, and students only —
 * opted-out students and staff accounts are left out of every snapshot.
 * Names are publicName() only ("Priya S."): never an email, roll number,
 * department or section identifier on an entry.
 *
 * Idempotent: the (period, periodKey, scope, scopeKey) key is unique and every
 * period's rows go in ONE insert (ON CONFLICT DO NOTHING), so the COLLEGE row
 * doubles as the "this period is frozen" marker. Two scheduler instances, or
 * a restart mid-freeze, cannot double-write.
 *
 * Cost per tick: nothing but arithmetic while the cut-off keys are unchanged.
 * When a period closes (plus FREEZE_GRACE_MS for in-flight judging: a
 * submission's XP lands in the period it was SUBMITTED in), one indexed
 * query finds unfrozen closed periods within the lookback window, and each is
 * frozen once. A scheduler that was down catches up on restart.
 */

export const FREEZE_PERIODS = ["WEEK", "MONTH"] as const;
export type FreezePeriod = (typeof FREEZE_PERIODS)[number];

/** Entries kept per board. */
export const SNAPSHOT_TOP = 200;
/** A period is frozen this long after it closes, so late verdicts still count. */
export const FREEZE_GRACE_MS = 30 * 60_000;
const DAY_MS = 86_400_000;
/** How far back a (re)started scheduler looks for closed periods that were never frozen. */
export const FREEZE_LOOKBACK_MS: Readonly<Record<FreezePeriod, number>> = {
  WEEK: 8 * 7 * DAY_MS,
  MONTH: 100 * DAY_MS,
};
/** After a failed attempt, wait before trying again (the query is not free). */
export const FREEZE_RETRY_MS = 5 * 60_000;

// ── Pure ────────────────────────────────────────────────────────────────

/** Every period key strictly below this one is closed and past its grace. */
export function freezeCutoffKey(period: FreezePeriod, now: Date): string {
  return periodKey(period, new Date(now.getTime() - FREEZE_GRACE_MS));
}

/** The oldest period key a catch-up considers. */
export function freezeFloorKey(period: FreezePeriod, now: Date): string {
  return periodKey(period, new Date(now.getTime() - FREEZE_GRACE_MS - FREEZE_LOOKBACK_MS[period]));
}

/**
 * Leaderboard-safe display name ("Priya S."). Mirrors publicName() in
 * @recx/design, which the scheduler does not depend on.
 */
export function publicName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName.charAt(0).toUpperCase()}.`;
}

/** One XpBucket row of the period being frozen, with the student's name. */
export interface StandingSource {
  userId: string;
  firstName: string;
  lastName: string;
  xp: number;
  solvedEasy: number;
  solvedMedium: number;
  solvedHard: number;
  batchYear: number | null;
  departmentCode: string | null;
  section: string | null;
  lastXpAt: Date;
}

/** One entry of LeaderboardSnapshot.top (jsonb). */
export interface SnapshotEntry {
  rank: number;
  userId: string;
  publicName: string;
  xp: number;
  /** ISO time the XP total was reached — the live board's tie-break. */
  lastXpAt: string;
  solved: number;
  solvedEasy: number;
  solvedMedium: number;
  solvedHard: number;
}

export interface BoardSnapshot {
  scope: LeaderboardScope;
  /** "" for COLLEGE; "CSE", "2027" or "2027:CSE:A" otherwise. */
  scopeKey: string;
  top: SnapshotEntry[];
}

/** The boards a bucket row appears on. A scope whose cohort column is missing is skipped. */
export function boardsOf(row: Pick<StandingSource, "batchYear" | "departmentCode" | "section">): Array<{
  scope: LeaderboardScope;
  scopeKey: string;
}> {
  const boards: Array<{ scope: LeaderboardScope; scopeKey: string }> = [{ scope: "COLLEGE", scopeKey: "" }];
  if (row.departmentCode) boards.push({ scope: "DEPARTMENT", scopeKey: row.departmentCode });
  if (row.batchYear !== null) boards.push({ scope: "BATCH", scopeKey: String(row.batchYear) });
  if (row.batchYear !== null && row.departmentCode && row.section) {
    boards.push({ scope: "SECTION", scopeKey: `${row.batchYear}:${row.departmentCode}:${row.section}` });
  }
  return boards;
}

/** Board order: more XP first; equal XP → reached first; then user id (stable). */
export function compareStanding(a: StandingSource, b: StandingSource): number {
  return (
    b.xp - a.xp ||
    a.lastXpAt.getTime() - b.lastXpAt.getTime() ||
    (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0)
  );
}

/**
 * Every board's top `limit`, with competition ranks within each board. The
 * COLLEGE board is always present (possibly empty): its row marks the period
 * as frozen. Boards are ordered COLLEGE, DEPARTMENT, BATCH, SECTION, then by key.
 */
export function buildSnapshots(rows: readonly StandingSource[], limit: number = SNAPSHOT_TOP): BoardSnapshot[] {
  const boards = new Map<string, { scope: LeaderboardScope; scopeKey: string; rows: StandingSource[] }>();
  const boardKey = (scope: string, scopeKey: string) => `${scope}\u0000${scopeKey}`;
  boards.set(boardKey("COLLEGE", ""), { scope: "COLLEGE", scopeKey: "", rows: [] });

  for (const row of [...rows].sort(compareStanding)) {
    for (const { scope, scopeKey } of boardsOf(row)) {
      const key = boardKey(scope, scopeKey);
      let board = boards.get(key);
      if (!board) {
        board = { scope, scopeKey, rows: [] };
        boards.set(key, board);
      }
      if (board.rows.length < limit) board.rows.push(row);
    }
  }

  const scopeOrder = (scope: LeaderboardScope) => LEADERBOARD_SCOPES.indexOf(scope);
  return [...boards.values()]
    .sort((a, b) => scopeOrder(a.scope) - scopeOrder(b.scope) || (a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0))
    .map((board) => ({ scope: board.scope, scopeKey: board.scopeKey, top: rankEntries(board.rows) }));
}

function rankEntries(rows: readonly StandingSource[]): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    const prevEntry = entries[i - 1];
    const tied = prev && prevEntry && prev.xp === row.xp && prev.lastXpAt.getTime() === row.lastXpAt.getTime();
    entries.push({
      rank: tied ? prevEntry.rank : i + 1,
      userId: row.userId,
      publicName: publicName(row.firstName, row.lastName),
      xp: row.xp,
      lastXpAt: row.lastXpAt.toISOString(),
      solved: row.solvedEasy + row.solvedMedium + row.solvedHard,
      solvedEasy: row.solvedEasy,
      solvedMedium: row.solvedMedium,
      solvedHard: row.solvedHard,
    });
  });
  return entries;
}

// ── Database ────────────────────────────────────────────────────────────

const periodKeyRows = z.array(z.object({ periodKey: z.string() }));

/** Closed periods in [floorKey, cutoffKey) that have buckets but no snapshot yet, oldest first. */
export async function findUnfrozenPeriods(
  db: Db,
  period: FreezePeriod,
  floorKey: string,
  cutoffKey: string,
): Promise<string[]> {
  // Key order is chronological ("2026-W09" < "2026-W41" < "2027-W01";
  // "2026-09" < "2026-10"), so a range scan on the bucket index finds them.
  const rows = periodKeyRows.parse(
    await db.$queryRaw<unknown[]>`
      SELECT k."periodKey"
      FROM (
        SELECT DISTINCT b."periodKey"
        FROM "XpBucket" b
        WHERE b."period" = ${period}::"XpPeriod"
          AND b."periodKey" >= ${floorKey}
          AND b."periodKey" < ${cutoffKey}
      ) k
      WHERE NOT EXISTS (
        SELECT 1 FROM "LeaderboardSnapshot" s
        WHERE s."period" = ${period}::"XpPeriod" AND s."periodKey" = k."periodKey"
          AND s."scope" = 'COLLEGE' AND s."scopeKey" = ''
      )
      ORDER BY k."periodKey"`,
  );
  return rows.map((r) => r.periodKey);
}

export interface FrozenPeriod {
  period: FreezePeriod;
  periodKey: string;
  boards: number;
  entries: number;
  /** Snapshot rows this call inserted (0 when another instance got there first, or in a dry run). */
  inserted: number;
}

/** Freeze one closed period: read its buckets once, write every board in one insert. */
export async function freezePeriod(
  db: Db,
  period: FreezePeriod,
  key: string,
  options: { now: Date; dryRun?: boolean },
): Promise<FrozenPeriod> {
  const buckets = await db.xpBucket.findMany({
    where: { period, periodKey: key, user: { leaderboardOptOut: false, role: "STUDENT" } },
    select: {
      userId: true,
      xp: true,
      solvedEasy: true,
      solvedMedium: true,
      solvedHard: true,
      batchYear: true,
      departmentCode: true,
      section: true,
      lastXpAt: true,
      user: { select: { firstName: true, lastName: true } },
    },
  });
  const snapshots = buildSnapshots(buckets.map(({ user, ...row }) => ({ ...row, ...user })));
  const entries = snapshots.reduce((n, s) => n + s.top.length, 0);
  let inserted = 0;
  if (!options.dryRun) {
    const result = await db.leaderboardSnapshot.createMany({
      data: snapshots.map((s) => ({
        period,
        periodKey: key,
        scope: s.scope,
        scopeKey: s.scopeKey,
        top: s.top.map((entry): Prisma.InputJsonObject => ({ ...entry })),
        frozenAt: options.now,
      })),
      skipDuplicates: true,
    });
    inserted = result.count;
  }
  return { period, periodKey: key, boards: snapshots.length, entries, inserted };
}

// ── The job ─────────────────────────────────────────────────────────────

export interface LeaderboardFreezeDeps {
  /** The scheduler's single-connection client on the DIRECT URL. */
  db: Db;
  log: Logger;
  dryRun?: boolean;
}

export interface FreezeTickReport {
  frozen: FrozenPeriod[];
  /** A period's catch-up failed this tick; retried after FREEZE_RETRY_MS. */
  failed: boolean;
}

export class LeaderboardFreezeJob {
  /** The cut-off key per period whose catch-up has completed. */
  private readonly done = new Map<FreezePeriod, string>();
  private retryAt = 0;

  constructor(private readonly deps: LeaderboardFreezeDeps) {}

  /** Called every scheduler tick. Queries only when a cut-off key has moved (or after a failure's back-off). */
  async tick(now: Date = new Date()): Promise<FreezeTickReport> {
    const report: FreezeTickReport = { frozen: [], failed: false };
    if (now.getTime() < this.retryAt) return report;
    const { db, log, dryRun } = this.deps;

    for (const period of FREEZE_PERIODS) {
      const cutoff = freezeCutoffKey(period, now);
      if (this.done.get(period) === cutoff) continue;
      try {
        const keys = await findUnfrozenPeriods(db, period, freezeFloorKey(period, now), cutoff);
        for (const key of keys) {
          const frozen = await freezePeriod(db, period, key, { now, dryRun });
          report.frozen.push(frozen);
          log.info({ ...frozen, dryRun: dryRun ?? false }, "leaderboard period frozen");
        }
        this.done.set(period, cutoff);
      } catch (err) {
        report.failed = true;
        this.retryAt = now.getTime() + FREEZE_RETRY_MS;
        log.error({ err, period, cutoff }, "leaderboard freeze failed; retrying later");
        return report;
      }
    }
    return report;
  }
}
