import { z } from "zod";
import { HINT_POLICY, type HelpInput } from "./help";

/**
 * The AI helper (Phase 12b): a student stuck on a PRACTICE problem asks what
 * they have got wrong, or what approach to take.
 *
 * Three rules shape everything here, and each exists because of something
 * else in this product:
 *
 * 1. **Practice only.** `docs/PROCTORING.md` and `help.ts` already draw this
 *    line for hints and editorials — CONTEST and ASSESSMENT get nothing,
 *    unconditionally — and the assistant is on the same side of it. The
 *    server decides the context (`lib/help/access.ts` is the chokepoint);
 *    the client never says which surface it is on.
 *
 * 2. **Using it makes a first solve ASSISTED.** An assistant that reads your
 *    code and tells you what is wrong is at least hint 3. Readiness is built
 *    on *unassisted* coverage (SPEC §9), so an assistant that did not mark
 *    the solve would quietly inflate every readiness score in the college.
 *
 * 3. **A super-admin owns it.** Which model answers, and whether it answers
 *    at all, is a `PlatformSetting` they edit — not a deploy. The kill
 *    switch takes effect on the next request.
 *
 * What the assistant is never given: hidden test data (SPEC §5 makes
 * expected-output secrecy a hard guarantee), another student's code, or
 * anything about who the student is. It sees the public statement, the
 * student's own draft, and the verdict of their own last run.
 */

export const AI_HELPER_SETTING_KEY = "ai-helper";

/** What a student can ask for. Both are explanations; neither is a solution. */
export const AI_ASK_KINDS = ["MISTAKE", "APPROACH"] as const;
export type AiAskKind = (typeof AI_ASK_KINDS)[number];

export const AI_ASK_LABEL: Readonly<Record<AiAskKind, string>> = Object.freeze({
  MISTAKE: "What is wrong with my code?",
  APPROACH: "How should I approach this?",
});

/**
 * The models a super-admin may choose between, and the provider each needs.
 *
 * A closed catalogue rather than a free-text model id: the id reaches an
 * external API, and "whatever somebody typed" is not a thing to send to one.
 * `custom` is the one exception, for a college-hosted OpenAI-compatible
 * endpoint, where the deployment names the model in `AI_MODEL` and the base
 * URL in `AI_BASE_URL`.
 */
export const AI_PROVIDERS = ["anthropic", "openai-compatible"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiModelChoice {
  readonly id: string;
  readonly provider: AiProvider;
  readonly label: string;
  readonly description: string;
}

export const AI_MODELS: readonly AiModelChoice[] = Object.freeze([
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    description: "The default: the strongest answers for the price, and good at reading a half-finished program.",
  },
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    label: "Claude Opus 5.5",
    description: "Slower and dearer. Worth it only if Sonnet's explanations are missing things.",
  },
  {
    id: "claude-haiku-5-5",
    provider: "anthropic",
    label: "Claude Haiku 5.5",
    description: "Fastest and cheapest. A sensible choice during a busy practice week.",
  },
  {
    id: "custom",
    provider: "openai-compatible",
    label: "College-hosted model (OpenAI-compatible)",
    description:
      "An endpoint the college runs. The deployment names it: AI_BASE_URL and AI_MODEL. Nothing leaves campus.",
  },
]);

export const AI_MODEL_IDS = AI_MODELS.map((m) => m.id);

export function aiModel(id: string): AiModelChoice | null {
  return AI_MODELS.find((m) => m.id === id) ?? null;
}

/** How many questions one student may ask in a day, whatever the model. */
export const AI_DAILY_LIMIT = Object.freeze({ min: 1, max: 50, default: 10 });
/** Hard ceilings on what crosses the wire, in characters and tokens. */
export const AI_SOURCE_MAX_CHARS = 20_000;
export const AI_STATEMENT_MAX_CHARS = 8_000;
export const AI_OUTPUT_MAX_TOKENS = Object.freeze({ min: 256, max: 2_000, default: 700 });
/** A model that has not answered in this long is not going to. */
export const AI_TIMEOUT_MS = 30_000;

export const aiHelperSettingSchema = z
  .object({
    enabled: z.boolean(),
    modelId: z.enum(AI_MODEL_IDS as unknown as [string, ...string[]]),
    dailyPerStudent: z.number().int().min(AI_DAILY_LIMIT.min).max(AI_DAILY_LIMIT.max),
    maxOutputTokens: z.number().int().min(AI_OUTPUT_MAX_TOKENS.min).max(AI_OUTPUT_MAX_TOKENS.max),
  })
  .strict();
export type AiHelperSetting = z.infer<typeof aiHelperSettingSchema>;

/**
 * Off, by default and on anything unreadable. A malformed setting must not
 * fail open: the helper sends a student's code to an external service, and
 * the safe reading of "we cannot tell what was configured" is "do not".
 */
export const AI_HELPER_DEFAULT: AiHelperSetting = Object.freeze({
  enabled: false,
  modelId: "claude-sonnet-5-5",
  dailyPerStudent: AI_DAILY_LIMIT.default,
  maxOutputTokens: AI_OUTPUT_MAX_TOKENS.default,
});

