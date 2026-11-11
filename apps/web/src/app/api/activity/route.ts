import { requireActionUser } from "@/lib/auth/guards";
import { AppError } from "@/lib/errors";
import { recordActivityPing } from "@/lib/help/activity";
import { isSameOrigin } from "@/lib/help/same-origin";
import { activityPingSchema } from "@/lib/help/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/activity — the workspace's active-time ping (ActivityTracker).
 * Body: { problemId, seconds }, sent as JSON by fetch or as text by
 * navigator.sendBeacon on pagehide. Cookie session; same-origin only.
 *
 *   200 { credited, activeSeconds }   accepted (credited may be 0)
 *   400 malformed body · 401 signed out · 403 cross-site · 404 unknown problem
 *   202 { credited: 0, deferred: true, retryAfterMs }   inside the 20 s
 *       window (one accepted ping per 20 s per problem). Not an error: a page
 *       load or tab hide routinely lands inside the window, and the tracker
 *       keeps the seconds for its next ping.
 *
 * Crediting and its caps live in src/lib/help/activity.ts.
 */

/** A ping is ~80 bytes; anything much larger is not one. */
const MAX_BODY_BYTES = 1_024;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return undefined;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return json({ error: "Cross-site requests are not accepted." }, 403);

  let userId: string;
  try {
    userId = (await requireActionUser()).id;
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    throw error;
  }

  const parsed = activityPingSchema.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "That activity ping is not valid." }, 400);

  const outcome = await recordActivityPing({ userId, problemId: parsed.data.problemId, seconds: parsed.data.seconds });
  switch (outcome.status) {
    case "accepted":
      return json({ credited: outcome.credited, activeSeconds: outcome.activeSeconds });
    case "rate-limited":
      return json({ credited: 0, deferred: true, retryAfterMs: outcome.retryAfterMs }, 202, {
        "retry-after": String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1000))),
      });
    case "not-found":
      return json({ error: "That problem is not available." }, 404);
  }
}
