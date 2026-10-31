import { z } from "zod";

/**
 * Output-only problems (Phase 12n): the submission is the ANSWER, not a
 * program.
 *
 * SPEC §11 asks for "output-only problem kinds". The student is handed one
 * hard instance, works it out however they like — by hand, in a
 * spreadsheet, with a program they never upload — and submits the result.
 * It is judged by comparing it with the expected output, or by the
 * author's checker when the answer deserves partial credit.
 *
 * What lives here is what both sides must agree about: the language key a
 * submission carries, and the words a student reads. The engine's own path
 * is `apps/judge-worker/src/judge/answer.ts` and the design is
 * `docs/handoff/phase12/DESIGN-output-only.md`.
 */

/**
 * The language key an answer submission carries — and, like `sql17`, not a
 * toolchain.
 *
 * `Submission.languageConfigId` is required, which is what kept SQL inside
 * the existing pipeline (XP, the leaderboard, contests, rejudges) without
 * touching `Submission` at all. The same reason applies here: an answer is
 * not compiled and not run, so it has no argv, no `/opt/toolchains`
 * directory and no process limit — and inventing nine fields that describe
 * nothing would be worse than a key of its own.
 */
export const ANSWER_LANGUAGE_KEY = "answer1";

/** What a student sees in the footer, the submission list and their profile. */
export const ANSWER_LANGUAGE_LABEL = "Answer file";

/** The editor grammar: an answer is text, and highlighting it would be a lie. */
export const ANSWER_EDITOR_LANGUAGE = "plaintext";

/** The toolchain id of the row, so the unique (key, toolchainId) holds. */
export const ANSWER_TOOLCHAIN_ID = "answer-1";

/**
 * The `LanguageConfig.runtime` of the answer row. Deliberately nothing
 * like `LanguageRuntime`: no argv, no toolchain, nothing to compile. A
 * reader who finds this in the column knows at once that no program runs.
 */
export const answerRuntimeSchema = z
  .object({
    key: z.literal(ANSWER_LANGUAGE_KEY),
    kind: z.literal("answer"),
    label: z.string().min(1).max(64),
    editorLanguage: z.literal(ANSWER_EDITOR_LANGUAGE),
  })
  .strict();
export type AnswerRuntime = z.infer<typeof answerRuntimeSchema>;

export const ANSWER_RUNTIME: AnswerRuntime = Object.freeze({
  key: ANSWER_LANGUAGE_KEY,
  kind: "answer",
  label: ANSWER_LANGUAGE_LABEL,
  editorLanguage: ANSWER_EDITOR_LANGUAGE,
});

export function isAnswerLanguage(key: string): boolean {
  return key === ANSWER_LANGUAGE_KEY;
}

/**
 * The starter an output-only problem opens with when its author wrote
 * none: nothing at all. A comment would be a line the student has to
 * delete before their answer is their answer.
 */
export const ANSWER_STARTER_CODE = "";

/**
 * What a student is told about an output-only problem.
 *
 * One copy of each sentence, for the reason the SQL and debugging notices
 * live that way (`sql-problem.ts`, `debug-problem.ts`): two copies is one
 * copy that goes stale, and the stale one is always the one on the screen.
 * A repository test refuses a second copy.
 */
export const ANSWER_NOTICES = Object.freeze({
  whatToSubmit:
    "This question asks for the answer itself, not a program. Work out the answer to the data below however you like — by hand, in a spreadsheet, or with a program you keep to yourself — and paste it here.",
  oneCase:
    "There is one case, and you can see all of it: the data is the question. Nothing is hidden, so nothing is held back from the result either.",
  noProgram:
    "Nothing is compiled and nothing is run, so there is no time limit and no memory limit on your side. What is compared is the text you submit.",
  whitespace:
    "Leading and trailing whitespace and the line endings do not matter unless the question says otherwise; the order of what you print does.",
});

export const ANSWER_REFUSALS = Object.freeze({
  noRun:
    "There is nothing to run: your answer IS the submission. Submit it when you are ready — the result tells you whether it is right.",
  empty: "Write your answer first.",
});

/** The labels a visible case carries for an output-only problem. */
export const ANSWER_LABELS = Object.freeze({
  data: "The data",
  answer: "Your answer",
  expected: "The expected answer",
});
