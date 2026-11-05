/**
 * When a session slides, and when it does not (Phase 14g).
 *
 * This was three lines inside `currentSession()`, and three lines inside a
 * function that needs `next/headers`, a database and React's request cache
 * is three lines nothing tests. Running REC Exam Browser against a real
 * server found out what that cost: the exchange issues the sitting's
 * session with an expiry of the paper plus slack, and the first request
 * from the kiosk window renewed it to fourteen days, because `needsRenew`
 * is true for anything expiring inside seven. Every sentence written about
 * that session's lifetime -- in `docs/EXAM-BROWSER.md`, in the audit row,
 * in the public page -- was false, and nothing failed.
 *
 * So the rule is a function over plain values, with no imports at all, and
 * the exemption is a property of the session rather than a special case at
 * the call site.
 */

/** How long a session created by signing in lasts. */
export const SESSION_DAYS = 14;

/** Renewed when it has less than this left, so an active user is never logged out. */
export const RENEW_THRESHOLD_DAYS = 7;

/** `lastSeenAt` is refreshed at most this often, to avoid a write per request. */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionRefresh {
  /** Push the expiry out, and re-set the cookie. */
  readonly renew: boolean;
  /** Write `lastSeenAt` without moving the expiry. */
  readonly touch: boolean;
  /** What the expiry should be after this request. */
  readonly expiresAt: Date;
}

export function sessionRefresh(args: {
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  /**
   * False for a session issued to one exam sitting. Such a session expires
   * when the paper it was issued for is over, whether it is used again or
   * not, and the ordinary renewal rule must not reach it.
   */
  readonly renewable: boolean;
  readonly now: number;
}): SessionRefresh {
  const renew = args.renewable && args.expiresAt.getTime() - args.now < RENEW_THRESHOLD_DAYS * 86_400_000;
  const touch = args.now - args.lastSeenAt.getTime() > TOUCH_INTERVAL_MS;
  return {
    renew,
    touch,
    expiresAt: renew ? new Date(args.now + SESSION_DAYS * 86_400_000) : args.expiresAt,
  };
}
