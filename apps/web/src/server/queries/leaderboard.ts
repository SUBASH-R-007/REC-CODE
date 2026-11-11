import "server-only";
import { z } from "zod";
import { Prisma, type ProfileVisibility, type Role } from "@recx/db";
import { RESTRICTED_STATUSES, isRestrictedStatus, periodKey, type XpPeriod } from "@recx/shared";
import { publicName } from "@recx/design";
import { db } from "@/lib/db";
import {
  NEIGHBOURS,
  TOP_N,
  composeBoard,
  rankFromCounts,
  rankNeighbourhood,
  rankRows,
  snapshotScopeKey,
  toFullBoardRows,
  xpToMoveUp,
  type BoardQuery,
  type BoardSegment,
  type FullBoardRow,
  type ScopeFilter,
  type SourceRow,
} from "@/components/leaderboard/model";

/**
 * Leaderboard reads. XpBucket ONLY — never the XpEvent ledger
 * (tests/repo/xp-ledger.test.ts). Every board is one ordered scan of a
 * (period, periodKey[, cohort…], xp DESC, lastXpAt ASC) index:
 *
 *   top N        ORDER BY xp DESC, lastXpAt ASC LIMIT N
 *   my rank      1 + count(*) WHERE xp > mine OR (xp = mine AND lastXpAt < mine)
 *                — an index-only count, minus the (few) hidden rows ahead
 *   neighbours   ±2 rows by keyset from my (xp, lastXpAt)
 *
 * Hidden rows — students who opted out of peer boards, and staff — are
 * excluded from every peer-visible list; an opted-out viewer still sees their
 * own rank, privately.
 */

/** A hard ceiling for the virtualised full board (the college is ~5,000 students). */
export const FULL_BOARD_CAP = 10_000;

/**
 * Peers never see these rows: opted-out students, staff accounts, and — from
 * Phase 8 — a student whose account is paused for inactivity.
 *
 * "Leaderboard visibility" is the first thing SPEC §5 lists among what
 * SOFT_RESTRICTED blocks, and this one SQL fragment is the whole mechanism:
 * it is what every board, every "my rank" and every peer view reads through.
 * Nothing is deleted and no XP is lost — the row simply is not shown, and it
 * reappears the moment the restriction lifts.
 */
const HIDDEN = Prisma.sql`(u."leaderboardOptOut" OR u."role" <> 'STUDENT'::"Role"
  OR u."status" = ANY (${RESTRICTED_STATUSES as unknown as string[]}::"AccountStatus"[]))`;

const ROW_COLUMNS = Prisma.sql`b."userId", b."xp", b."lastXpAt",
  (b."solvedEasy" + b."solvedMedium" + b."solvedHard")::int AS "solved",
  u."firstName", u."lastName", u."handle", u."visibility"`;

/** WHERE clause of one board: period bucket + the cohort columns of the scope. */
export function bucketScopeSql(period: XpPeriod, key: string, filter: ScopeFilter): Prisma.Sql {
  const base = Prisma.sql`b."period" = ${period}::"XpPeriod" AND b."periodKey" = ${key}`;
  switch (filter.scope) {
    case "COLLEGE":
      return base;
    case "DEPARTMENT":
      return Prisma.sql`${base} AND b."departmentCode" = ${filter.departmentCode}`;
    case "BATCH":
      return Prisma.sql`${base} AND b."batchYear" = ${filter.batchYear}::int`;
    case "SECTION":
      return Prisma.sql`${base} AND b."batchYear" = ${filter.batchYear}::int AND b."departmentCode" = ${filter.departmentCode} AND b."section" = ${filter.section}`;
  }
}

/**
 * The viewer's standing in one board, in one round trip: their bucket row,
 * the index-only count of rows strictly ahead, the hidden rows among them,
 * and the board's size. No row is read into JS.
 */
