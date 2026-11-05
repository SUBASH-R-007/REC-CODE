import { EXAM_BROWSER_PROTOCOL_VERSION, EXAM_BROWSER_TOKEN_PATTERN } from "@recx/shared";
import { audit } from "@/lib/audit";
import { exchangeLaunchToken } from "@/lib/exam/exam-browser";
import { requestIpHash } from "@/lib/ip";
import { hitRateLimit, type RateLimitRule } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/exam/browser/exchange — spend a launch token, receive the
 * sitting key (Phase 14b).
 *
 * The one request REC Exam Browser makes before it can sign anything, and
 * the only one it makes without a signature — the key it would sign with is
 * what this returns.
 *
 * **Not behind a signed-in session, deliberately.** The application has no
 * cookies: it is a fresh Chromium that has just been handed a URL by the
 * operating system. The launch token IS the authentication — it was minted
 * for a signed-in candidate on the readiness page, it is single-use, and it
 * expires in five minutes. Requiring a session here would mean asking the
 * candidate to sign in a second time, inside a window with no address bar,
 * which is the exact habit `docs/EXAM-BROWSER.md` §5 does not want to teach
 * anybody.
 *
 * What a stolen token is worth is therefore worth stating: one sitting, for
 * five minutes, once. Spending it is recorded, and a second attempt to
 * spend it is refused and audited — two applications holding one sitting's
 * key is the event an invigilator should hear about.
 */

/**
 * Generous, because a candidate whose launch failed will click it again,
 * and tight enough that guessing 64 characters of base64url is not a plan.
 */
const EXCHANGE_RATE_LIMIT = { limit: 30, windowMs: 10 * 60_000 } as const satisfies RateLimitRule;

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  const ipHash = await requestIpHash();
  const hit = await hitRateLimit(`exam-browser:exchange:${ipHash ?? "unknown"}`, EXCHANGE_RATE_LIMIT);
  if (!hit.allowed) {
    return json({ error: "Too many launches from here. Wait a minute and try again." }, 429);
  }

  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";

  // Shape first, so a malformed token never reaches a database lookup.
  if (!EXAM_BROWSER_TOKEN_PATTERN.test(token)) {
    return json({ error: "That launch is not one we issued. Launch the exam browser from the readiness check." }, 400);
  }

  const result = await exchangeLaunchToken(token);
  if (!result.ok) {
    /**
     * A second exchange is the one refusal worth a row of its own. The
     * other two mean a candidate waited too long or clicked an old link,
     * which is ordinary; this one means two applications tried to hold one
     * sitting's key.
     */
    if (result.reason === "already_used") {
      await audit({
        actorId: null,
        action: "exam.browser.launch_reused",
        entityType: "ExamBrowserSitting",
        entityId: null,
        sensitivity: "SECURITY",
        metadata: { ipHash },
      });
    }
    return json({ error: result.message }, result.reason === "unknown" ? 404 : 409);
  }

  await audit({
    actorId: null,
    action: "exam.browser.launch_bound",
    entityType: "ExamBrowserSitting",
    entityId: result.sittingId,
    sensitivity: "SECURITY",
    // The sitting and the paper. Never the key, and never the token.
    metadata: { assessmentId: result.assessmentId },
  });

  return json(
    {
      protocol: EXAM_BROWSER_PROTOCOL_VERSION,
      sittingId: result.sittingId,
      sittingKey: result.sittingKey,
      assessmentId: result.assessmentId,
    },
    200,
  );
}
