import { beforeEach, describe, expect, it, vi } from "vitest";
import { AI_HELPER_DEFAULT, AI_REFUSALS, type HelpContext } from "@recx/shared";

/**
 * The AI helper's server path with a fake database and a fake provider:
 * which asks are refused and in what order, what crosses the wire, what is
 * written down afterwards, and what the panel decides to draw.
 *
 * The practice-only rule is asserted here through the REAL chokepoint
 * (lib/help/access.ts over the fake db), not a stub of it — a test that
 * stubbed the chokepoint would pass over a build that had stopped calling
 * it.
 */

const NOW = new Date("2026-10-30T10:00:00.000Z");

const h = vi.hoisted(() => {
  const rows = {
    setting: null as null | { value: unknown },
    problem: null as null | { id: string; status: string; liveVersionId: string | null; editorialVisibleAt: Date | null },
    status: null as null | { status: string; attempts: number; failedAttempts: number },
    activity: null as null | { activeSeconds: number },
    draft: null as null | { language: string; source: string },
    submission: null as null | { id: string; verdict: string | null; firstFailedIndex: number | null },
    detail: null as null | { input: string | null; expected: string | null; stdout: string | null },
    asksToday: 0,
    assists: [] as { kind: string; answer: string | null; askedAt: Date; id: string }[],
  };
  const created: Record<string, unknown>[] = [];
  const env = { AI_API_KEY: "test-key-123456", AI_BASE_URL: undefined as string | undefined, AI_MODEL: undefined as string | undefined };
  const db = {
    platformSetting: { findUnique: vi.fn(async () => rows.setting) },
    problem: { findUnique: vi.fn(async () => rows.problem) },
    userProblemStatus: { findUnique: vi.fn(async () => rows.status) },
    problemActivity: { findUnique: vi.fn(async () => rows.activity) },
    problemVersion: {
      findUniqueOrThrow: vi.fn(async () => ({ title: "Two Sum", statementMd: "Return two indices." })),
    },
    codeDraft: { findFirst: vi.fn(async () => rows.draft) },
    submission: { findFirst: vi.fn(async () => rows.submission) },
    submissionTestDetail: { findUnique: vi.fn(async () => rows.detail) },
    aiAssist: {
      count: vi.fn(async () => rows.asksToday),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: "assist_1" };
      }),
      findMany: vi.fn(async () => rows.assists),
    },
  };
  return { rows, created, db, env };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/env", () => ({ env: () => h.env, isProduction: () => false }));

const { askAiHelperFor, AiUnavailableError } = await import("@/lib/ai/ask");
const { getAiPanelState } = await import("@/lib/ai/panel");
const { askProvider, AiProviderError } = await import("@/lib/ai/provider");
const { getAiHelperSetting, resolveAiRuntime } = await import("@/lib/ai/settings");

const USER = "user_1";
const PROBLEM = "prob_1";

function on(over: Record<string, unknown> = {}) {
  h.rows.setting = { value: { ...AI_HELPER_DEFAULT, enabled: true, dailyPerStudent: 3, ...over } };
}

/** A student who has made one judged attempt and not solved it. */
function tried() {
  h.rows.problem = { id: PROBLEM, status: "PUBLISHED", liveVersionId: "ver_live", editorialVisibleAt: null };
  h.rows.status = { status: "ATTEMPTED", attempts: 1, failedAttempts: 1 };
  h.rows.activity = { activeSeconds: 0 };
}

