import {
  VITALS_TTL_SECONDS,
  campusDay,
  VITAL_MAX,
  isVitalMetric,
  isVitalRoute,
  vitalBucket,
  vitalsKey,
  type VitalMetric,
  type VitalRoute,
} from "@recx/shared";
import { requestIpHash } from "@/lib/ip";
import { hitRateLimit, VITALS_RATE_LIMIT } from "@/lib/rate-limit";
import { redis } from "@/lib/redis";

/**
 * `POST /api/vitals` — field performance, with no idea who sent it
 * (Phase 10d).
 *
 * **Unauthenticated on purpose**, and that is the same decision as storing
 * no user id: the slowest page load on this platform is a student signing in
 * on campus wifi, and a vitals endpoint behind a session cannot see it. What
 * makes an unauthenticated write safe is the shape of what it can do, so all
 * four of these hold:
 *
 *   1. the body may carry exactly three fields, and the metric and the route
 *      must each be one of a closed list — so the caller never names the
 *      key, and the key space is bounded by the lists in
 *      `packages/shared/src/vitals.ts`;
 *   2. the value is bucketed before it is stored, so a day's data is a
 *      histogram per route and never a stream of timings that could be
 *      lined up with a session;
 *   3. it is rate limited per hashed client address, because an
 *      unauthenticated endpoint that writes is an invitation;
 *   4. it answers 204 to everything it accepts and 204 to everything it
 *      drops. A beacon has nobody to report an error to, and an endpoint
 *      that answered 400 on a bad metric would be a way to enumerate which
 *      metrics exist.
 *
 * `sendBeacon` sends `text/plain` with a JSON body, which is deliberately
 * not a form post: the browser treats it as a simple request, so this needs
 * no CORS preflight and accepts no cross-site form.
 */

export const dynamic = "force-dynamic";

/** 2 KB is ten times the largest legitimate body. */
const MAX_BODY_BYTES = 2048;

const NO_CONTENT = { status: 204, headers: { "cache-control": "no-store" } } as const;

interface Accepted {
  metric: VitalMetric;
  route: VitalRoute;
  value: number;
}

/**
 * The body, or null.
 *
 * Hand-written rather than zod because the rule is "exactly these three
 * keys, nothing else": an object with a fourth key is refused rather than
 * stripped, so a field somebody adds client-side cannot start arriving
 * unnoticed.
 */
function parse(body: unknown): Accepted | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 3) return null;
  const { metric, route, value } = body as Record<string, unknown>;
  if (typeof metric !== "string" || typeof route !== "string" || typeof value !== "number") return null;
  if (!isVitalMetric(metric) || !isVitalRoute(route)) return null;
  if (!Number.isFinite(value) || value < 0 || value > VITAL_MAX[metric]) return null;
  return { metric, route, value };
}

async function readBody(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  const report = parse(await readBody(request).catch(() => null));
  if (!report) return new Response(null, NO_CONTENT);

  /**
   * Per hashed address, and the hash is the only thing about the sender that
   * this route ever computes — `requestIpHash()` is sha256(address + pepper)
   * and the raw address is never stored anywhere in this platform. A budget
   * of 120 a minute is a generous page-load rate for one browser and a
   * useless write rate for anybody else.
   */
  const ipHash = await requestIpHash();
  if (ipHash) {
    const hit = await hitRateLimit(`vitals:${ipHash}`, VITALS_RATE_LIMIT);
    if (!hit.allowed) return new Response(null, NO_CONTENT);
  }

  try {
    const client = redis();
    const key = vitalsKey(campusDay(new Date()), report.metric, report.route);
    await client.hincrby(key, vitalBucket(report.metric, report.value), 1);
    // Set on every write, so a key that keeps being written keeps being
    // extended and one that stops disappears on its own. Retention becomes a
    // property of the data rather than a job somebody has to remember.
    await client.expire(key, VITALS_TTL_SECONDS);
  } catch (error) {
    // Redis is transport here as everywhere else: a vitals write that fails
    // is a missing data point, never a failed page load. The beacon is sent
    // from `visibilitychange`, so there is nothing to retry into anyway.
    console.warn("[vitals] could not record:", error instanceof Error ? error.message : error);
  }

  return new Response(null, NO_CONTENT);
}
