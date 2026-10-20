import "server-only";
import type { ExtraTimeTerms } from "@recx/shared";
import { db } from "@/lib/db";

/**
 * What an approved accommodation means for a practice mock (Phase 7c).
 *
 * Phase 7 only READS `Accommodation` — its state machine, its SUPER_ADMIN
 * approval, its expiry and its audit are Phase 4's and are not touched here.
 *
 * Extra time flows through the same `accommodatedDurationSec()` the assessment
 * product uses, so there is one definition of "25% extra time" in the system.
 *
 * Note what a practice mock does NOT need: `suggestedExemptSignals()` and the
 * whole exempt-signal machinery. A practice mock collects no focus or
 * fullscreen signals at all, so there is nothing to exempt — which is the
 * simplest possible way to honour the rule that a SCREEN_READER candidate is
 * never penalised for assistive technology moving focus.
 */

const NONE: ExtraTimeTerms = { extraTimePercent: 0, extraTimeMinutes: 0 };

export interface SittingAccommodation {
  readonly extra: ExtraTimeTerms;
  /**
   * What applied, for the candidate's own result page. Never a KIND — a kind
   * is a disability label, and SPEC §0 keeps those off every surface except
   * the approval screen.
   */
  readonly flags: string[];
}

export async function extraTimeFor(userId: string, now: Date = new Date()): Promise<SittingAccommodation> {
  const granted = await db.accommodation.findFirst({
    where: { userId, status: "APPROVED", validUntil: { gt: now } },
    select: { extraTimePercent: true, extraTimeMinutes: true, fontScalePercent: true, highContrast: true },
    orderBy: { grantedAt: "desc" },
  });
  if (!granted) return { extra: NONE, flags: [] };

  const flags: string[] = [];
  if (granted.extraTimePercent > 0) flags.push(`extra-time-${granted.extraTimePercent}pc`);
  if (granted.extraTimeMinutes > 0) flags.push(`extra-minutes-${granted.extraTimeMinutes}`);
  if (granted.fontScalePercent !== 100) flags.push(`font-${granted.fontScalePercent}pc`);
  if (granted.highContrast) flags.push("high-contrast");

  return {
    extra: { extraTimePercent: granted.extraTimePercent, extraTimeMinutes: granted.extraTimeMinutes },
    flags,
  };
}
