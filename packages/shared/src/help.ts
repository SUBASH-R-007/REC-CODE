/**
 * Hints and editorials are gated at ONE chokepoint, keyed off the submission
 * context discriminator — never per-feature branches. In CONTEST and
 * ASSESSMENT nothing is available, unconditionally.
 *
 * PRACTICE:
 *   tier 1 — always;
 *   tier 2 — after 1 failed submission or 10 active minutes;
 *   tier 3 — after 2 failed submissions or 25 active minutes;
 *   editorial — once solved, or past the problem's editorialVisibleAt, or
 *               after ≥ 5 attempts AND ≥ 45 active minutes.
 * A solve after a tier-3 hint or the editorial is ASSISTED: it counts as
 * solved, pays 40 % XP, and is excluded from unassisted readiness inputs.
 */
export const HELP_CONTEXTS = ["PRACTICE", "CONTEST", "ASSESSMENT"] as const;
export type HelpContext = (typeof HELP_CONTEXTS)[number];

export const HINT_POLICY = Object.freeze({
  tier2: { failedAttempts: 1, activeMinutes: 10 },
  tier3: { failedAttempts: 2, activeMinutes: 25 },
  editorial: { attempts: 5, activeMinutes: 45 },
});

export interface HelpInput {
  context: HelpContext;
  /** Judged submissions for this problem (CE included). */
  attempts: number;
  failedAttempts: number;
  activeSeconds: number;
  solved: boolean;
  editorialVisibleAt: Date | null;
  now: Date;
}

export interface HelpAccess {
  /** Highest hint tier that may be revealed (0 = none). */
  maxHintTier: 0 | 1 | 2 | 3;
  editorial: boolean;
  /** For the UI: what unlocks the next tier, or null when nothing more will. */
  nextUnlock: string | null;
}

export function helpAccess(input: HelpInput): HelpAccess {
  if (input.context !== "PRACTICE") {
    return { maxHintTier: 0, editorial: false, nextUnlock: null };
  }
  const minutes = input.activeSeconds / 60;
  let tier: 1 | 2 | 3 = 1;
  if (input.failedAttempts >= HINT_POLICY.tier2.failedAttempts || minutes >= HINT_POLICY.tier2.activeMinutes) tier = 2;
  if (input.failedAttempts >= HINT_POLICY.tier3.failedAttempts || minutes >= HINT_POLICY.tier3.activeMinutes) tier = 3;

  const editorial =
    input.solved ||
    (input.editorialVisibleAt !== null && input.editorialVisibleAt.getTime() <= input.now.getTime()) ||
    (input.attempts >= HINT_POLICY.editorial.attempts && minutes >= HINT_POLICY.editorial.activeMinutes);

  let nextUnlock: string | null = null;
  if (tier === 1) {
    nextUnlock = `Hint 2 unlocks after ${HINT_POLICY.tier2.failedAttempts} failed submission or ${HINT_POLICY.tier2.activeMinutes} minutes of work.`;
  } else if (tier === 2) {
    nextUnlock = `Hint 3 unlocks after ${HINT_POLICY.tier3.failedAttempts} failed submissions or ${HINT_POLICY.tier3.activeMinutes} minutes of work.`;
  } else if (!editorial) {
    nextUnlock = `The editorial unlocks when you solve the problem, or after ${HINT_POLICY.editorial.attempts} attempts and ${HINT_POLICY.editorial.activeMinutes} minutes of work.`;
  }
  return { maxHintTier: tier, editorial, nextUnlock };
}

/**
 * True when using this help makes a later first solve ASSISTED.
 *
 * The AI helper counts, always. It reads the student's own draft and names
 * what is wrong with it, which is past anything hint 3 does; a solve that
 * followed one is not evidence the student could have got there alone, and
 * readiness is built on exactly that evidence.
 */
export function makesSolveAssisted(kind: { hintTier: number } | { editorial: true } | { ai: true }): boolean {
  if ("editorial" in kind || "ai" in kind) return true;
  return kind.hintTier >= 3;
}
