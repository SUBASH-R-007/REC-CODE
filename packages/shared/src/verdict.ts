/**
 * The verdict vocabulary. This module is the ONLY definition of Verdict in
 * the repository — the Prisma enum in packages/db is a storage mirror that a
 * parity test (packages/db/test/enum-parity.test.ts) holds equal to this list,
 * and tests/repo/single-source.test.ts fails the build on any other copy.
 *
 * There is no separate PE verdict: presentation errors fold into WA and the
 * UI explains the whitespace policy instead.
 */
export const VERDICTS = [
  "AC",
  "WA",
  "TLE",
  "MLE",
  "RE",
  "CE",
  "OLE",
  "PARTIAL",
  "SKIPPED",
  "IE",
] as const;

export type Verdict = (typeof VERDICTS)[number];

export const Verdict = Object.freeze(
  Object.fromEntries(VERDICTS.map((v) => [v, v])) as { readonly [K in Verdict]: K },
);

/** States a submission shows before it has a verdict. Not verdicts. */
export type PendingDisplay = "QUEUED" | "RUNNING";
export type VerdictDisplay = Verdict | PendingDisplay;

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

/** Full text labels. Every rendering of a verdict carries one of these. */
export const VERDICT_LABEL: Readonly<Record<VerdictDisplay, string>> = {
  AC: "Accepted",
  WA: "Wrong Answer",
  TLE: "Time Limit Exceeded",
  MLE: "Memory Limit Exceeded",
  OLE: "Output Limit Exceeded",
  RE: "Runtime Error",
  CE: "Compile Error",
  PARTIAL: "Partially Accepted",
  SKIPPED: "Skipped",
  IE: "Internal Error",
  QUEUED: "Queued",
  RUNNING: "Running",
};

/** Monospace short codes. Pending states have no code ("—"). */
export const VERDICT_CODE: Readonly<Record<VerdictDisplay, string>> = {
  AC: "AC",
  WA: "WA",
  TLE: "TLE",
  MLE: "MLE",
  OLE: "OLE",
  RE: "RE",
  CE: "CE",
  PARTIAL: "PARTIAL",
  SKIPPED: "SKIPPED",
  IE: "IE",
  QUEUED: "—",
  RUNNING: "—",
};

/**
 * Precedence used when a single verdict must summarise several tests that
 * all ran (e.g. PER_TEST scoring, or stopOnFirstFailure=false). Lower index
 * wins. CE never coexists with test verdicts (nothing runs after a CE); IE
 * outranks everything because the result cannot be trusted at all.
 * Published on the /judge transparency page.
 */
export const VERDICT_PRECEDENCE: readonly Verdict[] = [
  "IE",
  "CE",
  "RE",
  "MLE",
  "OLE",
  "TLE",
  "WA",
  "PARTIAL",
  "SKIPPED",
  "AC",
];

export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  let best = VERDICT_PRECEDENCE.length - 1;
  for (const v of verdicts) {
    const idx = VERDICT_PRECEDENCE.indexOf(v);
    if (idx >= 0 && idx < best) best = idx;
  }
  return VERDICT_PRECEDENCE[best] ?? "AC";
}

/** Verdicts that are a statement about the student's code (never retried). */
export const DETERMINISTIC_VERDICTS: readonly Verdict[] = [
  "AC",
  "WA",
  "TLE",
  "MLE",
  "RE",
  "CE",
  "OLE",
  "PARTIAL",
  "SKIPPED",
];

/**
 * How ONE test's run is classified, in order: the first matching rule wins.
 * apps/judge-worker/src/judge/verdict.ts classifyRun() implements it
 * (apps/judge-worker/test/verdict-rules.test.ts binds the two). Published on
 * the /judge transparency page, which gives each rule its prose.
 */
export const RUN_OUTCOME_RULES = [
  { id: "sandbox-failure", verdict: "IE" }, // isolate status XX (retried, never charged)
  { id: "output-trip", verdict: "OLE" }, // the supervisor's early stdout trip
  { id: "time-limit", verdict: "TLE" }, // status TO (the idle variant is admin-only)
  { id: "cpu-overrun", verdict: "TLE" }, // ended inside --extra-time with CPU > limit
  { id: "memory-limit", verdict: "MLE" }, // cg-oom-killed, or cg-mem ≥ limit
  { id: "file-size-signal", verdict: "OLE" }, // SIGXFSZ
  { id: "signal", verdict: "RE" }, // any other signal
  { id: "runtime-out-of-memory", verdict: "MLE" }, // JVM OutOfMemoryError / Python MemoryError
  { id: "exit-code", verdict: "RE" }, // non-zero exit
  { id: "compare", verdict: null }, // clean exit: the compare mode / checker decides
] as const satisfies readonly { id: string; verdict: Verdict | null }[];

export type RunOutcomeRuleId = (typeof RUN_OUTCOME_RULES)[number]["id"];
