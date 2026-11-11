import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  JUDGE_PROTOCOL_VERSION,
  LANGUAGE_CATALOG,
  MIN_RANKED_PEERS,
  readComplexityDetail,
  type ResultRequest,
  type TestResult,
} from "@recx/shared";

/**
 * Phase 17 against a real PostgreSQL: the estimate a finalise stores, and
 * the peer population a standing is read from.
 *
 * Both halves are here because both are things no unit test can check. The
 * estimator itself is pure and covered in `packages/shared/test`; what this
 * file asserts is the plumbing around it — that a finalise reads the input
 * sizes of a version's HIDDEN cases and writes a class, and that the peer
 * query is the population it claims to be:
 *
 *   * one row per student, their fastest, not one row per submission;
 *   * calibration-normalised, so a solution judged on a faster node does
 *     not read as a better solution — asserted by making the fastest peer
 *     one that is only fastest if the calibration is applied;
 *   * this revision, this language, PRACTICE, Accepted, somebody else —
 *     each asserted with a decoy row that would win the ranking if the
 *     filter were missing;
 *   * nothing identifying in what comes back.
 *
 * Every fixture here is created by this file. A db test that reads rows the
 * seed happens to have passes on a development machine and covers nothing
 * on CI, which never runs the seed.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";

const fakes = vi.hoisted(() => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL =
      process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
  return { published: [] as string[] };
});

vi.mock("@/lib/redis", () => ({
  redis: () => ({
    publish: async (channel: string) => {
      fakes.published.push(channel);
      return 1;
    },
  }),
  newSubscriber: () => {
    throw new Error("no subscribers in this test");
  },
}));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: async () => true }));
vi.mock("@/lib/testdata/store", () => ({
  getTestDataStore: () => ({
    driver: "local" as const,
    async put() {},
    async get() {
      throw new Error("no case in this fixture is a sample, so no blob is read");
    },
    async exists() {
      return false;
    },
    async stream(): Promise<ReadableStream<Uint8Array>> {
      throw new Error("not used");
    },
  }),
}));

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  finalize: typeof import("@/lib/judge/finalize");
  standing: typeof import("@/server/queries/solution-standing");
};

/**
 * The quadratic time curve and the linear memory curve the fixture reports,
 * against the case sizes below. Both are what a real submission looks like:
 * a constant floor (process start-up, baseline RSS) with the growth on top.
 */
const CASE_BYTES = [200, 800, 1600, 3200, 6400, 25_600];
const TIME_MS = [20, 21, 23, 33, 70, 820];
const MEMORY_KB = [2080, 2176, 2304, 2560, 3072, 6144];

/** Sizes that span only 1.3x: six readings, and nothing to measure over. */
const FLAT_CASE_BYTES = [200, 210, 220, 230, 245, 260];

