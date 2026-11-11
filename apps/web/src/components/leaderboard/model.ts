import { z } from "zod";
import { LEADERBOARD_SCOPES, type LeaderboardScope, type XpPeriod } from "@recx/shared";

/**
 * Pure leaderboard logic: scope / period selection, the tie-break order,
 * competition ranking, and composing "top 10 + the viewer's ±2
 * neighbourhood". No database access — the SQL lives in
 * src/server/queries/leaderboard.ts and only ever reads XpBucket.
 */

export const TOP_N = 10;
export const NEIGHBOURS = 2;

// ── Scopes ─────────────────────────────────────────────────────────────

/** The viewer's own cohort, from their User row. */
export interface ViewerCohort {
  batchYear: number | null;
  departmentCode: string | null;
  section: string | null;
}

export type ScopeFilter =
  | { scope: "COLLEGE" }
  | { scope: "DEPARTMENT"; departmentCode: string }
  | { scope: "BATCH"; batchYear: number }
  | { scope: "SECTION"; batchYear: number; departmentCode: string; section: string };

/** Narrowest first: the default board is the first one the viewer has. */
const SCOPE_ORDER: readonly LeaderboardScope[] = ["SECTION", "BATCH", "DEPARTMENT", "COLLEGE"];

export function scopeFilterFor(scope: LeaderboardScope, cohort: ViewerCohort): ScopeFilter | null {
  switch (scope) {
    case "COLLEGE":
      return { scope };
    case "DEPARTMENT":
      return cohort.departmentCode ? { scope, departmentCode: cohort.departmentCode } : null;
    case "BATCH":
      return cohort.batchYear !== null ? { scope, batchYear: cohort.batchYear } : null;
    case "SECTION":
      return cohort.batchYear !== null && cohort.departmentCode && cohort.section
        ? { scope, batchYear: cohort.batchYear, departmentCode: cohort.departmentCode, section: cohort.section }
        : null;
  }
}

/** The boards this viewer can open, narrowest first (a scope they have no cohort for is not offered). */
export function availableScopes(cohort: ViewerCohort): ScopeFilter[] {
  return SCOPE_ORDER.map((scope) => scopeFilterFor(scope, cohort)).filter((f): f is ScopeFilter => f !== null);
}

/** LeaderboardSnapshot.scopeKey: "" for COLLEGE; "CSE", "2027" or "2027:CSE:A" otherwise. */
export function snapshotScopeKey(filter: ScopeFilter): string {
  switch (filter.scope) {
    case "COLLEGE":
      return "";
    case "DEPARTMENT":
      return filter.departmentCode;
    case "BATCH":
      return String(filter.batchYear);
    case "SECTION":
      return `${filter.batchYear}:${filter.departmentCode}:${filter.section}`;
  }
}

/**
 * Selector label. Only the viewer's OWN cohort is ever named here; a peer's
 * row never carries department or section codes.
 */
export function scopeLabel(filter: ScopeFilter): { title: string; detail: string } {
  switch (filter.scope) {
    case "COLLEGE":
      return { title: "College", detail: "Every student on REC Code" };
    case "DEPARTMENT":
      return { title: "Department", detail: filter.departmentCode };
    case "BATCH":
      return { title: "Batch", detail: `${filter.batchYear} batch` };
    case "SECTION":
      return { title: "Section", detail: `${filter.departmentCode} ${filter.section}, ${filter.batchYear}` };
  }
}

// ── Periods ────────────────────────────────────────────────────────────

export const PERIOD_OPTIONS = [
  { value: "week", label: "This week", period: "WEEK", previous: false },
  { value: "last-week", label: "Last week", period: "WEEK", previous: true },
  { value: "month", label: "This month", period: "MONTH", previous: false },
  { value: "all", label: "All time", period: "ALL_TIME", previous: false },
] as const satisfies ReadonlyArray<{ value: string; label: string; period: XpPeriod; previous: boolean }>;

