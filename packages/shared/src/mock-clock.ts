import { accommodatedDurationSec } from "./accommodation";

/**
 * The mock's clocks (Phase 7c): the paper's deadline and each section's own.
 *
 * Server-authoritative, like Phase 6b's attempt clock and unlike a contest
 * clock. A section deadline ENDS something — the section closes and cannot be
 * re-entered — so an advisory clock is not an option; the client renders what
 * `GET /api/aptitude/attempts/[id]/clock` tells it and never consults
 * `Date.now()`.
 *
 * Two behaviours are copied deliberately from `attempt-clock.ts`:
 *
 *   * a cap is REPORTED rather than silently applied. A candidate whose last
 *     section is shortened because the paper's own deadline arrives first
 *     must be told, on the section header, in words;
 *   * extra time flows through `accommodatedDurationSec()` and is not
 *     re-derived here. One definition of "25% extra time", used by the
 *     assessment product and by this one.
 */

export const MOCK_CLOCK_LIMITS = Object.freeze({
  /** Total paper, before accommodations. Eight sections of two hours is the schema's ceiling. */
  totalSec: { min: 60, max: 8 * 7_200 },
  /** The gap between a section's last answer and its close, so a save in flight lands. */
  sectionGraceMs: 2_000,
  /** How often the client asks the server for the time. SPEC §7: never 250 ms. */
  pollMs: 5_000,
  /** The four moments the timer speaks at, most urgent last. */
  announceSeconds: [600, 300, 60, 10] as readonly number[],
});

export interface ExtraTimeTerms {
  readonly extraTimePercent: number;
  readonly extraTimeMinutes: number;
}

const NO_EXTRA: ExtraTimeTerms = { extraTimePercent: 0, extraTimeMinutes: 0 };

/**
 * The whole paper's duration, with any accommodation applied.
 *
 * Extra time is granted on the PAPER and then distributed across sections in
 * proportion to their own limits (`sectionAllowances`), so a candidate granted
 * 25% extra gets 25% more in every section rather than all of it in the last
 * one — which is what they would get if the paper's deadline were simply moved
 * and the section limits left alone.
 */
export function mockDurationSec(sectionLimitsSec: readonly number[], terms: ExtraTimeTerms = NO_EXTRA): number {
  const base = sectionLimitsSec.reduce((sum, sec) => sum + sec, 0);
  return accommodatedDurationSec(base, terms);
}

export function mockExpiresAt(
  startedAt: Date,
  sectionLimitsSec: readonly number[],
  terms: ExtraTimeTerms = NO_EXTRA,
): { expiresAt: Date; durationSec: number; baseDurationSec: number; extraSec: number } {
  const baseDurationSec = sectionLimitsSec.reduce((sum, sec) => sum + sec, 0);
  const durationSec = mockDurationSec(sectionLimitsSec, terms);
  return {
    expiresAt: new Date(startedAt.getTime() + durationSec * 1_000),
    durationSec,
    baseDurationSec,
    extraSec: durationSec - baseDurationSec,
  };
}

export interface SectionAllowance {
  readonly position: number;
  /** The section's declared limit. */
  readonly baseSec: number;
  /** What this candidate gets, after their share of any extra time. */
  readonly allowedSec: number;
}

/**
 * Distribute the paper's extra time across its sections, in proportion.
 *
 * Integer seconds, and the remainder goes to the LAST section rather than
 * being dropped: a candidate granted 25% on a 90-minute paper is owed 1,350
 * seconds and must not lose two of them to three roundings. Never fewer
 * seconds than the section declares — an accommodation only ever adds.
 */
export function sectionAllowances(
  sectionLimitsSec: readonly number[],
  terms: ExtraTimeTerms = NO_EXTRA,
): SectionAllowance[] {
  const base = sectionLimitsSec.reduce((sum, sec) => sum + sec, 0);
  const total = mockDurationSec(sectionLimitsSec, terms);
  const extra = Math.max(0, total - base);

  const allowances = sectionLimitsSec.map((baseSec, index) => ({
    position: index + 1,
    baseSec,
    allowedSec: baseSec + (base === 0 ? 0 : Math.floor((extra * baseSec) / base)),
  }));
  if (allowances.length > 0) {
    const given = allowances.reduce((sum, a) => sum + (a.allowedSec - a.baseSec), 0);
    const last = allowances[allowances.length - 1]!;
    allowances[allowances.length - 1] = { ...last, allowedSec: last.allowedSec + (extra - given) };
  }
  return allowances;
}

export interface SectionWindow {
  readonly endsAt: Date;
  /** True when the paper's own deadline arrived first. */
  readonly cappedByAttempt: boolean;
  /** Seconds the candidate lost to that cap, for the sentence on the header. */
  readonly cappedBySec: number;
}

/**
 * When this section closes.
 *
 * Capped by the attempt's own `expiresAt`, and the cap is REPORTED — the same
 * honesty `computeExpiresAt()` already practises for accommodations. A
 * candidate who enters the last section with four minutes of paper left has a
 * four-minute section, and the header says so instead of showing a
 * twenty-minute clock that will be cut off.
 */
export function sectionEndsAt(args: {
  readonly now: Date;
  readonly allowedSec: number;
  readonly attemptExpiresAt: Date;
}): SectionWindow {
  const wanted = new Date(args.now.getTime() + args.allowedSec * 1_000);
  if (wanted.getTime() <= args.attemptExpiresAt.getTime()) {
    return { endsAt: wanted, cappedByAttempt: false, cappedBySec: 0 };
  }
  return {
    endsAt: args.attemptExpiresAt,
    cappedByAttempt: true,
    cappedBySec: Math.ceil((wanted.getTime() - args.attemptExpiresAt.getTime()) / 1_000),
  };
}

/** Milliseconds left in this section, never negative. */
export function msRemainingInSection(endsAt: Date | null, now: Date): number {
  if (endsAt === null) return 0;
  return Math.max(0, endsAt.getTime() - now.getTime());
}

/** Has this section's deadline passed? */
export function sectionHasEnded(endsAt: Date | null, now: Date): boolean {
  return endsAt !== null && now.getTime() >= endsAt.getTime();
}

/**
 * The thresholds this section's timer will speak at.
 *
 * Only those strictly BELOW the section's own limit: announcing "ten minutes
 * remaining" at the start of a ten-minute section is noise, and announcing it
 * in a five-minute section is a lie. The four moments and no others — never
 * `role="timer"` with a per-second live region, which makes a screen reader
 * unusable for the length of a 25-minute section.
 */
export function announceAtSeconds(limitSec: number): number[] {
  return MOCK_CLOCK_LIMITS.announceSeconds.filter((threshold) => threshold < limitSec);
}

/**
 * The most urgent threshold crossed between two readings, or null.
 *
 * Most urgent rather than first: a tab the OS froze past several thresholds
 * must not read out a stale "ten minutes remaining", because that is worse
 * than silence. Same rule as the exam timer in Phase 6c.
 */
export function dueSectionAnnouncement(prevMs: number, nowMs: number, limitSec: number): number | null {
  if (nowMs >= prevMs) return null;
  const crossed = announceAtSeconds(limitSec).filter(
    (threshold) => prevMs > threshold * 1_000 && nowMs <= threshold * 1_000,
  );
  return crossed.length === 0 ? null : Math.min(...crossed);
}
