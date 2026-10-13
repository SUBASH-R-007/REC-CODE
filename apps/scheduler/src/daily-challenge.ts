import { createHash } from "node:crypto";
import type { Db } from "@recx/db";
import { campusDay, dayDifference } from "@recx/shared";
import type { Logger } from "pino";

/**
 * Daily challenge. At campus midnight (Asia/Kolkata) a DailyChallenge row
 * must exist for the new day; a first solve of that problem on that day pays
 * 2x XP (apps/web src/lib/progress). Each tick costs nothing once the day's
 * row is known to exist; otherwise one primary-key lookup, and — once a day —
 * the pick and a single insert.
 *
 * The pick is deterministic for a given date and candidate set (rendezvous
 * hashing: every candidate scores sha256(day + ":" + problemId), the highest
 * wins, so adding or retiring one problem never reshuffles the others):
 *
 *   1. PUBLISHED problems with a live version, not the daily challenge
 *      within DAILY_REUSE_WINDOW_DAYS of this date (either side);
 *   2. among those, EASY and MEDIUM when there are any — the daily challenge
 *      is for everyone;
 *   3. if every problem was used within the window (a small catalogue), the
 *      least recently used, EASY / MEDIUM first again.
 *
 * Idempotent: DailyChallenge.date is the primary key and the insert is ON
 * CONFLICT DO NOTHING, so an admin's own choice for a date is never replaced
 * and two scheduler instances cannot disagree. In the last
 * DAILY_PREPARE_AHEAD_MS before campus midnight tomorrow's row is created as
 * well, so the challenge is live at 00:00:00 rather than at the next tick.
 */

export const DAILY_REUSE_WINDOW_DAYS = 30;
export const DAILY_PREPARE_AHEAD_MS = 10 * 60_000;
export const PREFERRED_DIFFICULTIES: ReadonlySet<string> = new Set(["EASY", "MEDIUM"]);
/** With no published problem to pick, wait before looking again. */
export const DAILY_RETRY_MS = 5 * 60_000;
/** History read for the reuse rule and the least-recently-used fallback. */
const HISTORY_DAYS = 400;
const DAY_MS = 86_400_000;

// ── Pure ────────────────────────────────────────────────────────────────

/** "yyyy-MM-dd" → the UTC-midnight Date a `@db.Date` column stores. */
export function dayAsDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The campus day after `day`. */
export function nextDay(day: string): string {
  return new Date(dayAsDate(day).getTime() + DAY_MS).toISOString().slice(0, 10);
}

/** Days that must have a challenge now: today, plus tomorrow in the last minutes before campus midnight. */
export function challengeDaysToEnsure(now: Date): string[] {
  const today = campusDay(now);
  const soon = campusDay(new Date(now.getTime() + DAILY_PREPARE_AHEAD_MS));
  return soon === today ? [today] : [today, soon];
}

/** Rendezvous score of a problem for a day: a deterministic 48-bit integer. */
export function challengeScore(day: string, problemId: string): number {
  return Number.parseInt(createHash("sha256").update(`${day}:${problemId}`).digest("hex").slice(0, 12), 16);
}

export interface ChallengeCandidate {
  id: string;
  difficulty: string;
}

export interface ChallengeUse {
  /** "yyyy-MM-dd" */
  day: string;
  problemId: string;
}

/** Days between `day` and the nearest other use of each problem (either side). */
function nearestUse(day: string, history: readonly ChallengeUse[]): Map<string, number> {
  const distance = new Map<string, number>();
  for (const use of history) {
    if (use.day === day) continue;
    const d = Math.abs(dayDifference(use.day, day));
    const known = distance.get(use.problemId);
    if (known === undefined || d < known) distance.set(use.problemId, d);
  }
  return distance;
}