export function effectiveAiHelperSetting(value: unknown): AiHelperSetting {
  const parsed = aiHelperSettingSchema.safeParse(value);
  return parsed.success ? parsed.data : AI_HELPER_DEFAULT;
}

// ── Who may ask, and when ───────────────────────────────────────────────

export const AI_REFUSALS = Object.freeze({
  off: "The assistant is switched off. Your hints and the editorial still work.",
  notPractice:
    "The assistant is not available during a contest or an assessment. It is a practice tool, and this sitting is not practice.",
  tooEarly:
    "Have a real go first. The assistant unlocks after one judged submission, or ten minutes of work on this problem.",
  dailyLimit: "You have used today's questions. They come back tomorrow — and the hints are always there.",
  unconfigured: "The assistant has no model configured. Ask a super-admin.",
  unavailable: "The assistant could not answer just now. Try again in a moment.",
});

export interface AiAccess {
  readonly allowed: boolean;
  /** Why not, in the student's own words. Null when allowed. */
  readonly reason: string | null;
  /**
   * True when an answer would make a later first solve ASSISTED. False once
   * the problem is already solved: the solve has happened, and nothing about
   * it changes retrospectively.
   */
  readonly marksAssisted: boolean;
}

/**
 * May this student ask, for this problem, right now?
 *
 * The effort gate is hint 2's, deliberately: the same threshold the product
 * already uses to decide somebody has tried. "Stuck" means having attempted
 * something, and an assistant reachable before the first read would teach
 * students to ask it instead of reading.
 */
export function aiHelperAccess(input: HelpInput & { enabled: boolean; askedToday: number; dailyPerStudent: number }): AiAccess {
  const no = (reason: string): AiAccess => ({ allowed: false, reason, marksAssisted: false });
  if (!input.enabled) return no(AI_REFUSALS.off);
  if (input.context !== "PRACTICE") return no(AI_REFUSALS.notPractice);

  const minutes = input.activeSeconds / 60;
  const tried = input.attempts >= 1 || minutes >= HINT_POLICY.tier2.activeMinutes;
  if (!tried && !input.solved) return no(AI_REFUSALS.tooEarly);

  if (input.askedToday >= input.dailyPerStudent) return no(AI_REFUSALS.dailyLimit);
  return { allowed: true, reason: null, marksAssisted: !input.solved };
}

// ── What the model is told ──────────────────────────────────────────────

export const AI_SYSTEM_PROMPT = [
  "You are a teaching assistant for REC Code, a practice platform for engineering students at Rajalakshmi Engineering College.",
  "",
  "A student is stuck on a practice problem and has asked for help. Your job is to teach, not to finish their work.",
  "",
  "Rules, in order of importance:",
  "1. NEVER write a complete solution, and never write more than three lines of code at once.",
  "2. Point at what is wrong, or at the idea they are missing, and let them write it.",
  "3. If their code has a specific bug, name the line and say what happens there — do not just rewrite it.",
  "4. If they have not started, describe the approach in plain words and name the technique.",
  "5. Be brief. Six sentences is plenty. They are mid-problem, not reading an article.",
  "6. Write in plain English for a second-year student. No jargon they have not met.",
  "7. You are not given the hidden tests and must not guess at them.",
  "",
  "End with one concrete next step they can take in their editor.",
].join("\n");

export interface AiPromptInput {
  readonly kind: AiAskKind;
  readonly problemTitle: string;
  readonly statement: string;
  readonly language: string;
  readonly source: string;
  /** The verdict of their own last judged run, when there was one. */
  readonly lastVerdict: string | null;
  /** The sample case their last run failed, if the product showed it to them. */
  readonly failedSample: { readonly input: string; readonly expected: string; readonly got: string } | null;
}

/** Trim to a budget on a line boundary, so the model never gets half a token of code. */
export function clipForModel(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf("\n");
  return `${lastBreak > max / 2 ? cut.slice(0, lastBreak) : cut}\n… (truncated)`;
}

/**
 * The user turn. Pure, so the exact bytes that leave the college are a thing
 * a test can assert — which is the only way a promise about what is sent
 * stays true.
 */
export function buildAiPrompt(input: AiPromptInput): string {
  const parts = [
    `Problem: ${input.problemTitle}`,
    "",
    "Statement:",
    clipForModel(input.statement, AI_STATEMENT_MAX_CHARS),
    "",
    `The student's code (${input.language}):`,
    "```",
    clipForModel(input.source, AI_SOURCE_MAX_CHARS) || "(they have written nothing yet)",
    "```",
  ];
  if (input.lastVerdict) parts.push("", `Their last judged submission: ${input.lastVerdict}`);
  if (input.failedSample) {
    parts.push(
      "",
      "A sample case they failed (the same one the product already shows them):",
      `input: ${clipForModel(input.failedSample.input, 500)}`,
      `expected: ${clipForModel(input.failedSample.expected, 500)}`,
      `their output: ${clipForModel(input.failedSample.got, 500)}`,
    );
  }
  parts.push(
    "",
    input.kind === "MISTAKE"
      ? "They asked: what is wrong with my code? Find the mistake and explain it. Do not rewrite their program."
      : "They asked: how should I approach this? Describe the idea and the technique. Do not write the solution.",
  );
  return parts.join("\n");
}
