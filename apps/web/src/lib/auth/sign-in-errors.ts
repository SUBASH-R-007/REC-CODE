/**
 * Sign-in failures travel from POST /api/auth/login back to /login as a
 * CODE in the query string (?error=credentials), never as text: the page
 * maps the code to its message, so nothing a third party puts in a link is
 * ever echoed. Dependency-free — the sign-in page imports it.
 */

export const SIGN_IN_MESSAGES = {
  /** One message for every credential failure — never reveal which part was wrong. */
  credentials: "Roll number/email or password is incorrect.",
  inactive: "This account is not active. Please contact your department coordinator.",
  "identifier-missing": "Enter your roll number or college email.",
  "identifier-long": "That roll number or email is too long.",
  "password-missing": "Enter your password.",
  "password-long": "That password is too long.",
  "cross-site": "Please sign in from this page.",
} as const;

export type SignInFailure = keyof typeof SIGN_IN_MESSAGES | "rate-limited" | "unavailable";

export function rateLimitMessage(minutes: number): string {
  return `Too many sign-in attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/** A support reference: 6 characters of the referenceId() alphabet (lib/errors.ts). */
const REFERENCE = /^[A-HJKMNP-Z2-9]{6}$/;

/**
 * The message for /login?error=…&retry=…&ref=…, or null for no (or an
 * unknown) code. Only the code chooses the words; `retry` must be a whole
 * number of minutes and `ref` a reference id, or they are ignored.
 */
export function signInErrorMessage(
  code: string | undefined,
  retry?: string | undefined,
  ref?: string | undefined,
): string | null {
  if (!code) return null;
  if (code === "rate-limited") {
    const minutes = retry && /^\d{1,4}$/.test(retry) ? Math.max(1, Number(retry)) : 1;
    return rateLimitMessage(minutes);
  }
  if (code === "unavailable") {
    return ref && REFERENCE.test(ref)
      ? `Something went wrong. Please try again — if it keeps happening, quote reference ${ref}.`
      : "Something went wrong. Please try again.";
  }
  return Object.hasOwn(SIGN_IN_MESSAGES, code) ? SIGN_IN_MESSAGES[code as keyof typeof SIGN_IN_MESSAGES] : null;
}
