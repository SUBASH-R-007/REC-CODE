import { createHash } from "node:crypto";
import { requestPasswordReset } from "@/lib/auth/password-reset";
import { referenceId } from "@/lib/errors";
import { readFormBody, seeOther } from "@/lib/http/form-body";
import { isSameOrigin } from "@/lib/help/same-origin";
import { requestIpHash } from "@/lib/ip";
import { hitRateLimit, PASSWORD_RESET_RATE_LIMITS, releaseRateLimit, type RateLimitHit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/forgot-password — the forgot-password form's target.
 *
 * It answers `303 /forgot-password?sent=1` for every accepted request,
 * whatever the identifier was. That is the whole security design of this
 * endpoint: an account that exists, one that may not sign in and one that
 * was never here are indistinguishable from the outside, so this cannot be
 * used to find out who has an account. Nothing is said about the mailbox
 * either.
 *
 * Unauthenticated by nature, so it is in PUBLIC_ROUTES and exempt in
 * tests/repo/action-guards.test.ts: there is no actor to authenticate. What
 * stands in for a guard is the same-origin check, the body cap, and a rate
 * limit on both the hashed identifier and the hashed address.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return failed("cross-site");

  const form = await readFormBody(request);
  if (!form) return failed("identifier-missing");
  const raw = form.get("identifier");
  const identifier = typeof raw === "string" ? raw.trim() : "";
  if (identifier.length === 0) return failed("identifier-missing");
  if (identifier.length > 254) return failed("identifier-long");

  try {
    const ipHash = await requestIpHash();
    /**
     * The budget is spent on the hashed identifier rather than on the
     * account, so that asking repeatedly about an address that has no
     * account is bounded too — otherwise the rate limit itself would answer
     * the question the response refuses to.
     */
    const key = createHash("sha256").update(identifier.toLowerCase()).digest("hex");
    const hits: RateLimitHit[] = [await hitRateLimit(`reset:id:${key}`, PASSWORD_RESET_RATE_LIMITS.identifier)];
    if (ipHash) hits.push(await hitRateLimit(`reset:ip:${ipHash}`, PASSWORD_RESET_RATE_LIMITS.ip));
    if (hits.some((h) => !h.allowed)) {
      await Promise.all(hits.filter((h) => h.allowed).map((h) => releaseRateLimit(h)));
      /**
       * Still `sent=1`. A refusal that said "too many requests" would
       * confirm that this identifier is worth asking about, and the honest
       * version of the message a legitimate visitor needs — look in your
       * mail, ask again in an hour — is the same one.
       */
      return seeOther("/forgot-password?sent=1");
    }

    await requestPasswordReset({ identifier, ipHash });
    return seeOther("/forgot-password?sent=1");
  } catch (error) {
    const ref = referenceId();
    console.error(`[auth] unexpected password-reset request error (ref ${ref}):`, error);
    return failed("unavailable");
  }
}

function failed(code: string): Response {
  return seeOther(`/forgot-password?error=${encodeURIComponent(code)}`);
}
