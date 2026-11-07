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
 * How a model is reached, and which one (Phase 15g).
 *
 * This began as a closed catalogue of four ids, on the reasoning that the id
 * reaches an external API and "whatever somebody typed" is not a thing to
 * send to one. That was the wrong line to draw. A list of model names is
 * stale the week after it ships: a college that buys a newer model, or runs
 * one of its own, had to wait for a deploy to use it — and the one escape
 * hatch could not even name its model without an environment variable.
 *
 * So the choice is now split. A super-admin picks the WIRE FORMAT from a
 * closed set, because there has to be code that speaks it, and then names
 * the model freely. Two things stay the deployment's rather than theirs, and
 * both for the same reason — they are where the college's API key and a
 * student's draft would go:
 *
 *   * the key itself (`AI_API_KEY`), as before;
 *   * which HOSTS may be reached. `AI_BASE_URL` may now name several,
 *     comma-separated, and a super-admin picks among them — so adding a
 *     vendor is one line of deployment config instead of a code change,
 *     while a compromised super-admin account still cannot post the key and
 *     five thousand students' drafts to a host nobody named.
 */
export const AI_PROVIDERS = ["anthropic", "openai", "openai-compatible"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABEL: Readonly<Record<AiProvider, string>> = Object.freeze({
  anthropic: "Anthropic",
  openai: "OpenAI",
  "openai-compatible": "OpenAI-compatible endpoint",
});

export const AI_PROVIDER_NOTE: Readonly<Record<AiProvider, string>> = Object.freeze({
  anthropic: "Anthropic's own hosted API. Any Claude model the key can reach.",
  openai: "OpenAI's own hosted API. Any chat model the key can reach.",
  "openai-compatible":
    "Anything that speaks OpenAI's chat-completions API: a model the college hosts (vLLM, Ollama, llama.cpp), a gateway, or another vendor's compatible endpoint. The deployment names the address in AI_BASE_URL.",
});

/** True when this provider's address comes from the deployment, not from code. */
export function aiProviderNeedsEndpoint(provider: AiProvider): boolean {
  return provider === "openai-compatible";
}

/**
 * A model id is free text, and not arbitrary text.
 *
 * It is interpolated into a JSON body posted to a third party, so its SHAPE
 * is fixed where its vocabulary is not: alphanumeric segments joined by
 * `.`, `_`, `-`, `:` or `/`. That covers every id these providers publish —
 * `claude-sonnet-5-5`, `gpt-5.1-2026-02-01`,
 * `meta-llama/Llama-3.3-70B-Instruct`, `qwen2.5-coder:32b` — and admits
 * nothing that could be a URL, a header, a newline or a path traversal.
 */
export const AI_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/;
export const AI_MODEL_ID_MAX = 120;
export const AI_MODEL_ID_MESSAGE =
  "A model id is letters, digits and . _ - : / — as the provider publishes it, for example claude-sonnet-5-5 or meta-llama/Llama-3.3-70B-Instruct.";

export const aiModelIdSchema = z
  .string()
  .trim()
  .min(2, AI_MODEL_ID_MESSAGE)
  .max(AI_MODEL_ID_MAX, `A model id is at most ${AI_MODEL_ID_MAX} characters.`)
  .regex(AI_MODEL_ID_PATTERN, AI_MODEL_ID_MESSAGE);

/**
 * Suggestions, not a gate: one click for the ordinary choice, with the field
 * still free underneath. Only ids this project can name accurately are
 * listed — a preset pointing at a model the vendor has retired is worse than
 * no preset at all, because it reads as a recommendation.
 */
export interface AiModelPreset {
  readonly provider: AiProvider;
  readonly modelId: string;
  readonly label: string;
  readonly description: string;
}

export const AI_MODEL_PRESETS: readonly AiModelPreset[] = Object.freeze([
  {
    provider: "anthropic",
    modelId: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    description: "The usual choice: the strongest answers for the price, and good at reading a half-finished program.",
  },
  {
    provider: "anthropic",
    modelId: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    description: "Slower and dearer. Worth it only if Sonnet's explanations are missing things.",
  },
  {
    provider: "anthropic",
    modelId: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    description: "Fastest and cheapest. A sensible choice during a busy practice week.",
  },
]);

export function aiModelPreset(provider: AiProvider, modelId: string): AiModelPreset | null {
  return AI_MODEL_PRESETS.find((p) => p.provider === provider && p.modelId === modelId) ?? null;
}

/** How a chosen model reads back to a human: the preset's name, or the id itself. */
export function aiModelLabel(choice: { readonly provider: AiProvider; readonly modelId: string }): string {
  const preset = aiModelPreset(choice.provider, choice.modelId);
  if (preset) return preset.label;
  if (choice.modelId) return choice.modelId;
  return `${AI_PROVIDER_LABEL[choice.provider]} — the model the deployment names`;
}

/**
 * The addresses a deployment allows, parsed from `AI_BASE_URL`: one URL, or
 * several separated by commas.
 *
 * https only, with loopback allowed so that a college-hosted model on the
 * same box — and this project's own integration test — can be reached. An
 * entry that is not a URL, or is plain http somewhere else, is dropped
 * rather than refused: the deployment should not be able to half-break the
 * assistant with a typo in a list.
 */
export function aiAllowedEndpoints(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const kept = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && !AI_LOOPBACK_HOSTS.includes(url.hostname)) continue;
    kept.add(trimmed);
  }
  return [...kept];
}

