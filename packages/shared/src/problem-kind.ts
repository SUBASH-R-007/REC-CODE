import type { CompareMode, IoMode } from "./protocol";

/**
 * What KIND of question a problem is, in one word, for the places that
 * list problems rather than open them (Phase 12p).
 *
 * Phases 12k to 12n each added a kind and each explained it carefully ON
 * the problem page — the dialect bar, the edit budget, the conversation
 * chips, the answer box. None of them touched the list a student picks
 * from, so a query, a one-line fix, a conversation and an answer box all
 * looked like an ordinary program until you opened one. A browser run
 * found that (docs/RUNBOOK.md §3, 12p.2); this is the single source for
 * the word, so the catalogue and the workspace cannot drift apart.
 *
 * The kind is DERIVED, never stored: the version's own CHECK constraints
 * already decide it, and a second column would be a second truth.
 */
export const PROBLEM_KINDS = ["program", "sql", "interactive", "debugging", "answer"] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

/** The three fields a frozen version's CHECKs tie the kind to. */
export interface ProblemKindFacts {
  ioMode: IoMode;
  compareMode: CompareMode;
  /** Phase 12m: a budget IS what makes a problem a debugging problem. */
  maxEditedLines: number | null;
}

/**
 * The kind, in the order the constraints make mutually exclusive:
 * `ProblemVersion_sql_mode_mirror` makes SQL exactly ROWS;
 * `ProblemVersion_debug_budget_kind` keeps a budget off SQL and
 * interactive versions; `ProblemVersion_output_only_fields` keeps an
 * output-only version free of all of them. So no two of these can be true
 * at once, and the order below is a reader's convenience rather than a
 * tie-break.
 */
export function problemKind(facts: ProblemKindFacts): ProblemKind {
  if (facts.ioMode === "SQL" || facts.compareMode === "ROWS") return "sql";
  if (facts.compareMode === "INTERACTIVE") return "interactive";
  if (facts.ioMode === "OUTPUT_ONLY") return "answer";
  if (facts.maxEditedLines !== null) return "debugging";
  return "program";
}

/**
 * The chip a student reads in a list. An ordinary program gets no chip —
 * a label on every row is a label nobody reads, and the four that are
 * unlike the rest are the ones worth naming.
 */
export const PROBLEM_KIND_LABEL: Readonly<Record<ProblemKind, string>> = Object.freeze({
  program: "",
  sql: "SQL",
  interactive: "Conversation",
  debugging: "Debugging",
  answer: "Answer only",
});

/**
 * One sentence of what the word means, for the screen-reader text behind
 * the chip and for a tooltip. Each one is the short form of what the
 * problem page says at length when the question is opened.
 */
export const PROBLEM_KIND_HINT: Readonly<Record<ProblemKind, string>> = Object.freeze({
  program: "",
  sql: "Answered with a single PostgreSQL query, not a program.",
  interactive: "A conversation with the examiner rather than one output.",
  debugging: "A program that is nearly right: find the mistake and fix it, within an edit budget.",
  answer: "No program to write: you work the answer out and submit it.",
});

/** True for the kinds that get a chip — everything but an ordinary program. */
export function isNamedProblemKind(kind: ProblemKind): boolean {
  return kind !== "program";
}
