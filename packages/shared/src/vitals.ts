/**
 * Field vitals: what the browser is allowed to report, and the shape it is
 * stored in (Phase 10d).
 *
 * The decision that matters here is not which metrics to collect, it is what
 * NOT to keep. SPEC §10 asks for field vitals; it does not ask for a record
 * of which pages each student visited and how slow each visit was. So:
 *
 *   - a report carries a METRIC, a VALUE and a ROUTE, and nothing else;
 *   - the route must be one of a closed list, so the key space is bounded
 *     and a stranger cannot fill Redis with keys of their own choosing;
 *   - the value is bucketed before it is stored, so what accumulates is a
 *     histogram per route per day and never a stream of timings that could
 *     be lined up with a session;
 *   - there is no user id, which also means the endpoint needs no session
 *     and works on a signed-out page.
 *
 * The cost of that choice, stated rather than discovered later: "which
 * students see a slow editor" is unanswerable from this data. A per-student
 * vitals table would answer it, and would be a browsing history with a
 * performance column attached.
 */

/**
 * The metrics accepted, which are web-vitals v4's own names.
 *
 * INP replaced FID in v4 and FID is deliberately absent: a report naming it
 * is from a stale bundle, and accepting it would mean two metrics measuring
 * roughly the same thing in the same histogram.
 */
export const VITAL_METRICS = ["LCP", "CLS", "INP", "FCP", "TTFB"] as const;
export type VitalMetric = (typeof VITAL_METRICS)[number];

export function isVitalMetric(value: string): value is VitalMetric {
  return (VITAL_METRICS as readonly string[]).includes(value);
}

/**
 * The routes sampled, as route PATTERNS rather than URLs.
 *
 * A closed list for two reasons. The key space stays bounded — an
 * unauthenticated endpoint that lets the caller name the key is a way to
 * fill a datastore — and a dynamic segment never reaches it: `/problems/
 * two-sum` is reported as `/problems/[slug]`, so the histogram is per PAGE
 * rather than per problem. Which problem a student opened at 11:02 is not a
 * performance question.
 */
export const VITAL_ROUTES = [
  "/dashboard",
  "/problems",
  "/problems/[slug]",
  "/contests",
  "/contests/[slug]",
  "/leaderboard",
  "/sheets",
  "/learn",
  "/aptitude",
  "/placement",
  "/profile",
] as const;
export type VitalRoute = (typeof VITAL_ROUTES)[number];

export function isVitalRoute(value: string): value is VitalRoute {
  return (VITAL_ROUTES as readonly string[]).includes(value);
}

/** Paths whose first segment collapses to a `[slug]` pattern. */
const SLUG_PARENTS = ["/problems", "/contests"] as const;

/**
 * A pathname → the route pattern it reports as, or null for a page that is
 * not sampled.
 *
 * Here, in shared, because the browser decides what to send and the endpoint
 * decides what to accept, and the two must be the same list — a reporter
 * that sent `/problems/two-sum` would have every beacon dropped, silently,
 * for ever.
 *
 * The collapse to `[slug]` is the privacy half of it: which PAGE is slow is
 * a performance question, and which problem a particular student opened at
 * 11:02 is not.
 *
 * `/login` is deliberately absent from `VITAL_ROUTES`: it is a zero-JavaScript
 * page by requirement (SPEC §5), so nothing there can measure anything, and
 * a route the endpoint accepts but nothing ever reports is dead
 * configuration.
 */
export function vitalRouteOf(pathname: string): VitalRoute | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (isVitalRoute(path)) return path;
  for (const parent of SLUG_PARENTS) {
    if (!path.startsWith(`${parent}/`)) continue;
    const rest = path.slice(parent.length + 1);
    // One segment only: `/problems/two-sum/submissions` is a different page
    // and is not sampled.
    if (rest.length === 0 || rest.includes("/")) return null;
    const pattern = `${parent}/[slug]`;
    return isVitalRoute(pattern) ? pattern : null;
  }
  return null;
}

/**
 * How many page loads report: one in four.
 *
 * A p75 per route per day needs tens of samples, not thousands, and this
 * platform's busiest hour is a contest — exactly when the last thing the app
 * host needs is one extra write per page view per student. The sampling is
 * done in the browser, so the request is never made at all for the other
 * three.
 */
export const VITALS_SAMPLE_RATE = 0.25;

