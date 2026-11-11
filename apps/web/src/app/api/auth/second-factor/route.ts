import { NextResponse } from "next/server";
import { SECOND_FACTOR_PATHS } from "@recx/shared";
import { readFormBody, seeOther } from "@/lib/http/form-body";
import { isSameOrigin } from "@/lib/help/same-origin";
import { referenceId } from "@/lib/errors";
import { completeSecondFactor, type SecondFactorFailure } from "@/lib/auth/second-factor";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/second-factor — finish a sign-in with a code (Phase 16j).
 *
 * Unauthenticated, like `POST /api/auth/login`, and for the same reason:
 * the person using it has no session, and will not have one until this
 * request succeeds. What stands in for a guard is the challenge — a
 * `SecondFactorChallenge` row this browser's httpOnly cookie names, five
 * minutes old at most, with an attempt count the database refuses to let
 * fall. Without one this answers `?error=no-challenge` and creates nothing.
 *
 * A plain form POST answered with a 303, like every other auth route here,
 * so the page that posts it needs no JavaScript to work and a refresh after
 * a failure does not re-post a code.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return failed("no-challenge");

  const form = await readFormBody(request);
  if (!form) return failed("code-format");

  try {
    const result = await completeSecondFactor({
      code: form.get("code"),
      recoveryCode: form.get("recoveryCode"),
    });
    if (!result.ok) return failed(result.failure);

    const query = result.lastRecoveryCode ? "?recovery=last" : "";
    return see(`${result.home}${query}`);
  } catch (error) {
    const ref = referenceId();
    console.error(`[auth] unexpected second-factor error (ref ${ref}):`, error);
    return failed("code-unreadable", ref);
  }
}

function see(location: string): NextResponse {
  const shared = seeOther(location);
  return new NextResponse(null, { status: shared.status, headers: shared.headers });
}

/**
 * Back to the page that asks, with a code.
 *
 * A code rather than a sentence, for the reason every auth route here uses
 * one: nothing that arrives in a query string should be able to reach the
 * page as text. The page owns the words.
 */
function failed(failure: SecondFactorFailure, ref?: string): NextResponse {
  const query = new URLSearchParams({ error: failure });
  if (ref) query.set("ref", ref);
  return see(`${SECOND_FACTOR_PATHS.verify}?${query.toString()}`);
}