export type PeriodOption = (typeof PERIOD_OPTIONS)[number];
export type PeriodValue = PeriodOption["value"];

const PERIOD_VALUES = PERIOD_OPTIONS.map((o) => o.value) as [PeriodValue, ...PeriodValue[]];
const SCOPE_PARAMS = LEADERBOARD_SCOPES.map((s) => s.toLowerCase()) as [string, ...string[]];

export function periodOption(value: PeriodValue): PeriodOption {
  return PERIOD_OPTIONS.find((o) => o.value === value) ?? PERIOD_OPTIONS[0];
}

// ── Search params (a server boundary: zod) ─────────────────────────────

const firstValue = (v: unknown) => (Array.isArray(v) ? v[0] : v);

const querySchema = z.object({
  scope: z.preprocess(firstValue, z.enum(SCOPE_PARAMS).optional()).catch(undefined),
  period: z.preprocess(firstValue, z.enum(PERIOD_VALUES).optional()).catch(undefined),
  view: z.preprocess(firstValue, z.enum(["full"]).optional()).catch(undefined),
});

export interface BoardQuery {
  filter: ScopeFilter;
  period: PeriodOption;
  full: boolean;
}

/**
 * Resolve ?scope=&period=&view= against the viewer's cohort. Defaults to the
 * viewer's SECTION board for THIS WEEK; an unknown or unavailable scope falls
 * back to the narrowest board the viewer has.
 */
export function parseBoardQuery(params: Record<string, unknown>, cohort: ViewerCohort): BoardQuery {
  const parsed = querySchema.parse(params);
  const scopes = availableScopes(cohort);
  const wanted = parsed.scope?.toUpperCase();
  const filter = scopes.find((f) => f.scope === wanted) ?? scopes[0] ?? { scope: "COLLEGE" as const };
  return { filter, period: periodOption(parsed.period ?? "week"), full: parsed.view === "full" };
}

export function boardHref(filter: ScopeFilter, period: PeriodValue, full = false): string {
  const params = new URLSearchParams({ scope: filter.scope.toLowerCase(), period });
  if (full) params.set("view", "full");
  return `/leaderboard?${params.toString()}`;
}

// ── Ordering and ranks ─────────────────────────────────────────────────

/** The tie-break key: more XP first; equal XP → whoever reached it first. */
export interface RankKey {
  xp: number;
  lastXpAt: Date;
}

/** True when `a` ranks strictly ahead of `b` (xp > b.xp, or equal xp reached earlier). */
export function isStrictlyAhead(a: RankKey, b: RankKey): boolean {
  return a.xp > b.xp || (a.xp === b.xp && a.lastXpAt.getTime() < b.lastXpAt.getTime());
}

export function sameRankKey(a: RankKey, b: RankKey): boolean {
  return a.xp === b.xp && a.lastXpAt.getTime() === b.lastXpAt.getTime();
}

/** "My rank" = 1 + the number of visible rows strictly ahead of me (the SQL count's result). */
export function rankFromCounts(aheadAll: number, aheadHidden: number): number {
  return 1 + Math.max(0, aheadAll - aheadHidden);
}

/**
 * Competition ranking ("1, 2, 2, 4") over rows already in board order, given
 * the board position of the first row. Exact ties — the same XP reached in
 * the same millisecond — share a rank.
 */
export function rankRows<T extends RankKey>(rows: readonly T[], firstPosition: number): Array<T & { rank: number }> {
  const ranked: Array<T & { rank: number }> = [];
  rows.forEach((row, i) => {
    const prev = ranked[i - 1];
    const rank = prev && sameRankKey(prev, row) ? prev.rank : firstPosition + i;
    ranked.push({ ...row, rank });
  });
  return ranked;
}

// ── Composing the board ────────────────────────────────────────────────

/** A source row as the query layer reads it. `userId` never leaves the server. */
export interface SourceRow extends RankKey {
  userId: string;
  name: string;
  solved: number;
  profileHref: string | null;
}