function answers(text: string) {
  return vi.fn(async () =>
    Response.json({ content: [{ type: "text", text }], usage: { input_tokens: 11, output_tokens: 22 } }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // cache() memoises per request; each test is its own.
  vi.resetModules();
  h.rows.setting = null;
  h.rows.problem = null;
  h.rows.status = null;
  h.rows.activity = null;
  h.rows.draft = { language: "cpp20", source: "int main(){}" };
  h.rows.submission = null;
  h.rows.detail = null;
  h.rows.asksToday = 0;
  h.rows.assists = [];
  h.created.length = 0;
  h.env.AI_API_KEY = "test-key-123456";
  h.env.AI_BASE_URL = undefined;
  h.env.AI_MODEL = undefined;
  globalThis.fetch = vi.fn(async () => {
    throw new Error("a test called the network");
  }) as unknown as typeof fetch;
});

describe("the setting", () => {
  it("is off when no row exists", async () => {
    expect(await getAiHelperSetting()).toEqual(AI_HELPER_DEFAULT);
  });
});

describe("refusals", () => {
  it("refuses when a super-admin has it switched off", async () => {
    h.rows.setting = { value: { ...AI_HELPER_DEFAULT, enabled: false } };
    tried();
    await expect(askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE")).rejects.toThrow(
      AI_REFUSALS.off,
    );
    expect(h.created).toEqual([]);
  });

  it("refuses when the deployment has no key, without saying which key", async () => {
    on();
    tried();
    h.env.AI_API_KEY = undefined as unknown as string;
    await expect(askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE")).rejects.toThrow(
      AI_REFUSALS.unconfigured,
    );
  });

  it("refuses in a contest and in an assessment", async () => {
    for (const context of ["CONTEST", "ASSESSMENT"] as HelpContext[]) {
      on();
      tried();
      await expect(askAiHelperFor(USER, { problemId: PROBLEM, kind: "APPROACH" }, context)).rejects.toThrow(
        AI_REFUSALS.notPractice,
      );
    }
    expect(h.created).toEqual([]);
  });

  it("refuses before a real go", async () => {
    on();
    h.rows.problem = { id: PROBLEM, status: "PUBLISHED", liveVersionId: "ver_live", editorialVisibleAt: null };
    h.rows.status = null;
    h.rows.activity = { activeSeconds: 60 };
    await expect(askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE")).rejects.toThrow(
      AI_REFUSALS.tooEarly,
    );
  });

  it("refuses past the daily allowance", async () => {
    on({ dailyPerStudent: 2 });
    tried();
    h.rows.asksToday = 2;
    await expect(askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE")).rejects.toThrow(
      AI_REFUSALS.dailyLimit,
    );
  });

  it("refuses an unpublished problem", async () => {
    on();
    h.rows.problem = { id: PROBLEM, status: "DRAFT", liveVersionId: "ver_live", editorialVisibleAt: null };
    await expect(askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE")).rejects.toThrow(
      "not available",
    );
  });

  it("refuses a client that tries to choose its own context", async () => {
    on();
    tried();
    await expect(
      askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE", context: "PRACTICE" }, "CONTEST"),
    ).rejects.toThrow();
  });

  it("refuses a client that tries to send its own code", async () => {
    on();
    tried();
    await expect(
      askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE", source: "print(1)" }, "PRACTICE"),
    ).rejects.toThrow();
  });

  it("refuses an unknown question kind", async () => {
    on();
    tried();
    await expect(askAiHelperFor(USER, { problemId: PROBLEM, kind: "SOLVE_IT" }, "PRACTICE")).rejects.toThrow();
  });
});

describe("an answered ask", () => {
  it("records what was asked and what it cost, and returns sanitised HTML", async () => {
    on();
    tried();
    globalThis.fetch = answers("Your loop is **off by one**.") as unknown as typeof fetch;

    const answer = await askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE");
    expect(answer.html).toContain("<strong>off by one</strong>");
    expect(answer.marksAssisted).toBe(true);
    expect(answer.remainingToday).toBe(2);

    expect(h.created).toHaveLength(1);
    const row = h.created[0]!;
    expect(row.failed).toBe(false);
    expect(row.context).toBe("PRACTICE");
    expect(row.kind).toBe("MISTAKE");
    expect(row.answer).toBe("Your loop is **off by one**.");
    expect(row.tokensIn).toBe(11);
    expect(row.tokensOut).toBe(22);
    expect(typeof row.latencyMs).toBe("number");
  });

  /**
   * Phase 15g, end to end: a model id this build has never heard of is what
   * the student's question is actually sent to, and what the record says
   * answered it. Nothing in between may substitute a model it recognises.
   */
  it("asks the model the super-admin named, even one this build does not know", async () => {
    on({ provider: "openai", modelId: "some-new-model-2026" });
    tried();
    const fetchImpl = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: "Look at line 4." } }], usage: { prompt_tokens: 7, completion_tokens: 9 } }),
    );
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const answer = await askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE");
    expect(answer.html).toContain("Look at line 4.");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((JSON.parse(String(init.body)) as { model: string }).model).toBe("some-new-model-2026");
    expect(h.created[0]?.modelId).toBe("some-new-model-2026");
  });

  it("stores the answer and not the student's code", async () => {
    on();
    tried();
    h.rows.draft = { language: "py312", source: "SECRET_DRAFT_MARKER = 1" };
    globalThis.fetch = answers("Try a hash map.") as unknown as typeof fetch;
    await askAiHelperFor(USER, { problemId: PROBLEM, kind: "APPROACH" }, "PRACTICE");
    expect(JSON.stringify(h.created)).not.toContain("SECRET_DRAFT_MARKER");
  });

  it("drops links a model emits", async () => {
    on();
    tried();
    globalThis.fetch = answers("See [this](https://example.invalid/x) and `fix()`.") as unknown as typeof fetch;
    const answer = await askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE");
    expect(answer.html).not.toContain("<a ");
    expect(answer.html).not.toContain("example.invalid");
    expect(answer.html).toContain("this");
    expect(answer.html).toContain("<code>fix()</code>");
  });

  it("does not mark a solved problem's first solve assisted", async () => {
    on();
    tried();
    h.rows.status = { status: "SOLVED", attempts: 3, failedAttempts: 1 };
    globalThis.fetch = answers("Here is why that works.") as unknown as typeof fetch;
    const answer = await askAiHelperFor(USER, { problemId: PROBLEM, kind: "APPROACH" }, "PRACTICE");
    expect(answer.marksAssisted).toBe(false);
  });

  it("sends the statement, the draft and the failed sample, and nothing about the student", async () => {
    on();
    tried();
    h.rows.submission = { id: "sub_1", verdict: "WA", firstFailedIndex: 0 };
    h.rows.detail = { input: "1 2", expected: "3", stdout: "4" };
    const fetchMock = answers("ok");
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(init.body)) as { model: string; messages: { content: string }[]; system: string };
    expect(body.model).toBe("claude-sonnet-5-5");
    const sent = body.messages[0]!.content;
    expect(sent).toContain("Return two indices.");
    expect(sent).toContain("int main(){}");
    expect(sent).toContain("expected: 3");
    expect(sent).not.toContain(USER);
    expect(body.system).toContain("NEVER write a complete solution");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key-123456");
  });

  it("never asks for a hidden test case", async () => {
    on();
    tried();
    // A submission that failed on a NON-sample index has no detail row.
    h.rows.submission = { id: "sub_1", verdict: "WA", firstFailedIndex: 7 };
    h.rows.detail = null;
    const fetchMock = answers("ok");
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE");
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      messages: { content: string }[];
    };
    expect(body.messages[0]!.content).not.toContain("A sample case they failed");
  });
});

