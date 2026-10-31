import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, RateLimitError, UnauthorizedError } from "@/lib/errors";

/**
 * POST /api/drafts — the page-hide beacon. Auth and the database are
 * replaced by fakes; the route's own rules (cross-site refusal, body cap,
 * schema, error mapping) run for real.
 */

const fakes = vi.hoisted(() => ({
  user: { id: "user_1", role: "STUDENT" } as { id: string; role: string } | null,
  saves: [] as { userId: string; input: unknown }[],
  saveError: null as Error | null,
}));

vi.mock("@/lib/auth/guards", () => ({
  requireActionUser: async () => {
    if (!fakes.user) throw new UnauthorizedError();
    return fakes.user;
  },
}));

vi.mock("@/lib/drafts/server", () => ({
  saveServerDraft: async (userId: string, input: unknown) => {
    if (fakes.saveError) throw fakes.saveError;
    fakes.saves.push({ userId, input });
    return { saved: true };
  },
}));

const { POST } = await import("@/app/api/drafts/route");

const NOW = Date.now();
const body = { problemId: "cmg1abcd0000xyz", language: "py312", source: "print(1)\n", clientUpdatedAt: NOW };

function beacon(payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3100/api/drafts", {
    method: "POST",
    headers: {
      host: "localhost:3100",
      origin: "http://localhost:3100",
      "sec-fetch-site": "same-origin",
      "content-type": "text/plain;charset=UTF-8",
      ...headers,
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

beforeEach(() => {
  fakes.user = { id: "user_1", role: "STUDENT" };
  fakes.saves = [];
  fakes.saveError = null;
});

describe("POST /api/drafts", () => {
  it("saves a valid beacon for the SESSION user", async () => {
    const res = await POST(beacon({ ...body, userId: "someone_else" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true });
    expect(fakes.saves).toEqual([{ userId: "user_1", input: body }]);
  });

  it("accepts an application/json body too", async () => {
    const res = await POST(beacon(body, { "content-type": "application/json" }));
    expect(res.status).toBe(200);
  });

  it("refuses cross-site requests before anything else", async () => {
    fakes.user = null;
    const res = await POST(beacon(body, { "sec-fetch-site": "cross-site", origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(fakes.saves).toEqual([]);
  });

  it("requires a session", async () => {
    fakes.user = null;
    const res = await POST(beacon(body));
    expect(res.status).toBe(401);
    expect(fakes.saves).toEqual([]);
  });

  it("refuses a body over the cap, declared or streamed", async () => {
    const declared = await POST(beacon(body, { "content-length": String(3 * 1024 * 1024) }));
    expect(declared.status).toBe(413);
    const huge = JSON.stringify({ ...body, source: "x".repeat(2 * 1024 * 1024 + 10) });
    const streamed = await POST(beacon(huge));
    expect(streamed.status).toBe(413);
    expect(fakes.saves).toEqual([]);
  });

  it("refuses a source over 256 KB with 422 (the envelope fits, the source does not)", async () => {
    const res = await POST(beacon({ ...body, source: "x".repeat(256 * 1024 + 1) }));
    expect(res.status).toBe(422);
    expect(fakes.saves).toEqual([]);
  });

  it("refuses malformed bodies with 422", async () => {
    for (const payload of ["", "not json", "[]", { ...body, language: "cobol" }, { ...body, clientUpdatedAt: "now" }]) {
      const res = await POST(beacon(payload));
      expect(res.status).toBe(422);
    }
    expect(fakes.saves).toEqual([]);
  });

  it("maps a missing problem to 404 and the rate limit to 429", async () => {
    fakes.saveError = new NotFoundError();
    expect((await POST(beacon(body))).status).toBe(404);
    fakes.saveError = new RateLimitError();
    expect((await POST(beacon(body))).status).toBe(429);
  });

  it("hides unexpected errors behind a 500", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fakes.saveError = new Error("database exploded: secret detail");
    const res = await POST(beacon(body));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
    spy.mockRestore();
  });
});
