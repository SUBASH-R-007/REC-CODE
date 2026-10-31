/**
 * Outcomes of the password-reset pages, as CODES in the query string —
 * never as text, exactly like sign-in (lib/auth/sign-in-errors.ts): the page
 * maps the code to its words, so nothing a third party puts in a link is
 * ever echoed back to a visitor. Dependency-free, because the pages import
 * it.
 */

/** Why a request for a link was refused. A missing identifier is the only thing we will admit to. */
export const FORGOT_MESSAGES = {
  "identifier-missing": "Enter your roll number or college email.",
  "identifier-long": "That roll number or email is too long.",
  "cross-site": "Please ask from this page.",
  unavailable: "Something went wrong. Please try again.",
} as const;

/**
 * The answer to a request that was accepted. It is deliberately the same
 * whether or not the account exists: this page must not become a way to
 * find out who has an account here.
 */
export const FORGOT_SENT =
  "If that roll number or email belongs to an account, a link to set a new password is on its way. It is valid for one hour.";

/** Why setting a password was refused. */
export const RESET_MESSAGES = {
  /**
   * One message for expired, already used, superseded and never-existed.
   * Which of those it was is not the visitor's business and is a hint to
   * anybody holding a stolen link.
   */
  invalid: "That link is not valid any more. Ask for a new one — a link lasts one hour and can be used once.",
  mismatch: "The two passwords do not match.",
  weak: "Choose a longer password: at least 10 characters, with a letter and a number.",
  "token-missing": "That link is incomplete. Open the link from your email again, or ask for a new one.",
  "cross-site": "Please set your password from this page.",
  unavailable: "Something went wrong. Please try again.",
} as const;

export type ForgotCode = keyof typeof FORGOT_MESSAGES;
export type ResetCode = keyof typeof RESET_MESSAGES;

export function forgotErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(FORGOT_MESSAGES, code) ? FORGOT_MESSAGES[code as ForgotCode] : null;
}

export function resetErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(RESET_MESSAGES, code) ? RESET_MESSAGES[code as ResetCode] : null;
}

/** The notice the sign-in page shows after a password has been set (`/login?reset=1`). */
export const PASSWORD_SET_NOTICE = "Your password is set. Sign in with it below.";
