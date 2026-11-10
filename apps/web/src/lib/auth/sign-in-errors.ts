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
  /**
   * Signing in through REC Learning (Phase 16i). The sentences live in
   * `OIDC_MESSAGES` so the provider-facing half and this page cannot
   * drift; they are repeated here only because this table is the one
   * thing the sign-in page reads, and it is dependency-free on purpose.
   */
  "lms-off": "Signing in through REC Learning is not switched on for this deployment.",
  "lms-unavailable":
    "REC Learning could not be reached just now. Sign in with your REC Code password below, or try again in a moment.",
  "lms-failed":
    "That sign-in could not be completed. Start again from the sign-in page, and tell your department if it keeps happening.",
  "lms-expired": "That sign-in took too long. Start again from the sign-in page.",
  "lms-not-enrolled":
    "You signed in to REC Learning, but there is no REC Code account for you yet. Your department adds accounts from the roster — ask them, and nothing is needed from you in the meantime.",
  /**
   * Phase 16j. `/second-factor` sends somebody here when their challenge
   * has expired, been spent or never existed. Declared rather than left to
   * fall through to "no message": a code the product itself emits must
   * render a sentence, or the page silently shows a plain form to a person
   * who was half-way through signing in.
   */
  "second-factor-expired": "That sign-in took too long, or had too many tries. Start again.",
  "lms-inactive":
    "Your REC Code account is not active. Ask your department, who can see why and can put it back.",
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
