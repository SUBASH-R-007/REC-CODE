import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JUDGE_PROTOCOL_VERSION, type ResultRequest, type TestResult, type Verdict } from "@recx/shared";

/**
 * The Phase 4 manual authoring check, automated against a real Postgres
 * (recx_test): author a problem through the admin actions, fail validation
 * on purpose with a wrong model solution, fix it, review it (a second admin
 * approves), publish revision 1, pin a submission to it, publish revision 2
 * with an edited statement, and confirm the older submission still shows
 * the revision it was judged against — byte for byte.
 *
 * Judging is simulated through the real claim → finalise path with a fake
 * node; sessions come from an AsyncLocalStorage store; audit() is real.
 * Opt-in: RECX_DB_TESTS=1 (RECX_TEST_DATABASE_URL must name a *_test database).
 */
const ENABLED = process.env.RECX_DB_TESTS === "1";
const TEST_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";

const h = await vi.hoisted(async () => {
  if (process.env.RECX_DB_TESTS === "1") {
    process.env.DATABASE_URL = process.env.RECX_TEST_DATABASE_URL ?? "postgresql://recx:recx-dev-only@127.0.0.1:5433/recx_test";
  }
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const objects = new Map<string, Buffer>();
  return {
    als: new AsyncLocalStorage<{ id: string; role: string }>(),
    objects,
    enqueued: [] as string[],
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
vi.mock("@/lib/judge/queue", () => ({
  enqueueJudge: async (_kind: string, id: string) => {
    h.enqueued.push(id);
    return true;
  },
}));
vi.mock("@/lib/redis", () => ({
  redis: () => ({ publish: async () => 1 }),
  newSubscriber: () => {
    throw new Error("no subscribers in this test");
  },
}));
vi.mock("@/lib/testdata/store", () => ({ getTestDataStore: () => h.store }));
vi.mock("@/lib/ip", () => ({ requestIpHash: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

type Modules = {
  db: (typeof import("@/lib/db"))["db"];
  problems: typeof import("@/server/actions/admin-problems");
  content: typeof import("@/server/actions/admin-problem-content");
  validation: typeof import("@/lib/judge/validation");
  readiness: typeof import("@/lib/authoring/readiness");
  claim: typeof import("@/lib/judge/claim");
  finalize: typeof import("@/lib/judge/finalize");
  nodeAuth: typeof import("@/lib/judge/node-auth");
  submissions: typeof import("@/server/queries/submissions");
  fixtures: typeof import("./support/authoring-fixtures");
};

const WRONG_MODEL = "#include <iostream>\nint main(){std::string s;std::cin>>s;std::cout<<s<<'\\n';}\n// echoes unchanged\n";
const FIXED_MODEL =
  "#include <iostream>\n#include <cctype>\nint main(){std::string s;std::cin>>s;for(auto&c:s)c=std::toupper(c);std::cout<<s<<'\\n';}\n";

describe.skipIf(!ENABLED)("authoring end to end (recx_test)", () => {
  const tag = `auth-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const slug = `${tag}-loud-echo`;
  let m: Modules;
  const problemIds: string[] = [];
  const userIds: string[] = [];
  const nodeIds: string[] = [];
  const blobShas: string[] = [];
  let configIds: Record<string, string> = {};
  let author: { id: string; role: string };
  let reviewer: { id: string; role: string };
  let student: { id: string; role: string };
  let node: { id: string; token: string };
  let problemId = "";

  const as = <T>(user: { id: string; role: string }, fn: () => Promise<T>) => h.als.run(user, fn);
  const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
    if (!r.ok) throw new Error(`action failed: ${r.error}`);
    return r.data;
  };
  const editSeq = async (versionId: string) =>
    (await m.db.problemVersion.findUniqueOrThrow({ where: { id: versionId }, select: { editSeq: true } })).editSeq;
  const nodeRow = () => m.db.judgeNode.findUniqueOrThrow({ where: { id: node.id } });

  /** Claim a validation run on the fake node and post the given verdict for every test. */
  async function judge(runId: string, verdict: Verdict): Promise<void> {
    const outcome = await m.claim.claimJob(await nodeRow(), { protocolVersion: JUDGE_PROTOCOL_VERSION, kind: "validation", id: runId });
    if (!outcome.claimed) throw new Error(`claim refused: ${outcome.refusal.reason}`);
    const spec = outcome.spec;
    // Phase 12k: a claim answers with either engine's spec. Every version
    // in this suite is a program.
    if (spec.engine !== "isolate") throw new Error(`expected an isolate spec, got ${spec.engine}`);
    // AC: every test passes. Otherwise the first test fails and the rest are skipped (stop on first failure).
    const tests: TestResult[] = spec.tests.map((t, i) => ({
      i: t.index,
      v: verdict === "AC" ? "AC" : i === 0 ? verdict : "SKIPPED",
      ms: 20,
      kb: 2048,
    }));
    const ran = tests.filter((t) => t.v !== "SKIPPED");
    const body: ResultRequest = {
      protocolVersion: JUDGE_PROTOCOL_VERSION,
      kind: "validation",
      id: runId,
      claimToken: spec.claimToken,
      verdict,
      compile: { ok: true, output: "", timeMs: 300, cached: false, resourceExceeded: false },
      tests,
      passedCases: tests.filter((t) => t.v === "AC").length,
      totalCases: tests.length,
      maxTimeMs: Math.max(0, ...ran.map((t) => t.ms)),
      maxMemoryKb: Math.max(0, ...ran.map((t) => t.kb)),
      firstFailedIndex: tests.find((t) => t.v !== "AC")?.i ?? null,
      score: verdict === "AC" ? 1 : 0,
      maxScore: 1,
      subtasks: [],
      cpuMs: ran.reduce((s, t) => s + t.ms, 0),
      judgeNodeId: node.id,
      calibrationScore: 1000,
    };
    expect(await m.finalize.finalizeValidation(await nodeRow(), body)).toBe("ok");
  }

  /** Judge every pending run of a version: models get `modelVerdict`, deliberately-wrong ones their expected verdict. */
  async function drainRuns(versionId: string, modelVerdict: Verdict = "AC"): Promise<void> {
    for (let pass = 0; pass < 4; pass++) {
      const runs = await m.db.validationRun.findMany({
        where: { problemVersionId: versionId, status: "QUEUED" },
        select: { id: true, referenceSolution: { select: { expectedVerdict: true } } },
      });
      if (runs.length === 0) return;
      for (const run of runs) await judge(run.id, run.referenceSolution.expectedVerdict === "AC" ? modelVerdict : run.referenceSolution.expectedVerdict);
    }
  }

  async function snapshot(versionId: string) {
    return m.db.problemVersion.findUniqueOrThrow({
      where: { id: versionId },
      include: {
        testCases: { orderBy: { index: "asc" } },
        referenceSolutions: { orderBy: { createdAt: "asc" } },
        starterCodes: true,
        subtasks: true,
        hints: true,
        editorial: true,
        languageLimits: { orderBy: { language: "asc" } },
      },
    });
  }

  beforeAll(async () => {
    if (!new URL(TEST_URL).pathname.endsWith("_test")) {
      throw new Error(`Refusing to run against a non-test database: ${new URL(TEST_URL).pathname}`);
    }
    const [dbModule, problems, content, validation, readiness, claim, finalize, nodeAuth, submissions, fixtures] = await Promise.all([
      import("@/lib/db"),
      import("@/server/actions/admin-problems"),
      import("@/server/actions/admin-problem-content"),
      import("@/lib/judge/validation"),
      import("@/lib/authoring/readiness"),
      import("@/lib/judge/claim"),
      import("@/lib/judge/finalize"),
      import("@/lib/judge/node-auth"),
      import("@/server/queries/submissions"),
      import("./support/authoring-fixtures"),
    ]);
    m = { db: dbModule.db, problems, content, validation, readiness, claim, finalize, nodeAuth, submissions, fixtures };
    configIds = await fixtures.enableLanguages(m.db);
    author = await fixtures.createUser(m.db, tag, "author", "ADMIN");
    reviewer = await fixtures.createUser(m.db, tag, "reviewer", "ADMIN");
    student = await fixtures.createUser(m.db, tag, "student", "STUDENT");
    userIds.push(author.id, reviewer.id, student.id);
    const token = randomBytes(32).toString("base64url");
    node = { id: `${tag}-node`, token };
    await m.db.judgeNode.create({
      data: {
        id: node.id,
        hostname: "authoring-test",
        tokenHash: m.nodeAuth.hashNodeToken(token),
        status: "ONLINE",
        sensitiveLanesOk: false,
        startupMs: {},
        workerVersion: "0.4.0-test",
        calibrationScore: 1000,
      },
    });
    nodeIds.push(node.id);
  }, 60_000);

  afterAll(async () => {
    if (!m) return;
    try {
      const blobs = await m.db.testCase.findMany({
        where: { problemVersion: { problemId: { in: problemIds } } },
        select: { inputSha256: true, outputSha256: true },
      });
      blobShas.push(...blobs.flatMap((b) => [b.inputSha256, b.outputSha256]));
      await m.fixtures.cleanup(m.db, { problemIds, userIds, blobShas });
      await m.db.judgeNode.deleteMany({ where: { id: { in: nodeIds } } });
    } finally {
      await m.db.$disconnect();
    }
  }, 60_000);

  it("authors, fails validation on purpose, fixes, reviews, publishes r1 and r2, and keeps the old submission on r1", async () => {
    // 1. Create the draft (admin "author").
    const created = ok(
      await as(author, () =>
        m.problems.createProblem({
          title: "Loud Echo",
          slug,
          displayCode: `REC-${String(9000 + (Date.now() % 999)).padStart(4, "0")}`,
          difficulty: "EASY",
          ioMode: "STDIN",
          compareMode: "TOKEN",
          statementMd: `Read one word and print it in upper case. ${tag}-r1`,
          timeLimitMs: 1000,
          memoryLimitMb: 256,
          origin: "FACULTY",
        }),
      ),
    );
    problemId = created.problemId;
    problemIds.push(problemId);
    const r1 = created.versionId;

    // Tests: one sample, three hidden.
    for (const [i, word] of ["hello", "judge", "rec", "code"].entries()) {
      ok(
        await as(author, async () =>
          m.content.addDraftTests({
            versionId: r1,
            expectedEditSeq: await editSeq(r1),
            tests: [{ input: `${word}${tag}\n`, output: `${word.toUpperCase()}${tag.toUpperCase()}\n`, isSample: i === 0 }],
          }),
        ),
      );
    }
    // A wrong "model" (echoes unchanged, labelled AC) and a deliberately-wrong Python (labelled WA).
    const model = ok(
      await as(author, async () =>
        m.content.upsertReferenceSolution({
          versionId: r1,
          expectedEditSeq: await editSeq(r1),
          language: "cpp20",
          label: "Model",
          expectedVerdict: "AC",
          source: WRONG_MODEL,
        }),
      ),
    );
    ok(
      await as(author, async () =>
        m.content.upsertReferenceSolution({
          versionId: r1,
          expectedEditSeq: await editSeq(r1),
          language: "py312",
          label: "Echo",
          expectedVerdict: "WA",
          source: "print(input())\n",
        }),
      ),
    );

    // A stale form conflicts; it never overwrites.
    const stale = await as(author, () =>
      m.content.updateDraftDetails({
        versionId: r1,
        expectedEditSeq: 0,
        title: "Loud Echo",
        difficulty: "EASY",
        statementMd: "overwritten",
        constraints: [],
        origin: "FACULTY",
      }),
    );
    expect(stale).toMatchObject({ ok: false, error: expect.stringMatching(/changed by someone else/) });

    // 2. Fail validation on purpose.
    ok(await as(author, () => m.problems.startProblemValidation({ versionId: r1 })));
    await drainRuns(r1, "WA");
    const failed = await m.readiness.getPublishReadiness(r1);
    expect(failed.validation.phase).toBe("STAGE1_FAILED");
    expect(failed.blockers.join("\n")).toMatch(/Model solution failed: .*produced WA/);
    expect(failed.publishable).toBe(false);

    // Submitting is allowed (content is complete); approving and publishing are blocked.
    ok(await as(author, async () => m.problems.submitForReview({ versionId: r1, expectedEditSeq: await editSeq(r1), attestOriginal: true })));
    const blockedApprove = await as(reviewer, () => m.problems.approveVersion({ versionId: r1 }));
    expect(blockedApprove).toMatchObject({ ok: false, error: expect.stringMatching(/Approval is blocked: Model solution failed: .*produced WA/) });
    const problemVersion0 = (await m.db.problem.findUniqueOrThrow({ where: { id: problemId } })).version;
    const blockedPublish = await as(reviewer, () => m.problems.publishProblemVersion({ versionId: r1, expectedProblemVersion: problemVersion0 }));
    expect(blockedPublish).toMatchObject({ ok: false, error: expect.stringMatching(/Publishing is blocked: Model solution failed: .*produced WA/) });

    // In review, nothing can be edited.
    const inReview = await as(author, async () =>
      m.content.upsertReferenceSolution({
        versionId: r1,
        expectedEditSeq: await editSeq(r1),
        referenceId: model.referenceId,
        language: "cpp20",
        label: "Model",
        expectedVerdict: "AC",
        source: FIXED_MODEL,
      }),
    );
    expect(inReview).toMatchObject({ ok: false, error: expect.stringMatching(/in review/) });

    // 3. Withdraw, fix, re-validate: the earlier runs no longer count (judgeSeq).
    ok(await as(author, () => m.problems.withdrawFromReview({ versionId: r1 })));
    const fixed = ok(
      await as(author, async () =>
        m.content.upsertReferenceSolution({
          versionId: r1,
          expectedEditSeq: await editSeq(r1),
          referenceId: model.referenceId,
          language: "cpp20",
          label: "Model",
          expectedVerdict: "AC",
          source: FIXED_MODEL,
        }),
      ),
    );
    expect(fixed.judgeSeq).toBeGreaterThan(0);
    expect((await m.validation.getValidationStatus(r1)).phase).toBe("NOT_STARTED");
    ok(await as(author, () => m.problems.startProblemValidation({ versionId: r1 })));
    await drainRuns(r1, "AC");
    const complete = await m.validation.getValidationStatus(r1);
    expect(complete).toMatchObject({ phase: "COMPLETE", publishable: true });

    // Review: the author cannot approve; a second admin can.
    ok(await as(author, async () => m.problems.submitForReview({ versionId: r1, expectedEditSeq: await editSeq(r1), attestOriginal: true })));
    const self = await as(author, () => m.problems.approveVersion({ versionId: r1 }));
    expect(self).toMatchObject({ ok: false, error: expect.stringMatching(/another admin must/i) });
    ok(await as(reviewer, () => m.problems.approveVersion({ versionId: r1, comment: "Statement, tests and solutions checked." })));

    // The bundle does not exist until the publish freezes the revision.
    expect([...h.objects.keys()].some((k) => k.startsWith(`problems/${problemId}/`))).toBe(false);
    const pv = (await m.db.problem.findUniqueOrThrow({ where: { id: problemId } })).version;
    const published1 = ok(await as(reviewer, () => m.problems.publishProblemVersion({ versionId: r1, expectedProblemVersion: pv })));
    expect(published1).toEqual({ problemId, revision: 1 });
    const frozen1 = await snapshot(r1);
    expect(frozen1.frozenAt).not.toBeNull();
    expect(frozen1.approvedById).toBe(reviewer.id);
    expect(frozen1.bundleKey).toBe(`problems/${problemId}/v1/tests.tar.zst`);
    const manifest = JSON.parse(h.objects.get(`problems/${problemId}/v1/manifest.json`)!.toString("utf8")) as {
      files: { name: string; sha256: string }[];
    };
    expect(manifest.files.filter((f) => f.name.endsWith(".in")).map((f) => f.sha256)).toEqual(frozen1.testCases.map((t) => t.inputSha256));

    const approvedAudit = await m.db.auditLog.findFirst({ where: { action: "problem.review.approved", entityId: r1 } });
    expect(approvedAudit).toMatchObject({ actorId: reviewer.id, sensitivity: "SENSITIVE" });
    const publishedAudit = await m.db.auditLog.findFirst({ where: { action: "problem.published", entityId: problemId } });
    expect(publishedAudit).toMatchObject({ actorId: reviewer.id, sensitivity: "SENSITIVE" });
    const reviews = await m.db.problemReview.findMany({ where: { problemVersionId: r1 }, orderBy: { createdAt: "asc" } });
    expect(reviews.map((r) => r.action)).toEqual(["SUBMITTED", "WITHDRAWN", "SUBMITTED", "APPROVED"]);
    expect(reviews[0]!.attestedOriginal).toBe(true);

    // 4. A student's submission is pinned to revision 1.
    const submission = await m.db.submission.create({
      data: {
        userId: student.id,
        problemId,
        problemVersionId: r1,
        languageConfigId: configIds["py312"]!,
        language: "py312",
        origin: "PRACTICE",
        lane: "PRACTICE",
        status: "DONE",
        judgeState: "DONE",
        verdict: "AC",
        totalCases: 4,
        passedCases: 4,
        sourceSha256: "0".repeat(64),
        sourceBytes: 22,
        judgedAt: new Date(),
        source: { create: { source: "print(input().upper())\n" } },
      },
      select: { id: true },
    });

    // 5. Revision 2: a new draft with an edited statement (statement-only edits keep validation).
    const r2 = ok(await as(author, () => m.problems.startRevision({ problemId })));
    expect(r2).toMatchObject({ revision: 2, existing: false });
    const again = ok(await as(reviewer, () => m.problems.startRevision({ problemId })));
    expect(again).toMatchObject({ versionId: r2.versionId, existing: true });
    expect((await m.db.problemVersion.findUniqueOrThrow({ where: { id: r2.versionId } })).bundleKey).toBeNull();
    ok(await as(author, () => m.problems.startProblemValidation({ versionId: r2.versionId })));
    await drainRuns(r2.versionId, "AC");
    const before = await m.db.problemVersion.findUniqueOrThrow({ where: { id: r2.versionId }, select: { judgeSeq: true } });
    ok(
      await as(author, async () =>
        m.content.updateDraftDetails({
          versionId: r2.versionId,
          expectedEditSeq: await editSeq(r2.versionId),
          title: "Loud Echo",
          difficulty: "EASY",
          statementMd: `Read one word and print it in upper case. R2-marker-${tag}`,
          constraints: ["1 ≤ |w| ≤ 100"],
          origin: "FACULTY",
        }),
      ),
    );
    expect((await m.db.problemVersion.findUniqueOrThrow({ where: { id: r2.versionId }, select: { judgeSeq: true } })).judgeSeq).toBe(before.judgeSeq);
    expect((await m.validation.getValidationStatus(r2.versionId)).phase).toBe("COMPLETE");
    ok(
      await as(author, async () =>
        m.problems.submitForReview({ versionId: r2.versionId, expectedEditSeq: await editSeq(r2.versionId), attestOriginal: true }),
      ),
    );
    ok(await as(reviewer, () => m.problems.approveVersion({ versionId: r2.versionId })));
    const pv2 = (await m.db.problem.findUniqueOrThrow({ where: { id: problemId } })).version;
    expect(ok(await as(reviewer, () => m.problems.publishProblemVersion({ versionId: r2.versionId, expectedProblemVersion: pv2 })))).toEqual({
      problemId,
      revision: 2,
    });

    // 6. The old submission still shows revision 1 as judged; r1's rows are unchanged.
    const detail = await m.submissions.getSubmissionDetail(submission.id, slug, { id: student.id, role: "STUDENT" });
    expect(detail?.pinned.revision).toBe(1);
    expect(detail?.liveRevision).toBe(2);
    expect(detail?.pinned.statementHtml).toContain(`${tag}-r1`);
    expect(detail?.pinned.statementHtml).not.toContain("R2-marker");
    expect(await snapshot(r1)).toEqual(frozen1);
    const live = await m.db.problem.findUniqueOrThrow({ where: { id: problemId }, select: { liveVersionId: true } });
    expect(live.liveVersionId).toBe(r2.versionId);
  }, 180_000);

  it("a test edit after COMPLETE blocks publishing until validation runs again", async () => {
    const r3 = ok(await as(author, () => m.problems.startRevision({ problemId })));
    ok(await as(author, () => m.problems.startProblemValidation({ versionId: r3.versionId })));
    await drainRuns(r3.versionId, "AC");
    expect((await m.validation.getValidationStatus(r3.versionId)).phase).toBe("COMPLETE");
    ok(
      await as(author, async () =>
        m.content.addDraftTests({
          versionId: r3.versionId,
          expectedEditSeq: await editSeq(r3.versionId),
          tests: [{ input: `extra${tag}\n`, output: `EXTRA${tag.toUpperCase()}\n`, isSample: false }],
        }),
      ),
    );
    const readiness = await m.readiness.getPublishReadiness(r3.versionId);
    expect(readiness.validation.phase).toBe("NOT_STARTED");
    expect(readiness.publishable).toBe(false);
    expect(readiness.blockers).toContain("Validation has not been started for every model solution.");
    ok(
      await as(author, async () =>
        m.problems.submitForReview({ versionId: r3.versionId, expectedEditSeq: await editSeq(r3.versionId), attestOriginal: true }),
      ),
    );
    const approve = await as(reviewer, () => m.problems.approveVersion({ versionId: r3.versionId }));
    expect(approve).toMatchObject({ ok: false, error: expect.stringMatching(/Approval is blocked/) });
    // Publishing without approval is blocked even when validation passes.
    ok(await as(author, () => m.problems.withdrawFromReview({ versionId: r3.versionId })));
    ok(await as(author, () => m.problems.startProblemValidation({ versionId: r3.versionId })));
    await drainRuns(r3.versionId, "AC");
    const pv = (await m.db.problem.findUniqueOrThrow({ where: { id: problemId } })).version;
    const unapproved = await as(reviewer, () => m.problems.publishProblemVersion({ versionId: r3.versionId, expectedProblemVersion: pv }));
    expect(unapproved).toMatchObject({ ok: false, error: expect.stringMatching(/not been approved/) });
  }, 120_000);

  it("the admin queries read every view of the problem", async () => {
    const q = await import("@/server/queries/admin-problems");
    const viewer = { id: reviewer.id, role: "ADMIN" as const };
    const list = await q.listAdminProblems(viewer, { stage: null, q: "Loud Ech", difficulty: null, page: 1 });
    expect(list.rows.some((r) => r.id === problemId)).toBe(true);
    const drafts = await q.listAdminProblems(viewer, { stage: "DRAFT", q: slug, difficulty: "EASY", page: 1 });
    expect(drafts.rows.map((r) => r.id)).toEqual([problemId]);
    const detail = await q.getAdminProblem(viewer, problemId, null);
    expect(detail?.revisions.map((r) => [r.revision, r.stage])).toEqual([
      [3, "DRAFT"],
      [2, "PUBLISHED"],
      [1, "SUPERSEDED"],
    ]);
    expect(detail?.selected).toMatchObject({ revision: 3, stage: "DRAFT", editable: true, viewerIsAuthor: false });
    expect(detail?.selected?.references.map((r) => r.language).sort()).toEqual(["cpp20", "py312"]);
    const r1 = await q.getAdminProblem(viewer, problemId, 1);
    expect(r1?.selected).toMatchObject({ revision: 1, stage: "SUPERSEDED", editable: false });
    expect(r1?.selected?.reviews.map((r) => r.action)).toEqual(["SUBMITTED", "WITHDRAWN", "SUBMITTED", "APPROVED"]);
    const tests = await q.getDraftTests(viewer, problemId, null);
    expect(tests?.tests).toHaveLength(5);
    expect(tests?.tests[0]).toMatchObject({ index: 0, isSample: true, inputPreview: expect.stringContaining("hello") });
    const report = await q.getValidationReport(viewer, problemId, 2);
    expect(report?.readiness).toMatchObject({ frozen: true, stage: "PUBLISHED" });
    expect(report?.references.every((r) => r.run?.outcome === "MATCHED")).toBe(true);
    expect(report?.limits.map((l) => l.language)).toEqual(expect.arrayContaining(["cpp20", "py312"]));
    await expect(q.getAdminProblem({ id: student.id, role: "STUDENT" }, problemId, null)).rejects.toThrow(/permission/);
  });

  it("submitting needs the originality attestation and complete content", async () => {
    const draft = await m.db.problemVersion.findFirstOrThrow({ where: { problemId, frozenAt: null }, select: { id: true } });
    const noAttest = await as(author, async () =>
      m.problems.submitForReview({ versionId: draft.id, expectedEditSeq: await editSeq(draft.id), attestOriginal: false }),
    );
    expect(noAttest).toMatchObject({ ok: false, error: expect.stringMatching(/originally authored/) });
  });
});