export function standingSql(period: XpPeriod, key: string, filter: ScopeFilter, userId: string): Prisma.Sql {
  const scope = bucketScopeSql(period, key, filter);
  const ahead = Prisma.sql`(b."xp" > me."xp" OR (b."xp" = me."xp" AND b."lastXpAt" < me."lastXpAt"))`;
  return Prisma.sql`
    WITH me AS (
      SELECT m."xp", m."lastXpAt", (m."solvedEasy" + m."solvedMedium" + m."solvedHard")::int AS "solved"
      FROM "XpBucket" m
      WHERE m."period" = ${period}::"XpPeriod" AND m."periodKey" = ${key} AND m."userId" = ${userId}
    )
    SELECT
      (SELECT me."xp" FROM me) AS "xp",
      (SELECT me."lastXpAt" FROM me) AS "lastXpAt",
      (SELECT me."solved" FROM me) AS "solved",
      (SELECT count(*) FROM "XpBucket" b, me WHERE ${scope} AND ${ahead})::int AS "aheadAll",
      (SELECT count(*) FROM "XpBucket" b JOIN "User" u ON u."id" = b."userId", me
        WHERE ${scope} AND ${HIDDEN} AND ${ahead})::int AS "aheadHidden",
      (SELECT count(*) FROM "XpBucket" b WHERE ${scope})::int AS "totalAll",
      (SELECT count(*) FROM "XpBucket" b JOIN "User" u ON u."id" = b."userId"
        WHERE ${scope} AND ${HIDDEN})::int AS "totalHidden"`;
}

/** The first `limit` visible rows of a board, in board order. */
export function topRowsSql(period: XpPeriod, key: string, filter: ScopeFilter, limit: number): Prisma.Sql {
  return Prisma.sql`
    SELECT ${ROW_COLUMNS}
    FROM "XpBucket" b JOIN "User" u ON u."id" = b."userId"
    WHERE ${bucketScopeSql(period, key, filter)} AND NOT ${HIDDEN}
    ORDER BY b."xp" DESC, b."lastXpAt" ASC, b."userId" ASC
    LIMIT ${limit}`;
}

/** Up to `limit` visible rows strictly ahead of (xp, lastXpAt), nearest first. */
export function aheadRowsSql(
  period: XpPeriod,
  key: string,
  filter: ScopeFilter,
  me: { xp: number; lastXpAt: Date },
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT ${ROW_COLUMNS}
    FROM "XpBucket" b JOIN "User" u ON u."id" = b."userId"
    WHERE ${bucketScopeSql(period, key, filter)} AND NOT ${HIDDEN}
      AND b."xp" >= ${me.xp}
      AND (b."xp" > ${me.xp} OR b."lastXpAt" < ${me.lastXpAt}::timestamp(3))
    ORDER BY b."xp" ASC, b."lastXpAt" DESC, b."userId" DESC
    LIMIT ${limit}`;
}

/** Up to `limit` visible rows at or behind (xp, lastXpAt), excluding the viewer, nearest first. */
export function behindRowsSql(
  period: XpPeriod,
  key: string,
  filter: ScopeFilter,
  me: { userId: string; xp: number; lastXpAt: Date },
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT ${ROW_COLUMNS}
    FROM "XpBucket" b JOIN "User" u ON u."id" = b."userId"
    WHERE ${bucketScopeSql(period, key, filter)} AND NOT ${HIDDEN}
      AND b."userId" <> ${me.userId}
      AND b."xp" <= ${me.xp}
      AND (b."xp" < ${me.xp} OR b."lastXpAt" >= ${me.lastXpAt}::timestamp(3))
    ORDER BY b."xp" DESC, b."lastXpAt" ASC, b."userId" ASC
    LIMIT ${limit}`;
}

// ── Row mapping ────────────────────────────────────────────────────────

interface DbBoardRow {
  userId: string;
  xp: number;
  lastXpAt: Date;
  solved: number;
  firstName: string;
  lastName: string;
  handle: string;
  visibility: ProfileVisibility;
}

