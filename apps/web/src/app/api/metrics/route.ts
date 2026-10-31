import { timingSafeEqual } from "node:crypto";
import { METRICS_CONTENT_TYPE, renderMetrics } from "@/lib/metrics";
import { env } from "@/lib/env";

/**
 * `GET /api/metrics` (Phase 10a).
 *
 * **Not public.** Queue depths, verdict counts and host names are an
 * attacker's reconnaissance and a student's distraction, and SPEC §10 puts
 * the scrape on a separate monitoring network. In compose, this port is bound
 * to that network; here, the web host is the one with a public listener, so
 * it carries a bearer token as well.
 *
 * `METRICS_TOKEN` is its own secret. Without it set, the endpoint is DISABLED
 * rather than open — the alternative, "no token means no check", is how a
 * metrics endpoint ends up public on the one host that faces the internet.
 *
 * It answers 404 rather than 401 when the token is wrong or missing: there is
 * nothing here for an unauthenticated caller to retry, and a 401 advertises
 * that an endpoint worth guessing a token for exists.
 */

export const dynamic = "force-dynamic";

function authorised(request: Request): boolean {
  const expected = env().METRICS_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const offered = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (offered.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(offered, "utf8"), Buffer.from(expected, "utf8"));
}

export async function GET(request: Request): Promise<Response> {
  if (!authorised(request)) {
    return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }
  return new Response(await renderMetrics(), {
    status: 200,
    headers: { "content-type": METRICS_CONTENT_TYPE, "cache-control": "no-store" },
  });
}
