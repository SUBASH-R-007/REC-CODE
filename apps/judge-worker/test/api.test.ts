import { describe, expect, it } from "vitest";
import { JUDGE_PROTOCOL_VERSION, type ResultRequest } from "@recx/shared";
import { HttpJudgeApi, isRefusal } from "../src/api";
import { HttpStatusError, InfraError, ProtocolMismatchError } from "../src/errors";
import { blob, buildJob } from "./support/jobs";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(respond: (call: Call, n: number) => Response | Error) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const answer = respond(call, calls.length);
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function api(fetchImpl: typeof fetch) {
  return new HttpJudgeApi({
    appUrl: "https://code.example.test/",
    nodeId: "judge-01",
    token: "node-token-0123456789abcdef",
    fetch: fetchImpl,
    retries: 2,
    retryDelayMs: 1,
  });
}

const job = buildJob({ cases: [{ input: "1\n", output: "1\n" }] });

describe("HttpJudgeApi", () => {
  it("sends the three node headers on every request", async () => {
    const { impl, calls } = fakeFetch(() => json({ refused: true, reason: "CANCELLED" }));
    await api(impl).claim({ kind: "submission", id: "abc" });
    expect(calls[0]!.url).toBe("https://code.example.test/api/judge/claim");
    expect(calls[0]!.headers).toMatchObject({
      authorization: "Bearer node-token-0123456789abcdef",
      "x-recx-judge-node": "judge-01",
      "x-recx-judge-protocol": String(JUDGE_PROTOCOL_VERSION),
    });
    expect(calls[0]!.body).toEqual({ protocolVersion: JUDGE_PROTOCOL_VERSION, kind: "submission", id: "abc" });
  });

  it("parses a claim refusal and a job spec", async () => {
    const refused = await api(fakeFetch(() => json({ refused: true, reason: "LEASED_ELSEWHERE" })).impl).claim({
      kind: "submission",
      id: job.spec.id,
    });
    expect(isRefusal(refused)).toBe(true);

    const spec = await api(fakeFetch(() => json(job.spec)).impl).claim({ kind: "submission", id: job.spec.id });
    expect(isRefusal(spec)).toBe(false);
    expect(spec).toEqual(job.spec);
  });

  it("rejects a claim body that fails the protocol schema", async () => {
    const bad = { ...job.spec, language: { ...job.spec.language, processes: 100_000 } };
    await expect(api(fakeFetch(() => json(bad)).impl).claim({ kind: "submission", id: job.spec.id })).rejects.toThrow(
      /claim response failed validation/,
    );
  });

  it("rejects a spec for a different job than the one claimed", async () => {
    await expect(api(fakeFetch(() => json(job.spec)).impl).claim({ kind: "submission", id: "other" })).rejects.toThrow(
      InfraError,
    );
  });

  it("426 is a fatal protocol mismatch", async () => {
    const { impl } = fakeFetch(() => json({ error: "Judge protocol version mismatch." }, 426));
    await expect(api(impl).claim({ kind: "submission", id: "abc" })).rejects.toBeInstanceOf(ProtocolMismatchError);
    await expect(api(impl).claim({ kind: "submission", id: "abc" })).rejects.toThrow(/protocol mismatch/);
  });

  it("retries network errors, then gives up with InfraError", async () => {
    const flaky = fakeFetch((_c, n) => (n < 3 ? new TypeError("fetch failed") : json({ refused: true, reason: "NOT_FOUND" })));
    await expect(api(flaky.impl).claim({ kind: "submission", id: "abc" })).resolves.toMatchObject({ refused: true });
    expect(flaky.calls).toHaveLength(3);

    const down = fakeFetch(() => new TypeError("fetch failed"));
    await expect(api(down.impl).claim({ kind: "submission", id: "abc" })).rejects.toThrow(/unreachable after 3 attempts/);
  });

  it("does not retry an HTTP error status", async () => {
    const { impl, calls } = fakeFetch(() => json({ error: "Internal error." }, 500));
    const error = await api(impl)
      .claim({ kind: "submission", id: "abc" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect((error as HttpStatusError).status).toBe(500);
    expect(calls).toHaveLength(1);
  });

  it("fetches a blob with the claim token and checks its size", async () => {
    const b = blob("payload");
    const ok = fakeFetch(() => new Response(b.data));
    const handle = { kind: "submission" as const, id: "s1", claimToken: "claim-token-0123456789" };
    expect((await api(ok.impl).fetchBlob(b.ref, handle)).toString()).toBe("payload");
    expect(ok.calls[0]!.url).toBe(
      `https://code.example.test/api/judge/blob/${b.ref.sha256}?kind=submission&id=s1&claimToken=claim-token-0123456789`,
    );
    const short = fakeFetch(() => new Response("pay"));
    await expect(api(short.impl).fetchBlob(b.ref, handle)).rejects.toThrow(/expected 7/);
  });

  const result: ResultRequest = {
    protocolVersion: JUDGE_PROTOCOL_VERSION,
    kind: "submission",
    id: "s1",
    claimToken: "claim-token-0123456789",
    verdict: "AC",
    compile: null,
    tests: [{ i: 0, v: "AC", ms: 1, kb: 1 }],
    passedCases: 1,
    totalCases: 1,
    maxTimeMs: 1,
    maxMemoryKb: 1,
    firstFailedIndex: null,
    score: 1,
    maxScore: 1,
    subtasks: [],
    cpuMs: 1,
    judgeNodeId: "judge-01",
    calibrationScore: null,
  };

  it("posts a result; 409 means stale", async () => {
    expect(await api(fakeFetch(() => json({ ok: true })).impl).postResult(result)).toEqual({ stale: false });
    expect(await api(fakeFetch(() => json({ stale: true }, 409)).impl).postResult(result)).toEqual({ stale: true });
    await expect(api(fakeFetch(() => json({ error: "nope" }, 400)).impl).postResult(result)).rejects.toThrow(/HTTP 400 — nope/);
  });

  it("validates a result locally before sending it", async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true }));
    await expect(api(impl).postResult({ ...result, tests: [{ i: 0, v: "AC", ms: -1, kb: 1 }] })).rejects.toThrow(
      /local validation/,
    );
    expect(calls).toHaveLength(0);
  });

  it("sends permanent on a release and validates it locally", async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true }));
    const release = {
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      kind: "submission" as const,
      id: "s1",
      claimToken: "claim-token-0123456789",
      reason: "checker FAIL: answer file is not a permutation",
      permanent: true,
    };
    expect(await api(impl).release(release)).toEqual({ stale: false });
    expect(calls[0]!.url).toBe("https://code.example.test/api/judge/release");
    expect(calls[0]!.body).toEqual(release);

    await api(impl).release({ ...release, permanent: false, reason: "x".repeat(900) });
    expect(calls[1]!.body).toMatchObject({ permanent: false });
    expect((calls[1]!.body as { reason: string }).reason).toHaveLength(500);
  });

  it("v2 results with subtasks pass local validation", async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true }));
    await api(impl).postResult({
      ...result,
      verdict: "PARTIAL",
      score: 40,
      maxScore: 100,
      subtasks: [
        { index: 0, earned: 40, max: 40, verdict: "AC" },
        { index: 1, earned: 0, max: 60, verdict: "WA" },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ protocolVersion: JUDGE_PROTOCOL_VERSION, score: 40, maxScore: 100, cpuMs: 1 });
  });

  it("validates the heartbeat response", async () => {
    const body = {
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      hostname: "h",
      workerVersion: "0.1.0",
      isolateVersion: "2.7",
      engineVersion: "",
      driver: "isolate" as const,
      languages: ["py312" as const],
      slots: 1,
      calibrationScore: null,
      calibratedAt: null,
      selfCheck: null,
      hostHardening: null,
      startupMs: {},
      busySlots: 0,
    };
    const ok = await api(
      fakeFetch(() => json({ status: "DRAINING", serverTime: "2026-10-10T00:00:00Z", lanes: ["RUN", "PRACTICE"] })).impl,
    ).heartbeat(body);
    expect(ok.status).toBe("DRAINING");
    expect(ok.lanes).toEqual(["RUN", "PRACTICE"]);
    expect(ok.laneRestrictions).toEqual([]);
    await expect(api(fakeFetch(() => json({ status: "ASLEEP" })).impl).heartbeat(body)).rejects.toThrow(/validation/);
    await expect(
      api(fakeFetch(() => json({ status: "ONLINE", serverTime: "2026-10-10T00:00:00Z" })).impl).heartbeat(body),
    ).rejects.toThrow(/validation/);
  });
});
