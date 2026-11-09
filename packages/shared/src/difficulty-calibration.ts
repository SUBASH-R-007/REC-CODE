/**
 * The three labels, spelled out rather than imported: `@recx/shared` has
 * no single `Difficulty` union (`xp.ts` derives a key from its own rules
 * table, and `recommend.ts` writes the literals), and this module is read
 * by `tests/repo` as well as by the app.
 */
export const CALIBRATED_DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export type Difficulty = (typeof CALIBRATED_DIFFICULTIES)[number];

/**
 * When the label disagrees with the data (Phase 16b).
 *
 * `docs/ROADMAP.md` §3.3. `/admin/reports` already shows "Hardest problems"
 * — lowest solve share first — and that answers a different question. A hard
 * problem being hard is not news. What a new catalogue most needs to hear
 * about itself is the DISAGREEMENT: a problem labelled EASY that eight per
 * cent of attempters solve is either mis-labelled or broken, and either way
 * somebody should look at it this week.
 *
 * It matters because the label is load-bearing in four places a student
 * never sees as "a label": the problem list's filter, a study plan's
 * ordering, the recommender's rung order, and `topicBreadth` in the
 * readiness score. A first-year told to warm up on five EASY problems who
 * cannot solve any of them does not conclude that the labels are wrong.
 *
 * **The bands are a choice, and this is the argument for them.** There is no
 * population here to calibrate against — that is the whole problem — so they
 * are set from what the label is FOR rather than from a distribution:
 *
 *   * EASY is "you can do this now". Fewer than 35% of the people who tried
 *     it finishing is not that, whatever the author intended.
 *   * HARD is "this will take you a while". More than 70% solving it means
 *     the problem is not doing the job the label promises, and a student
 *     picking it as a stretch target gets a false reading of their own
 *     level.
 *   * MEDIUM is the wide middle on purpose: 15% to 85%. A band that flagged
 *     most MEDIUM problems would be a report nobody reads.
 *
 * They are deliberately asymmetric. An EASY problem nobody can solve costs a
 * beginner their first week; a HARD problem everybody solves costs a strong
 * student one afternoon. The first threshold is therefore tighter.
 *
 * Nothing acts on a verdict. It is a row in a staff report — no re-labelling,
 * no delisting, no change to any student's numbers. Re-labelling a problem
 * starts a new revision, and that is an author's decision with an editorial
 * judgement in it that a solve share cannot make.
 */

/** Below this many attempters a share is noise, not a signal. */
export const CALIBRATION_MIN_ATTEMPTERS = 8;

export interface CalibrationBand {
  /** Flag as harder than labelled at or below this solve share (0–1). null = never. */
  readonly harderAtOrBelow: number | null;
  /** Flag as easier than labelled at or above this solve share (0–1). null = never. */
  readonly easierAtOrAbove: number | null;
}

export const CALIBRATION_BANDS: Readonly<Record<Difficulty, CalibrationBand>> = Object.freeze({
  // An EASY problem nobody finishes is the expensive mistake: it lands on
  // the people with the least ability to tell a bad problem from their own
  // shortcoming.
  EASY: { harderAtOrBelow: 0.35, easierAtOrAbove: null },
  MEDIUM: { harderAtOrBelow: 0.15, easierAtOrAbove: 0.85 },
  // There is no "harder than HARD": the label is already the top of the
  // scale, and a HARD problem with a 3% solve share is just hard.
  HARD: { harderAtOrBelow: null, easierAtOrAbove: 0.7 },
});

export type CalibrationVerdict = "too-few-attempts" | "as-labelled" | "harder-than-labelled" | "easier-than-labelled";

export interface CalibrationInput {
  readonly difficulty: Difficulty;
  readonly attempters: number;
  readonly solvers: number;
}

export function calibrationVerdict(input: CalibrationInput): CalibrationVerdict {
  const { difficulty, attempters, solvers } = input;
  if (attempters < CALIBRATION_MIN_ATTEMPTERS) return "too-few-attempts";
  if (attempters <= 0) return "too-few-attempts";
  const share = solvers / attempters;
  const band = CALIBRATION_BANDS[difficulty];
  if (band.harderAtOrBelow !== null && share <= band.harderAtOrBelow) return "harder-than-labelled";
  if (band.easierAtOrAbove !== null && share >= band.easierAtOrAbove) return "easier-than-labelled";
  return "as-labelled";
}

/**
 * How far outside its band a problem is, as a share of the band's own
 * threshold. Used only to sort: the worst disagreement first, so a report
 * truncated at fifteen rows truncates the least interesting end.
 */
export function calibrationDistance(input: CalibrationInput): number {
  const verdict = calibrationVerdict(input);
  if (verdict === "too-few-attempts" || verdict === "as-labelled") return 0;
  const share = input.solvers / input.attempters;
  const band = CALIBRATION_BANDS[input.difficulty];
  if (verdict === "harder-than-labelled" && band.harderAtOrBelow !== null) {
    return band.harderAtOrBelow - share;
  }
  if (verdict === "easier-than-labelled" && band.easierAtOrAbove !== null) {
    return share - band.easierAtOrAbove;
  }
  return 0;
}

/** The sentence a staff member reads beside the row. Says what to look at, not what to do. */
export function calibrationSentence(input: CalibrationInput): string {
  const verdict = calibrationVerdict(input);
  const percent = input.attempters > 0 ? Math.round((100 * input.solvers) / input.attempters) : 0;
  switch (verdict) {
    case "harder-than-labelled":
      return `Labelled ${input.difficulty.toLowerCase()}, solved by ${percent}% of the ${input.attempters} who tried it. Check the tests and the constraints before the label.`;
    case "easier-than-labelled":
      return `Labelled ${input.difficulty.toLowerCase()}, solved by ${percent}% of the ${input.attempters} who tried it. It may belong a rung lower.`;
    case "too-few-attempts":
      return `Only ${input.attempters} ${input.attempters === 1 ? "student has" : "students have"} tried it: too few to say anything.`;
    default:
      return `Solved by ${percent}% of the ${input.attempters} who tried it, which is what the label says.`;
  }
}

export const CALIBRATION_VERDICT_LABEL: Readonly<Record<CalibrationVerdict, string>> = Object.freeze({
  "too-few-attempts": "Too few attempts",
  "as-labelled": "As labelled",
  "harder-than-labelled": "Harder than labelled",
  "easier-than-labelled": "Easier than labelled",
});
