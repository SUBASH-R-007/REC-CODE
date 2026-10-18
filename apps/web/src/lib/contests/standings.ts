import "server-only";

import {
  rankStandings,
  scoreParticipant,
  type AttemptRecord,
  type ContestKind,
  type RankedParticipant,
} from "@recx/shared";
import type { Db, DbTx } from "@recx/db";

/**
 * Standings, rebuilt from the authoritative rows.
 *
 * Structural decision (e), SPEC §4: ContestProblemAttempt is authoritative
 * and ContestStanding is a materialised view of it. Everything here reads
 * ONLY ContestProblemAttempt, so `rebuild-standings` can reproduce a
 * standings table byte-for-byte after a Redis flush — the phase's gate test.
 *
 * The order and the tie rule come from @recx/shared (contest-scoring.ts), so
 * the live board and this rebuild cannot disagree.
 */

/** The plain client or a transaction client, as elsewhere (lib/auth/scope.ts). */
type Client = Db | DbTx;

export interface RebuiltStanding extends RankedParticipant {
  readonly lastAcceptedAt: Date | null;
}

/**
 * Score, order and rank every participant of `contestId` from its attempts.
 * Pure apart from the one read: no writes, so it is safe to call to compare
 * against what is stored.
 */
export async function computeStandings(
  client: Client,
  contestId: string,
  kind: ContestKind,
): Promise<RebuiltStanding[]> {
  const attempts = await client.contestProblemAttempt.findMany({
    where: { contestId },
    select: {
      userId: true,
      contestProblemId: true,
      wrongAttempts: true,
      points: true,
      solvedAt: true,
      solvedAtMinutes: true,
    },
    // A total order on the read as well, so two rebuilds group identically.
    orderBy: [{ userId: "asc" }, { contestProblemId: "asc" }],
  });

  const byUser = new Map<string, { records: AttemptRecord[]; lastAcceptedAt: Date | null }>();
  for (const a of attempts) {
    let entry = byUser.get(a.userId);
    if (!entry) {
      entry = { records: [], lastAcceptedAt: null };
      byUser.set(a.userId, entry);
    }
    entry.records.push({
      contestProblemId: a.contestProblemId,
      wrongAttempts: a.wrongAttempts,
      solvedAtMinutes: a.solvedAtMinutes,
      points: a.points,
    });
    if (a.solvedAt && (entry.lastAcceptedAt === null || a.solvedAt > entry.lastAcceptedAt)) {
      entry.lastAcceptedAt = a.solvedAt;
    }
  }

  const scored = [...byUser.entries()].map(([userId, entry]) => scoreParticipant(userId, entry.records, kind));
  const ranked = rankStandings(scored, kind);
  return ranked.map((row) => ({ ...row, lastAcceptedAt: byUser.get(row.userId)?.lastAcceptedAt ?? null }));
}

/**
 * Write the rebuilt board into ContestStanding, in one transaction, and
 * bump Contest.standingsVersion so a client can tell a stale board from a
 * fresh one.
 *
 * Rows are upserted and any row no longer in the field is removed, so the
 * table always equals the rebuild exactly — that equality is what the gate
 * test asserts.
 */
export async function writeStandings(
  client: Client,
  contestId: string,
  rows: readonly RebuiltStanding[],
): Promise<{ written: number; removed: number }> {
  const keep = new Set(rows.map((r) => r.userId));
  const existing = await client.contestStanding.findMany({
    where: { contestId },
    select: { userId: true },
  });
  const stale = existing.filter((e) => !keep.has(e.userId)).map((e) => e.userId);

  for (const row of rows) {
    await client.contestStanding.upsert({
      where: { contestId_userId: { contestId, userId: row.userId } },
      create: {
        contestId,
        userId: row.userId,
        score: row.score,
        penalty: row.penalty,
        solved: row.solved,
        lastAcceptedAt: row.lastAcceptedAt,
        rank: row.rank,
      },
      update: {
        score: row.score,
        penalty: row.penalty,
        solved: row.solved,
        lastAcceptedAt: row.lastAcceptedAt,
        rank: row.rank,
        version: { increment: 1 },
      },
    });
  }

  if (stale.length > 0) {
    await client.contestStanding.deleteMany({ where: { contestId, userId: { in: stale } } });
  }
  await client.contest.update({
    where: { id: contestId },
    data: { standingsVersion: { increment: 1 } },
  });
  return { written: rows.length, removed: stale.length };
}

/** The comparable shape of a stored board, for the rebuild equality check. */
export interface StandingSnapshot {
  userId: string;
  score: number;
  penalty: number;
  solved: number;
  rank: number | null;
  lastAcceptedAt: string | null;
}

export function snapshotOf(rows: readonly RebuiltStanding[]): StandingSnapshot[] {
  return rows
    .map((r) => ({
      userId: r.userId,
      score: r.score,
      penalty: r.penalty,
      solved: r.solved,
      rank: r.rank,
      lastAcceptedAt: r.lastAcceptedAt ? r.lastAcceptedAt.toISOString() : null,
    }))
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}

/** Read the stored board in the same shape, so the two can be compared. */
export async function storedSnapshot(client: Client, contestId: string): Promise<StandingSnapshot[]> {
  const rows = await client.contestStanding.findMany({
    where: { contestId },
    select: { userId: true, score: true, penalty: true, solved: true, rank: true, lastAcceptedAt: true },
  });
  return rows
    .map((r) => ({
      userId: r.userId,
      score: r.score,
      penalty: r.penalty,
      solved: r.solved,
      rank: r.rank,
      lastAcceptedAt: r.lastAcceptedAt ? r.lastAcceptedAt.toISOString() : null,
    }))
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}
