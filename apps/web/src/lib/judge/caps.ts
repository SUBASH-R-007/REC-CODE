import type { DbTx } from "@recx/db";
import { LIMITS } from "@recx/shared";

/**
 * Per-user judge caps (LIMITS.userCaps). The evaluation is pure and
 * unit-tested; the two loaders read what it needs inside the caller's
 * transaction, after the per-user advisory lock, so a double-click cannot
 * slip past an in-flight cap.
 *
 *   in flight     2 submissions / 1 run (QUEUED or JUDGING) — not overridable
 *   practice/day  PRACTICE submissions per Asia/Kolkata calendar day:
 *                 finalised (UserJudgeUsage.submissions) + in flight
 *   runs/hour     RunRequest rows in the trailing hour
 *   CPU/day       UserJudgeUsage.cpuMs for today (charged at finalise)
 *
 * An active JudgeQuotaOverride (the latest by createdAt that has not
 * expired) replaces each cap it sets; a null field keeps the default.
 */

export const CAP_TIME_ZONE = "Asia/Kolkata";
/** India has no daylight saving: IST is UTC+05:30 all year. */
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface JudgeCaps {
  inFlightSubmissions: number;
  inFlightRuns: number;
  practicePerDay: number;
  runsPerHour: number;
  cpuMinutesPerDay: number;
}

export function defaultCaps(): JudgeCaps {
  return { ...LIMITS.userCaps };
}

/** The overridable caps. In-flight caps protect the fleet and stay fixed. */
export const OVERRIDABLE_CAPS = ["practicePerDay", "runsPerHour", "cpuMinutesPerDay"] as const;
export type OverridableCap = (typeof OVERRIDABLE_CAPS)[number];

export interface CapOverride {
  practicePerDay: number | null;
  runsPerHour: number | null;
  cpuMinutesPerDay: number | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export function isOverrideActive(override: Pick<CapOverride, "expiresAt">, now: Date): boolean {
  return override.expiresAt === null || override.expiresAt.getTime() > now.getTime();
}

/** The latest (by createdAt) override that has not expired, or null. */
export function activeOverride<T extends CapOverride>(overrides: readonly T[], now: Date): T | null {
  let best: T | null = null;
  for (const o of overrides) {
    if (!isOverrideActive(o, now)) continue;
    if (!best || o.createdAt.getTime() > best.createdAt.getTime()) best = o;
  }
  return best;
}

/** Defaults with every non-null override field applied. */
export function effectiveCaps(override: Omit<CapOverride, "expiresAt" | "createdAt"> | null, base = defaultCaps()): JudgeCaps {
  if (!override) return base;
  return {
    ...base,
    practicePerDay: override.practicePerDay ?? base.practicePerDay,
    runsPerHour: override.runsPerHour ?? base.runsPerHour,
    cpuMinutesPerDay: override.cpuMinutesPerDay ?? base.cpuMinutesPerDay,
  };
}

// ── The Asia/Kolkata calendar day ─────────────────────────────────────

/**
 * The UserJudgeUsage.day key for an instant: the IST calendar date as a
 * Date at 00:00 UTC (Prisma maps a @db.Date column to the UTC date part).
 * Equal to `(now AT TIME ZONE 'Asia/Kolkata')::date` in SQL.
 */
export function istDay(now: Date): Date {
  const shifted = now.getTime() + IST_OFFSET_MS;
  return new Date(Math.floor(shifted / DAY_MS) * DAY_MS);
}

/** The instant the current IST day began (IST midnight, as a UTC instant). */
export function istDayStart(now: Date): Date {
  return new Date(istDay(now).getTime() - IST_OFFSET_MS);
}

/** The next IST midnight, when the daily caps reset. */
export function nextIstMidnight(now: Date): Date {
  return new Date(istDayStart(now).getTime() + DAY_MS);
}

/**
 * "2026-10-12T18:00" (an <input type="datetime-local"> value) read as IST.
 * Null when malformed or not a real calendar time.
 */
export function parseIstLocalDateTime(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi));
  // Reject rollovers such as 2026-02-31 or 24:61.
  if (
    wall.getUTCFullYear() !== y ||
    wall.getUTCMonth() !== mo - 1 ||
    wall.getUTCDate() !== d ||
    wall.getUTCHours() !== h ||
    wall.getUTCMinutes() !== mi
  ) {
    return null;
  }
  return new Date(wall.getTime() - IST_OFFSET_MS);
}

// ── Evaluation ────────────────────────────────────────────────────────

export type CapName = keyof JudgeCaps;

export type CapDecision = { ok: true } | { ok: false; cap: CapName; message: string };

export interface SubmitUsage {
  /** Submissions of any origin that are QUEUED or JUDGING. */
  inFlight: number;
  /** PRACTICE submissions today: finalised (UserJudgeUsage) + in flight. */
  practiceToday: number;
  /** CPU ms charged today (UserJudgeUsage.cpuMs). */
  cpuMsToday: number;
}

export interface RunUsage {
  /** Runs that are QUEUED or JUDGING (and not expired). */
  inFlight: number;
  /** RunRequest rows created in the trailing hour. */
  runsLastHour: number;
  /** When enough of those age out for one more run; null when not at the cap. */
  runSlotFreesAt: Date | null;
  cpuMsToday: number;
}