/**
 * What a board row renders. Names come only from publicName(); no email,
 * roll number, department or section — and no user id — ever reaches it.
 */
export interface BoardRow {
  rank: number;
  name: string;
  xp: number;
  solved: number;
  /** /u/[handle] when that profile is visible to signed-in users, else null. */
  profileHref: string | null;
  isViewer: boolean;
  /** The viewer opted out: this row is shown to them alone. */
  hiddenFromPeers: boolean;
}

export interface ViewerStanding {
  /** null = the viewer has no XP in this period (unranked). */
  rank: number | null;
  /** Visible students on this board. */
  total: number;
  row: SourceRow | null;
  /** The viewer opted out of peer boards (or is staff): their row is private. */
  hidden: boolean;
}

export interface BoardSegment {
  label: "top" | "around-you";
  rows: BoardRow[];
}

function toBoardRow(row: SourceRow & { rank: number }, viewerId: string | null, hiddenSelf: boolean): BoardRow {
  return {
    rank: row.rank,
    name: row.name,
    xp: row.xp,
    solved: row.solved,
    profileHref: row.profileHref,
    isViewer: row.userId === viewerId,
    hiddenFromPeers: hiddenSelf,
  };
}

/**
 * The viewer's neighbourhood: up to NEIGHBOURS visible rows strictly ahead
 * (in board order), the viewer, and up to NEIGHBOURS rows behind. Positions
 * are anchored on the viewer's counted rank, so they are exact; an exact tie
 * straddling the window's first row is the only approximation.
 *
 * A hidden viewer (opted out) is NOT a position on the visible board: the
 * rows behind them keep the rank everyone else sees.
 */
export function rankNeighbourhood(input: {
  ahead: readonly SourceRow[];
  viewer: SourceRow | null;
  viewerHidden: boolean;
  behind: readonly SourceRow[];
  viewerRank: number;
}): { rows: Array<SourceRow & { rank: number }>; viewerRow: (SourceRow & { rank: number }) | null } {
  const ahead = input.ahead.slice(-NEIGHBOURS);
  const behind = input.behind.slice(0, NEIGHBOURS);
  const firstPosition = input.viewerRank - ahead.length;
  if (input.viewer && !input.viewerHidden) {
    const rows = rankRows([...ahead, input.viewer, ...behind], firstPosition);
    return { rows, viewerRow: rows[ahead.length] ?? null };
  }
  const visible = rankRows([...ahead, ...behind], firstPosition);
  const viewerRow = input.viewer ? { ...input.viewer, rank: input.viewerRank } : null;
  return { rows: visible, viewerRow };
}

/**
 * Top N plus the neighbourhood, deduplicated, as one segment when they touch
 * (the viewer is within TOP_N + NEIGHBOURS + 1) or as two segments otherwise.
 * The viewer's row is always present when they are ranked — pinned in the
 * neighbourhood and marked "You" in text, not by colour alone.
 */
