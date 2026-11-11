import { describe, expect, it, vi } from "vitest";
import { JUDGE_HEADERS, JUDGE_PROTOCOL_VERSION } from "@recx/shared";

// The header checks never reach the database; keep the module from building a client.
vi.mock("@/lib/db", () => ({ db: {} }));

const {
  authenticateNode,
  checkProtocolVersion,
  hashNodeToken,
  nodeTokenMatches,
  parseBearer,
  parseNodeId,
  readNodeCredentials,
} = await import("@/lib/judge/node-auth");

const TOKEN = "tok_0123456789abcdefABCDEF-_";

function headers(overrides: Record<string, string | null> = {}): Headers {
  const base: Record<string, string | null> = {
    [JUDGE_HEADERS.protocol]: String(JUDGE_PROTOCOL_VERSION),
    [JUDGE_HEADERS.node]: "dev-judge-1",
    authorization: `Bearer ${TOKEN}`,
    ...overrides,
  };
  const h = new Headers();
  for (const [k, v] of Object.entries(base)) if (v !== null) h.set(k, v);
  return h;
}

describe("judge protocol version", () => {
  it("accepts exactly the current version", () => {
    expect(checkProtocolVersion(String(JUDGE_PROTOCOL_VERSION))).toEqual({ ok: true });
    expect(checkProtocolVersion(JUDGE_PROTOCOL_VERSION)).toEqual({ ok: true });
  });

  it.each([null, undefined, "", "0", String(JUDGE_PROTOCOL_VERSION + 1), "1.0", "v1", "abc"])(
    "rejects %j with 426 and the expected version",
    (value) => {
      const result = checkProtocolVersion(value);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(426);
      expect(result.body.expected).toBe(JUDGE_PROTOCOL_VERSION);
      expect(result.body.error).toMatch(/protocol/i);
    },
  );

  it("checks the protocol before credentials (an old worker learns to upgrade, not that its token is bad)", () => {
    const result = readNodeCredentials(headers({ [JUDGE_HEADERS.protocol]: "0", authorization: null }));
    expect(result).toMatchObject({ ok: false, status: 426 });
  });

  it("authenticateNode answers 426 for a mismatched worker without touching the database", async () => {
    const request = new Request("http://localhost/api/judge/claim", {
      method: "POST",
      headers: headers({ [JUDGE_HEADERS.protocol]: String(JUDGE_PROTOCOL_VERSION + 1) }),
    });
    const auth = await authenticateNode(request);
    expect(auth.ok).toBe(false);
    if (auth.ok) return;
    expect(auth.response.status).toBe(426);
    expect(await auth.response.json()).toMatchObject({ expected: JUDGE_PROTOCOL_VERSION });
  });

  it("authenticateNode answers 401 when credentials are missing", async () => {
    const request = new Request("http://localhost/api/judge/heartbeat", {
      method: "POST",
      headers: headers({ authorization: null }),
    });
    const auth = await authenticateNode(request);
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.response.status).toBe(401);
  });
});

describe("node credentials", () => {
  it("reads node id and bearer token", () => {
    expect(readNodeCredentials(headers())).toEqual({ ok: true, nodeId: "dev-judge-1", token: TOKEN });
  });

  it.each([
    ["missing node header", { [JUDGE_HEADERS.node]: null }],
    ["missing authorization", { authorization: null }],
    ["non-bearer scheme", { authorization: `Basic ${TOKEN}` }],
    ["short token", { authorization: "Bearer short" }],
    ["node id with a slash", { [JUDGE_HEADERS.node]: "../judge" }],
  ])("401 on %s", (_label, overrides) => {
    expect(readNodeCredentials(headers(overrides))).toMatchObject({ ok: false, status: 401 });
  });

  it("parses bearer tokens strictly", () => {
    expect(parseBearer(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(parseBearer(`bearer ${TOKEN}`)).toBeNull();
    expect(parseBearer(`Bearer ${TOKEN} extra`)).toBeNull();
    expect(parseBearer(null)).toBeNull();
  });

  it("parses node ids", () => {
    expect(parseNodeId("judge-a.1")).toBe("judge-a.1");
    expect(parseNodeId("")).toBeNull();
    expect(parseNodeId("a".repeat(65))).toBeNull();
    expect(parseNodeId("node id")).toBeNull();
  });

  it("compares sha256(token) with the stored hash", () => {
    const stored = hashNodeToken(TOKEN);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(nodeTokenMatches(TOKEN, stored)).toBe(true);
    expect(nodeTokenMatches(`${TOKEN}x`, stored)).toBe(false);
    expect(nodeTokenMatches(TOKEN, stored.toUpperCase())).toBe(false);
    expect(nodeTokenMatches(TOKEN, "not-a-hash")).toBe(false);
    expect(nodeTokenMatches(TOKEN, "")).toBe(false);
  });
});

