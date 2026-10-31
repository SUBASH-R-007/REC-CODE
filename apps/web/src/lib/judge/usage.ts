import type { DbTx } from "@recx/db";

/**
 * Daily judge usage per user (UserJudgeUsage), charged in the finalise
 * transaction of every submission and run, under the per-user advisory lock.
 * It backs the per-user caps in LIMITS.userCaps (300 practice submissions and
 * 20 CPU-minutes per day; read by src/lib/judge/caps.ts). Results that are
 * never stored (IE, a discarded result) are never charged.
 *
 * The day is the Asia/Kolkata calendar day — the college's day, not UTC's:
 * a student judged at 00:10 IST is on a fresh budget even though it is still
 * the previous day in UTC. The day computation is pure (and unit-tested);
 * the write is one INSERT … ON CONFLICT, so it is atomic even without the
 * advisory lock.
 */

export const USAGE_TIME_ZONE = "Asia/Kolkata";

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: USAGE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Asia/Kolkata calendar day containing `at`, as "YYYY-MM-DD". */
export function usageDayKey(at: Date): string {
  if (Number.isNaN(at.getTime())) throw new RangeError("usageDayKey: invalid date");
  const parts = DAY_FORMAT.formatToParts(at);
  const part = (type: "year" | "month" | "day") => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The same day as a Date at UTC midnight — the value Prisma reads from and
 * writes to a `@db.Date` column (UserJudgeUsage.day).
 */
export function usageDay(at: Date): Date {
  return new Date(`${usageDayKey(at)}T00:00:00.000Z`);
}

export type UsageKind = "submission" | "run";

export interface UsageIncrement {
  submissions: number;
  runs: number;
  cpuMs: number;
}

/**
 * What one finalised job adds to the day's row. `submissions` counts
 * PRACTICE submissions only — it backs the practice-per-day cap, which a
 * contest or assessment submission must never use up — while every job's
 * CPU is charged. CPU ms is clamped to a non-negative integer.
 */
export function usageIncrement(kind: UsageKind, cpuMs: number, practice = true): UsageIncrement {
  const cpu = Number.isFinite(cpuMs) ? Math.max(0, Math.round(cpuMs)) : 0;
  if (kind === "run") return { submissions: 0, runs: 1, cpuMs: cpu };
  return { submissions: practice ? 1 : 0, runs: 0, cpuMs: cpu };
}

/**
 * Charge one finalised job to its user's day. Call inside the finalise
 * transaction, after the per-user advisory lock, so the verdict and the
 * charge commit together.
 */
export async function recordJudgeUsage(
  tx: DbTx,
  input: { userId: string; kind: UsageKind; cpuMs: number; at: Date; practice?: boolean },
): Promise<void> {
  const inc = usageIncrement(input.kind, input.cpuMs, input.practice ?? true);
  const day = usageDayKey(input.at);
  await tx.$executeRaw`
    INSERT INTO "UserJudgeUsage" ("userId", "day", "submissions", "runs", "cpuMs", "updatedAt")
    VALUES (${input.userId}, ${day}::date, ${inc.submissions}, ${inc.runs}, ${BigInt(inc.cpuMs)}, now())
    ON CONFLICT ("userId", "day") DO UPDATE SET
      "submissions" = "UserJudgeUsage"."submissions" + EXCLUDED."submissions",
      "runs" = "UserJudgeUsage"."runs" + EXCLUDED."runs",
      "cpuMs" = "UserJudgeUsage"."cpuMs" + EXCLUDED."cpuMs",
      "updatedAt" = now()`;
}