interface DbStanding {
  xp: number | null;
  lastXpAt: Date | null;
  solved: number | null;
  aheadAll: number;
  aheadHidden: number;
  totalAll: number;
  totalHidden: number;
}

/** A peer's profile link: signed-in viewers may open PUBLIC and REC_ONLY profiles. */
export function peerProfileHref(visibility: ProfileVisibility, handle: string): string | null {
  return visibility === "PRIVATE" ? null : `/u/${encodeURIComponent(handle)}`;
}

function toSourceRow(row: DbBoardRow): SourceRow {
  return {
    userId: row.userId,
    xp: row.xp,
    lastXpAt: row.lastXpAt,
    solved: row.solved,
    name: publicName(row.firstName, row.lastName),
    profileHref: peerProfileHref(row.visibility, row.handle),
  };
}

// ── Snapshots of closed periods ────────────────────────────────────────

/**
 * LeaderboardSnapshot.top as this reader accepts it: an array in board order
 * of { userId, xp, lastXpAt? }. Names are never trusted from the snapshot —
 * they are re-read (and opt-outs re-applied) at read time.
 */
export const snapshotTopSchema = z.array(
  z
    .object({
      userId: z.string().min(1),
      xp: z.number().int(),
      lastXpAt: z.coerce.date().optional(),
    })
    .passthrough(),
);

