import { describe, expect, it } from "vitest";
import {
  RENEW_THRESHOLD_DAYS,
  SESSION_DAYS,
  TOUCH_INTERVAL_MS,
  sessionRefresh,
} from "@/lib/auth/session-refresh";

/**
 * When a session slides, and when it does not (Phase 14g).
 *
 * These exist because the rule was three lines inside `currentSession()`,
 * where nothing could reach it, and running the real exam browser found
 * what that cost: a session issued for one paper renewed itself to a
 * fortnight on its first request, and every claim made about its lifetime
 * went quietly false.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 5, 9, 0, 0);
const fresh = (over: Partial<Parameters<typeof sessionRefresh>[0]> = {}) =>
  sessionRefresh({
    expiresAt: new Date(NOW + SESSION_DAYS * DAY),
    lastSeenAt: new Date(NOW),
    renewable: true,
    now: NOW,
    ...over,
  });

describe("an ordinary session, created by signing in", () => {
  it("is left alone when it is fresh and was just seen", () => {
    expect(fresh()).toMatchObject({ renew: false, touch: false });
  });

  it("is renewed once it has less than the threshold left", () => {
    const result = fresh({ expiresAt: new Date(NOW + (RENEW_THRESHOLD_DAYS - 1) * DAY) });
    expect(result.renew).toBe(true);
    expect(result.expiresAt.getTime()).toBe(NOW + SESSION_DAYS * DAY);
  });

  it("is not renewed while it still has more than the threshold left", () => {
    expect(fresh({ expiresAt: new Date(NOW + (RENEW_THRESHOLD_DAYS + 1) * DAY) }).renew).toBe(false);
  });

  it("is touched, without moving its expiry, once the interval has passed", () => {
    const expiresAt = new Date(NOW + SESSION_DAYS * DAY);
    const result = fresh({ expiresAt, lastSeenAt: new Date(NOW - TOUCH_INTERVAL_MS - 1_000) });
    expect(result).toMatchObject({ renew: false, touch: true });
    expect(result.expiresAt).toBe(expiresAt);
  });

  it("is not touched on every request, which would be a write per request", () => {
    expect(fresh({ lastSeenAt: new Date(NOW - TOUCH_INTERVAL_MS + 1_000) }).touch).toBe(false);
  });
});

describe("the session an exam sitting holds", () => {
  /**
   * The bug this whole module exists for. A two-hour session is inside the
   * seven-day threshold by a wide margin, so the ordinary rule renewed it
   * to fourteen days the moment the kiosk window asked for anything.
   */
  const sitting = (over: Partial<Parameters<typeof sessionRefresh>[0]> = {}) =>
    sessionRefresh({
      expiresAt: new Date(NOW + 2 * 3_600_000),
      lastSeenAt: new Date(NOW),
      renewable: false,
      now: NOW,
      ...over,
    });

  it("is never renewed, however little time it has left", () => {
    for (const msLeft of [2 * 3_600_000, 60_000, 1_000, 0]) {
      const result = sitting({ expiresAt: new Date(NOW + msLeft) });
      expect(result.renew, String(msLeft)).toBe(false);
    }
  });

  it("keeps the expiry it was issued with, to the millisecond", () => {
    const expiresAt = new Date(NOW + 2 * 3_600_000);
    expect(sitting({ expiresAt }).expiresAt).toBe(expiresAt);
  });

  it("is still touched, so an invigilator's screen can show it is live", () => {
    /**
     * Touching writes `lastSeenAt` and nothing else. The reason to keep it
     * is that "when did this window last ask for anything" is a useful
     * fact about a sitting, and it cannot extend anything.
     */
    expect(sitting({ lastSeenAt: new Date(NOW - TOUCH_INTERVAL_MS - 1_000) })).toMatchObject({
      renew: false,
      touch: true,
    });
  });

  it("differs from a renewable session with the identical clock, which is the whole point", () => {
    const clock = { expiresAt: new Date(NOW + 2 * 3_600_000), lastSeenAt: new Date(NOW), now: NOW };
    expect(sessionRefresh({ ...clock, renewable: true }).renew).toBe(true);
    expect(sessionRefresh({ ...clock, renewable: false }).renew).toBe(false);
  });
});
