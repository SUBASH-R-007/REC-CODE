import { NextResponse } from "next/server";
import { isProduction } from "@/lib/env";
import { referenceId } from "@/lib/errors";
import { isSameOrigin } from "@/lib/help/same-origin";
import { signIn } from "@/lib/auth/sign-in";
import { LOGIN_IDENTIFIER_COOKIE } from "@/lib/auth/login-cookie";
import type { SignInFailure } from "@/lib/auth/sign-in-errors";

export const dynamic = "force-dynamic";

/**
 * The sign-in form's whole body: a ≤ 254-character identifier and a
 * ≤ 1,024-character password, percent-encoded (at most 9 bytes per
 * character) — comfortably under this. Anything larger is not our form, and
 * is refused without being buffered (the server action this replaced had
 * Next's 1 MB body limit; a route handler has none).
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * POST /api/auth/login — the sign-in form's target. /login is a plain HTML
 * page with no JavaScript (src/pages/login.tsx), so this answers every
 * outcome with a 303 to a page:
 *
 *   success  → the role's home (homeForRole — never a URL from the request;
 *              the new session cookie is set here)
 *   failure  → /login?error=<code> (lib/auth/sign-in-errors.ts holds the
 *              words), with the typed roll number / email kept in a
 *              60-second, /login-only, httpOnly cookie so the form comes
 *              back filled in — never in the URL.
 *
 * Cross-site posts are refused before the body is read (login CSRF; the
 * session cookie is SameSite=Lax on top). Rate limits, the Argon2id check
 * (a decoy hash for unknown accounts), session rotation and the audit trail
 * live in signIn().
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return failed("cross-site");

  const form = await readForm(request);
  if (!form) return failed("identifier-missing");
  const identifier = form.get("identifier");
  const typed = typeof identifier === "string" ? identifier.trim().slice(0, 254) : "";

  try {
    const result = await signIn({ identifier, password: form.get("password") });
    if (result.ok) {
      const response = see(result.home);
      response.cookies.delete({ name: LOGIN_IDENTIFIER_COOKIE, path: "/login" });
      return response;
    }
    return failed(result.failure, { typed, retry: result.retryMinutes });
  } catch (error) {
    const ref = referenceId();
    console.error(`[auth] unexpected sign-in error (ref ${ref}):`, error);
    return failed("unavailable", { typed, ref });
  }
}

/**
 * The urlencoded form body (what an HTML form sends), read with a size cap.
 * null for any other content type, or a body over MAX_BODY_BYTES.
 */
async function readForm(request: Request): Promise<URLSearchParams | null> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!request.body) return new URLSearchParams();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new URLSearchParams(new TextDecoder().decode(body));
}

/** 303 See Other: the browser follows with a GET. A relative Location stays on whatever host the student used. */
function see(location: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });
}

function failed(failure: SignInFailure, extra: { typed?: string; retry?: number; ref?: string } = {}): NextResponse {
  const query = new URLSearchParams({ error: failure });
  if (extra.retry !== undefined) query.set("retry", String(extra.retry));
  if (extra.ref) query.set("ref", extra.ref);
  const response = see(`/login?${query.toString()}`);
  if (extra.typed) {
    response.cookies.set(LOGIN_IDENTIFIER_COOKIE, extra.typed, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction(),
      path: "/login",
      maxAge: 60,
    });
  }
  return response;
}
