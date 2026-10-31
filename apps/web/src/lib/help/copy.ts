import { CAMPUS_TIME_ZONE, HINT_POLICY, XP_RULES, makesSolveAssisted, type HelpContext } from "@recx/shared";

/**
 * The words the help panels use. Pure (no I/O), so it is unit-tested and
 * every number comes from the single-source policy in @recx/shared rather
 * than being retyped into a component.
 */

/** "40" — the share of XP an assisted first solve pays. */
export const ASSISTED_XP_PERCENT = Math.round(XP_RULES.assistedMultiplier * 100);

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function activeMinutes(activeSeconds: number): number {
  return Math.max(0, Math.floor(activeSeconds / 60));
}

/** The unlock condition of a hint tier (the same sentence helpAccess() uses for nextUnlock). */
export function hintCondition(tier: number): string {
  if (tier <= 1) return "Hint 1 is available from the start.";
  const rule = tier === 2 ? HINT_POLICY.tier2 : HINT_POLICY.tier3;
  return `Hint ${tier} unlocks after ${count(rule.failedAttempts, "failed submission")} or ${rule.activeMinutes} minutes of work.`;
}

/** The refusal when a locked tier is requested anyway. */
export function hintLockedMessage(tier: number): string {
  return `Hint ${tier} is still locked. ${hintCondition(tier)}`;
}

/** Shown before revealing a hint that would make a later first solve ASSISTED; null when it would not. */
export function hintWarning(tier: number, solved: boolean): string | null {
  if (solved || !makesSolveAssisted({ hintTier: tier })) return null;
  return `Using hint ${tier} marks a later solve as assisted (${ASSISTED_XP_PERCENT}% XP).`;
}

/** Shown before the first editorial view of an unsolved problem; null once solved. */
export function editorialWarning(solved: boolean): string | null {
  if (solved || !makesSolveAssisted({ editorial: true })) return null;
  return `Viewing the editorial before you solve this problem marks your solve as assisted (${ASSISTED_XP_PERCENT}% XP).`;
}

/** "So far: 1 failed submission and 7 minutes of active work." */
export function hintProgress(input: { failedAttempts: number; activeSeconds: number }): string {
  const minutes = activeMinutes(input.activeSeconds);
  return `So far: ${count(input.failedAttempts, "failed submission")} and ${count(minutes, "minute")} of active work.`;
}

const campusDateTime = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: CAMPUS_TIME_ZONE,
});

/** "12 Oct 2026, 6:00 pm IST" (campus time, whatever the server's zone). */
export function formatCampusDateTime(at: Date): string {
  return `${campusDateTime.format(at)} IST`;
}

export const CLOSED_CONTEXT_MESSAGE = {
  hints: "Hints are not available during contests and assessments.",
  editorial: "Editorials are not available during contests and assessments.",
} as const;

/** Why the editorial is still locked, with the student's progress towards it. */
export function editorialLockReason(input: {
  context: HelpContext;
  attempts: number;
  activeSeconds: number;
  editorialVisibleAt: Date | null;
  now: Date;
}): string {
  if (input.context !== "PRACTICE") return CLOSED_CONTEXT_MESSAGE.editorial;
  const rule = HINT_POLICY.editorial;
  const parts = [
    `The editorial unlocks when you solve this problem, or after ${count(rule.attempts, "attempt")} and ${rule.activeMinutes} minutes of work.`,
  ];
  if (input.editorialVisibleAt && input.editorialVisibleAt.getTime() > input.now.getTime()) {
    parts.push(`It also opens to everyone on ${formatCampusDateTime(input.editorialVisibleAt)}.`);
  }
  parts.push(
    `So far: ${count(input.attempts, "attempt")} and ${count(activeMinutes(input.activeSeconds), "minute")} of active work.`,
  );
  return parts.join(" ");
}
