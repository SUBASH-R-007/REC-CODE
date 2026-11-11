import { beforeEach, describe, expect, it, vi } from "vitest";
import { JUDGE_HEADERS, JUDGE_PROTOCOL_VERSION, type ResultRequest } from "@recx/shared";

/**
 * Route-level decisions of /api/judge/result and /api/judge/release, with
 * authentication and the finalise layer replaced: which finaliser a result
 * reaches, that a QUARANTINED node's result is discarded (409) and never
 * stored, and that `permanent` reaches the release logic. The database-backed
 * behaviour is covered by judge-pipeline.db.test.ts (RECX_DB_TESTS=1).
 */
const mocks = vi.hoisted(() => ({
  node: { id: "judge-1", hostname: "judge-1", status: "ONLINE" as string },
  finalizeSubmission: vi.fn(async () => "ok"),
  finalizeRun: vi.fn(async () => "ok"),
  finalizeValidation: vi.fn(async () => "ok"),
  discardQuarantinedResult: vi.fn(async () => undefined),
  releaseJob: vi.fn(async () => "ok"),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/judge/finalize", () => ({
  finalizeSubmission: mocks.finalizeSubmission,
  finalizeRun: mocks.finalizeRun,
  finalizeValidation: mocks.finalizeValidation,
  discardQuarantinedResult: mocks.discardQuarantinedResult,
  releaseJob: mocks.releaseJob,
}));
vi.mock("@/lib/judge/node-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/judge/node-auth")>();
  return { ...actual, authenticateNode: async () => ({ ok: true, node: mocks.node }) };
});

const resultRoute = await import("@/app/api/judge/result/route");
const releaseRoute = await import("@/app/api/judge/release/route");

const TOKEN = "c".repeat(43);

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { [JUDGE_HEADERS.protocol]: String(JUDGE_PROTOCOL_VERSION), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function result(overrides: Partial<ResultRequest> = {}): ResultRequest {
  return {
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: "submission",
    id: "cmsub000000000000000000001",
    claimToken: TOKEN,
    verdict: "AC",
    compile: null,
    tests: [{ i: 0, v: "AC", ms: 12, kb: 2048 }],
    passedCases: 1,
    totalCases: 1,
    maxTimeMs: 12,
    maxMemoryKb: 2048,
    firstFailedIndex: null,
    score: 1,
    maxScore: 1,
    subtasks: [],
    cpuMs: 12,
    judgeNodeId: "judge-1",
    calibrationScore: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.node.status = "ONLINE";
});

describe("POST /api/judge/result", () => {
  it.each([
    ["submission", "finalizeSubmission"],
    ["run", "finalizeRun"],
    ["validation", "finalizeValidation"],
  ] as const)("routes a %s result to %s", async (kind, finaliser) => {
    const response = await resultRoute.POST(post("/api/judge/result", result({ kind })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks[finaliser]).toHaveBeenCalledTimes(1);
  });

  it("answers 409 {stale:true} when the finaliser finds the job stale", async () => {
    mocks.finalizeSubmission.mockResolvedValueOnce("stale");
    const response = await resultRoute.POST(post("/api/judge/result", result()));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ stale: true });
  });

  it("discards a QUARANTINED node's result: nothing is finalised, 409 {stale:true}", async () => {
    mocks.node.status = "QUARANTINED";
    const response = await resultRoute.POST(post("/api/judge/result", result({ verdict: "AC" })));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ stale: true });
    expect(mocks.discardQuarantinedResult).toHaveBeenCalledTimes(1);
    expect(mocks.finalizeSubmission).not.toHaveBeenCalled();
  });

  it("refuses IE as a reported verdict", async () => {
    const response = await resultRoute.POST(post("/api/judge/result", result({ verdict: "IE" })));
    expect(response.status).toBe(422);
    expect(mocks.finalizeSubmission).not.toHaveBeenCalled();
  });

  it("rejects a v1-shaped body (no maxScore / cpuMs)", async () => {
    const { maxScore: _maxScore, cpuMs: _cpuMs, ...v1 } = result();
    const response = await resultRoute.POST(post("/api/judge/result", v1));
    expect(response.status).toBe(400);
  });

  it("answers 426 to a body from another protocol version", async () => {
    const response = await resultRoute.POST(post("/api/judge/result", result({ protocolVersion: JUDGE_PROTOCOL_VERSION - 1 })));
    expect(response.status).toBe(426);
  });
});

describe("POST /api/judge/release", () => {
  const release = (extra: Record<string, unknown> = {}) => ({
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: "submission",
    id: "cmsub000000000000000000001",
    claimToken: TOKEN,
    reason: "isolate status XX",
    ...extra,
  });

  it("passes permanent: true through", async () => {
    const response = await releaseRoute.POST(post("/api/judge/release", release({ permanent: true })));
    expect(response.status).toBe(200);
    expect(mocks.releaseJob).toHaveBeenCalledWith(mocks.node, expect.objectContaining({ permanent: true }));
  });

  it("defaults permanent to false", async () => {
    await releaseRoute.POST(post("/api/judge/release", release()));
    expect(mocks.releaseJob).toHaveBeenCalledWith(mocks.node, expect.objectContaining({ permanent: false }));
  });

  it("answers 409 when the node no longer holds the job", async () => {
    mocks.releaseJob.mockResolvedValueOnce("stale");
    const response = await releaseRoute.POST(post("/api/judge/release", release()));
    expect(response.status).toBe(409);
  });
});