describe("a failed ask", () => {
  it("is recorded with no answer, costs no quota, and tells the student to try again", async () => {
    on();
    tried();
    globalThis.fetch = vi.fn(async () => new Response("upstream on fire", { status: 503 })) as unknown as typeof fetch;

    await expect(askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE")).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.failed).toBe(true);
    expect(h.created[0]!.answer).toBeNull();
  });

  it("never quotes the provider's body back", async () => {
    on();
    tried();
    globalThis.fetch = vi.fn(
      async () => new Response("your prompt was: int main(){}", { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(askAiHelperFor(USER, { problemId: PROBLEM, kind: "MISTAKE" }, "PRACTICE")).rejects.toThrow(
      AI_REFUSALS.unavailable,
    );
  });
});

describe("the provider", () => {
  const model = { id: "claude-sonnet-5-5", provider: "anthropic" as const, baseUrl: null, label: "x" };
  const custom = {
    id: "rec-coder-7b",
    provider: "openai-compatible" as const,
    baseUrl: "https://ai.rec.invalid/v1/",
    label: "x",
  };

  it("reads an Anthropic answer and its usage", async () => {
    const fetchImpl = answers("hello") as unknown as typeof fetch;
    const out = await askProvider({ model, system: "s", prompt: "p", maxOutputTokens: 300, fetchImpl });
    expect(out).toEqual({ text: "hello", tokensIn: 11, tokensOut: 22 });
  });

  it("posts an OpenAI-compatible request when the college hosts the model", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: " use two pointers " } }], usage: { prompt_tokens: 5 } }),
    );
    const out = await askProvider({
      model: custom,
      system: "s",
      prompt: "p",
      maxOutputTokens: 300,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.text).toBe("use two pointers");
    expect(out.tokensIn).toBe(5);
    expect(out.tokensOut).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // One slash, not two: the base URL's trailing one is dropped.
    expect(url).toBe("https://ai.rec.invalid/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key-123456");
  });

  it("refuses an OpenAI-compatible target with no address, rather than guessing one", async () => {
    await expect(
      askProvider({
        model: { ...custom, baseUrl: null },
        system: "s",
        prompt: "p",
        maxOutputTokens: 300,
        fetchImpl: answers("x") as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(AiProviderError);
  });

  /**
   * Phase 15g. The field that caps the answer is not the same on OpenAI's
   * own API as on the servers that imitate it, and sending the wrong one is
   * a 400 rather than a long answer: api.openai.com refuses `max_tokens`
   * for its current models, and vLLM, Ollama and llama.cpp have mostly
   * never heard of `max_completion_tokens`. So the field follows the host.
   */
  it("caps the answer with the field the host understands", async () => {
    const posted = async (target: Parameters<typeof askProvider>[0]["model"]) => {
      const fetchImpl = vi.fn(async () => Response.json({ choices: [{ message: { content: "ok" } }] }));
      await askProvider({
        model: target,
        system: "s",
        prompt: "p",
        maxOutputTokens: 321,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    };

    const openai = await posted({ id: "gpt-5.1-2026-02-01", provider: "openai", baseUrl: null, label: "x" });
    expect(openai.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(openai.body.max_completion_tokens).toBe(321);
    expect(openai.body.max_tokens).toBeUndefined();
    expect(openai.body.model).toBe("gpt-5.1-2026-02-01");

    const hosted = await posted(custom);
    expect(hosted.url).toBe("https://ai.rec.invalid/v1/chat/completions");
    expect(hosted.body.max_tokens).toBe(321);
    expect(hosted.body.max_completion_tokens).toBeUndefined();
  });

  it("reads a reply that arrives as content parts rather than a string", async () => {
    // Some gateways answer this way. Telling a student the assistant is
    // broken when it answered is the worst of the available mistakes.
    const out = await askProvider({
      model: custom,
      system: "s",
      prompt: "p",
      maxOutputTokens: 300,
      fetchImpl: (async () =>
        Response.json({
          choices: [{ message: { content: [{ type: "text", text: " use two " }, { type: "text", text: "pointers " }] } }],
        })) as unknown as typeof fetch,
    });
    expect(out.text).toBe("use two pointers");
  });

  it("reports a timeout as a timeout and an error status as a status", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    await expect(
      askProvider({
        model,
        system: "s",
        prompt: "p",
        maxOutputTokens: 300,
        fetchImpl: (async () => {
          throw timeout;
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("timeout");

    await expect(
      askProvider({
        model,
        system: "s",
        prompt: "p",
        maxOutputTokens: 300,
        fetchImpl: (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("http 429");
  });

  it("refuses an empty answer rather than storing one", async () => {
    await expect(
      askProvider({
        model,
        system: "s",
        prompt: "p",
        maxOutputTokens: 300,
        fetchImpl: (async () => Response.json({ content: [{ type: "text", text: "   " }] })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow("empty");
  });
});

/**
 * Phase 15g: the super-admin names the model, the deployment owns the key
 * and the addresses, and this is where the two have to add up to something
 * askable. Every way they fail to ends in one sentence and a null model, so
 * a helper that cannot answer reads as off rather than failing at a student.
 */
describe("what the chosen model resolves to", () => {
  const setting = (over: Record<string, unknown> = {}) => ({ ...AI_HELPER_DEFAULT, enabled: true, ...over });
  const deployment = (over: Record<string, unknown> = {}) => ({
    hasKey: true,
    endpoints: [] as readonly string[],
    defaultModelId: "",
    ...over,
  });

  it("sends a named model straight to its provider", () => {
    const runtime = resolveAiRuntime(setting({ provider: "openai", modelId: "gpt-5.1-2026-02-01" }), deployment());
    expect(runtime.misconfiguration).toBeNull();
    expect(runtime.model).toEqual({
      provider: "openai",
      id: "gpt-5.1-2026-02-01",
      baseUrl: null,
      label: "gpt-5.1-2026-02-01",
    });
  });

  it("uses the deployment's first address when the super-admin picked none", () => {
    const runtime = resolveAiRuntime(
      setting({ provider: "openai-compatible", modelId: "rec-coder-7b" }),
      deployment({ endpoints: ["https://a.invalid/v1", "https://b.invalid/v1"] }),
    );
    expect(runtime.model?.baseUrl).toBe("https://a.invalid/v1");
  });

  it("uses the address they picked, when it is one the deployment allows", () => {
    const runtime = resolveAiRuntime(
      setting({ provider: "openai-compatible", modelId: "rec-coder-7b", baseUrl: "https://b.invalid/v1" }),
      deployment({ endpoints: ["https://a.invalid/v1", "https://b.invalid/v1"] }),
    );
    expect(runtime.model?.baseUrl).toBe("https://b.invalid/v1");
  });

  /**
   * The security line, and the reason the address is not a text field: a
   * stolen super-admin session must not be able to point the assistant —
   * and with it the college's key and five thousand students' drafts — at a
   * host nobody named.
   */
  it("refuses an address the deployment never named", () => {
    const runtime = resolveAiRuntime(
      setting({ provider: "openai-compatible", modelId: "x-1", baseUrl: "https://evil.invalid/v1" }),
      deployment({ endpoints: ["https://a.invalid/v1"] }),
    );
    expect(runtime.model).toBeNull();
    expect(runtime.misconfiguration).toContain("not one this deployment allows");
  });

  it("says so when an OpenAI-compatible endpoint has no address at all", () => {
    const runtime = resolveAiRuntime(setting({ provider: "openai-compatible", modelId: "x-1" }), deployment());
    expect(runtime.model).toBeNull();
    expect(runtime.misconfiguration).toContain("AI_BASE_URL");
  });

  it("falls back to the deployment's model only where the deployment names the host", () => {
    const hosted = resolveAiRuntime(
      setting({ provider: "openai-compatible", modelId: "" }),
      deployment({ endpoints: ["https://a.invalid/v1"], defaultModelId: "rec-coder-7b" }),
    );
    expect(hosted.model?.id).toBe("rec-coder-7b");

    const nothing = resolveAiRuntime(
      setting({ provider: "openai-compatible", modelId: "" }),
      deployment({ endpoints: ["https://a.invalid/v1"] }),
    );
    expect(nothing.model).toBeNull();
    expect(nothing.misconfiguration).toContain("AI_MODEL");

    const named = resolveAiRuntime(setting({ provider: "anthropic", modelId: "" }), deployment({ defaultModelId: "rec-coder-7b" }));
    expect(named.model).toBeNull();
    expect(named.misconfiguration).toContain("No model is named");
  });

  it("reads as unanswerable without a key, whatever else is right", () => {
    const runtime = resolveAiRuntime(setting(), deployment({ hasKey: false }));
    expect(runtime.model).toBeNull();
    expect(runtime.misconfiguration).toContain("No API key");
  });
});

describe("the panel", () => {
  it("draws nothing outside practice, or when the helper is off or unconfigured", async () => {
    on();
    tried();
    expect(await getAiPanelState(USER, PROBLEM, "CONTEST")).toBeNull();
    expect(await getAiPanelState(USER, PROBLEM, "ASSESSMENT")).toBeNull();

    h.rows.setting = { value: { ...AI_HELPER_DEFAULT, enabled: false } };
    expect(await getAiPanelState(USER, PROBLEM, "PRACTICE")).toBeNull();

    on();
    h.env.AI_API_KEY = undefined as unknown as string;
    expect(await getAiPanelState(USER, PROBLEM, "PRACTICE")).toBeNull();
  });

  it("draws the lock and its reason in practice, with today's answers", async () => {
    on({ dailyPerStudent: 4 });
    h.rows.problem = { id: PROBLEM, status: "PUBLISHED", liveVersionId: "ver_live", editorialVisibleAt: null };
    h.rows.status = null;
    h.rows.activity = { activeSeconds: 0 };
    h.rows.assists = [{ id: "a1", kind: "MISTAKE", answer: "Look at line 4.", askedAt: NOW }];

    const state = await getAiPanelState(USER, PROBLEM, "PRACTICE");
    expect(state).not.toBeNull();
    expect(state!.allowed).toBe(false);
    expect(state!.refusal).toBe(AI_REFUSALS.tooEarly);
    expect(state!.remainingToday).toBe(4);
    expect(state!.answers[0]!.html).toContain("Look at line 4.");
  });

  it("counts the allowance down and never below zero", async () => {
    on({ dailyPerStudent: 2 });
    tried();
    h.rows.asksToday = 5;
    const state = await getAiPanelState(USER, PROBLEM, "PRACTICE");
    expect(state!.remainingToday).toBe(0);
    expect(state!.allowed).toBe(false);
  });
});