export function composeBoard(input: {
  top: ReadonlyArray<SourceRow & { rank: number }>;
  neighbourhood: ReadonlyArray<SourceRow & { rank: number }>;
  viewerRow: (SourceRow & { rank: number }) | null;
  viewerId: string | null;
  viewerHidden: boolean;
}): BoardSegment[] {
  const { top, neighbourhood, viewerRow, viewerId, viewerHidden } = input;
  if (neighbourhood.length === 0 && !viewerRow) {
    return top.length > 0 ? [{ label: "top", rows: top.map((row) => toBoardRow(row, viewerId, false)) }] : [];
  }

  const merged: Array<{ row: SourceRow & { rank: number }; hiddenSelf: boolean }> = [];
  const seen = new Set<string>();
  const push = (row: SourceRow & { rank: number }, hiddenSelf = false) => {
    if (seen.has(row.userId)) return;
    seen.add(row.userId);
    merged.push({ row, hiddenSelf });
  };

  const lastTopRank = top.at(-1)?.rank ?? 0;
  const firstWindowRank = Math.min(
    ...neighbourhood.map((r) => r.rank),
    viewerRow ? viewerRow.rank : Number.POSITIVE_INFINITY,
  );
  // Contiguous when the window starts at most one position after the top list.
  const contiguous = top.length < TOP_N || firstWindowRank <= lastTopRank + 1;

  const hiddenSelfRow = viewerHidden && viewerRow ? viewerRow : null;
  const insertHiddenSelf = (list: ReadonlyArray<SourceRow & { rank: number }>) => {
    // The private row sits before the first visible row ranked at or after it.
    const out: Array<{ row: SourceRow & { rank: number }; hiddenSelf: boolean }> = [];
    let placed = hiddenSelfRow === null;
    for (const row of list) {
      if (!placed && hiddenSelfRow && row.rank >= hiddenSelfRow.rank) {
        out.push({ row: hiddenSelfRow, hiddenSelf: true });
        placed = true;
      }
      out.push({ row, hiddenSelf: false });
    }
    if (!placed && hiddenSelfRow) out.push({ row: hiddenSelfRow, hiddenSelf: true });
    return out;
  };

  if (contiguous) {
    for (const row of top) push(row);
    for (const row of neighbourhood) push(row);
    merged.sort((a, b) => a.row.rank - b.row.rank);
    const visible = merged.map((m) => m.row);
    const rows = insertHiddenSelf(visible).map((m) => toBoardRow(m.row, viewerId, m.hiddenSelf));
    return rows.length > 0 ? [{ label: "top", rows }] : [];
  }

  const topRows = top.map((row) => toBoardRow(row, viewerId, false));
  const windowRows = insertHiddenSelf(neighbourhood).map((m) => toBoardRow(m.row, viewerId, m.hiddenSelf));
  return [
    { label: "top", rows: topRows },
    { label: "around-you", rows: windowRows },
  ];
}

/** XP the viewer needs to pass the row directly ahead (equal XP reached later still ranks behind). */
export function xpToMoveUp(viewer: RankKey | null, ahead: RankKey | null): number | null {
  if (!viewer || !ahead) return null;
  return Math.max(1, ahead.xp - viewer.xp + 1);
}

// ── The full board (virtualised on the client) ─────────────────────────

/**
 * Compact row for the virtualised full board: [rank, name, xp, solved,
 * profileHref, flags]. flags: 1 = the viewer, 2 = the viewer's private row.
 */
export type FullBoardRow = [rank: number, name: string, xp: number, solved: number, href: string | null, flags: number];

export const FULL_ROW_VIEWER = 1;
export const FULL_ROW_HIDDEN_SELF = 2;

export function toFullBoardRows(
  ranked: ReadonlyArray<SourceRow & { rank: number }>,
  viewerId: string | null,
  hiddenSelf: (SourceRow & { rank: number }) | null,
): FullBoardRow[] {
  const rows: FullBoardRow[] = [];
  let placed = hiddenSelf === null;
  for (const row of ranked) {
    if (!placed && hiddenSelf && row.rank >= hiddenSelf.rank) {
      rows.push([hiddenSelf.rank, hiddenSelf.name, hiddenSelf.xp, hiddenSelf.solved, null, FULL_ROW_VIEWER | FULL_ROW_HIDDEN_SELF]);
      placed = true;
    }
    rows.push([row.rank, row.name, row.xp, row.solved, row.profileHref, row.userId === viewerId ? FULL_ROW_VIEWER : 0]);
  }
  if (!placed && hiddenSelf) {
    rows.push([hiddenSelf.rank, hiddenSelf.name, hiddenSelf.xp, hiddenSelf.solved, null, FULL_ROW_VIEWER | FULL_ROW_HIDDEN_SELF]);
  }
  return rows;
}
