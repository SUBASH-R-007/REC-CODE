import "server-only";
import {
  VITAL_METRICS,
  VITAL_ROUTES,
  campusDay,
  vitalPercentile,
  vitalsCohortKey,
  vitalsKey,
  type VitalMetric,
  type VitalRoute,
} from "@recx/shared";
import { redis } from "@/lib/redis";

/**
 * Reading the field vitals back (Phase 16l, `docs/ROADMAP.md` §3.4).
 *
 * §3.4 is titled "Field vitals cannot be read by cohort", and until this
 * phase the gap was wider than that: **nothing read them at all.** The
 * histograms have accumulated in Redis since Phase 10d with no surface and
 * no query — collected, retained for five weeks, and never looked at. A
 * cohort dimension on data nobody can read answers no question, so this is
 * the other half of the same entry.
 *
 * What it does NOT do, on purpose: aggregate across days into a trend.
 * `vitalPercentile` returns the bucket a percentile falls in, and those
 * buckets were chosen so a budget is a boundary — averaging a bucket index
 * across days would invent a precision the data does not have. A day is the
 * unit this data was stored in, so a day is the unit it is read in.
 */

export interface VitalCell {
  readonly metric: VitalMetric;
  readonly route: VitalRoute;
  /** The bucket the p75 falls in, or null when nothing was reported. */
  readonly bucket: string | null;
  readonly total: number;
}

export interface VitalsReading {
  readonly day: string;
  readonly cohort: string | null;
  readonly cells: readonly VitalCell[];
  /** Sum of every sample read, so an empty day is obvious rather than blank. */
  readonly samples: number;
}

/**
 * One day's p75 per metric per route, for the whole population or for one
 * cohort.
 *
 * Every key in one pipeline: this is 5 metrics × 11 routes = 55 hashes, and
 * 55 round trips to Redis on a page render is the kind of thing that works
 * on a laptop and falls over on a campus network.
 */
export async function readVitals(input: {
  readonly day?: string;
  readonly cohort?: string | null;
  readonly now?: Date;
}): Promise<VitalsReading> {
  const day = input.day ?? campusDay(input.now ?? new Date());
  const cohort = input.cohort ?? null;

  const wanted: Array<{ metric: VitalMetric; route: VitalRoute; key: string }> = [];
  for (const metric of VITAL_METRICS) {
    for (const route of VITAL_ROUTES) {
      wanted.push({
        metric,
        route,
        key: cohort === null ? vitalsKey(day, metric, route) : vitalsCohortKey(day, metric, route, cohort),
      });
    }
  }

  let raw: Array<Record<string, string>> = [];
  try {
    const pipeline = redis().pipeline();
    for (const entry of wanted) pipeline.hgetall(entry.key);
    const replies = (await pipeline.exec()) ?? [];
    raw = replies.map(([, value]) => (value as Record<string, string> | null) ?? {});
  } catch (error) {
    // Redis is transport here as everywhere else. A page that cannot read
    // the histograms says so; it does not fail.
    console.warn("[vitals] could not read:", error instanceof Error ? error.message : error);
    return { day, cohort, cells: [], samples: 0 };
  }

  let samples = 0;
  const cells = wanted.map((entry, index) => {
    const counts: Record<string, number> = {};
    for (const [bucket, value] of Object.entries(raw[index] ?? {})) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) counts[bucket] = parsed;
    }
    const p75 = vitalPercentile(entry.metric, counts);
    samples += p75?.total ?? 0;
    return {
      metric: entry.metric,
      route: entry.route,
      bucket: p75?.bucket ?? null,
      total: p75?.total ?? 0,
    } satisfies VitalCell;
  });

  return { day, cohort, cells, samples };
}

/**
 * The cohorts that reported on a day, so the page can offer a filter rather
 * than asking somebody to type a year.
 *
 * `SCAN` and not `KEYS`: this runs on a page render against the same Redis
 * the rate limiter uses, and `KEYS` on a loaded instance blocks it.
 */
export async function reportingCohorts(day: string): Promise<string[]> {
  const found = new Set<string>();
  try {
    const client = redis();
    let cursor = "0";
    do {
      const [next, keys] = await client.scan(cursor, "MATCH", `vitals:${day}:*:c:*`, "COUNT", 200);
      cursor = next;
      for (const key of keys) {
        const cohort = key.slice(key.lastIndexOf(":c:") + 3);
        if (cohort.length > 0) found.add(cohort);
      }
    } while (cursor !== "0");
  } catch (error) {
    console.warn("[vitals] could not list cohorts:", error instanceof Error ? error.message : error);
    return [];
  }
  return [...found].sort().reverse();
}
