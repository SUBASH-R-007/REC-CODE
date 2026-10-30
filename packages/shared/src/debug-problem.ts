/**
 * Debugging problems (Phase 12m): a question that hands the student a
 * program which is nearly right and asks them to fix it within an EDIT
 * BUDGET.
 *
 * The judging is an ordinary problem's — the fixed program runs against the
 * version's tests. The budget is the only new rule, and it is the whole
 * question: without it the student deletes the program and writes their
 * own, and the exercise (read somebody else's code, find the mistake)
 * never happens.
 *
 * One counting function, used by three surfaces — the editor's live
 * counter, the submit and run refusals, and the publish gate that proves
 * the author's own fix fits — because a student told "you changed 4 lines"
 * by one of them and "2" by another cannot act on either number.
 *
 * The design is `docs/handoff/phase12/DESIGN-debugging.md`.
 */

/** The range an author may set. One line is a real question; fifty is a rewrite. */
export const DEBUG_BUDGET = Object.freeze({ min: 1, max: 50 });

/** Above this many significant lines on both sides the exact diff is skipped (see `countEditedLines`). */
const EXACT_DIFF_CELLS = 4_000_000;

export function isDebugBudget(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= DEBUG_BUDGET.min &&
    value <= DEBUG_BUDGET.max
  );
}

/**
 * The lines the count is taken over: trimmed, and blank ones dropped.
 *
 * Re-indenting is not a fix and spacing a program out while reading it is
 * not an edit, so neither may cost a student part of their budget. Both
 * halves of that are this function, and it is exported because the live
 * counter in the editor runs on the same lines as the server's refusal.
 */
export function significantLines(source: string): string[] {
  const out: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) out.push(line);
  }
  return out;
}

/** Length of the longest common subsequence of two line lists. */
function commonLines(a: readonly string[], b: readonly string[]): number {
  // The shared head and tail are the whole answer for a one-line fix, and
  // taking them off first keeps the table small for every realistic edit.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const fixed = start + (a.length - 1 - endA);
  const x = a.slice(start, endA + 1);
  const y = b.slice(start, endB + 1);
  if (x.length === 0 || y.length === 0) return fixed;

  if (x.length * y.length > EXACT_DIFF_CELLS) {
    // A submission with thousands of changed lines is over every budget an
    // author may set, so there is nothing to be gained by an exact diff of
    // it — and a quadratic table that large is a request a server should
    // not honour. Counted as a multiset instead: order is ignored, which
    // can only over-state what the two have in common, and over-stating it
    // can only make the count smaller than the truth. A budget is never
    // enforced more harshly than the exact rule would.
    const pool = new Map<string, number>();
    for (const line of x) pool.set(line, (pool.get(line) ?? 0) + 1);
    let shared = 0;
    for (const line of y) {
      const left = pool.get(line);
      if (left) {
        pool.set(line, left - 1);
        shared += 1;
      }
    }
    return fixed + shared;
  }

  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  let prev = new Int32Array(short.length + 1);
  let cur = new Int32Array(short.length + 1);
  for (const line of long) {
    for (let j = 0; j < short.length; j += 1) {
      const diagonal = prev[j] ?? 0;
      const above = prev[j + 1] ?? 0;
      const left = cur[j] ?? 0;
      cur[j + 1] = line === short[j] ? diagonal + 1 : Math.max(above, left);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return fixed + (prev[short.length] ?? 0);
}

/**
 * How many lines a submission changes, against the program it was given.
 *
 * `max(added, removed)` over a line-level diff — the number of lines the
 * student had to type. Editing a line is 1; deleting three is 3; replacing
 * one line with two is 2. Moving a line is 1, because one line moved.
 */
export function countEditedLines(original: string, submitted: string): number {
  const a = significantLines(original);
  const b = significantLines(submitted);
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const shared = commonLines(a, b);
  return Math.max(a.length - shared, b.length - shared);
}

const lines = (n: number) => `${n} line${n === 1 ? "" : "s"}`;

/**
 * The sentences that do not depend on the budget.
 *
 * Every word a student reads about a debugging question comes from here or
 * from one of the builders below, for the reason the SQL and interactive
 * notices do (`sql-problem.ts`, `interactive.ts`): two copies of a
 * sentence is one copy that goes stale, and the stale one is always the one
 * on the screen. A repository test refuses a second copy.
 */
export const DEBUG_NOTICES = Object.freeze({
  counted:
    "A line counts as changed when its text differs once the indentation is taken off. Blank lines are ignored entirely, so you may space the program out while you read it.",
  why:
    "The budget is the question: the point is to find the mistake, not to write the program again from the beginning.",
  reset: "Reset puts the original program back, exactly as it was given to you.",
  languages:
    "A debugging question is offered in the languages its program is written in and no others, because each one would be a different program with a different mistake.",
});

/** The rule itself, in a sentence, for the statement and the refusals. */
export function debugRuleSentence(budget: number): string {
  return `This program is nearly right: it has one mistake. Find it and fix it, changing at most ${lines(budget)}.`;
}

/** The chip over the editor. */
export function debugChipLabel(budget: number): string {
  return `a debugging question · at most ${lines(budget)}`;
}

/** The live counter beside it. */
export function debugCountLabel(changed: number, budget: number): string {
  return `${changed} of ${lines(budget)} changed`;
}

/** What a student reads instead of a verdict when the submission is over budget. */
export function debugOverBudget(changed: number, budget: number): string {
  return (
    `This changes ${lines(changed)} and the question allows ${budget}. ` +
    "Fix the program that is there rather than replacing it — Reset puts the original back."
  );
}

export const DEBUG_REFUSALS = Object.freeze({
  noProgram:
    "This question gives you a program to repair, and there is none in that language. Choose one of the languages the editor offers.",
});

export const DEBUG_LABELS = Object.freeze({
  original: "The program you were given",
  changed: "Lines changed",
});
