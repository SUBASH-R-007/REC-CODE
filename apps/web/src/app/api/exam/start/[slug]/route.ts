import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireActionUser } from "@/lib/auth/guards";
import { AppError } from "@/lib/errors";
import { SESSION_COOKIE, hashSessionToken } from "@/lib/auth/session-token";
import { db } from "@/lib/db";
import { startOrResumeAttempt } from "@/lib/exam/start";

export const dynamic = "force-dynamic";

/**
 * `POST /api/exam/start/[slug]` — begin or resume a sitting (Phase 12a).
 *
 * This exists because of where the attempt token has to be written. Starting
 * a sitting mints one and puts it in an httpOnly cookie, and Next refuses a
 * cookie write during a page render: "Cookies can only be modified in a
 * Server Action or Route Handler". The arena page used to call
 * `startOrResumeAttempt` while rendering, so every first sitting died with
 * that error before a candidate saw a question — found by sitting one, which
 * nothing had ever done. The page now only renders a sitting that exists;
 * this route is what creates it.
 *
 * POST, and reached from the readiness page's own form, so it works with no
 * JavaScript and so a link preview or a prefetch cannot start somebody's
 * clock.
 */
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await context.params;

  // The shared action guard, which also refuses while a super-admin is
  // viewing as somebody else: starting a sitting writes an attempt row and a
  // token, and there is nothing sensible for an impersonated session to sit.
  let user;
  try {
    user = await requireActionUser();
  } catch (error) {
    // The guard's own message and status, as every other exam route answers:
    // 401 signed out, 403 while a super-admin is viewing as somebody else. A
    // signed-out POST here means the session expired between loading the
    // readiness page and pressing the button, which is rare and is not worth
    // a redirect that would hide which of the two happened.
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = token
    ? await db.session.findUnique({ where: { tokenHash: hashSessionToken(token) }, select: { id: true } })
    : null;

  const started = await startOrResumeAttempt({ slug, userId: user.id, sessionId: session?.id ?? null });
  if (!started.ok) {
    const to =
      started.refusal === "not_found"
        ? "/assessments"
        : `/assessments/${encodeURIComponent(slug)}/readiness?refused=${started.refusal}`;
    return NextResponse.redirect(new URL(to, request.url), 303);
  }
  return NextResponse.redirect(new URL(`/assessments/${encodeURIComponent(slug)}/attempt`, request.url), 303);
}
