import { completePasswordReset } from "@/lib/auth/password-reset";
import { referenceId } from "@/lib/errors";
import { readFormBody, seeOther } from "@/lib/http/form-body";
import { isSameOrigin } from "@/lib/help/same-origin";
import { requestIpHash } from "@/lib/ip";
import { hitRateLimit, PASSWORD_RESET_ATTEMPT_LIMIT } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/reset-password — spends a one-time link and sets the
 * password.
 *
 * Success is `303 /login?reset=1`, so the next thing the person sees is the
 * sign-in form with a notice; every session of the account has just been
 * ended, including this browser's if it had one. Failure comes back to the
 * page with the token still in the query, because the form needs it to try
 * again, and with a CODE rather than a message.
 *
 * Unauthenticated by nature (PUBLIC_ROUTES, and exempt in
 * tests/repo/action-guards.test.ts): the link IS the credential. Guarding
 * it with a session would make it useless to the people it exists for.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return failed("cross-site", null);

  const form = await readFormBody(request);
  if (!form) return failed("token-missing", null);

  const tokenRaw = form.get("token");
  const token = typeof tokenRaw === "string" ? tokenRaw.trim() : "";
  // Bounded before it is used: a token is 43 base64url characters.
  if (token.length === 0 || token.length > 128) return failed("token-missing", null);

  const password = form.get("password");
  const confirm = form.get("confirm");
  if (typeof password !== "string" || password.length === 0) return failed("weak", token);
  if (password.length > 1024) return failed("weak", token);
  if (password !== confirm) return failed("mismatch", token);

  try {
    const ipHash = await requestIpHash();
    if (ipHash) {
      const hit = await hitRateLimit(`reset:try:${ipHash}`, PASSWORD_RESET_ATTEMPT_LIMIT);
      // A refused attempt is reported as an invalid link: the limit exists
      // to make walking tokens slow, and saying so would only tell a walker
      // to come back later from somewhere else.
      if (!hit.allowed) return failed("invalid", token);
    }

    const result = await completePasswordReset({ token, password, ipHash });
    if (result.ok) return seeOther("/login?reset=1");
    return failed(result.failure, token);
  } catch (error) {
    const ref = referenceId();
    console.error(`[auth] unexpected password-reset error (ref ${ref}):`, error);
    return failed("unavailable", token);
  }
}

function failed(code: string, token: string | null): Response {
  const query = new URLSearchParams({ error: code });
  if (token) query.set("token", token);
  return seeOther(`/reset-password?${query.toString()}`);
}
