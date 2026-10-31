import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  deriveTimeLimitMs,
  JUDGE_HEADERS,
  JUDGE_PROTOCOL_VERSION,
  LANGUAGE_CATALOG,
  LIMITS,
  type JobKind,
  type ResultRequest,
  type TestResult,
  type Verdict,
} from "@recx/shared";

/**
 * The web side of judge protocol v2 against a real Postgres (recx_test,
 * migrations applied): sensitive-lane claim refusal, v2 finalise + daily
 * usage, the discarded result of a quarantined node, permanent release, the
 * blob route's checker / validation scopes, and the validation → publish
 * pipeline with its optimistic-concurrency guard.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database). Redis, BullMQ and the test-data store are replaced
 * by in-memory fakes, so nothing reaches a local judge worker's queues.
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";

const fakes = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
  const objects = new Map<string, Buffer>();
  return {
    published: [] as { channel: string; message: string }[],
    enqueued: [] as { kind: string; id: string; lane: string }[],
    store: {
      driver: "local" as const,
      async put(key: string, bytes: Buffer) {
        objects.set(key, bytes);
      },
      async get(key: string) {
        const bytes = objects.get(key);
        if (!bytes) throw new Error(`missing ${key}`);
        return bytes;
      },
      async exists(key: string) {
        return objects.has(key);
      },
      async stream(key: string): Promise<ReadableStream<Uint8Array>> {
        const bytes = objects.get(key) ?? Buffer.alloc(0);
        return new Blob([new Uint8Array(bytes)]).stream();
      },
    },
  };
});

vi.mock("@/lib/redis", () => ({
  redis: () => ({
    publish: async (channel: string, message: string) => {
      fakes.published.push({ channel, message });
      return 1;
    },
  }),
  newSubscriber: () => {
    throw new Error("no subscribers in this test");
  },
}));
vi.mock("@/lib/judge/queue", () => ({
  enqueueJudge: async (kind: string, id: string, lane: string) => {
    fakes.enqueued.push({ kind, id, lane });
    return true;
  },
}));
vi.mock("@/lib/testdata/store", () => ({ getTestDataStore: () => fakes.store }));

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  claim: typeof import("@/lib/judge/claim");
  finalize: typeof import("@/lib/judge/finalize");
  validation: typeof import("@/lib/judge/validation");
  nodeAuth: typeof import("@/lib/judge/node-auth");
  blobs: typeof import("@/lib/testdata/blobs");
  usage: typeof import("@/lib/judge/usage");
  resultRoute: typeof import("@/app/api/judge/result/route");
  releaseRoute: typeof import("@/app/api/judge/release/route");
  blobRoute: typeof import("@/app/api/judge/blob/[sha256]/route");
  heartbeatRoute: typeof import("@/app/api/judge/heartbeat/route");
};

describe.skipIf(!ENABLED)("judge protocol v2 against recx_test", () => {
  const tag = `jv2-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: Modules;
  let userId: string;
  const problemIds: string[] = [];
  const nodeIds: string[] = [];
  const configIds: Record<"cpp20" | "py312", string> = { cpp20: "", py312: "" };
  let checkerSha = "";
  const testShas: { input: string; output: string; isSample: boolean }[] = [];

  interface TestNode {
    id: string;
    token: string;
  }

  async function createNode(
    name: string,
    data: { status?: "ONLINE" | "QUARANTINED"; sensitiveLanesOk?: boolean; startupMs?: Record<string, number> } = {},
  ): Promise<TestNode> {
    const id = `${tag}-${name}`;
    const token = randomBytes(32).toString("base64url");
    await m.db.judgeNode.create({
      data: {
        id,
        hostname: "judge-v2-test",
        tokenHash: m.nodeAuth.hashNodeToken(token),
        status: data.status ?? "ONLINE",
        sensitiveLanesOk: data.sensitiveLanesOk ?? false,
        startupMs: data.startupMs ?? {},
        workerVersion: "0.2.0-test",
        calibrationScore: 1000,
      },
    });
    nodeIds.push(id);
    return { id, token };
  }

  const nodeRow = (node: TestNode) => m.db.judgeNode.findUniqueOrThrow({ where: { id: node.id } });

  function request(node: TestNode, path: string, init: { method: string; body?: unknown }): Request {
    return new Request(`http://localhost${path}`, {
      method: init.method,
      headers: {
        [JUDGE_HEADERS.protocol]: String(JUDGE_PROTOCOL_VERSION),
        [JUDGE_HEADERS.node]: node.id,
        authorization: `Bearer ${node.token}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  /** A STDIN, CHECKER-compared, SUBTASK-scored version with three tests and a checker. */
  async function createVersion(options: { revision?: number; problemId?: string; references?: { language: "cpp20" | "py312"; expected: Verdict }[] } = {}) {
    const problemId =
      options.problemId ??
      (
        await m.db.problem.create({
          data: {
            slug: `${tag}-p${problemIds.length}`,
            displayCode: `${tag}-P${problemIds.length}`,
            title: "Judge v2 test problem",
            difficulty: "EASY",
          },
          select: { id: true },
        })
      ).id;
    if (!options.problemId) problemIds.push(problemId);
    const version = await m.db.problemVersion.create({
      data: {
        problemId,
        revision: options.revision ?? 1,
        title: "Judge v2 test problem",
        difficulty: "EASY",
        statementMd: "Test.",
        ioMode: "STDIN",
        compareMode: "CHECKER",
        scoringMode: "SUBTASK",
        stopOnFirstFailure: false,
        timeLimitMs: 1000,
        checkerSha256: checkerSha,
        testlibId: "testlib-0.9.41",
      },
      select: { id: true },
    });
    await m.db.testCase.createMany({
      data: testShas.map((t, index) => ({
        problemVersionId: version.id,
        index,
        isSample: t.isSample,
        inputSha256: t.input,
        outputSha256: t.output,
        subtaskIndex: index < 2 ? 1 : 2,
      })),
    });
    await m.db.subtask.createMany({
      data: [
        { problemVersionId: version.id, index: 1, points: 40, dependsOn: [] },
        { problemVersionId: version.id, index: 2, points: 60, dependsOn: [1] },
      ],
    });
    const defaults: { language: "cpp20" | "py312"; expected: Verdict }[] = [
      { language: "cpp20", expected: "AC" },
      { language: "py312", expected: "AC" },
      { language: "cpp20", expected: "TLE" },
    ];
    const references = options.references ?? defaults;
    for (const [i, r] of references.entries()) {
      await m.db.referenceSolution.create({
        data: {
          problemVersionId: version.id,
          language: r.language,
          label: `ref ${i}`,
          source: `// ${r.expected} ${i}\nint main() { return 0; }\n`,
          expectedVerdict: r.expected,
        },
      });
    }
    return { problemId, versionId: version.id };
  }

  async function createSubmission(versionId: string, problemId: string, lane: "PRACTICE" | "ASSESSMENT" = "PRACTICE") {
    const row = await m.db.submission.create({
      data: {
        userId,
        problemId,
        problemVersionId: versionId,
        languageConfigId: configIds.cpp20,
        language: "cpp20",
        origin: lane === "ASSESSMENT" ? "ASSESSMENT" : "PRACTICE",
        lane,
        status: "QUEUED",
        judgeState: "DISPATCHED",
        totalCases: testShas.length,
        sourceSha256: "0".repeat(64),
        sourceBytes: 20,
        source: { create: { source: "int main() { return 0; }\n" } },
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Phase 12k: a claim answers with either engine's spec. Every job in this
   * suite is a program, so the helper narrows to the isolate spec and
   * fails loudly if a SQL one ever turns up here — which would mean the
   * engine mapping had changed under the pipeline.
   */
  async function claim(node: TestNode, kind: JobKind, id: string) {
    const outcome = await m.claim.claimJob(await nodeRow(node), { protocolVersion: JUDGE_PROTOCOL_VERSION, kind, id });
    if (!outcome.claimed) throw new Error(`claim refused: ${outcome.refusal.reason}`);
    if (outcome.spec.engine !== "isolate") throw new Error(`expected an isolate spec, got ${outcome.spec.engine}`);
    return outcome.spec;
  }

  function result(
    kind: JobKind,
    id: string,
    claimToken: string,
    node: TestNode,
    verdict: Verdict,
    tests: TestResult[],
    extra: Partial<ResultRequest> = {},
  ): ResultRequest {
    const ran = tests.filter((t) => t.v !== "SKIPPED");
    return {
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      kind,
      id,
      claimToken,
      verdict,
      compile: { ok: true, output: "", timeMs: 400, cached: false, resourceExceeded: false },
      tests,
      passedCases: tests.filter((t) => t.v === "AC").length,
      totalCases: tests.length,
      maxTimeMs: Math.max(0, ...ran.map((t) => t.ms)),
      maxMemoryKb: Math.max(0, ...ran.map((t) => t.kb)),
      firstFailedIndex: tests.find((t) => t.v !== "AC")?.i ?? null,
      score: kind === "run" ? null : 100,
      maxScore: kind === "run" ? null : 100,
      subtasks: [],
      cpuMs: ran.reduce((s, t) => s + t.ms, 0),
      judgeNodeId: node.id,
      calibrationScore: 1000,
      ...extra,
    };
  }

  const allAc = (ms: number[]): TestResult[] => ms.map((t, i) => ({ i, v: "AC", ms: t, kb: 2048 }));

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    const [dbModule, claim, finalize, validation, nodeAuth, blobs, usage, resultRoute, releaseRoute, blobRoute, heartbeatRoute] =
      await Promise.all([
        import("@/lib/db"),
        import("@/lib/judge/claim"),
        import("@/lib/judge/finalize"),
        import("@/lib/judge/validation"),
        import("@/lib/judge/node-auth"),
        import("@/lib/testdata/blobs"),
        import("@/lib/judge/usage"),
        import("@/app/api/judge/result/route"),
        import("@/app/api/judge/release/route"),
        import("@/app/api/judge/blob/[sha256]/route"),
        import("@/app/api/judge/heartbeat/route"),
      ]);
    m = { db: dbModule.db, claim, finalize, validation, nodeAuth, blobs, usage, resultRoute, releaseRoute, blobRoute, heartbeatRoute };

    for (const key of ["cpp20", "py312"] as const) {
      const rt = LANGUAGE_CATALOG[key];
      const fields = { label: rt.label, version: rt.version, runtime: JSON.parse(JSON.stringify(rt)), enabled: true, isCurrent: true };
      const row = await m.db.languageConfig.upsert({
        where: { key_toolchainId: { key, toolchainId: rt.toolchainId } },
        create: { key, toolchainId: rt.toolchainId, ...fields },
        update: fields,
        select: { id: true },
      });
      configIds[key] = row.id;
    }
    const user = await m.db.user.create({
      data: {
        collegeId: tag,
        email: `${tag}@rec-code.example`,
        firstName: "Judge",
        lastName: "Tester",
        handle: tag,
      },
      select: { id: true },
    });
    userId = user.id;

    const blob = (text: string) => m.blobs.ensureTestBlob(m.db, fakes.store, Buffer.from(text, "utf8"));
    checkerSha = (await blob(`#include "testlib.h"\n// ${tag}\nint main(int argc, char* argv[]) { registerTestlibCmd(argc, argv); quitf(_ok, "ok"); }\n`)).sha256;
    for (let i = 0; i < 3; i++) {
      testShas.push({
        input: (await blob(`${tag} input ${i}\n`)).sha256,
        output: (await blob(`${tag} output ${i}\n`)).sha256,
        isSample: i === 0,
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      const scope = `SELECT "id" FROM "ProblemVersion" WHERE "problemId" = ANY($1::text[])`;
      const guarded = ["TestCase", "StarterCode", "ReferenceSolution", "Subtask", "ProblemLanguageLimit", "ProblemVersion"];
      await m.db.$transaction([
        // Published versions are immutable by trigger; teardown lifts the
        // triggers inside this one transaction (no other session sees it).
        ...guarded.map((t) => m.db.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER "${t}_frozen_guard"`)),
        m.db.$executeRawUnsafe(`DELETE FROM "ValidationRun" WHERE "problemVersionId" IN (${scope})`, problemIds),
        // Phase 3 progress rows written by the PRACTICE finalise. The XP
        // ledger is append-only by trigger; lifted only inside this transaction.
        m.db.$executeRawUnsafe(`ALTER TABLE "XpEvent" DISABLE TRIGGER "XpEvent_append_only"`),
        m.db.$executeRawUnsafe(`DELETE FROM "XpEvent" WHERE "userId" = $1`, userId),
        m.db.$executeRawUnsafe(`ALTER TABLE "XpEvent" ENABLE TRIGGER "XpEvent_append_only"`),
        ...["XpBucket", "ActivityDay", "UserStats", "UserProblemStatus", "UserBadge", "Notification"].map((t) =>
          m.db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "userId" = $1`, userId),
        ),
        m.db.$executeRawUnsafe(`DELETE FROM "ProblemStat" WHERE "problemId" = ANY($1::text[])`, problemIds),
        m.db.$executeRawUnsafe(`DELETE FROM "Submission" WHERE "userId" = $1`, userId),
        m.db.$executeRawUnsafe(`DELETE FROM "RunRequest" WHERE "userId" = $1`, userId),
        m.db.$executeRawUnsafe(`DELETE FROM "UserJudgeUsage" WHERE "userId" = $1`, userId),
        ...["ProblemLanguageLimit", "Subtask", "TestCase", "StarterCode", "ReferenceSolution"].map((t) =>
          m.db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "problemVersionId" IN (${scope})`, problemIds),
        ),
        m.db.$executeRawUnsafe(`UPDATE "Problem" SET "liveVersionId" = NULL WHERE "id" = ANY($1::text[])`, problemIds),
        m.db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = ANY($1::text[])`, problemIds),
        m.db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE "id" = ANY($1::text[])`, problemIds),
        m.db.$executeRawUnsafe(`DELETE FROM "JudgeNode" WHERE "id" = ANY($1::text[])`, nodeIds),
        m.db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId),
        ...guarded.map((t) => m.db.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER "${t}_frozen_guard"`)),
      ]);
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  it("heartbeat stores the v2 report, decides lanes, and quarantines a failed hardening check", async () => {
    const node = await createNode("heartbeat", { status: "ONLINE" });
    await m.db.judgeNode.update({ where: { id: node.id }, data: { status: "OFFLINE", calibrationScore: null } });
    const now = new Date().toISOString();
    const report = (overrides: Record<string, unknown> = {}) => ({
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      hostname: "judge-v2-test",
      workerVersion: "0.2.0-test",
      isolateVersion: "2.7",
      driver: "isolate",
      languages: ["cpp20", "py312"],
      slots: 4,
      calibrationScore: 1000,
      calibratedAt: now,
      selfCheck: { ok: true, at: now, failures: [] },
      hostHardening: { ok: true, failures: [] },
      startupMs: { cpp20: 7, py312: 25 },
      busySlots: 0,
      ...overrides,
    });
    const beat = async (body: unknown) => {
      const response = await m.heartbeatRoute.POST(request(node, "/api/judge/heartbeat", { method: "POST", body }));
      expect(response.status).toBe(200);
      return (await response.json()) as { status: string; lanes: string[]; laneRestrictions: string[] };
    };

    const healthy = await beat(report());
    expect(healthy).toMatchObject({ status: "ONLINE", lanes: ["ASSESSMENT", "CONTEST", "RUN", "PRACTICE", "REJUDGE"], laneRestrictions: [] });
    const stored = await nodeRow(node);
    expect(stored).toMatchObject({ sensitiveLanesOk: true, hostHardened: true, selfCheckOk: true, startupMs: { cpp20: 7, py312: 25 } });
    expect(stored.calibratedAt?.toISOString()).toBe(now);

    // No calibration in this heartbeat: still ONLINE, but no sensitive lanes.
    const uncalibrated = await beat(report({ calibrationScore: null, calibratedAt: null, selfCheck: null }));
    expect(uncalibrated.status).toBe("ONLINE");
    expect(uncalibrated.lanes).toEqual(["RUN", "PRACTICE", "REJUDGE"]);
    expect(uncalibrated.laneRestrictions[0]).toMatch(/calibration missing/);
    expect(await nodeRow(node)).toMatchObject({ sensitiveLanesOk: false, selfCheckOk: true });

    const unhardened = await beat(report({ hostHardening: { ok: false, failures: ["kernel.io_uring_disabled = 0 (expected 2)"] } }));
    expect(unhardened).toMatchObject({ status: "QUARANTINED", lanes: [] });
    const audit = await m.db.auditLog.findFirst({ where: { action: "judge.node.quarantined", entityId: node.id } });
    expect(audit?.sensitivity).toBe("SECURITY");
    expect(JSON.stringify(audit?.metadata)).toMatch(/host hardening check failed/);
    // Only an admin lifts a quarantine; a healthy report does not restore sensitive lanes.
    expect((await beat(report())).status).toBe("QUARANTINED");
    expect((await nodeRow(node)).sensitiveLanesOk).toBe(false);
  });

  it("keeps an ASSESSMENT job queued for an eligible node, consuming no attempt", async () => {
    const { problemId, versionId } = await createVersion();
    const id = await createSubmission(versionId, problemId, "ASSESSMENT");
    const ineligible = await createNode("ineligible", { sensitiveLanesOk: false });
    const outcome = await m.claim.claimJob(await nodeRow(ineligible), {
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      kind: "submission",
      id,
    });
    expect(outcome).toEqual({ claimed: false, refusal: { refused: true, reason: "NOT_CLAIMABLE" } });
    const row = await m.db.submission.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "QUEUED", attemptCount: 0, claimToken: null, claimedByNodeId: null });

    const eligible = await createNode("eligible", { sensitiveLanesOk: true, startupMs: { cpp20: 7 } });
    const spec = await claim(eligible, "submission", id);
    expect(spec.lane).toBe("ASSESSMENT");
    expect(spec.subtasks.map((s) => s.index)).toEqual([1, 2]);
    expect(spec.checker).toEqual({
      source: { sha256: checkerSha, sizeBytes: expect.any(Number) as number },
      language: "cpp20",
      testlibId: "testlib-0.9.41",
    });
    // No ProblemLanguageLimit row yet: fallback (C++ ×1) + the node's startup credit.
    expect(spec.timeLimitMs).toBe(1007);
  });

  it("stores the v2 result and charges the user's Kolkata day, for submissions and runs", async () => {
    const { problemId, versionId } = await createVersion();
    const node = await createNode("finaliser");
    const before = await m.db.userJudgeUsage.findUnique({
      where: { userId_day: { userId, day: m.usage.usageDay(new Date()) } },
    });

    const id = await createSubmission(versionId, problemId);
    const spec = await claim(node, "submission", id);
    const body = result("submission", id, spec.claimToken, node, "PARTIAL", [
      { i: 0, v: "AC", ms: 30, kb: 1024 },
      { i: 1, v: "AC", ms: 40, kb: 1024 },
      { i: 2, v: "TLE", ms: 1100, kb: 1024 },
    ], {
      score: 40,
      maxScore: 100,
      subtasks: [
        { index: 2, earned: 0, max: 60, verdict: "TLE" },
        { index: 1, earned: 40, max: 40, verdict: "AC" },
      ],
    });
    expect(await m.finalize.finalizeSubmission(await nodeRow(node), body)).toBe("ok");
    const row = await m.db.submission.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "DONE", verdict: "PARTIAL", score: 40, maxScore: 100, cpuMs: 1170, claimToken: null });
    expect(row.subtaskResults).toEqual([
      { index: 1, earned: 40, max: 40, verdict: "AC" },
      { index: 2, earned: 0, max: 60, verdict: "TLE" },
    ]);
    // A retried callback changes nothing.
    expect(await m.finalize.finalizeSubmission(await nodeRow(node), body)).toBe("stale");

    const run = await m.db.runRequest.create({
      data: {
        userId,
        problemVersionId: versionId,
        languageConfigId: configIds.cpp20,
        language: "cpp20",
        source: "int main() {}\n",
        status: "QUEUED",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      select: { id: true },
    });
    const runSpec = await claim(node, "run", run.id);
    expect(runSpec.tests.every((t) => t.isSample)).toBe(true);
    expect(await m.finalize.finalizeRun(await nodeRow(node), result("run", run.id, runSpec.claimToken, node, "AC", allAc([25])))).toBe("ok");

    const after = await m.db.userJudgeUsage.findUniqueOrThrow({
      where: { userId_day: { userId, day: m.usage.usageDay(new Date()) } },
    });
    expect(after.submissions - (before?.submissions ?? 0)).toBe(1);
    expect(after.runs - (before?.runs ?? 0)).toBe(1);
    expect(Number(after.cpuMs - (before?.cpuMs ?? 0n))).toBe(1170 + 25);

    // An assessment submission is charged CPU, but never the practice count.
    const eligible = await createNode("assessment-finaliser", { sensitiveLanesOk: true });
    const assessment = await createSubmission(versionId, problemId, "ASSESSMENT");
    const assessmentSpec = await claim(eligible, "submission", assessment);
    const graded = result("submission", assessment, assessmentSpec.claimToken, eligible, "AC", allAc([10, 10, 10]));
    expect(await m.finalize.finalizeSubmission(await nodeRow(eligible), graded)).toBe("ok");
    const later = await m.db.userJudgeUsage.findUniqueOrThrow({
      where: { userId_day: { userId, day: m.usage.usageDay(new Date()) } },
    });
    expect(later.submissions).toBe(after.submissions);
    expect(Number(later.cpuMs - after.cpuMs)).toBe(30);
  });

  it("discards a quarantined node's result and requeues the job without counting the attempt", async () => {
    const { problemId, versionId } = await createVersion();
    const node = await createNode("compromised");
    const id = await createSubmission(versionId, problemId);
    const spec = await claim(node, "submission", id);
    await m.db.judgeNode.update({ where: { id: node.id }, data: { status: "QUARANTINED" } });

    const response = await m.resultRoute.POST(
      request(node, "/api/judge/result", {
        method: "POST",
        body: result("submission", id, spec.claimToken, node, "AC", allAc([5, 5, 5])),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ stale: true });
    const row = await m.db.submission.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      status: "QUEUED",
      judgeState: "DISPATCHED",
      verdict: null,
      claimToken: null,
      leaseExpiresAt: null,
      attemptCount: 0,
    });
    const audit = await m.db.auditLog.findFirst({ where: { action: "judge.result.discarded_quarantined", entityId: id } });
    expect(audit?.sensitivity).toBe("SECURITY");

    // A healthy node then judges it normally.
    const healthy = await createNode("healthy");
    const retry = await claim(healthy, "submission", id);
    expect(retry.attempt).toBe(1);
  });

  it("finalises a permanent release as INTERNAL_ERROR at once, without draining the node", async () => {
    const { problemId, versionId } = await createVersion();
    const node = await createNode("releaser");
    const id = await createSubmission(versionId, problemId);
    const spec = await claim(node, "submission", id);
    const response = await m.releaseRoute.POST(
      request(node, "/api/judge/release", {
        method: "POST",
        body: {
          protocolVersion: JUDGE_PROTOCOL_VERSION,
          kind: "submission",
          id,
          claimToken: spec.claimToken,
          reason: "compare mode INTERACTIVE is not supported",
          permanent: true,
        },
      }),
    );
    expect(response.status).toBe(200);
    const row = await m.db.submission.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "INTERNAL_ERROR", judgeState: "FAILED", verdict: "IE", attemptCount: 1, claimToken: null });
    const audit = await m.db.auditLog.findFirst({ where: { action: "judge.submission.permanent_failure", entityId: id } });
    expect(JSON.stringify(audit?.metadata)).toMatch(/INTERACTIVE/);
    expect((await nodeRow(node)).consecutiveIe).toBe(0);
    expect(fakes.published.some((p) => p.channel === `recx:submission:${id}` && p.message.includes("final"))).toBe(true);
  });

  it("serves blobs only within the held job's scope", async () => {
    const { problemId, versionId } = await createVersion();
    const holder = await createNode("blob-holder");
    const other = await createNode("blob-other");
    const get = (node: TestNode, sha: string, kind: JobKind, id: string, claimToken: string) =>
      m.blobRoute.GET(request(node, `/api/judge/blob/${sha}?kind=${kind}&id=${id}&claimToken=${encodeURIComponent(claimToken)}`, { method: "GET" }), {
        params: Promise.resolve({ sha256: sha }),
      });

    const id = await createSubmission(versionId, problemId);
    const spec = await claim(holder, "submission", id);
    const checker = await get(holder, checkerSha, "submission", id, spec.claimToken);
    expect(checker.status).toBe(200);
    expect(checker.headers.get("x-content-sha256")).toBe(checkerSha);
    expect(Buffer.from(await checker.arrayBuffer()).toString("utf8")).toContain("testlib.h");
    expect((await get(holder, testShas[2]!.output, "submission", id, spec.claimToken)).status).toBe(200);
    expect((await get(other, checkerSha, "submission", id, spec.claimToken)).status).toBe(403);
    expect((await get(holder, "f".repeat(64), "submission", id, spec.claimToken)).status).toBe(403);

    const run = await m.db.runRequest.create({
      data: {
        userId,
        problemVersionId: versionId,
        languageConfigId: configIds.cpp20,
        language: "cpp20",
        source: "int main() {}\n",
        status: "QUEUED",
        expiresAt: new Date(Date.now() + 3_600_000),
      },
      select: { id: true },
    });
    const runSpec = await claim(holder, "run", run.id);
    expect((await get(holder, testShas[0]!.input, "run", run.id, runSpec.claimToken)).status).toBe(200);
    expect((await get(holder, testShas[2]!.input, "run", run.id, runSpec.claimToken)).status).toBe(403);
    expect((await get(holder, checkerSha, "run", run.id, runSpec.claimToken)).status).toBe(200);

    const started = await m.validation.startValidation(versionId, { requestedById: null, via: "test" });
    const validationSpec = await claim(holder, "validation", started.runIds[0]!);
    for (const t of testShas) {
      expect((await get(holder, t.input, "validation", validationSpec.id, validationSpec.claimToken)).status).toBe(200);
      expect((await get(holder, t.output, "validation", validationSpec.id, validationSpec.claimToken)).status).toBe(200);
    }
  });

  /** Drive a version through both stages; returns the stage-1 C++ measurement. */
  async function validate(versionId: string, node: TestNode): Promise<void> {
    const started = await m.validation.startValidation(versionId, { requestedById: null, via: "test" });
    expect(started.runIds).toHaveLength(2);
    for (const runId of started.runIds) {
      expect(fakes.enqueued).toContainEqual({ kind: "validation", id: runId, lane: "REJUDGE" });
      const spec = await claim(node, "validation", runId);
      expect(spec.timeLimitMs).toBe(LIMITS.cpuTime.ceilingMs);
      expect(spec.stopOnFirstFailure).toBe(false);
      const ms = spec.language?.key === "cpp20" ? [20, 120, 80] : [60, 700, 300];
      expect(
        await m.finalize.finalizeValidation(await nodeRow(node), result("validation", runId, spec.claimToken, node, "AC", allAc(ms))),
      ).toBe("ok");
    }
    const status = await m.validation.getValidationStatus(versionId);
    expect(status.phase).toBe("STAGE2_RUNNING");
    const stage2 = await m.db.validationRun.findFirstOrThrow({
      where: { problemVersionId: versionId, referenceSolution: { expectedVerdict: "TLE" } },
      orderBy: { createdAt: "desc" },
    });
    const spec = await claim(node, "validation", stage2.id);
    expect(spec.stopOnFirstFailure).toBe(true);
    // Derived C++ limit: max(2.5 × 120, 1000) = 1000, plus the node's 7 ms startup credit.
    expect(spec.timeLimitMs).toBe(1007);
    const body = result("validation", stage2.id, spec.claimToken, node, "PARTIAL", [
      { i: 0, v: "AC", ms: 10, kb: 1024 },
      { i: 1, v: "AC", ms: 10, kb: 1024 },
      { i: 2, v: "TLE", ms: 1510, kb: 1024 },
    ]);
    expect(await m.finalize.finalizeValidation(await nodeRow(node), body)).toBe("ok");
  }

  it("validates, derives limits, and publishes exactly one of two concurrent publishes", async () => {
    const node = await createNode("validator", { startupMs: { cpp20: 7, py312: 25 } });
    const first = await createVersion();
    const second = await createVersion({ problemId: first.problemId, revision: 2 });

    // Not validated yet: blocked.
    const early = await m.validation.publishVersion(first.versionId, { actorId: null, via: "test" });
    expect(early).toMatchObject({ ok: false, reason: "BLOCKED" });

    await validate(first.versionId, node);
    await validate(second.versionId, node);

    const status = await m.validation.getValidationStatus(first.versionId);
    expect(status).toMatchObject({ phase: "COMPLETE", publishable: true, blockers: [] });
    const runs = await m.db.validationRun.findMany({ where: { problemVersionId: first.versionId, status: "DONE" } });
    expect(runs.every((r) => r.outcome === "MATCHED")).toBe(true);
    expect(runs.find((r) => r.verdict === "PARTIAL")?.measuredMs).toBe(1510);

    const limits = await m.db.problemLanguageLimit.findMany({ where: { problemVersionId: first.versionId } });
    const cpp = limits.find((l) => l.language === "cpp20");
    const py = limits.find((l) => l.language === "py312");
    expect(cpp).toMatchObject({ timeLimitMs: 1000, measuredModelMs: 120, measuredOnGeneration: `0.2.0-test/${node.id}/1000` });
    expect(py).toMatchObject({
      timeLimitMs: deriveTimeLimitMs({ baseMs: 1000, measuredModelMs: 700, multiplier: 5, extraMs: 1000 }),
      measuredModelMs: 700,
    });
    expect(py?.timeLimitMs).toBe(1800);

    const { version } = await m.db.problem.findUniqueOrThrow({ where: { id: first.problemId }, select: { version: true } });
    const stale = await m.validation.publishVersion(first.versionId, { actorId: null, via: "test", expectedProblemVersion: version - 1, requireApproval: false });
    expect(stale).toMatchObject({ ok: false, reason: "CONFLICT" });
    expect((await m.db.problemVersion.findUniqueOrThrow({ where: { id: first.versionId } })).frozenAt).toBeNull();

    const outcomes = await Promise.all([
      m.validation.publishVersion(first.versionId, { actorId: null, via: "test", expectedProblemVersion: version, requireApproval: false }),
      m.validation.publishVersion(second.versionId, { actorId: null, via: "test", expectedProblemVersion: version, requireApproval: false }),
    ]);
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.ok && o.reason === "CONFLICT")).toHaveLength(1);
    const winner = outcomes[0]!.ok ? first.versionId : second.versionId;
    const loser = winner === first.versionId ? second.versionId : first.versionId;

    const problem = await m.db.problem.findUniqueOrThrow({ where: { id: first.problemId } });
    expect(problem).toMatchObject({ liveVersionId: winner, status: "PUBLISHED", version: version + 1 });
    const won = await m.db.problemVersion.findUniqueOrThrow({ where: { id: winner } });
    expect(won.status).toBe("PUBLISHED");
    expect(won.frozenAt).not.toBeNull();
    expect(won.bundleKey).toMatch(/^problems\/.+\/tests\.tar\.zst$/);
    const lost = await m.db.problemVersion.findUniqueOrThrow({ where: { id: loser } });
    expect(lost).toMatchObject({ status: "DRAFT", frozenAt: null });
    const model = await m.db.referenceSolution.findFirstOrThrow({ where: { problemVersionId: winner, language: "py312" } });
    expect(model.measuredMs).toBe(700);
    expect(await m.db.auditLog.findFirst({ where: { action: "problem.published", entityId: first.problemId } })).not.toBeNull();

    // Published means frozen: its limits can no longer change.
    await expect(
      m.db.problemLanguageLimit.updateMany({ where: { problemVersionId: winner }, data: { timeLimitMs: 2000 } }),
    ).rejects.toThrow(/frozen/i);

    // A submission against the published version is judged with the measured limits.
    const claimant = await createNode("after-publish", { startupMs: { cpp20: 7 } });
    const id = await createSubmission(winner, first.problemId);
    expect((await claim(claimant, "submission", id)).timeLimitMs).toBe(1007);
  });

  it("clones a live version into a new draft with every child but the limits", async () => {
    const node = await createNode("cloner", { startupMs: { cpp20: 7 } });
    const { problemId, versionId } = await createVersion();
    await validate(versionId, node);
    expect((await m.validation.publishVersion(versionId, { actorId: null, via: "test", requireApproval: false })).ok).toBe(true);

    const clone = await m.validation.cloneVersionAsDraft(versionId, { createdById: null, via: "test" });
    expect(clone.revision).toBe(2);
    const copy = await m.db.problemVersion.findUniqueOrThrow({
      where: { id: clone.versionId },
      include: { testCases: true, subtasks: true, referenceSolutions: true, languageLimits: true },
    });
    expect(copy).toMatchObject({ problemId, status: "DRAFT", frozenAt: null, checkerSha256: checkerSha, testlibId: "testlib-0.9.41" });
    expect(copy.testCases.map((t) => t.inputSha256)).toEqual(testShas.map((t) => t.input));
    expect(copy.subtasks.map((s) => [s.index, s.points, s.dependsOn])).toEqual([
      [1, 40, []],
      [2, 60, [1]],
    ]);
    expect(copy.referenceSolutions).toHaveLength(3);
    expect(copy.referenceSolutions.every((r) => r.measuredMs === null)).toBe(true);
    expect(copy.languageLimits).toEqual([]);
    // Drafts never write a bundle; publishing writes it once, after the freeze.
    expect(copy.bundleKey).toBeNull();
  });
});
