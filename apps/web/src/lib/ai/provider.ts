import "server-only";
import { AI_TIMEOUT_MS, type AiModelTarget } from "@recx/shared";
import { env } from "@/lib/env";

/**
 * The one place a student's code leaves this server.
 *
 * Deliberately a hand-written fetch rather than a vendor SDK: this is one
 * POST, and a dependency that can read the environment, retry on its own
 * schedule and phone home with telemetry is a poor trade for saving twenty
 * lines — on the one call in the product that carries a student's work to a
 * third party. Three wire formats are three small functions here; three
 * SDKs would be three supply chains.
 *
 * Nothing here logs the prompt, the answer or the key. A failure is reported
 * by shape (`timeout`, `http 429`), never by body: a provider error body can
 * echo the request, and the request is the student's program.
 *
 * WHICH model and WHICH host are not decided here. `lib/ai/settings.ts`
 * resolves both from the super-admin's setting and the deployment's
 * environment, and hands this an `AiModelTarget`; this module can only post
 * where it is told. That split is what lets a super-admin name any model
 * freely (Phase 15g) while the set of reachable hosts stays the
 * deployment's.
 */

export interface AiCompletion {
  readonly text: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
}

export class AiProviderError extends Error {
  constructor(reason: string) {
    super(`The AI provider did not answer: ${reason}.`);
    this.name = "AiProviderError";
  }
}

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

export interface AskOptions {
  readonly model: AiModelTarget;
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  /** Injected by tests; the real one is global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export async function askProvider(options: AskOptions): Promise<AiCompletion> {
  const e = env();
  const key = e.AI_API_KEY;
  if (!key) throw new AiProviderError("no API key is configured");

  const doFetch = options.fetchImpl ?? fetch;
  const request = buildRequest(options, key);

  let response: Response;
  try {
    response = await doFetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    throw new AiProviderError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "the request failed");
  }

  if (!response.ok) {
    // The status, and nothing else. See the header.
    throw new AiProviderError(`http ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AiProviderError("the answer was not JSON");
  }

  const completion = request.parse(payload);
  if (!completion.text.trim()) throw new AiProviderError("the answer was empty");
  return completion;
}

interface ProviderRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly parse: (payload: unknown) => AiCompletion;
}

function buildRequest(options: AskOptions, key: string): ProviderRequest {
  switch (options.model.provider) {
    case "anthropic":
      return anthropicRequest(options, key);
    /**
     * OpenAI's own API and anything that imitates it differ on one field,
     * and it is not cosmetic: api.openai.com refuses `max_tokens` for its
     * current models and wants `max_completion_tokens`, while the servers a
     * college actually runs — vLLM, Ollama, llama.cpp, most gateways — know
     * `max_tokens` and many have never heard of the other. Sending both
     * would 400 on the stricter of them. So the field follows the host.
     */
    case "openai":
      return chatCompletionsRequest(options, key, OPENAI_ENDPOINT, "max_completion_tokens");
    case "openai-compatible": {
      const base = options.model.baseUrl;
      if (!base) throw new AiProviderError("the OpenAI-compatible endpoint has no address");
      return chatCompletionsRequest(options, key, `${base.replace(/\/+$/, "")}/chat/completions`, "max_tokens");
    }
  }
}

function anthropicRequest(options: AskOptions, key: string): ProviderRequest {
  return {
    url: ANTHROPIC_ENDPOINT,
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: {
      model: options.model.id,
      max_tokens: options.maxOutputTokens,
      system: options.system,
      messages: [{ role: "user", content: options.prompt }],
    },
    parse: (payload) => {
      const body = payload as {
        content?: { type?: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (body.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("")
        .trim();
      return { text, tokensIn: intOrNull(body.usage?.input_tokens), tokensOut: intOrNull(body.usage?.output_tokens) };
    },
  };
}

function chatCompletionsRequest(
  options: AskOptions,
  key: string,
  url: string,
  tokenField: "max_tokens" | "max_completion_tokens",
): ProviderRequest {
  return {
    url,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: {
      model: options.model.id,
      [tokenField]: options.maxOutputTokens,
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: options.prompt },
      ],
    },
    parse: (payload) => {
      const body = payload as {
        choices?: { message?: { content?: unknown } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        text: contentText(body.choices?.[0]?.message?.content),
        tokensIn: intOrNull(body.usage?.prompt_tokens),
        tokensOut: intOrNull(body.usage?.completion_tokens),
      };
    },
  };
}

/**
 * A chat message's content. A string on OpenAI and on most of what imitates
 * it, and an array of parts on some gateways — which is worth reading rather
 * than discarding, because the alternative is telling a student the
 * assistant is broken when it answered.
 */
function contentText(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown })?.text === "string" ? ((part as { text: string }).text) : ""))
      .join("")
      .trim();
  }
  return "";
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
