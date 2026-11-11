import { z } from "zod";
import { MOCK_CLOCK_LIMITS } from "@recx/shared";
import { requireActionUser } from "@/lib/auth/guards";
import { AppError } from "@/lib/errors";
import { readClock } from "@/lib/aptitude/sitting";
import { hitRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/aptitude/attempts/[attemptId]/clock — the section clock (Phase 7c).
 *
 * The client renders THIS and never `Date.now()`. A section deadline ENDS
 * something — the section closes and cannot be re-entered — so an advisory
 * clock is not an option, the same reasoning Phase 6b applied to the attempt
 * clock and the opposite of a contest's.
 *
 * Polled every five seconds, never 250 ms (SPEC §7): this is a database read
 * per candidate, and a college-wide sitting at four times a second is a load
 * nobody budgeted for. The interval is `MOCK_CLOCK_LIMITS.pollMs`, so the
 * client and the rate limit cannot drift apart.
 *
 * Unlike the exam heartbeat this route answers with ordinary status codes. A
 * candidate in a practice mock whose clock request fails sees a stale
 * countdown for five seconds and then a fresh one; there is no proctoring
 * decision riding on it, so there is nothing to explain in a 200 body.
 */

const paramsSchema = z.object({ attemptId: z.string().min(1).max(64) });

const noStore = { "cache-control": "no-store" } as const;

export async function GET(
  request: Request,
  context: { params: Promise<{ attemptId: string }> },
): Promise<Response> {
  try {
    const user = await requireActionUser();
    const { attemptId } = paramsSchema.parse(await context.params);

    // Generous relative to the five-second cadence, so a reload or a second
    // tab is not refused, and tight enough that nobody can poll it at 250 ms.
    const limited = await hitRateLimit(`aptitude-clock:${user.id}`, {
      limit: 40,
      windowMs: MOCK_CLOCK_LIMITS.pollMs * 20,
    });
    if (!limited.allowed) {
      return Response.json(
        { error: "Too many clock requests. The sitting page asks every five seconds." },
        { status: 429, headers: noStore },
      );
    }

    const reading = await readClock(attemptId, user.id, new Date());
    return Response.json(reading, { headers: noStore });
  } catch (error) {
    if (error instanceof AppError) {
      return Response.json({ error: error.message }, { status: error.status, headers: noStore });
    }
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Bad request." }, { status: 400, headers: noStore });
    }
    throw error;
  }
}
