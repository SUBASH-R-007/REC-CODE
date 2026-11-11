import { LIMITS } from "./limits";

/**
 * What a student is told about an interactive problem (Phase 12l, slice 3).
 *
 * Every sentence a student reads about a conversation lives here, for the
 * same reason the SQL ones do (`sql-problem.ts`): two copies of a sentence
 * is one copy that goes stale, and the stale one is always the one on the
 * screen. A repository test refuses a second copy.
 *
 * The engine's own rules are in `apps/judge-worker/src/judge/interactive.ts`
 * and the design is `docs/handoff/phase12/DESIGN-interactive.md`; these are
 * the words, not the rules.
 */

/** The transcript's two markers, as the worker's relay writes them. */
export const INTERACTIVE_TRANSCRIPT_MARKERS = Object.freeze({ solution: ">", interactor: "<" });

export const INTERACTIVE_NOTICES = Object.freeze({
  dialogue:
    "This question is a conversation: your program and the examiner's take turns on standard input and output, and there is no expected output to match.",
  flush:
    "Flush after every line you print, or your program will wait for a reply to a question that never arrived — in C++ use std::endl or std::cout.flush(), in Python print(..., flush=True), in Java System.out.flush().",
  deadlock: `If neither side writes anything for ${LIMITS.interactive.idleMs / 1000} seconds, both are waiting to read and the submission is reported as too slow.`,
  transcript:
    "For the sample cases you can read the whole conversation afterwards: lines you sent are marked > and the replies <.",
  sampleData:
    "A sample shows the examiner's own data for that case — the secret it keeps and the budget it allows. Your program never reads it; it only sees the replies.",
  noCustomInput:
    "There is no custom input for a conversation: what a case gives the examiner is the author's, and your program's input is whatever it replies.",
});

export const INTERACTIVE_REFUSALS = Object.freeze({
  customInput:
    "This question is a conversation, so there is no input to type. Run it to talk to the examiner on the sample cases.",
  noSampleCase: "That question has no sample conversation to run against. Submit your program instead.",
});

/** The label a visible case's three blocks carry for an interactive problem. */
export const INTERACTIVE_LABELS = Object.freeze({
  data: "The examiner's data",
  transcript: "Your conversation",
});
