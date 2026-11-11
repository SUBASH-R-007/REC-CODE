/**
 * The seed's daily-challenge pick: a deterministic rotation over the
 * published problems (in display-code order), keyed by the campus day, so
 * re-running the seed on the same day always picks the same problem.
 */

/** Days since 1970-01-01 for a campus day "yyyy-MM-dd". */
export function campusDayNumber(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Not a campus day: ${day}`);
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/** Index into the published problems (display-code order) for a campus day. */
export function dailyChallengeIndex(day: string, problemCount: number): number {
  if (!Number.isInteger(problemCount) || problemCount <= 0) throw new Error("There is no published problem to choose from.");
  return campusDayNumber(day) % problemCount;
}
