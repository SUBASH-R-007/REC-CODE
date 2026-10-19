/**
 * The question palette (Phase 6c). Pure: state derivation, labels, counts and
 * keyboard navigation. No React, no icons — the component maps each state to
 * a shape and a lucide icon, and this module decides WHICH state a question
 * is in and what it is called.
 *
 * SPEC §5 names five states and is specific that colour is never the carrier:
 *
 *   Question palette, five states each with a distinct shape + icon + full
 *   aria-label, as a role="group" of buttons with a roving tabindex and
 *   Arrow-key navigation, a text+icon legend, and a counts row
 *   ("Answered 12 · Marked 3 · Not answered 15").
 *
 *     Not visited — bg-surface border-border, square, no glyph.
 *     Visited, unanswered — bg-danger-subtle text-danger, square with bottom
 *       notch, Minus.
 *     Answered — bg-success-subtle text-success, rounded-full, Check.
 *     Marked — bg-info-subtle text-info, rounded-full, Flag.
 *     Answered and marked — as 4 plus a small Check badge.
 *
 * This is TCS iON / AMCAT muscle memory on purpose. An exam is the worst
 * possible place to teach new UI, so the five states, their order and the
 * counts row all match what a student has already sat.
 */

export const PALETTE_STATES = [
  "NOT_VISITED",
  "VISITED_UNANSWERED",
  "ANSWERED",
  "MARKED",
  "ANSWERED_MARKED",
] as const;
export type PaletteState = (typeof PALETTE_STATES)[number];

/** What the exam page knows about one question. */
export interface QuestionProgress {
  readonly visited: boolean;
  readonly answered: boolean;
  readonly marked: boolean;
}

/**
 * Which of the five states a question is in.
 *
 * `visited` wins over everything: a question that was never opened cannot be
 * answered or marked, and a stored flag that says otherwise is a bug
 * somewhere else, not something to render as a fifth-and-a-half state.
 */
export function paletteStateOf(progress: QuestionProgress): PaletteState {
  if (!progress.visited) return "NOT_VISITED";
  if (progress.answered && progress.marked) return "ANSWERED_MARKED";
  if (progress.marked) return "MARKED";
  if (progress.answered) return "ANSWERED";
  return "VISITED_UNANSWERED";
}

/**
 * The shape and glyph each state carries, so the state survives greyscale,
 * a colour-blind candidate and a projector with the contrast turned down.
 * `icon` is a lucide name, or null for the one state that is deliberately
 * empty; `shape` is the geometry the component draws.
 */
export interface PaletteAppearance {
  readonly shape: "square" | "square-notched" | "circle";
  readonly icon: "minus" | "check" | "flag" | null;
  /** Answered-and-marked is a flag with a check badged onto it. */
  readonly badge: "check" | null;
  /** The legend's wording, which is also the state's name in the label. */
  readonly legend: string;
}

export const PALETTE_APPEARANCE: Readonly<Record<PaletteState, PaletteAppearance>> = Object.freeze({
  NOT_VISITED: { shape: "square", icon: null, badge: null, legend: "Not visited" },
  VISITED_UNANSWERED: { shape: "square-notched", icon: "minus", badge: null, legend: "Not answered" },
  ANSWERED: { shape: "circle", icon: "check", badge: null, legend: "Answered" },
  MARKED: { shape: "circle", icon: "flag", badge: null, legend: "Marked for review" },
  ANSWERED_MARKED: { shape: "circle", icon: "flag", badge: "check", legend: "Answered and marked for review" },
});

/**
 * The full accessible name for one palette button. "Full" matters: a screen
 * reader user navigating 30 buttons with Arrow keys hears only this, so it
 * carries the number AND the state, never a bare "7".
 */
export function paletteLabel(position: number, state: PaletteState): string {
  return `Question ${position}, ${PALETTE_APPEARANCE[state].legend.toLowerCase()}`;
}

export interface PaletteCounts {
  readonly answered: number;
  readonly marked: number;
  readonly notAnswered: number;
  readonly total: number;
}

/**
 * The counts row. `marked` counts every marked question whether or not it is
 * answered, and `notAnswered` counts both unvisited and visited-unanswered —
 * which is what a candidate means by "how many have I not done", and what
 * makes the three numbers add up to the total only when nothing is marked.
 * The spec's own example ("Answered 12 · Marked 3 · Not answered 15") has
 * exactly that overlap.
 */
export function paletteCounts(progress: readonly QuestionProgress[]): PaletteCounts {
  let answered = 0;
  let marked = 0;
  let notAnswered = 0;
  for (const q of progress) {
    if (q.answered) answered++;
    else notAnswered++;
    if (q.marked) marked++;
  }
  return { answered, marked, notAnswered, total: progress.length };
}

export function paletteCountsText(counts: PaletteCounts): string {
  return `Answered ${counts.answered} · Marked ${counts.marked} · Not answered ${counts.notAnswered}`;
}

// ── Roving tabindex ──────────────────────────────────────────────────────

/**
 * Keys the palette handles. Anything else is left to the browser — a palette
 * that swallows Tab traps the candidate in it.
 */
export const PALETTE_KEYS = [
  "ArrowRight",
  "ArrowLeft",
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
] as const;
export type PaletteKey = (typeof PALETTE_KEYS)[number];

export function isPaletteKey(key: string): key is PaletteKey {
  return (PALETTE_KEYS as readonly string[]).includes(key);
}

/**
 * Where the roving tabindex moves next, or null when the key is not ours.
 *
 * The palette is a grid, so Up and Down move by a row rather than by one —
 * a candidate who presses Down expects the question below, not the next one.
 * Movement CLAMPS rather than wrapping: wrapping from question 30 to
 * question 1 on one extra keypress is how someone loses their place in an
 * exam, and there is no affordance that would have warned them.
 */
export function paletteNavigate(args: {
  readonly index: number;
  readonly total: number;
  readonly columns: number;
  readonly key: string;
}): number | null {
  const { total } = args;
  if (total <= 0) return null;
  if (!isPaletteKey(args.key)) return null;
  const columns = Math.max(1, Math.floor(args.columns));
  const index = Math.min(Math.max(0, Math.floor(args.index)), total - 1);
  const clamp = (n: number) => Math.min(Math.max(0, n), total - 1);

  switch (args.key) {
    case "ArrowRight":
      return clamp(index + 1);
    case "ArrowLeft":
      return clamp(index - 1);
    case "ArrowDown":
      // Past the last row, go to the last question rather than nowhere: the
      // candidate asked to move down and something should move.
      return clamp(index + columns);
    case "ArrowUp":
      return clamp(index - columns);
    case "Home":
      return 0;
    case "End":
      return total - 1;
  }
}

// ── The bottom bar ───────────────────────────────────────────────────────

/**
 * The bottom bar's buttons, in the order SPEC §5 fixes them:
 * "Previous · Mark for review & next · Clear response · Save & next in that
 * order — TCS iON / AMCAT muscle memory, because an exam is the worst
 * possible place to teach new UI."
 *
 * Exported as data, and asserted in a test, so a later tidy-up cannot
 * reorder them for visual balance.
 */
export const EXAM_BOTTOM_BAR_ACTIONS = [
  { id: "previous", label: "Previous" },
  { id: "markAndNext", label: "Mark for review & next" },
  { id: "clear", label: "Clear response" },
  { id: "saveAndNext", label: "Save & next" },
] as const;
export type ExamBottomBarAction = (typeof EXAM_BOTTOM_BAR_ACTIONS)[number]["id"];
