import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import {
  ATTEMPT_COOKIE_NAME,
  ATTEMPT_TOKEN_BYTES,
  ATTEMPT_TOKEN_HEADER,
  attemptCookiePath,
} from "@recx/shared";

/**
 * The attempt token (Phase 6b). SPEC §5:
 *
 *   Attempt token: 32 random bytes, sha256 at rest, httpOnly SameSite=Strict
 *   cookie scoped to the attempt path, mirrored in an X-Attempt-Token header
 *   for telemetry, rotated on resume.
 *
 * It is a SECOND factor on top of the signed-in session, not a replacement
 * for it: every exam request checks both. The session says who you are; the
 * token says this browser is the one that started this sitting. That is what
 * makes a candidate who hands their session cookie to a friend in another
 * room fail to get a second live client on the same paper.
 *
 * The raw token is returned to the caller exactly once, at mint, and only the
 * sha256 is ever stored or logged.
 */

/** sha256 of the raw token. `AssessmentAttempt.tokenHash` holds only this. */
export function hashAttemptToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface MintedToken {
  /** Give this to the browser once. Never store it, never log it. */
  readonly token: string;
  /** Store this. */
  readonly tokenHash: string;
}

export function mintAttemptToken(): MintedToken {
  const token = randomBytes(ATTEMPT_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashAttemptToken(token) };
}

/**
 * Constant-time hash comparison. The hashes are not secret, so a timing leak
 * here is not the attack it would be on a password — but a token check is
 * exactly the place where a lazy `===` becomes a real oracle later, when
 * someone reuses this helper for something that is secret.
 */
export function attemptTokenMatches(presented: string | null | undefined, storedHash: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(hashAttemptToken(presented), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The raw token this request carries: the header first, then the cookie.
 *
 * Both exist on purpose, and the pair is what SPEC §5 describes — an
 * httpOnly cookie AND "mirrored in an X-Attempt-Token header for telemetry".
 * The cookie is what the browser sends on its own, and httpOnly keeps the
 * PERSISTED copy out of reach of any script on the page. The header is the
 * copy the exam client holds in memory, handed to it once when the sitting
 * starts, so a request can be correlated without parsing cookies.
 *
 * Accepting the header as a source adds no attack surface: a script that
 * cannot read the httpOnly cookie cannot populate the header either, so the
 * only callers that can use it are ones that already hold the token.
 */
export async function presentedAttemptToken(request: Request, attemptId: string): Promise<string | null> {
  const header = request.headers.get(ATTEMPT_TOKEN_HEADER);
  if (header && header.trim() !== "") return header.trim();
  const jar = await cookies();
  return jar.get(attemptCookieName(attemptId))?.value ?? null;
}

/**
 * One cookie per attempt. Two attempts in two tabs then hold two tokens
 * rather than overwriting each other, which is what makes a resumed sitting
 * and a second sitting distinguishable.
 */
export function attemptCookieName(attemptId: string): string {
  return `${ATTEMPT_COOKIE_NAME}_${attemptId}`;
}

/**
 * Hand the browser its token. httpOnly so no script in the exam page (or
 * injected into it) can read it; SameSite=Strict so no other site can cause
 * a request that carries it; path-scoped so it is not sent to any route
 * outside this attempt; `secure` outside development, where the dev server
 * is plain http on localhost and a secure cookie would simply be dropped.
 */
export async function setAttemptCookie(attemptId: string, token: string, maxAgeSeconds: number): Promise<void> {
  const jar = await cookies();
  jar.set(attemptCookieName(attemptId), token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: attemptCookiePath(attemptId),
    maxAge: Math.max(0, Math.floor(maxAgeSeconds)),
  });
}

/** Drop the cookie once the sitting is over, so a finished attempt stops carrying a credential. */
export async function clearAttemptCookie(attemptId: string): Promise<void> {
  const jar = await cookies();
  jar.set(attemptCookieName(attemptId), "", {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: attemptCookiePath(attemptId),
    maxAge: 0,
  });
}