describe.skipIf(!ENABLED)("solution complexity and standing, against recx_test", () => {
  const tag = `sc-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: Modules;
  const userIds: string[] = [];
  const problemIds: string[] = [];
  const nodeIds: string[] = [];
  const ids = {
    mine: "",
    problem: "",
    version: "",
    flatVersion: "",
    quietVersion: "",
    cpp20: "",
    py312: "",
    node: "",
    submission: "",
  };

  async function blob(sizeBytes: number, salt: string): Promise<string> {
    const bytes = Buffer.alloc(sizeBytes, salt.charCodeAt(0));
    bytes.write(salt, 0, Math.min(salt.length, sizeBytes), "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await m.db.testBlob.upsert({
      where: { sha256 },
      create: { sha256, sizeBytes: bytes.byteLength, inline: null, storageKey: `${tag}/${sha256}` },
      update: {},
      select: { sha256: true },
    });
    return sha256;
  }

  let revisions = 0;

  /** A version with one hidden case per size. No sample: nothing reads a blob. */
  async function version(label: string, sizes: readonly number[]): Promise<string> {
    revisions += 1;
    const row = await m.db.problemVersion.create({
      data: {
        problemId: ids.problem,
        revision: revisions,
        title: `Growth ${label}`,
        difficulty: "MEDIUM",
        statementMd: "Measure it.",
        ioMode: "STDIN",
        compareMode: "TOKEN",
        scoringMode: "ICPC",
        stopOnFirstFailure: true,
        timeLimitMs: 2000,
      },
      select: { id: true },
    });
    for (const [index, size] of sizes.entries()) {
      await m.db.testCase.create({
        data: {
          problemVersionId: row.id,
          index,
          isSample: false,
          inputSha256: await blob(size, `${label}-in-${index}`),
          outputSha256: await blob(64, `${label}-out-${index}`),
        },
      });
    }
    return row.id;
  }

  async function student(key: string): Promise<string> {
    const row = await m.db.user.create({
      data: {
        collegeId: `${tag}-${key}`.toUpperCase(),
        email: `${tag}-${key}@rec-code.example`,
        handle: `${tag}-${key}`,
        firstName: key,
        lastName: "Peer",
        role: "STUDENT",
      },
      select: { id: true },
    });
    userIds.push(row.id);
    return row.id;
  }

  /** A finished submission written straight in — no judge, no progress. */
  async function accepted(over: {
    userId: string;
    versionId?: string;
    language?: "cpp20" | "py312";
    origin?: "PRACTICE" | "CONTEST";
    verdict?: "AC" | "WA";
    cpuMs: number;
    maxMemoryKb?: number;
    calibrationScore?: number;
    timeComplexity?: "LINEARITHMIC" | "QUADRATIC" | null;
  }): Promise<string> {
    const language = over.language ?? "cpp20";
    const row = await m.db.submission.create({
      data: {
        userId: over.userId,
        problemId: ids.problem,
        problemVersionId: over.versionId ?? ids.version,
        languageConfigId: language === "cpp20" ? ids.cpp20 : ids.py312,
        language,
        origin: over.origin ?? "PRACTICE",
        lane: "PRACTICE",
        status: "DONE",
        judgeState: "DONE",
        verdict: over.verdict ?? "AC",
        cpuMs: over.cpuMs,
        maxTimeMs: over.cpuMs,
        maxMemoryKb: over.maxMemoryKb ?? 4096,
        calibrationScore: over.calibrationScore ?? 1000,
        timeComplexity: over.timeComplexity ?? null,
        passedCases: CASE_BYTES.length,
        totalCases: CASE_BYTES.length,
        sourceSha256: "1".repeat(64),
        sourceBytes: 32,
        judgedAt: new Date(),
      },
      select: { id: true },
    });
    return row.id;
  }

  function resultBody(id: string, claimToken: string, tests: TestResult[]): ResultRequest {
    return {
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      kind: "submission",
      id,
      claimToken,
      verdict: "AC",
      compile: { ok: true, output: "", timeMs: 300, cached: false, resourceExceeded: false },
      tests,
      passedCases: tests.length,
      totalCases: tests.length,
      maxTimeMs: Math.max(...tests.map((t) => t.ms)),
      maxMemoryKb: Math.max(...tests.map((t) => t.kb)),
      firstFailedIndex: null,
      score: 100,
      maxScore: 100,
      subtasks: [],
      cpuMs: tests.reduce((sum, t) => sum + t.ms, 0),
      judgeNodeId: ids.node,
      calibrationScore: 1000,
    };
  }

  /** Create, claim-stamp and finalise one submission; returns its id. */
  async function judge(versionId: string, tests: TestResult[]): Promise<string> {
    const claimToken = randomBytes(24).toString("base64url");
    const row = await m.db.submission.create({
      data: {
        userId: ids.mine,
        problemId: ids.problem,
        problemVersionId: versionId,
        languageConfigId: ids.cpp20,
        language: "cpp20",
        origin: "PRACTICE",
        lane: "PRACTICE",
        status: "JUDGING",
        judgeState: "DISPATCHED",
        claimToken,
        claimedByNodeId: ids.node,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        totalCases: tests.length,
        sourceSha256: "2".repeat(64),
        sourceBytes: 32,
      },
      select: { id: true },
    });
    const node = await m.db.judgeNode.findUniqueOrThrow({ where: { id: ids.node } });
    const outcome = await m.finalize.finalizeSubmission(node, resultBody(row.id, claimToken, tests));
    expect(outcome).toBe("ok");
    return row.id;
  }

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    m = {
      db: (await import("@/lib/db")).db,
      finalize: await import("@/lib/judge/finalize"),
      standing: await import("@/server/queries/solution-standing"),
    };
    for (const key of ["cpp20", "py312"] as const) {
      const rt = LANGUAGE_CATALOG[key];
      const fields = {
        label: rt.label,
        version: rt.version,
        runtime: JSON.parse(JSON.stringify(rt)) as object,
        enabled: true,
        isCurrent: true,
      };
      ids[key] = (
        await m.db.languageConfig.upsert({
          where: { key_toolchainId: { key, toolchainId: rt.toolchainId } },
          create: { key, toolchainId: rt.toolchainId, ...fields },
          update: fields,
          select: { id: true },
        })
      ).id;
    }
    ids.node = `${tag}-node`;
    await m.db.judgeNode.create({
      data: {
        id: ids.node,
        hostname: "complexity-test",
        tokenHash: createHash("sha256").update(`${tag}-token`).digest("hex"),
        status: "ONLINE",
        sensitiveLanesOk: false,
        startupMs: {},
        workerVersion: "0.2.0-test",
        calibrationScore: 1000,
      },
    });
    nodeIds.push(ids.node);
    ids.mine = await student("me");
    ids.problem = (
      await m.db.problem.create({
        data: { slug: `${tag}-growth`, displayCode: tag.toUpperCase(), title: "Growth", difficulty: "MEDIUM" },
        select: { id: true },
      })
    ).id;
    problemIds.push(ids.problem);
    ids.version = await version("wide", CASE_BYTES);
    ids.flatVersion = await version("flat", FLAT_CASE_BYTES);
    ids.quietVersion = await version("quiet", CASE_BYTES);
  }, 120_000);

  afterAll(async () => {
    if (!m) return;
    try {
      const scope = `SELECT "id" FROM "ProblemVersion" WHERE "problemId" = ANY($1::text[])`;
      /**
       * The XP ledger refuses DELETE by trigger, so the trigger comes off —
       * and `ALTER TABLE ... DISABLE TRIGGER` takes an ACCESS EXCLUSIVE lock
       * on a table every other suite writes to. It is therefore held for one
       * statement in a transaction of its own rather than for the twenty
       * below, and no `_frozen_guard` is lifted at all: this file freezes no
       * version, so its cases and revisions delete without one.
       */
      await m.db.$transaction([
        m.db.$executeRawUnsafe(`ALTER TABLE "XpEvent" DISABLE TRIGGER "XpEvent_append_only"`),
        m.db.$executeRawUnsafe(`DELETE FROM "XpEvent" WHERE "userId" = ANY($1::text[])`, userIds),
        m.db.$executeRawUnsafe(`ALTER TABLE "XpEvent" ENABLE TRIGGER "XpEvent_append_only"`),
      ]);
      await m.db.$transaction([
        ...["XpBucket", "ActivityDay", "UserStats", "UserProblemStatus", "UserBadge", "Notification", "RevisionCard"].map(
          (t) => m.db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "userId" = ANY($1::text[])`, userIds),
        ),
        m.db.$executeRawUnsafe(`DELETE FROM "ProblemActivity" WHERE "problemId" = ANY($1::text[])`, problemIds),
        m.db.$executeRawUnsafe(`DELETE FROM "ProblemStat" WHERE "problemId" = ANY($1::text[])`, problemIds),
        m.db.$executeRawUnsafe(
          `DELETE FROM "SubmissionTestDetail" WHERE "submissionId" IN (SELECT "id" FROM "Submission" WHERE "userId" = ANY($1::text[]))`,
          userIds,
        ),
        m.db.$executeRawUnsafe(
          `DELETE FROM "SubmissionSource" WHERE "submissionId" IN (SELECT "id" FROM "Submission" WHERE "userId" = ANY($1::text[]))`,
          userIds,
        ),
        m.db.$executeRawUnsafe(`DELETE FROM "Submission" WHERE "userId" = ANY($1::text[])`, userIds),
        m.db.$executeRawUnsafe(`DELETE FROM "UserJudgeUsage" WHERE "userId" = ANY($1::text[])`, userIds),
        m.db.$executeRawUnsafe(`DELETE FROM "TestCase" WHERE "problemVersionId" IN (${scope})`, problemIds),
        // Content-addressed blobs this file wrote: no TestCase references
        // them once the line above has run.
        m.db.$executeRawUnsafe(`DELETE FROM "TestBlob" WHERE "storageKey" LIKE $1`, `${tag}/%`),
        m.db.$executeRawUnsafe(`UPDATE "Problem" SET "liveVersionId" = NULL WHERE "id" = ANY($1::text[])`, problemIds),
        m.db.$executeRawUnsafe(`DELETE FROM "ProblemVersion" WHERE "problemId" = ANY($1::text[])`, problemIds),
        m.db.$executeRawUnsafe(`DELETE FROM "Problem" WHERE "id" = ANY($1::text[])`, problemIds),
        m.db.$executeRawUnsafe(`DELETE FROM "JudgeNode" WHERE "id" = ANY($1::text[])`, nodeIds),
        m.db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, userIds),
      ]);
    } finally {
      await m.db.$disconnect();
    }
  }, 120_000);

  describe("what a finalise stores", () => {
    it("fits the run's own readings against its hidden cases' input sizes", async () => {
      const tests: TestResult[] = CASE_BYTES.map((_, i) => ({
        i,
        v: "AC",
        ms: TIME_MS[i]!,
        kb: MEMORY_KB[i]!,
      }));
      ids.submission = await judge(ids.version, tests);

      const row = await m.db.submission.findUniqueOrThrow({
        where: { id: ids.submission },
        select: { verdict: true, timeComplexity: true, spaceComplexity: true, complexityDetail: true },
      });
      expect(row.verdict).toBe("AC");
      // Quadratic time on a 20 ms floor, linear memory on a 2 MB one. The
      // sizes come from the TestBlob rows of cases no student may read.
      expect(row.timeComplexity).toBe("QUADRATIC");
      expect(row.spaceComplexity).toBe("LINEAR");

      const detail = readComplexityDetail(row.complexityDetail);
      expect(detail).not.toBeNull();
      expect(detail!.time).toMatchObject({ fitted: true, growth: "QUADRATIC", points: 6, sizeRatio: 128 });
      expect(detail!.space).toMatchObject({ fitted: true, growth: "LINEAR" });
    });

    it("records the refusal when the cases are all about one size", async () => {
      const tests: TestResult[] = FLAT_CASE_BYTES.map((_, i) => ({ i, v: "AC", ms: 20 + i * 200, kb: 2048 + i * 900 }));
      const id = await judge(ids.flatVersion, tests);
      const row = await m.db.submission.findUniqueOrThrow({
        where: { id },
        select: { timeComplexity: true, spaceComplexity: true, complexityDetail: true },
      });
      // A steep rise, and still nothing to say: the x-axis spans 1.3x.
      expect(row.timeComplexity).toBeNull();
      expect(row.spaceComplexity).toBeNull();
      const detail = readComplexityDetail(row.complexityDetail);
      expect(detail!.time).toMatchObject({ fitted: false, reason: "SIZES_TOO_CLOSE", points: 6 });
      expect(detail!.space).toMatchObject({ fitted: false, reason: "SIZES_TOO_CLOSE" });
    });

    it("reads nothing at all when too few cases passed to fit anything", async () => {
      const tests: TestResult[] = CASE_BYTES.map((_, i) => ({
        i,
        v: i < 2 ? "AC" : i === 2 ? "WA" : "SKIPPED",
        ms: i < 3 ? TIME_MS[i]! : 0,
        kb: i < 3 ? MEMORY_KB[i]! : 0,
      }));
      const claimToken = randomBytes(24).toString("base64url");
      const row = await m.db.submission.create({
        data: {
          userId: ids.mine,
          problemId: ids.problem,
          problemVersionId: ids.quietVersion,
          languageConfigId: ids.cpp20,
          language: "cpp20",
          origin: "PRACTICE",
          lane: "PRACTICE",
          status: "JUDGING",
          judgeState: "DISPATCHED",
          claimToken,
          claimedByNodeId: ids.node,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          totalCases: tests.length,
          sourceSha256: "3".repeat(64),
          sourceBytes: 32,
        },
        select: { id: true },
      });
      const node = await m.db.judgeNode.findUniqueOrThrow({ where: { id: ids.node } });
      const body = { ...resultBody(row.id, claimToken, tests), verdict: "WA" as const, firstFailedIndex: 2, score: 0 };
      expect(await m.finalize.finalizeSubmission(node, body)).toBe("ok");
      const stored = await m.db.submission.findUniqueOrThrow({
        where: { id: row.id },
        select: { verdict: true, timeComplexity: true, complexityDetail: true },
      });
      // Two passing cases cannot fit six curves, so the version's cases are
      // never read and nothing is written — not even a refusal.
      expect(stored.verdict).toBe("WA");
      expect(stored.timeComplexity).toBeNull();
      expect(stored.complexityDetail).toBeNull();
    });
  });

  describe("the peer population", () => {
    beforeAll(async () => {
      /**
       * Twenty-five peers. Peer 0 is the fastest ONLY after calibration:
       * 50 CPU ms on a node twice as fast as the one that judged this
       * submission is 100 ms on it, where peer 1's 200 ms is 200. An
       * implementation that ignored the calibration would report a best of
       * 50 and rank everybody against a machine, not a solution.
       */
      for (let k = 0; k < MIN_RANKED_PEERS + 5; k++) {
        const peer = await student(`p${k}`);
        if (k === 0) {
          await accepted({ userId: peer, cpuMs: 50, calibrationScore: 2000, timeComplexity: "LINEARITHMIC" });
        } else {
          await accepted({ userId: peer, cpuMs: 200 + k * 80, timeComplexity: "LINEARITHMIC" });
        }
        // A second, slower accepted submission by the same student. One
        // student is one row of the population, their fastest.
        await accepted({ userId: peer, cpuMs: 9000 + k, timeComplexity: "QUADRATIC" });
      }
      /**
       * Four decoys on one extra student, each 1 ms — each would be the
       * fastest solution in the population if its filter were missing.
       */
      const decoy = await student("decoy");
      await accepted({ userId: decoy, cpuMs: 1, verdict: "WA" });
      await accepted({ userId: decoy, cpuMs: 1, origin: "CONTEST" });
      await accepted({ userId: decoy, cpuMs: 1, language: "py312" });
      await accepted({ userId: decoy, cpuMs: 1, versionId: ids.quietVersion });
      // And one of the student's own, faster than their ranked submission:
      // the population is OTHER students.
      await accepted({ userId: ids.mine, cpuMs: 2 });
    }, 120_000);

    it("ranks one row per other student, normalised for the host", async () => {
      const outcome = await m.standing.getSolutionStanding(ids.submission);
      expect(outcome).not.toBeNull();
      if (!outcome!.ranked) throw new Error(`expected a ranking, got ${outcome!.reason}`);
      // 25 peers with two accepted submissions each, plus a student whose
      // every row is excluded by one filter.
      expect(outcome!.peers).toBe(MIN_RANKED_PEERS + 5);
      expect(outcome!.time.population).toBe(MIN_RANKED_PEERS + 6);
      // 50 ms on a 2x node, expressed on the node that judged this one.
      expect(outcome!.time.best).toBeCloseTo(100, 6);
      expect(outcome!.time.mine).toBe(TIME_MS.reduce((sum, ms) => sum + ms, 0));
      expect(outcome!.time.betterThan).toBeGreaterThan(0);
      expect(outcome!.time.betterThan).toBeLessThan(1);
      expect(outcome!.time.bands.filter((band) => band.mine)).toHaveLength(1);
    });

    it("counts what the other accepted solutions grow like", async () => {
      const outcome = await m.standing.getSolutionStanding(ids.submission);
      if (!outcome!.ranked) throw new Error("expected a ranking");
      // Every peer's FASTEST submission was stored LINEARITHMIC; the
      // quadratic second submissions are not in the population.
      expect(outcome!.growth).toEqual([
        { growth: "LINEARITHMIC", count: MIN_RANKED_PEERS + 5, share: 1, mine: false },
        { growth: "QUADRATIC", count: 0, share: 0, mine: true },
      ]);
      expect(outcome!.growthUnmeasured).toBe(0);
    });

    it("returns nothing identifying", async () => {
      const outcome = await m.standing.getSolutionStanding(ids.submission);
      const json = JSON.stringify(outcome);
      for (const id of userIds) expect(json).not.toContain(id);
      expect(json).not.toContain(tag);
      expect(json).not.toContain("calibration");
    });

    it("refuses to place a submission with too few peers", async () => {
      const lonely = await accepted({ userId: ids.mine, versionId: ids.flatVersion, cpuMs: 400 });
      for (let k = 0; k < MIN_RANKED_PEERS - 1; k++) {
        await accepted({ userId: await student(`q${k}`), versionId: ids.flatVersion, cpuMs: 300 + k });
      }
      const outcome = await m.standing.getSolutionStanding(lonely);
      expect(outcome).toEqual({ ranked: false, reason: "TOO_FEW_PEERS", peers: MIN_RANKED_PEERS - 1 });
    });

    it("places nothing that is not an accepted practice submission", async () => {
      const wrong = await accepted({ userId: ids.mine, cpuMs: 500, verdict: "WA" });
      expect(await m.standing.getSolutionStanding(wrong)).toBeNull();
      const contest = await accepted({ userId: ids.mine, cpuMs: 500, origin: "CONTEST" });
      expect(await m.standing.getSolutionStanding(contest)).toBeNull();
      expect(await m.standing.getSolutionStanding(`${tag}-no-such-submission`)).toBeNull();
    });

    it("places nothing when the run carries no calibration to scale by", async () => {
      const row = await m.db.submission.create({
        data: {
          userId: ids.mine,
          problemId: ids.problem,
          problemVersionId: ids.version,
          languageConfigId: ids.cpp20,
          language: "cpp20",
          origin: "PRACTICE",
          lane: "PRACTICE",
          status: "DONE",
          judgeState: "DONE",
          verdict: "AC",
          cpuMs: 700,
          maxMemoryKb: 4096,
          calibrationScore: null,
          passedCases: 6,
          totalCases: 6,
          sourceSha256: "4".repeat(64),
          sourceBytes: 32,
          judgedAt: new Date(),
        },
        select: { id: true },
      });
      expect(await m.standing.getSolutionStanding(row.id)).toBeNull();
    });
  });
});
