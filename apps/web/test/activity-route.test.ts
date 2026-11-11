import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/activity with the recorder stubbed: same-origin only, cookie
 * session required, strict zod body (JSON from fetch or text from
 * sendBeacon), and each recorder outcome mapped to its status code.
 */

const h = vi.hoisted(() => ({
  user: { id: "user_1" } as { id: string } | null,
  requireActionUser: vi.fn(),
  recordActivityPing: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({ requireActionUser: h.requireActionUser }));
vi.mock("@/lib/help/activity", () => ({ recordActivityPing: h.recordActivityPing }));

const { UnauthorizedError } = await import("@/lib/errors");
const { POST } = await import("@/app/api/activity/route");
const { isSameOrigin } = await import("@/lib/help/same-origin");

const PROBLEM = "cmg1problem0000000000001";

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3100/api/activity", {
    method: "POST",
    headers: { host: "localhost:3100", "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.user = { id: "user_1" };
  h.requireActionUser.mockImplementation(async () => {
    if (!h.user) throw new UnauthorizedError();
    return h.user;
  });
  h.recordActivityPing.mockResolvedValue({ status: "accepted", credited: 30, activeSeconds: 630 });
});

describe("POST /api/activity", () => {
  it("credits a ping for the signed-in user", async () => {
    const response = await POST(request({ problemId: PROBLEM, seconds: 30 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ credited: 30, activeSeconds: 630 });
    expect(h.recordActivityPing).toHaveBeenCalledWith({ userId: "user_1", problemId: PROBLEM, seconds: 30 });
  });

  it("accepts sendBeacon's text/plain body", async () => {
    const response = await POST(
      request(JSON.stringify({ problemId: PROBLEM, seconds: 12 }), { "content-type": "text/plain;charset=UTF-8" }),
    );
    expect(response.status).toBe(200);
    expect(h.recordActivityPing).toHaveBeenCalledWith({ userId: "user_1", problemId: PROBLEM, seconds: 12 });
  });

  it("refuses a cross-site request before looking at the session", async () => {
    const response = await POST(request({ problemId: PROBLEM, seconds: 30 }, { "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(403);
    expect(h.requireActionUser).not.toHaveBeenCalled();
    expect(h.recordActivityPing).not.toHaveBeenCalled();
  });

  it("refuses a signed-out request", async () => {
    h.user = null;
    const response = await POST(request({ problemId: PROBLEM, seconds: 30 }));
    expect(response.status).toBe(401);
    expect(h.recordActivityPing).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "seconds=30"],
    ["negative seconds", { problemId: PROBLEM, seconds: -5 }],
    ["fractional seconds", { problemId: PROBLEM, seconds: 1.5 }],
    ["string seconds", { problemId: PROBLEM, seconds: "30" }],
    ["absurd seconds", { problemId: PROBLEM, seconds: 1_000_000 }],
    ["an extra field", { problemId: PROBLEM, seconds: 30, userId: "someone_else" }],
    ["a malformed problem id", { problemId: "x'; DROP TABLE", seconds: 30 }],
    ["no problem id", { seconds: 30 }],
    ["an oversized body", { problemId: PROBLEM, seconds: 30, pad: "x".repeat(2_000) }],
  ])("refuses %s with 400", async (_label, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(h.recordActivityPing).not.toHaveBeenCalled();
  });

  it("answers a ping inside the 20 s window with 202 deferred (not an error) and Retry-After", async () => {
    h.recordActivityPing.mockResolvedValue({ status: "rate-limited", retryAfterMs: 12_300 });
    const response = await POST(request({ problemId: PROBLEM, seconds: 30 }));
    expect(response.status).toBe(202);
    expect(response.headers.get("retry-after")).toBe("13");
    expect(await response.json()).toMatchObject({ credited: 0, deferred: true, retryAfterMs: 12_300 });
  });

  it("maps an unknown problem to 404", async () => {
    h.recordActivityPing.mockResolvedValue({ status: "not-found" });
    expect((await POST(request({ problemId: PROBLEM, seconds: 30 }))).status).toBe(404);
  });
});

describe("isSameOrigin", () => {
  const req = (headers: Record<string, string>) => new Request("http://localhost:3100/api/activity", { method: "POST", headers });

  it("trusts Fetch-Metadata when present", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(req({ "sec-fetch-site": "same-site" }))).toBe(false);
    expect(isSameOrigin(req({ "sec-fetch-site": "cross-site", origin: "http://localhost:3100", host: "localhost:3100" }))).toBe(
      false,
    );
  });

  it("falls back to Origin vs Host", () => {
    expect(isSameOrigin(req({ origin: "http://localhost:3100", host: "localhost:3100" }))).toBe(true);
    expect(isSameOrigin(req({ origin: "https://lms.rajalakshmi.edu.in", host: "code.rajalakshmi.edu.in" }))).toBe(false);
    expect(isSameOrigin(req({ origin: "null", host: "localhost:3100" }))).toBe(false);
  });

  it("lets through a request with neither header (no browser ambient credentials to answer for)", () => {
    expect(isSameOrigin(req({}))).toBe(true);
  });
});