/** Largest value worth recording per metric; anything above lands in the top bucket. */
const CLS_BUCKETS = [0.01, 0.05, 0.1, 0.15, 0.25, 0.4, 0.75, 1.5] as const;
/**
 * 2000 and 2500 are both boundaries because `docs/CAPACITY.md` sets LCP at
 * ≤2.0 s and ≤2.5 s on the statement page: with a 1800 boundary instead,
 * "is the p75 within budget" would have needed interpolating across the one
 * number the budget is written in. (The test that asserts this caught the
 * first ladder, which had 1800.)
 */
const MS_FAST = [100, 200, 400, 800, 1200, 2000, 2500, 4000, 6000, 10_000] as const;

/**
 * The bucket ladders, per metric.
 *
 * Each ladder has a boundary ON the budget it is judged against, which is
 * the whole point of choosing them by hand: `docs/CAPACITY.md` says LCP
 * ≤2.0 s and ≤2.5 s on the statement page, so 2500 is a boundary and "p75
 * within budget" is answerable from the counts without interpolating across
 * it. CLS's ladder straddles the 0.1 "good" and 0.25 "poor" thresholds for
 * the same reason.
 */
export const VITAL_BUCKETS: Readonly<Record<VitalMetric, readonly number[]>> = Object.freeze({
  LCP: MS_FAST,
  FCP: MS_FAST,
  TTFB: [50, 100, 200, 400, 800, 1200, 2000, 4000] as const,
  INP: [50, 100, 200, 300, 500, 800, 1200, 2000] as const,
  CLS: CLS_BUCKETS,
});

/** Largest sane value per metric: a report above this is dropped, not clamped. */
export const VITAL_MAX: Readonly<Record<VitalMetric, number>> = Object.freeze({
  LCP: 120_000,
  FCP: 120_000,
  TTFB: 120_000,
  INP: 60_000,
  CLS: 100,
});

/**
 * The bucket a value belongs to: the first boundary it is at or under, or
 * `"+Inf"`.
 *
 * Returned as a STRING because it is a Redis hash field, and because `+Inf`
 * has to be representable: a 40-second LCP is real (a phone on campus wifi
 * during a contest) and must not be rounded into the 10-second bucket.
 */
export function vitalBucket(metric: VitalMetric, value: number): string {
  const ladder = VITAL_BUCKETS[metric];
  for (const boundary of ladder) {
    if (value <= boundary) return String(boundary);
  }
  return "+Inf";
}

/** A report that passed validation: what the endpoint stores. */
export interface VitalReport {
  readonly metric: VitalMetric;
  readonly route: VitalRoute;
  readonly value: number;
}

/**
 * The Redis key: one hash per metric per route per DAY.
 *
 * The day is in the key rather than a field so the whole day expires at
 * once, which is what makes retention a TTL rather than a job. No user, no
 * session, no address — the key is the question this data answers.
 */
export function vitalsKey(day: string, metric: VitalMetric, route: VitalRoute): string {
  return `vitals:${day}:${metric}:${route}`;
}

/**
 * How long a day's histogram lives: five weeks.
 *
 * Long enough to compare this week with the same week last month (a contest
 * against a quiet Tuesday), short enough that nothing here outlives the
 * question it was collected for. Expiry is set on every write, so a key that
 * keeps being written keeps being extended and one that stops disappears.
 */
export const VITALS_TTL_SECONDS = 35 * 24 * 60 * 60;

/**
 * The percentile of a bucketed histogram, as the LOWER boundary of the
 * bucket the percentile falls in.
 *
 * Deliberately not interpolated. The buckets were chosen so the budget is a
 * boundary, so the useful answer is "the p75 is in the 2000–2500 bucket",
 * and interpolating would invent a precision the data does not have.
 * Returns null for an empty histogram rather than 0, because "nothing was
 * reported" and "everything was instant" are different answers.
 */
export function vitalPercentile(
  metric: VitalMetric,
  counts: Readonly<Record<string, number>>,
  percentile = 0.75,
): { bucket: string; atOrBelow: number; total: number } | null {
  const ladder = [...VITAL_BUCKETS[metric]].map(String);
  ladder.push("+Inf");
  const total = ladder.reduce((sum, bucket) => sum + (counts[bucket] ?? 0), 0);
  if (total <= 0) return null;
  const want = percentile * total;
  let seen = 0;
  for (const bucket of ladder) {
    seen += counts[bucket] ?? 0;
    if (seen >= want) return { bucket, atOrBelow: seen, total };
  }
  return { bucket: ladder.at(-1)!, atOrBelow: seen, total };
}
