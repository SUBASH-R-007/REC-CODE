import "server-only";
import { AI_TIMEOUT_MS, type AiModelChoice } from "@recx/shared";
import { env } from "@/lib/env";

/**
 * The one place a student's code leaves this server.
 *
 * Deliberately a hand-written fetch rather than a vendor SDK: this is two
 * POSTs, and a dependency that can read the environment, retry on its own
 * schedule and phone home with telemetry is a poor trade for saving twenty
 * lines — on the one call in the product that carries a student's work to a
 * third party.
 *
 * Nothing here logs the prompt, the answer or the key. A failure is reported
 * by shape (`timeout`, `http 429`), never by body: a provider error body can
 * echo the request, and the request is the student's program.
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

interface AskOptions {
  readonly model: AiModelChoice;
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
  const request =
    options.model.provider === "anthropic"
      ? anthropicRequest(options, key)
      : openAiCompatibleRequest(options, key, e.AI_BASE_URL, e.AI_MODEL);

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

function openAiCompatibleRequest(
  options: AskOptions,
  key: string,
  baseUrl: string | undefined,
  modelName: string | undefined,
): ProviderRequest {
  if (!baseUrl || !modelName) throw new AiProviderError("the college-hosted model is not configured");
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: {
      model: modelName,
      max_tokens: options.maxOutputTokens,
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
      const raw = body.choices?.[0]?.message?.content;
      return {
        text: typeof raw === "string" ? raw.trim() : "",
        tokensIn: intOrNull(body.usage?.prompt_tokens),
        tokensOut: intOrNull(body.usage?.completion_tokens),
      };
    },
  };
}

function intOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