async function snapshotRows(period: XpPeriod, key: string, filter: ScopeFilter): Promise<SourceRow[] | null> {
  const snapshot = await db.leaderboardSnapshot.findUnique({
    where: {
      period_periodKey_scope_scopeKey: { period, periodKey: key, scope: filter.scope, scopeKey: snapshotScopeKey(filter) },
    },
    select: { top: true },
  });
  if (!snapshot) return null;
  const parsed = snapshotTopSchema.safeParse(snapshot.top);
  if (!parsed.success) {
    console.warn(`[leaderboard] unreadable snapshot ${period}/${key}/${filter.scope}; reading buckets instead`);
    return null;
  }
  const entries = parsed.data;
  const users = await db.user.findMany({
    where: { id: { in: entries.map((e) => e.userId) } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      handle: true,
      visibility: true,
      leaderboardOptOut: true,
      role: true,
      status: true,
    },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return entries
    .map((entry, index) => ({ entry, index, user: byId.get(entry.userId) }))
    .filter((e): e is typeof e & { user: NonNullable<typeof e.user> } => e.user !== undefined && !isHidden(e.user))
    .map(({ entry, index, user }) => ({
      userId: entry.userId,
      xp: entry.xp,
      // Without a timestamp, the frozen order is the tie-break.
      lastXpAt: entry.lastXpAt ?? new Date(index),
      solved: typeof entry.solved === "number" ? entry.solved : 0,
      name: publicName(user.firstName, user.lastName),
      profileHref: peerProfileHref(user.visibility, user.handle),
    }))
    .sort((a, b) => b.xp - a.xp || a.lastXpAt.getTime() - b.lastXpAt.getTime());
}

export function isHidden(user: { leaderboardOptOut: boolean; role: Role; status?: string }): boolean {
  if (user.leaderboardOptOut || user.role !== "STUDENT") return true;
  // `status` is optional so a caller that genuinely has no status (a frozen
  // snapshot row) still type-checks — but every live caller passes it, and
  // the SQL fragment above is the real gate for the board itself.
  return user.status !== undefined && isRestrictedStatus(user.status);
}

// ── The page model ─────────────────────────────────────────────────────

export interface LeaderboardViewer {
  id: string;
  firstName: string;
  lastName: string;
  role: Role;
  leaderboardOptOut: boolean;
  /** Phase 8: a paused account is not ranked, and is told why. */
  status?: string;
}

export interface LeaderboardStanding {
  /** Staff are never ranked; students with no XP this period are unranked. */
  kind: "staff" | "unranked" | "ranked";
  rank: number | null;
  total: number;
  xp: number;
  solved: number;
  /** The viewer opted out: the rank is shown to them alone. */
  hidden: boolean;
  xpToMoveUp: number | null;
}

export interface LeaderboardView {
  periodKey: string;
  /** "snapshot" = a closed period read from its frozen top list. */
  source: "live" | "snapshot";
  segments: BoardSegment[];
  standing: LeaderboardStanding;
  /** Present only in "View full board" mode. */
  full: FullBoardRow[] | null;
}

/** The bucket key a period option reads: this week/month/all, or last week. */
export function boardPeriodKey(query: Pick<BoardQuery, "period">, now: Date): string {
  const at = query.period.previous ? new Date(now.getTime() - 7 * 86_400_000) : now;
  return periodKey(query.period.period, at);
}

export async function getLeaderboard(
  viewer: LeaderboardViewer,
  query: BoardQuery,
  now: Date = new Date(),
): Promise<LeaderboardView> {
  const period = query.period.period;
  const key = boardPeriodKey(query, now);
  const filter = query.filter;
  const isStaff = viewer.role !== "STUDENT";
  const viewerHidden = isHidden(viewer);

  const frozen = query.period.previous ? await snapshotRows(period, key, filter) : null;

  const [standingRows, liveTop] = await Promise.all([
    db.$queryRaw<DbStanding[]>(standingSql(period, key, filter, viewer.id)),
    frozen
      ? Promise.resolve(null)
      : db.$queryRaw<DbBoardRow[]>(topRowsSql(period, key, filter, query.full ? FULL_BOARD_CAP : TOP_N)),
  ]);
  const s = standingRows[0];
  const ordered: SourceRow[] = frozen ?? (liveTop ?? []).map(toSourceRow);
  const rankedAll = rankRows(ordered, 1);
  const top = rankedAll.slice(0, TOP_N);

  const liveTotal = s ? s.totalAll - s.totalHidden : 0;
  const total = frozen ? Math.max(frozen.length, liveTotal) : liveTotal;
  const mine =
    s && s.xp !== null && s.lastXpAt !== null ? { xp: s.xp, lastXpAt: s.lastXpAt, solved: s.solved ?? 0 } : null;

  let viewerRow: (SourceRow & { rank: number }) | null = null;
  let neighbourhood: Array<SourceRow & { rank: number }> = [];
  let rank: number | null = null;
  let aheadRow: SourceRow | null = null;

  if (!isStaff && s && mine) {
    rank = rankFromCounts(s.aheadAll, s.aheadHidden);
    const me: SourceRow = {
      userId: viewer.id,
      ...mine,
      name: publicName(viewer.firstName, viewer.lastName),
      profileHref: "/profile",
    };
    const [aheadDb, behindDb] = await Promise.all([
      db.$queryRaw<DbBoardRow[]>(aheadRowsSql(period, key, filter, me, NEIGHBOURS)),
      db.$queryRaw<DbBoardRow[]>(behindRowsSql(period, key, filter, me, NEIGHBOURS)),
    ]);
    const ahead = aheadDb.map(toSourceRow).reverse();
    const behind = behindDb.map(toSourceRow);
    aheadRow = ahead.at(-1) ?? null;
    const result = rankNeighbourhood({ ahead, viewer: me, viewerHidden, behind, viewerRank: rank });
    neighbourhood = result.rows;
    viewerRow = result.viewerRow;
  }

  const segments = composeBoard({ top, neighbourhood, viewerRow, viewerId: viewer.id, viewerHidden });
  const full = query.full ? toFullBoardRows(rankedAll, viewer.id, viewerHidden ? viewerRow : null) : null;

  return {
    periodKey: key,
    source: frozen ? "snapshot" : "live",
    segments,
    standing: {
      kind: isStaff ? "staff" : rank === null ? "unranked" : "ranked",
      rank,
      total,
      xp: mine?.xp ?? 0,
      solved: mine?.solved ?? 0,
      hidden: viewerHidden && !isStaff,
      xpToMoveUp: viewerRow ? xpToMoveUp(viewerRow, aheadRow) : null,
    },
    full,
  };
}
