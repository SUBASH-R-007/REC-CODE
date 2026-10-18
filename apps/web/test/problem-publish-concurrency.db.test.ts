import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * "Two concurrent Problem publishes produce one success and one conflict" —
 * through the server action publishProblemVersion({versionId,
 * expectedProblemVersion}) against a real Postgres (recx_test), with the
 * real guards and the real audit chain.
 *
 * Each concurrent caller has its own session: getCurrentUser() reads an
 * AsyncLocalStorage store (a single shared "current user" would race under
 * Promise.all). Validation results are inserted as DONE / MATCHED runs, so
 * no judge is needed. Passing the same expectedProblemVersion makes the
 * outcome independent of timing: in READ COMMITTED the losing conditional
 * UPDATE waits for the winner's row lock, re-checks, and matches 0 rows.
 *
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL overrides the URL; it must
 * name a *_test database).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";

const h = await vi.hoisted(async () => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@localhost:5433/recx_test";
  }
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const objects = new Map<string, Buffer>();
  return {
    als: new AsyncLocalStorage<{ id: string; role: string }>(),
    store: {
      driver: "local" as const,
      async put(key: string, bytes: Buffer) {
        const seen = objects.get(key);
        if (seen && !seen.equals(bytes)) throw new Error(`ImmutableKeyError: ${key}`);
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
        return new Blob([new Uint8Array(objects.get(key) ?? Buffer.alloc(0))]).stream();
      },
    },
  };
});

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => h.als.getStore() ?? null }));
vi.mock("@/lib/judge/queue", () => ({ enqueueJudge: async () => true }));
vi.mock("@/lib/testdata/store", () => ({ getTestDataStore: () => h.store }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  actions: typeof import("@/server/actions/admin-problems");
  blobs: typeof import("@/lib/testdata/blobs");
  fixtures: typeof import("./support/authoring-fixtures");
};

describe.skipIf(!ENABLED)("publishProblemVersion under concurrency (recx_test)", () => {
  const tag = `pubc-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let m: Modules;
  const problemIds: string[] = [];
  const userIds: string[] = [];
  const blobShas: string[] = [];
  let cppConfigId = "";
  let adminA: { id: string; role: string };
  let adminB: { id: string; role: string };
  let author: { id: string; role: string };
  let superAdmin: { id: string; role: string };
  let seq = 0;

  const as = <T>(user: { id: string; role: string }, fn: () => Promise<T>) => h.als.run(user, fn);

  async function createProblem(): Promise<string> {
    const n = ++seq;
    const p = await m.db.problem.create({
      data: { slug: `${tag}-p${n}`, displayCode: `${tag}-P${n}`.toUpperCase(), title: "Concurrency fixture", difficulty: "EASY" },
      select: { id: true },
    });
    problemIds.push(p.id);
    return p.id;
  }

  /** An APPROVED draft whose validation is COMPLETE (a DONE / MATCHED model run at the current judgeSeq). */
  async function approvedDraft(problemId: string, revision: number): Promise<string> {
    const blob = async (text: string) => {
      const b = await m.blobs.ensureTestBlob(m.db, h.store, Buffer.from(text, "utf8"));
      blobShas.push(b.sha256);
      return b.sha256;
    };
    const v = await m.db.problemVersion.create({
      data: {
        problemId,
        revision,
        status: "IN_REVIEW",
        title: `Concurrency fixture r${revision}`,
        difficulty: "EASY",
        statementMd: "Print the input in upper case.",
        ioMode: "STDIN",
        compareMode: "TOKEN",
        timeLimitMs: 1000,
        createdById: author.id,
        lastEditedById: author.id,
        submittedById: author.id,
        submittedForReviewAt: new Date(),
        approvedAt: new Date(),
        approvedById: adminB.id,
      },
      select: { id: true },
    });
    await m.db.testCase.createMany({
      data: [
        { problemVersionId: v.id, index: 0, isSample: true, inputSha256: await blob(`${tag} in a\n`), outputSha256: await blob(`${tag} OUT A\n`) },
        { problemVersionId: v.id, index: 1, isSample: false, inputSha256: await blob(`${tag} in b\n`), outputSha256: await blob(`${tag} OUT B\n`) },
      ],
    });
    const ref = await m.db.referenceSolution.create({
      data: { problemVersionId: v.id, language: "cpp20", label: "Model", source: `// ${tag}\nint main(){}\n`, expectedVerdict: "AC" },
      select: { id: true },
    });
    await m.db.validationRun.create({
      data: {
        problemVersionId: v.id,
        referenceSolutionId: ref.id,
        language: "cpp20",
        languageConfigId: cppConfigId,
        status: "DONE",
        judgeState: "DONE",
        verdict: "AC",
        outcome: "MATCHED",
        measuredMs: 40,
        judgeSeq: 0,
        judgedAt: new Date(),
      },
    });
    return v.id;
  }

  const problemVersionOf = async (problemId: string) =>
    (await m.db.problem.findUniqueOrThrow({ where: { id: problemId }, select: { version: true } })).version;
  const publishedAudits = (problemId: string, since: Date) =>
    m.db.auditLog.findMany({ where: { action: "problem.published", entityId: problemId, createdAt: { gte: since } } });

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    const [dbModule, actions, blobs, fixtures] = await Promise.all([
      import("@/lib/db"),
      import("@/server/actions/admin-problems"),
      import("@/lib/testdata/blobs"),
      import("./support/authoring-fixtures"),
    ]);
    m = { db: dbModule.db, actions, blobs, fixtures };
    cppConfigId = (await fixtures.enableLanguages(m.db))["cpp20"]!;
    adminA = await fixtures.createUser(m.db, tag, "adminA", "ADMIN");
    adminB = await fixtures.createUser(m.db, tag, "adminB", "ADMIN");
    author = await fixtures.createUser(m.db, tag, "author", "ADMIN");
    superAdmin = await fixtures.createUser(m.db, tag, "super", "SUPER_ADMIN");
    userIds.push(adminA.id, adminB.id, author.id, superAdmin.id);
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      await m.fixtures.cleanup(m.db, { problemIds, userIds, blobShas });
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  it("two admins publishing two revisions with the same expected version: exactly one wins (5 rounds)", async () => {
    for (let round = 0; round < 5; round++) {
      const problemId = await createProblem();
      const r1 = await approvedDraft(problemId, 1);
      const r2 = await approvedDraft(problemId, 2);
      const expected = await problemVersionOf(problemId);
      const t0 = new Date(Date.now() - 1000);
      const [a, b] = await Promise.all([
        as(adminA, () => m.actions.publishProblemVersion({ versionId: r1, expectedProblemVersion: expected })),
        as(adminB, () => m.actions.publishProblemVersion({ versionId: r2, expectedProblemVersion: expected })),
      ]);
      const results = [a, b];
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const loser = results.find((r) => !r.ok)!;
      expect(loser.ok).toBe(false);
      if (!loser.ok) expect(loser.error).toMatch(/changed concurrently/);

      const winnerVersion = a.ok ? r1 : r2;
      const loserVersion = a.ok ? r2 : r1;
      const winnerActor = a.ok ? adminA.id : adminB.id;
      const problem = await m.db.problem.findUniqueOrThrow({ where: { id: problemId } });
      expect(problem).toMatchObject({ liveVersionId: winnerVersion, status: "PUBLISHED", version: expected + 1 });
      const lost = await m.db.problemVersion.findUniqueOrThrow({ where: { id: loserVersion }, include: { languageLimits: true } });
      expect(lost.frozenAt).toBeNull();
      expect(lost.status).not.toBe("PUBLISHED");
      expect(lost.bundleKey).toBeNull();
      expect(lost.languageLimits).toEqual([]);
      const won = await m.db.problemVersion.findUniqueOrThrow({ where: { id: winnerVersion } });
      expect(won.frozenAt).not.toBeNull();
      expect(won.bundleKey).toMatch(/\/tests\.tar\.zst$/);
      const audits = await publishedAudits(problemId, t0);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actorId).toBe(winnerActor);
      expect(audits[0]!.sensitivity).toBe("SENSITIVE");
    }
  }, 120_000);

  it("the same draft published twice at once: one ok, one 'already published' (3 rounds)", async () => {
    for (let round = 0; round < 3; round++) {
      const problemId = await createProblem();
      const r1 = await approvedDraft(problemId, 1);
      const expected = await problemVersionOf(problemId);
      const t0 = new Date(Date.now() - 1000);
      const results = await Promise.all([
        as(adminA, () => m.actions.publishProblemVersion({ versionId: r1, expectedProblemVersion: expected })),
        as(adminB, () => m.actions.publishProblemVersion({ versionId: r1, expectedProblemVersion: expected })),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const loser = results.find((r) => !r.ok);
      if (loser && !loser.ok) expect(loser.error).toMatch(/already published/);
      expect(await publishedAudits(problemId, t0)).toHaveLength(1);
      expect((await m.db.problem.findUniqueOrThrow({ where: { id: problemId } })).version).toBe(expected + 1);
    }
  }, 120_000);

  it("a stale expectedProblemVersion is a conflict and changes nothing", async () => {
    const problemId = await createProblem();
    const r1 = await approvedDraft(problemId, 1);
    const expected = await problemVersionOf(problemId);
    const t0 = new Date(Date.now() - 1000);
    const result = await as(adminA, () => m.actions.publishProblemVersion({ versionId: r1, expectedProblemVersion: expected + 7 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/changed concurrently/);
    const v = await m.db.problemVersion.findUniqueOrThrow({ where: { id: r1 } });
    expect(v.frozenAt).toBeNull();
    expect(await problemVersionOf(problemId)).toBe(expected);
    expect(await publishedAudits(problemId, t0)).toHaveLength(0);
  });

  it("validation on an older toolchain no longer counts: publish is refused until it is re-validated", async () => {
    const problemId = await createProblem();
    const r1 = await approvedDraft(problemId, 1);
    // The model run was judged on a cpp20 toolchain that is no longer current (a GCC upgrade since).
    const old = await m.db.languageConfig.create({
      data: { key: "cpp20", toolchainId: `${tag}-old-gcc`, label: "C++20 (old)", version: "old", runtime: {}, enabled: true, isCurrent: false },
      select: { id: true },
    });
    try {
      await m.db.validationRun.updateMany({ where: { problemVersionId: r1 }, data: { languageConfigId: old.id } });
      const expected = await problemVersionOf(problemId);
      const result = await as(adminA, () => m.actions.publishProblemVersion({ versionId: r1, expectedProblemVersion: expected }));
      expect(result.ok).toBe(false);
      expect((await m.db.problemVersion.findUniqueOrThrow({ where: { id: r1 } })).frozenAt).toBeNull();
      // Back on the current toolchain, the same run counts again.
      await m.db.validationRun.updateMany({ where: { problemVersionId: r1 }, data: { languageConfigId: cppConfigId } });
      const again = await as(adminA, () => m.actions.publishProblemVersion({ versionId: r1, expectedProblemVersion: expected }));
      expect(again.ok).toBe(true);
    } finally {
      await m.db.validationRun.updateMany({ where: { languageConfigId: old.id }, data: { languageConfigId: cppConfigId } });
      await m.db.languageConfig.delete({ where: { id: old.id } });
    }
  });

  it("omitting expectedProblemVersion fails validation with no writes", async () => {
    const problemId = await createProblem();
    const r1 = await approvedDraft(problemId, 1);
    const t0 = new Date(Date.now() - 1000);
    const result = await as(adminA, () => m.actions.publishProblemVersion({ versionId: r1 } as never));
    expect(result.ok).toBe(false);
    expect((await m.db.problemVersion.findUniqueOrThrow({ where: { id: r1 } })).frozenAt).toBeNull();
    expect(await publishedAudits(problemId, t0)).toHaveLength(0);
  });

  it("STUDENT, TA_MENTOR and PLACEMENT_OFFICER are refused before anything is written", async () => {
    const problemId = await createProblem();
    const r1 = await approvedDraft(problemId, 1);
    const t0 = new Date(Date.now() - 1000);
    for (const role of ["STUDENT", "TA_MENTOR", "PLACEMENT_OFFICER"]) {
      const result = await as({ id: `${tag}-${role}`, role }, () =>
        m.actions.publishProblemVersion({ versionId: r1, expectedProblemVersion: 0 }),
      );
      expect(result).toEqual({ ok: false, error: "You don't have permission to do that." });
    }
    const signedOut = await m.actions.publishProblemVersion({ versionId: r1, expectedProblemVersion: 0 });
    expect(signedOut).toEqual({ ok: false, error: "You need to sign in to do that." });
    expect((await m.db.problemVersion.findUniqueOrThrow({ where: { id: r1 } })).frozenAt).toBeNull();
    expect(await publishedAudits(problemId, t0)).toHaveLength(0);
  });

  it("publish racing retire with the same expected version: exactly one wins (3 rounds)", async () => {
    const { retireProblem } = await import("@/server/actions/super-problems");
    for (let round = 0; round < 3; round++) {
      const problemId = await createProblem();
      const r1 = await approvedDraft(problemId, 1);
      const first = await as(adminA, () => m.actions.publishProblemVersion({ versionId: r1, expectedProblemVersion: 0 }));
      expect(first.ok).toBe(true);
      const r2 = await approvedDraft(problemId, 2);
      const expected = await problemVersionOf(problemId);
      const [published, retired] = await Promise.all([
        as(adminA, () => m.actions.publishProblemVersion({ versionId: r2, expectedProblemVersion: expected })),
        as(superAdmin, () => retireProblem({ problemId, expectedProblemVersion: expected, reason: "Concurrency test retirement" })),
      ]);
      expect([published.ok, retired.ok].filter(Boolean)).toHaveLength(1);
      const problem = await m.db.problem.findUniqueOrThrow({ where: { id: problemId } });
      expect(problem.version).toBe(expected + 1);
      if (published.ok) expect(problem).toMatchObject({ status: "PUBLISHED", liveVersionId: r2 });
      else {
        expect(problem).toMatchObject({ status: "RETIRED", liveVersionId: r1 });
        expect((await m.db.problemVersion.findUniqueOrThrow({ where: { id: r2 } })).frozenAt).toBeNull();
      }
    }
  }, 120_000);
});
