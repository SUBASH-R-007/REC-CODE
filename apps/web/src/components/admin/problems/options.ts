import "server-only";
import {
  ANSWER_LANGUAGE_KEY,
  ANSWER_LANGUAGE_LABEL,
  LANGUAGE_CATALOG,
  LANGUAGE_KEYS,
  SQL_LANGUAGE_KEY,
  SQL_LANGUAGE_LABEL,
  TOPICS,
  TOPIC_LABEL,
} from "@recx/shared";
import { CONTENT_ORIGINS, CONTENT_ORIGIN_LABEL, REFERENCE_EXPECTED_VERDICTS } from "@recx/shared/authoring";

/**
 * Select options for the authoring forms, built on the server and passed to
 * the client leaves as plain data (so the client bundles never pull in the
 * shared zod schemas).
 */
export interface Option {
  value: string;
  label: string;
}

export const COMPARE_MODE_OPTIONS: readonly Option[] = [
  { value: "TOKEN", label: "TOKEN — whitespace-separated tokens must match" },
  { value: "EXACT", label: "EXACT — byte-for-byte (after trailing-newline normalisation)" },
  { value: "FLOAT", label: "FLOAT — numbers within a tolerance" },
  { value: "CHECKER", label: "CHECKER — a testlib checker program decides" },
  // Phase 12l. Last, because it is the only one whose problem is not
  // authored by typing expected output: the interactor decides as it goes.
  { value: "INTERACTIVE", label: "INTERACTIVE — a testlib interactor talks to the program and decides" },
];

export const ORIGIN_OPTIONS: readonly Option[] = CONTENT_ORIGINS.map((o) => ({ value: o, label: CONTENT_ORIGIN_LABEL[o] }));

/**
 * Every language a reference solution or a starter may be written in: the
 * toolchains, plus the two that are not toolchains — `sql17` (Phase 12k)
 * and `answer1` (Phase 12n). A SQL problem's model solution is its
 * reference QUERY and an output-only problem's is its model ANSWER, and
 * the publish gate asks for each by name, so the form has to offer them.
 */
export const LANGUAGE_OPTIONS: readonly Option[] = [
  ...LANGUAGE_KEYS.map((k) => ({ value: k, label: `${LANGUAGE_CATALOG[k].label} (${k})` })),
  { value: SQL_LANGUAGE_KEY, label: `${SQL_LANGUAGE_LABEL} (${SQL_LANGUAGE_KEY}) — a query, for a SQL problem` },
  { value: ANSWER_LANGUAGE_KEY, label: `${ANSWER_LANGUAGE_LABEL} (${ANSWER_LANGUAGE_KEY}) — the answer, for an output-only problem` },
];

const VERDICT_TEXT: Record<string, string> = {
  AC: "AC — model solution, must pass",
  WA: "WA — must give a wrong answer",
  TLE: "TLE — must exceed the time limit",
  MLE: "MLE — must exceed the memory limit",
  RE: "RE — must crash",
};

export const VERDICT_OPTIONS: readonly Option[] = REFERENCE_EXPECTED_VERDICTS.map((v) => ({ value: v, label: VERDICT_TEXT[v] ?? v }));

export const TOPIC_OPTIONS: readonly Option[] = TOPICS.map((t) => ({ value: t, label: TOPIC_LABEL[t] }));