const AI_LOOPBACK_HOSTS: readonly string[] = Object.freeze(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * A model the provider layer can actually be asked for: the wire format, the
 * id to put in the body, and — where the deployment names the host rather
 * than the code — the address to post to.
 *
 * Resolved from the setting plus the environment by `lib/ai/settings.ts`,
 * which is the only place that reads the environment. Kept here so that the
 * provider and the resolver agree on the shape without the provider
 * importing anything that can reach the database.
 */
export interface AiModelTarget {
  readonly provider: AiProvider;
  readonly id: string;
  /** Null when the endpoint is fixed in code (anthropic, openai). */
  readonly baseUrl: string | null;
  /** For a super-admin's screen and nothing else. */
  readonly label: string;
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
    provider: z.enum(AI_PROVIDERS),
    /**
     * The model, as the provider publishes it. Empty is allowed and means
     * "the one the deployment names" (`AI_MODEL`), which is how a
     * college-hosted endpoint was configured before this was a field at
     * all; `lib/ai/settings.ts` decides whether that is enough to answer.
     */
    modelId: z.union([z.literal(""), aiModelIdSchema]),
    /**
     * Which of the deployment's allowed addresses to use. Empty means the
     * first, which is every single-endpoint deployment. An address that is
     * not on the list is refused at resolution rather than here, because
     * the list lives in the environment and this schema is pure.
     */
    baseUrl: z.union([z.literal(""), z.string().trim().url()]),
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
  provider: "anthropic",
  modelId: "claude-sonnet-5-5",
  baseUrl: "",
  dailyPerStudent: AI_DAILY_LIMIT.default,
  maxOutputTokens: AI_OUTPUT_MAX_TOKENS.default,
});

/**
 * The shape this setting had before Phase 15g: one `modelId` out of a closed
 * list of four, where `custom` meant the college-hosted endpoint.
 *
 * Read forward rather than discarded. Falling back to the default would be
 * SAFE — the default is off — but it would also silently switch off a
 * working assistant on the deploy that widened the field, and leave a
 * super-admin to work out why from a page showing settings they never
 * chose. A row written by the old code says exactly what was meant.
 */
const legacySettingSchema = z
  .object({
    enabled: z.boolean(),
    modelId: z.string(),
    dailyPerStudent: z.number().int().min(AI_DAILY_LIMIT.min).max(AI_DAILY_LIMIT.max),
    maxOutputTokens: z.number().int().min(AI_OUTPUT_MAX_TOKENS.min).max(AI_OUTPUT_MAX_TOKENS.max),
  })
  .strict();

function upgradeLegacySetting(value: unknown): unknown {
  const parsed = legacySettingSchema.safeParse(value);
  if (!parsed.success) return null;
  const { modelId, ...rest } = parsed.data;
  // `custom` named no model of its own: the deployment's AI_MODEL did.
  if (modelId === "custom") return { ...rest, provider: "openai-compatible", modelId: "", baseUrl: "" };
  if (AI_MODEL_ID_PATTERN.test(modelId)) return { ...rest, provider: "anthropic", modelId, baseUrl: "" };
  return null;
}

export function effectiveAiHelperSetting(value: unknown): AiHelperSetting {
  const parsed = aiHelperSettingSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const upgraded = aiHelperSettingSchema.safeParse(upgradeLegacySetting(value));
  return upgraded.success ? upgraded.data : AI_HELPER_DEFAULT;
}

/**
 * The reachability check behind the Test button on /super/settings/ai.
 *
 * A free-text model id is only usable if a super-admin can find out whether
 * it works before five thousand students do, so the page can ask the model
 * one fixed question and show what came back. These two strings are that
 * question, and they are CONSTANTS on purpose: the check reaches a third
 * party, and the one thing that must be impossible is for it to carry a
 * student's code there. `tests/repo/ai-helper-posture.test.ts` holds the
 * test path to sending exactly these.
 */
export const AI_PROBE_SYSTEM =
  "You are being checked for reachability by a college practice platform. Answer in one short sentence.";
export const AI_PROBE_PROMPT =
  "This is a configuration check, not a question from a student. Reply with one short sentence confirming you can read this, and nothing else.";
/** Enough for a sentence; a probe should never cost more than one. */
export const AI_PROBE_MAX_TOKENS = 64;
/** How much of the reply a super-admin is shown. */
export const AI_PROBE_REPLY_CHARS = 400;

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
