import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The provider against a REAL HTTP server (Phase 15g).
 *
 * Everything else about this path is tested with a fake `fetch`, which is
 * the right tool for the refusals, the recording and the prompt bytes — and
 * it leaves one thing permanently unproven, which `docs/OPEN-QUESTIONS.md`
 * named at Phase 12b and called NOT RUN: that a response arriving over a
 * socket parses as this code expects, and that what this code puts ON the
 * socket is what a provider is owed.
 *
 * So this file starts a server on loopback that answers in an
 * OpenAI-compatible shape, points a target at it, and uses the real global
 * `fetch`. No key, no vendor and no network: the half that is this
 * project's responsibility is the half that can be checked, and it is
 * checked here in every run rather than by hand.
 *
 * What the server asserts from the outside — the model id, the token-cap
 * field, two message turns, a bearer scheme — is the request shape a
 * super-admin's free-text choice turns into (Phase 15g). What the test
 * asserts is that each answer, and each way of failing to answer, comes
 * back as the one sentence the product shows.
 */

const h = vi.hoisted(() => ({
  // A value this test invents, for a server this test runs. Long enough to
  // satisfy the env schema and meaningless anywhere else.
  env: { AI_API_KEY: "local-loopback-probe", AI_BASE_URL: undefined as string | undefined, AI_MODEL: undefined as string | undefined },
}));

vi.mock("@/lib/env", () => ({ env: () => h.env, isProduction: () => false }));

const { askProvider, AiProviderError } = await import("@/lib/ai/provider");

interface Seen {
  method: string;
  url: string;
  authScheme: string;
  contentType: string;
  body: Record<string, unknown>;
}

const seen: Seen[] = [];
let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const auth = String(req.headers.authorization ?? "");
      seen.push({
        method: String(req.method),
        url: String(req.url),
        // The scheme only. The value is never recorded, here or anywhere.
        authScheme: auth.split(" ")[0] ?? "",
        contentType: String(req.headers["content-type"] ?? ""),
        body,
      });

      const path = String(req.url);
      if (path.startsWith("/busy")) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "slow down" } }));
        return;
      }
      if (path.startsWith("/html")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>a proxy sat in the way</html>");
        return;
      }
      if (path.startsWith("/empty")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "   " } }] }));
        return;
      }
      if (path.startsWith("/parts")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: [{ type: "text", text: "line 4 " }, { type: "text", text: "is the bug" }] } }],
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "Look at line 4." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 41, completion_tokens: 9, total_tokens: 50 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen.length = 0;
});

/** A college-hosted target, as `resolveAiRuntime` would hand one over. */
const target = (path = "/v1") => ({
  id: "qwen2.5-coder:32b",
  provider: "openai-compatible" as const,
  baseUrl: `${origin}${path}`,
  label: "qwen2.5-coder:32b",
});

describe("the provider over a real socket", () => {
  it("posts what a provider is owed, and reads back what it answered", async () => {
    const completion = await askProvider({
      model: target(),
      system: "You are a teaching assistant.",
      prompt: "What is wrong with my code?",
      maxOutputTokens: 700,
    });

    expect(completion).toEqual({ text: "Look at line 4.", tokensIn: 41, tokensOut: 9 });

    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/chat/completions");
    expect(request.contentType).toBe("application/json");
    expect(request.authScheme).toBe("Bearer");
    // The model the super-admin typed, not one this build knows.
    expect(request.body.model).toBe("qwen2.5-coder:32b");
    expect(request.body.max_tokens).toBe(700);
    expect(request.body.max_completion_tokens).toBeUndefined();
    const messages = request.body.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0]!.content).toContain("teaching assistant");
    expect(messages[1]!.content).toContain("What is wrong with my code?");
  });

  it("reports a provider's status and nothing from its body", async () => {
    await expect(
      askProvider({ model: target("/busy/v1"), system: "s", prompt: "p", maxOutputTokens: 700 }),
    ).rejects.toThrow("http 429");
    // The body said "slow down". A provider's error body can echo the
    // request, and the request is the student's program, so none of it is
    // carried out of here.
    await expect(
      askProvider({ model: target("/busy/v1"), system: "s", prompt: "p", maxOutputTokens: 700 }),
    ).rejects.not.toThrow(/slow down/);
  });

  it("says so when something in the way answers with a page instead of JSON", async () => {
    // A captive portal, a proxy, an endpoint that is not a model: all land
    // here, and all read the same way to a student.
    const error = await askProvider({ model: target("/html/v1"), system: "s", prompt: "p", maxOutputTokens: 700 }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AiProviderError);
    expect(String(error)).toContain("not JSON");
  });

  it("refuses an answer that arrived empty rather than storing one", async () => {
    await expect(
      askProvider({ model: target("/empty/v1"), system: "s", prompt: "p", maxOutputTokens: 700 }),
    ).rejects.toThrow("empty");
  });

  it("joins a reply that arrives as content parts", async () => {
    const completion = await askProvider({
      model: target("/parts/v1"),
      system: "s",
      prompt: "p",
      maxOutputTokens: 700,
    });
    expect(completion.text).toBe("line 4 is the bug");
    expect(completion.tokensIn).toBeNull();
  });

  it("reports a refused connection as a failure, not as a crash", async () => {
    // Nothing is listening on this port: the address is well formed and the
    // host is right, which is what a mistyped port in AI_BASE_URL looks
    // like. A super-admin sees a sentence; a student never gets this far.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const error = await askProvider({
      model: { ...target(), baseUrl: `http://127.0.0.1:${port}/v1` },
      system: "s",
      prompt: "p",
      maxOutputTokens: 700,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(String(error)).toContain("the request failed");
  });

  /**
   * What this file deliberately does NOT claim. The `anthropic` and `openai`
   * providers post to endpoints fixed in code, so they cannot be pointed at
   * this server, and nobody here has a key for either. Their request shape —
   * including the one difference that matters, `max_tokens` against
   * `max_completion_tokens` — is held by `ai-helper.test.ts` with a fake
   * fetch, and whether those two live APIs answer as this code expects is
   * still unproven. `docs/OPEN-QUESTIONS.md` says so in those words.
   */
  it("covers the one provider whose address a deployment owns", () => {
    expect(target().provider).toBe("openai-compatible");
  });
});
