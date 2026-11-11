import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { seeOther } from "@/lib/http/form-body";
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
 *
 * **The redirect is RELATIVE, and that is not a style choice** (Phase 13a).
 *
 * It used to be `NextResponse.redirect(new URL(to, request.url), 303)`,
 * which writes an ABSOLUTE `Location` built from the host Next believes it
 * is serving. When that host is not the one the browser typed, the redirect
 * crosses origin -- and the page's own Content-Security-Policy says
 * `form-action 'self'`, which Chromium enforces on a form submission's
 * REDIRECT as well as on its action. The browser then blocks the
 * submission outright: *"Sending form data to '...' violates the following
 * Content Security Policy directive: form-action 'self'"*, printed in a
 * console the candidate does not have open. No request, no attempt, no
 * message on screen -- the Start button simply does nothing, for every
 * candidate.
 *
 * Found on this machine, where the dev server is reached as `127.0.0.1` and
 * Next resolves `request.url` to `localhost`; in production the same thing
 * happens behind any proxy or alternate hostname. A relative `Location` is
 * resolved by the browser against the URL IT used, so it is same-origin by
 * construction and there is nothing left to get wrong. `seeOther` is the
 * helper the sign-in routes have always used -- which is exactly why the
 * login form never had this bug.
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

  // The request itself, because containment is checked HERE now and not only
  // on the next request: the hall's CIDR allowlist needs the client address
  // and the Safe Exam Browser key is a hash of the URL (Phase 12s).
  const started = await startOrResumeAttempt({
    request,
    slug,
    userId: user.id,
    sessionId: session?.id ?? null,
  });
  if (!started.ok) {
    const to =
      started.refusal === "not_found"
        ? "/assessments"
        : `/assessments/${encodeURIComponent(slug)}/readiness?refused=${started.refusal}`;
    return seeOther(to);
  }
  return seeOther(`/assessments/${encodeURIComponent(slug)}/attempt`);
}
