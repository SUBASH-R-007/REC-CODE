/**
 * The seed's authored problems, by slug. Problems are listed in display-code
 * order; two-sum's problem data lives in @recx/shared (see ./two-sum.ts).
 * Badges and study plans have their own modules (./badges, ./study-plans).
 */
import type { Topic } from "@recx/shared";
import { TWO_SUM } from "@recx/shared/samples/two-sum";
import { BENCH_BLACKOUT } from "./bench-blackout";
import { BRACKET_CLEANUP } from "./bracket-cleanup";
import { CONVEYOR_SHIFT } from "./conveyor-shift";
import { EXACT_CHANGE_PAIR } from "./exact-change-pair";
import { HANDLE_MAKER } from "./handle-maker";
import { LAB_POWER_BUDGET } from "./lab-power-budget";
import { NO_NEIGHBOUR_SEATING } from "./no-neighbour-seating";
import { PLAYLIST_FOLD } from "./playlist-fold";
import { SECOND_SWIPE } from "./second-swipe";
import { SESSION_ORDER } from "./session-order";
import { STUDY_PAIRS } from "./study-pairs";
import { TWO_SUM_HELP, TWO_SUM_TOPICS } from "./two-sum";
import type { AuthoredProblem, HelpContent } from "./types";

/** Problems the seed creates as DRAFT revision 1 (published only through validation). */
export const AUTHORED_PROBLEMS: readonly AuthoredProblem[] = [
  BRACKET_CLEANUP,
  STUDY_PAIRS,
  HANDLE_MAKER,
  LAB_POWER_BUDGET,
  SECOND_SWIPE,
  CONVEYOR_SHIFT,
  PLAYLIST_FOLD,
  BENCH_BLACKOUT,
  SESSION_ORDER,
  EXACT_CHANGE_PAIR,
  NO_NEIGHBOUR_SEATING,
];

/** Hints and editorial for every seeded problem, two-sum included. */
export const HELP_BY_SLUG: ReadonlyMap<string, HelpContent> = new Map<string, HelpContent>([
  [TWO_SUM.slug, TWO_SUM_HELP],
  ...AUTHORED_PROBLEMS.map((p): [string, HelpContent] => [p.slug, p.help]),
]);

/** Topic tags for every seeded problem, primary topic first. */
export const TOPICS_BY_SLUG: ReadonlyMap<string, readonly Topic[]> = new Map<string, readonly Topic[]>([
  [TWO_SUM.slug, TWO_SUM_TOPICS],
  ...AUTHORED_PROBLEMS.map((p): [string, readonly Topic[]] => [p.slug, p.topics]),
]);