const OK: CapDecision = { ok: true };

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function cpuDecision(caps: JudgeCaps, cpuMsToday: number): CapDecision {
  if (cpuMsToday < caps.cpuMinutesPerDay * 60_000) return OK;
  const n = caps.cpuMinutesPerDay;
  return {
    ok: false,
    cap: "cpuMinutesPerDay",
    message: `You have used today's ${n} ${plural(n, "CPU-minute")} of judging. It resets at midnight IST.`,
  };
}

/** "in 1 minute" / "in 12 minutes" — never "in 0 minutes". */
function inMinutes(from: Date, to: Date): string {
  const minutes = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 60_000));
  return `in ${minutes} ${plural(minutes, "minute")}`;
}

/**
 * Submit. Lasting limits are reported before the momentary in-flight one,
 * so a student is not told to wait for a judgement only to be refused again.
 */
export function evaluateSubmitCaps(caps: JudgeCaps, usage: SubmitUsage): CapDecision {
  if (usage.practiceToday >= caps.practicePerDay) {
    const n = caps.practicePerDay;
    return {
      ok: false,
      cap: "practicePerDay",
      message: `You have made today's ${n} practice ${plural(n, "submission")}. The limit resets at midnight IST.`,
    };
  }
  const cpu = cpuDecision(caps, usage.cpuMsToday);
  if (!cpu.ok) return cpu;
  if (usage.inFlight >= caps.inFlightSubmissions) {
    const n = caps.inFlightSubmissions;
    return {
      ok: false,
      cap: "inFlightSubmissions",
      message: `You already have ${n} ${plural(n, "submission")} being judged. Wait for one to finish, then submit again.`,
    };
  }
  return OK;
}

export function evaluateRunCaps(caps: JudgeCaps, usage: RunUsage, now: Date): CapDecision {
  const cpu = cpuDecision(caps, usage.cpuMsToday);
  if (!cpu.ok) return cpu;
  if (usage.runsLastHour >= caps.runsPerHour) {
    const n = caps.runsPerHour;
    const when = usage.runSlotFreesAt ? inMinutes(now, usage.runSlotFreesAt) : "within the hour";
    return {
      ok: false,
      cap: "runsPerHour",
      message: `You have used ${n} ${plural(n, "run")} in the last hour. You can run again ${when}.`,
    };
  }
  if (usage.inFlight >= caps.inFlightRuns) {
    return {
      ok: false,
      cap: "inFlightRuns",
      message: "Your previous run is still in progress. Wait for it to finish, then run again.",
    };
  }
  return OK;
}

/**
 * Index (0-based, oldest first) of the run in the trailing hour whose
 * ageing-out frees one slot: with `count` runs and a cap of `cap`, the
 * (count − cap)-th oldest. Null when below the cap.
 */
export function freeingRunOffset(count: number, cap: number): number | null {
  return count >= cap ? Math.max(0, count - cap) : null;
}

// ── Loaders (inside the caller's transaction) ─────────────────────────

const IN_FLIGHT = ["QUEUED", "JUDGING"] as const;

export async function loadCaps(tx: DbTx, userId: string, now: Date): Promise<JudgeCaps> {
  const override = await tx.judgeQuotaOverride.findFirst({
    where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: { createdAt: "desc" },
    select: { practicePerDay: true, runsPerHour: true, cpuMinutesPerDay: true },
  });
  return effectiveCaps(override);
}

async function cpuMsToday(tx: DbTx, userId: string, now: Date): Promise<{ cpuMs: number; submissions: number }> {
  const usage = await tx.userJudgeUsage.findUnique({
    where: { userId_day: { userId, day: istDay(now) } },
    select: { cpuMs: true, submissions: true },
  });
  return { cpuMs: usage ? Number(usage.cpuMs) : 0, submissions: usage?.submissions ?? 0 };
}

/**
 * UserJudgeUsage.submissions is charged by the finalise transaction (under
 * its own `user:` lock), so a submission finalised between these reads can
 * be counted once too few — bounded by the in-flight cap, never more.
 */
export async function loadSubmitUsage(tx: DbTx, userId: string, now: Date): Promise<SubmitUsage> {
  const [usage, inFlight, inFlightPractice] = await Promise.all([
    cpuMsToday(tx, userId, now),
    tx.submission.count({ where: { userId, status: { in: [...IN_FLIGHT] } } }),
    tx.submission.count({ where: { userId, origin: "PRACTICE", status: { in: [...IN_FLIGHT] } } }),
  ]);
  return { inFlight, practiceToday: usage.submissions + inFlightPractice, cpuMsToday: usage.cpuMs };
}

export async function loadRunUsage(tx: DbTx, userId: string, now: Date, caps: JudgeCaps): Promise<RunUsage> {
  const since = new Date(now.getTime() - HOUR_MS);
  const [usage, inFlight, runsLastHour] = await Promise.all([
    cpuMsToday(tx, userId, now),
    tx.runRequest.count({ where: { userId, status: { in: [...IN_FLIGHT] }, expiresAt: { gt: now } } }),
    tx.runRequest.count({ where: { userId, createdAt: { gt: since } } }),
  ]);
  let runSlotFreesAt: Date | null = null;
  const offset = freeingRunOffset(runsLastHour, caps.runsPerHour);
  if (offset !== null) {
    const freeing = await tx.runRequest.findFirst({
      where: { userId, createdAt: { gt: since } },
      orderBy: { createdAt: "asc" },
      skip: offset,
      select: { createdAt: true },
    });
    runSlotFreesAt = freeing ? new Date(freeing.createdAt.getTime() + HOUR_MS) : null;
  }
  return { inFlight, runsLastHour, runSlotFreesAt, cpuMsToday: usage.cpuMs };
}