function highestScore(day: string, pool: readonly ChallengeCandidate[]): ChallengeCandidate | null {
  let best: ChallengeCandidate | null = null;
  let bestScore = -1;
  for (const candidate of pool) {
    const score = challengeScore(day, candidate.id);
    if (score > bestScore || (score === bestScore && best !== null && candidate.id < best.id)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function preferEasyMedium(pool: readonly ChallengeCandidate[]): readonly ChallengeCandidate[] {
  const preferred = pool.filter((c) => PREFERRED_DIFFICULTIES.has(c.difficulty));
  return preferred.length > 0 ? preferred : pool;
}

/** The problem id for `day`, or null when there is no candidate at all. */
export function pickDailyChallenge(
  day: string,
  candidates: readonly ChallengeCandidate[],
  history: readonly ChallengeUse[],
): string | null {
  if (candidates.length === 0) return null;
  const distance = nearestUse(day, history);
  const gap = (c: ChallengeCandidate) => distance.get(c.id) ?? Number.POSITIVE_INFINITY;

  const fresh = candidates.filter((c) => gap(c) >= DAILY_REUSE_WINDOW_DAYS);
  if (fresh.length > 0) return highestScore(day, preferEasyMedium(fresh))?.id ?? null;

  // Every problem was used recently: the least recently used ones.
  const widest = Math.max(...candidates.map(gap));
  return highestScore(day, preferEasyMedium(candidates.filter((c) => gap(c) === widest)))?.id ?? null;
}

// ── Database ────────────────────────────────────────────────────────────

export type EnsureOutcome = "exists" | "created" | "raced" | "no-candidates" | "would-create";

/** Make sure `day` has a challenge. Never replaces an existing row. */
export async function ensureDailyChallenge(
  db: Db,
  day: string,
  options: { dryRun?: boolean } = {},
): Promise<{ outcome: EnsureOutcome; problemId: string | null }> {
  const date = dayAsDate(day);
  const existing = await db.dailyChallenge.findUnique({ where: { date }, select: { problemId: true } });
  if (existing) return { outcome: "exists", problemId: existing.problemId };

  const [candidates, history] = await Promise.all([
    db.problem.findMany({
      where: { status: "PUBLISHED", liveVersionId: { not: null } },
      select: { id: true, difficulty: true },
    }),
    db.dailyChallenge.findMany({
      where: {
        date: {
          gte: new Date(date.getTime() - HISTORY_DAYS * DAY_MS),
          lte: new Date(date.getTime() + DAILY_REUSE_WINDOW_DAYS * DAY_MS),
        },
      },
      select: { date: true, problemId: true },
    }),
  ]);
  const problemId = pickDailyChallenge(
    day,
    candidates,
    history.map((h) => ({ day: h.date.toISOString().slice(0, 10), problemId: h.problemId })),
  );
  if (!problemId) return { outcome: "no-candidates", problemId: null };
  if (options.dryRun) return { outcome: "would-create", problemId };

  const { count } = await db.dailyChallenge.createMany({ data: [{ date, problemId }], skipDuplicates: true });
  if (count === 1) return { outcome: "created", problemId };
  // Someone else (an admin, another instance) wrote the day first: theirs stands.
  const winner = await db.dailyChallenge.findUnique({ where: { date }, select: { problemId: true } });
  return { outcome: "raced", problemId: winner?.problemId ?? null };
}

// ── The job ─────────────────────────────────────────────────────────────

export interface DailyChallengeDeps {
  /** The scheduler's single-connection client on the DIRECT URL. */
  db: Db;
  log: Logger;
  dryRun?: boolean;
}

export interface DailyTickReport {
  ensured: Array<{ day: string; outcome: EnsureOutcome; problemId: string | null }>;
  failed: boolean;
}

export class DailyChallengeJob {
  /** Days whose row is known to exist (pruned to the days still relevant). */
  private readonly known = new Set<string>();
  private retryAt = 0;

  constructor(private readonly deps: DailyChallengeDeps) {}

  /** Called every scheduler tick: free once today's (and, near midnight, tomorrow's) row is known. */
  async tick(now: Date = new Date()): Promise<DailyTickReport> {
    const report: DailyTickReport = { ensured: [], failed: false };
    const days = challengeDaysToEnsure(now);
    for (const day of [...this.known]) if (!days.includes(day)) this.known.delete(day);
    const missing = days.filter((day) => !this.known.has(day));
    if (missing.length === 0 || now.getTime() < this.retryAt) return report;

    const { db, log, dryRun } = this.deps;
    for (const day of missing) {
      try {
        const result = await ensureDailyChallenge(db, day, { dryRun });
        report.ensured.push({ day, ...result });
        if (result.outcome === "no-candidates") {
          this.retryAt = now.getTime() + DAILY_RETRY_MS;
          log.warn({ day }, "no published problem can be the daily challenge; retrying later");
          continue;
        }
        // A dry run decides once per day too, rather than re-deciding every tick.
        this.known.add(day);
        if (result.outcome !== "exists") log.info({ day, ...result, dryRun: dryRun ?? false }, "daily challenge set");
      } catch (err) {
        report.failed = true;
        this.retryAt = now.getTime() + DAILY_RETRY_MS;
        log.error({ err, day }, "could not set the daily challenge; retrying later");
        return report;
      }
    }
    return report;
  }
}
